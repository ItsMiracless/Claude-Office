/**
 * Resident staff (src/residentStaff.ts, shared/staff.js): the owner's own
 * subagents are always in the office, idle on their own routine, and the same
 * character goes to work when Claude Code really runs that subagent.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  reduceOffice, stepOffice, initialOfficeState, moveAgentsForEvent, pickSingleEventAgent,
  MAIN_ROOM, BOSS_ID, MIN_VISIBLE_TIME,
  type OfficeState, type OfficeEnv,
} from '../src/officeReducer'
import {
  initialStaff, isIdleStaff, staffAgentId, getStaffRoster, setStaffRoster, pickStaffActivity, staffLabel,
  STAFF_DESK_RESERVE, WHITEBOARD_SPOT,
} from '../src/residentStaff'
import { staffRoster } from '../shared/staff.js'
import { staffFromConfig, defaultStaff } from '../server/config.js'
import { createAgent } from '../src/agentManager'
import { ROOMS, type RoomId } from '../src/rooms'
import type { Agent } from '../src/types'

const T0 = 1_000_000
const ROOT = join(__dirname, '..')
const ALL_ROOMS: ReadonlySet<RoomId> = new Set(['main-office', 'corridor', 'meeting-room', 'server-room', 'lunch-room'])

function env(over: Partial<OfficeEnv> = {}): OfficeEnv {
  return { now: T0, live: true, computePath: () => [], random: () => 0.5, ...over }
}

function boss(): Agent {
  const spot = MAIN_ROOM.agentSpots.find(s => s.id === 'spot-1')!
  return { ...createAgent({ id: BOSS_ID, name: 'Irvin', role: 'boss', spot, hiredAt: T0 }), state: 'working', position: { x: spot.x, y: spot.y }, pathQueue: [] }
}

/** The office as App.tsx opens it: the boss and the whole roster */
function office(open?: ReadonlySet<RoomId>): OfficeState {
  const permanent = [boss()]
  return initialOfficeState([...permanent, ...initialStaff(permanent, open, () => 0.3, T0)], T0)
}

/** Step the office `frames` times, `dt` frames each, with the clock moving `msPerStep` */
function run(state: OfficeState, steps: number, e: (now: number) => OfficeEnv, msPerStep = 1000, dt = 200): OfficeState {
  let cur = state
  for (let i = 1; i <= steps; i++) cur = stepOffice(cur, dt, e(T0 + i * msPerStep)).state
  return cur
}

const spawn = (agentType: string, id = `agent-${agentType}`, task = 'Cari dasar hukum PPN') =>
  ({ type: 'agent_spawned' as const, agent: { id, name: 'whatever the hook said', role: 'general-purpose', task, agentType, sessionId: 's1' } })

const session = (sessionId: string) => ({ type: 'session_started' as const, sessionId, project: sessionId })

afterEach(() => { setStaffRoster(undefined) })

describe('roster (shared/staff.js)', () => {
  it('defaults to the owner\'s eleven subagents, with Elaine as the team lead', () => {
    const list = getStaffRoster()
    expect(list).toHaveLength(11)
    expect(list.map(m => m.agentType)).toContain('pajak-riset-regulasi')
    expect(list.find(m => m.agentType === 'elaine')).toMatchObject({ name: 'Elaine', role: 'ai-engineer', manager: true })
    expect(list.find(m => m.agentType === 'airbnb-analis')).toMatchObject({ name: 'Valen', title: 'AirBNB' })
    expect(list.some(m => m.agentType === 'bebong')).toBe(false)
  })

  it('can be switched off or replaced from office.config.json', () => {
    const fallback = [{ agentType: 'a', name: 'A' }]
    expect(staffRoster(false, fallback)).toEqual([])
    expect(staffRoster({ enabled: false }, fallback)).toEqual([])
    expect(staffRoster(undefined, fallback)).toEqual([{ agentType: 'a', name: 'A', role: 'general-purpose' }])
    expect(staffRoster([{ agentType: 'b', name: ' B ', role: 'debugger', title: 'Bug', manager: true }, { agentType: 'b', name: 'dup' }, { name: 'no type' }, 'junk'], fallback))
      .toEqual([{ agentType: 'b', name: 'B', role: 'debugger', title: 'Bug', manager: true }])
    expect(staffRoster({ members: [{ agentType: 'c', name: 'C' }] }, fallback)).toEqual([{ agentType: 'c', name: 'C', role: 'general-purpose' }])
  })

  it('the server hands the same roster to the page (GET /config staff)', () => {
    expect(staffFromConfig({})).toEqual(getStaffRoster())
    expect(staffFromConfig({ staff: false })).toEqual([])
    expect(defaultStaff()).toHaveLength(11)
  })

  it('matches the hook\'s CUSTOM_AGENTS (names and roles), so the two cannot drift', () => {
    const py = readFileSync(join(ROOT, 'hooks', 'agent-tracker.py'), 'utf8')
    const block = py.slice(py.indexOf('CUSTOM_AGENTS = {'), py.indexOf('}', py.indexOf('CUSTOM_AGENTS = {')))
    const hook = [...block.matchAll(/'([^']+)':\s*\('([^']+)',\s*'([^']+)'\)/g)].map(m => ({ agentType: m[1], role: m[2], name: m[3] }))
    const json = JSON.parse(readFileSync(join(ROOT, 'shared', 'resident-staff.json'), 'utf8')) as { agentType: string; role: string; name: string }[]
    const key = (l: { agentType: string; role: string; name: string }[]) => l.map(m => `${m.agentType}|${m.role}|${m.name}`).sort()
    expect(key(hook)).toEqual(key(json))
  })

  it('labels a member with its title', () => {
    expect(staffLabel({ name: 'Valen', title: 'AirBNB' })).toBe('Valen · AirBNB')
    expect(staffLabel({ name: 'X' })).toBe('X')
  })
})

describe('idle staff', () => {
  it('are all in the building from the start, idle, holding no desk and no session', () => {
    const s = office(ALL_ROOMS)
    const staff = s.agents.filter(a => a.staffType)
    expect(staff).toHaveLength(11)
    for (const a of staff) {
      expect(isIdleStaff(a)).toBe(true)
      expect(a.id).toBe(staffAgentId(a.staffType!))
      expect(a.state).not.toBe('working')
      expect(a.sessionId).toBeUndefined()
      expect(a.assignedSpotId).toBeUndefined()
    }
    // Nobody shares a seat or a counter place
    const spots = staff.map(a => a.visitSpotId).filter(Boolean)
    expect(new Set(spots).size).toBe(spots.length)
  })

  it('none at all when the roster is switched off', () => {
    setStaffRoster(false)
    expect(initialStaff([boss()], ALL_ROOMS, Math.random, T0)).toEqual([])
  })

  it('leave enough desks free for real work, and give up a desk they only sit at', () => {
    let s = office()
    const desks = new Set(MAIN_ROOM.agentSpots.filter(sp => sp.type === 'desk').map(sp => sp.id))
    const sitting = s.agents.filter(a => isIdleStaff(a) && desks.has(a.visitSpotId ?? ''))
    // the boss holds one desk
    expect(desks.size - 1 - sitting.length).toBeGreaterThanOrEqual(STAFF_DESK_RESERVE)
    expect(sitting.length).toBeGreaterThan(0)

    // Real workers (sessions' Claudes) take every desk, the ones idle staff sit at included...
    for (let i = 0; i < desks.size; i++) s = reduceOffice(s, session(`w-${i}`), env()).state
    const given = new Set(s.agents.filter(a => !isIdleStaff(a)).map(a => a.assignedSpotId))
    expect(sitting.every(a => given.has(a.visitSpotId))).toBe(true)
    // ...and whoever sat there gets up on the next frame
    s = stepOffice(s, 1, env({ now: T0 + 16 })).state
    for (const a of sitting) expect(s.agents.find(o => o.id === a.id)!.state).toBe('changing-room')
  })

  it('move on to another activity by themselves and never start "working"', () => {
    let s = office(ALL_ROOMS)
    const before = new Map(s.agents.map(a => [a.id, `${a.room}:${a.position.x},${a.position.y}`]))
    let r = 0
    s = run(s, 240, now => env({ now, openRooms: ALL_ROOMS, random: () => ((r = (r * 9301 + 49297) % 233280) / 233280) }))
    const staff = s.agents.filter(a => a.staffType)
    expect(staff).toHaveLength(11)
    expect(staff.every(isIdleStaff)).toBe(true)
    expect(staff.some(a => a.state === 'working')).toBe(false)
    expect(staff.filter(a => before.get(a.id) !== `${a.room}:${a.position.x},${a.position.y}`).length).toBeGreaterThan(5)
  })

  it('the team lead does rounds and plans at the whiteboard', () => {
    const s = office(ALL_ROOMS)
    const elaine = s.agents.find(a => a.staffType === 'elaine')!
    const member = getStaffRoster().find(m => m.agentType === 'elaine')!
    const kinds = new Set<string>()
    for (let i = 0; i < 40; i++) kinds.add(pickStaffActivity(elaine, member, s.agents, ALL_ROOMS, () => (i * 0.137) % 1)?.kind ?? 'none')
    expect(kinds.has('rounds')).toBe(true)
    expect(kinds.has('whiteboard')).toBe(true)
    expect(kinds.has('lunch')).toBe(false)
  })

  it('stay out of random office events', () => {
    const s = office()
    const target = { x: 67.5, y: 48.9 }
    for (const live of [true, false]) {
      const { movedIds } = moveAgentsForEvent(s.agents, target, 'pizza', env({ live }))
      expect(movedIds.some(id => id.startsWith('staff-'))).toBe(false)
      expect(pickSingleEventAgent(s.agents.filter(a => a.id !== BOSS_ID || live), env({ live: false }))?.staffType).toBeUndefined()
    }
  })

  it('are not reconciled away by a server snapshot that does not know them', () => {
    const s = office()
    const r = reduceOffice(s, { type: 'snapshot', activeAgents: [], sessions: [] } as never, env())
    expect(r.state.agents.filter(isIdleStaff)).toHaveLength(11)
  })
})

describe('called in, then back to the routine', () => {
  it('the same character walks to a desk, works and shows the real task', () => {
    const s0 = office()
    const rega = s0.agents.find(a => a.staffType === 'pajak-riset-regulasi')!
    const r = reduceOffice(s0, spawn('pajak-riset-regulasi'), env())
    expect(r.state.agents).toHaveLength(s0.agents.length) // no new character
    expect(r.state.agents.some(a => a.id === rega.id)).toBe(false)
    const worker = r.state.agents.find(a => a.id === 'agent-pajak-riset-regulasi')!
    expect(worker).toMatchObject({ name: 'Ricky', role: 'architect-reviewer', staffType: 'pajak-riset-regulasi', task: 'Cari dasar hukum PPN', sessionId: 's1' })
    expect(worker.assignedSpotId).toMatch(/^spot-/)
    expect(worker.position).toEqual(rega.position)

    let s = run(r.state, 5, now => env({ now }), 1000, 1000)
    const seated = s.agents.find(a => a.id === worker.id)!
    expect(seated.state).toBe('working')
    expect(seated.position).toEqual(seated.deskPosition)

    s = reduceOffice(s, { type: 'agent_working', agentId: worker.id, status: 'reading UU PPN' }, env({ now: T0 + 6000 })).state
    expect(s.agents.find(a => a.id === worker.id)!.statusText).toBe('reading UU PPN')
  })

  it('on completion it gives the desk up and goes back to being idle staff, not out of the door', () => {
    let s = reduceOffice(office(), spawn('airbnb-analis'), env()).state
    s = run(s, 5, now => env({ now }), 1000, 1000)
    const done = T0 + MIN_VISIBLE_TIME + 1000
    const r = reduceOffice(s, { type: 'agent_completed', agentId: 'agent-airbnb-analis', result: 'laporan selesai' }, env({ now: done }))
    const valen = r.state.agents.find(a => a.staffType === 'airbnb-analis')!
    expect(valen.id).toBe(staffAgentId('airbnb-analis'))
    expect(isIdleStaff(valen)).toBe(true)
    expect(valen.state).toBe('idle')
    expect(valen.assignedSpotId).toBeUndefined()
    expect(valen.sessionId).toBeUndefined()
    expect(r.state.meta['agent-airbnb-analis']).toBeUndefined()
    expect(r.effects.some(e => e.kind === 'sfx' && e.sfx === 'celebration')).toBe(true)
    // ...and it is still there long after
    const later = run(r.state, 60, now => env({ now: done + now - T0 }))
    expect(later.agents.filter(a => a.staffType === 'airbnb-analis')).toHaveLength(1)
  })

  it('the server\'s chat lines for it carry its own name, not the borrowed role\'s title', () => {
    const s = reduceOffice(office(), spawn('pajak-riset-regulasi'), env()).state
    const r = reduceOffice(s, { type: 'chat_message', sender: 'Ricky', role: 'architect-reviewer', text: 'starting: riset', timestamp: T0 } as never, env())
    expect(r.effects.find(e => e.kind === 'msg')).toMatchObject({ sender: 'Ricky' })
    const other = reduceOffice(s, { type: 'chat_message', sender: 'Someone', role: 'architect-reviewer', text: 'hi', timestamp: T0 + 1 } as never, env())
    expect(other.effects.find(e => e.kind === 'msg')).not.toMatchObject({ sender: 'Someone' })
  })

  it('a quick job still gets its 30 s on screen first', () => {
    const s = reduceOffice(office(), spawn('website-maintainer'), env()).state
    const r = reduceOffice(s, { type: 'agent_completed', agentId: 'agent-website-maintainer' }, env({ now: T0 + 1000 }))
    expect(r.effects.some(e => e.kind === 'schedule')).toBe(true)
    expect(r.state.agents.find(a => a.id === 'agent-website-maintainer')).toBeDefined()
  })

  it('a subagent that is not staff gets no character of its own in a staffed office', () => {
    const s0 = office()
    const r = reduceOffice(s0, spawn('general-purpose', 'agent-x'), env())
    expect(r.state.agents).toHaveLength(s0.agents.length)
    expect(r.state.agents.some(a => a.id === 'agent-x')).toBe(false)
  })

  it('a second run of the same subagent while the first works adds no duplicate character', () => {
    let s = reduceOffice(office(), spawn('penerjemah-pajak', 'agent-1'), env()).state
    const n = s.agents.length
    s = reduceOffice(s, spawn('penerjemah-pajak', 'agent-2'), env()).state
    expect(s.agents).toHaveLength(n)
    expect(s.agents.filter(a => a.name === 'Christia')).toHaveLength(1)
  })

  it('one character per name across sessions: it shows the latest run and stays at work until every run is done', () => {
    let s = reduceOffice(office(), { ...spawn('airbnb-analis', 'v-1'), agent: { ...spawn('airbnb-analis', 'v-1').agent, sessionId: 's1' } }, env()).state
    s = reduceOffice(s, { ...spawn('airbnb-analis', 'v-2'), agent: { ...spawn('airbnb-analis', 'v-2').agent, sessionId: 's2' } }, env()).state
    s = reduceOffice(s, { ...spawn('airbnb-analis', 'v-3'), agent: { ...spawn('airbnb-analis', 'v-3').agent, sessionId: 's3' } }, env()).state
    expect(s.agents.filter(a => a.staffType === 'airbnb-analis')).toHaveLength(1)
    s = run(s, 5, now => env({ now }), 1000, 1000)
    s = reduceOffice(s, { type: 'agent_working', agentId: 'v-2', status: 'cek harga Canggu' }, env({ now: T0 + 6000 })).state
    const valen = () => s.agents.find(a => a.staffType === 'airbnb-analis')!
    expect(valen()).toMatchObject({ statusText: 'cek harga Canggu' })
    const done = T0 + MIN_VISIBLE_TIME + 1000
    s = reduceOffice(s, { type: 'agent_completed', agentId: 'v-1' }, env({ now: done })).state
    s = reduceOffice(s, { type: 'agent_completed', agentId: 'v-3' }, env({ now: done })).state
    expect(isIdleStaff(valen())).toBe(false)
    s = reduceOffice(s, { type: 'agent_completed', agentId: 'v-2' }, env({ now: done })).state
    expect(isIdleStaff(valen())).toBe(true)
    expect(s.agents.filter(a => a.staffType === 'airbnb-analis')).toHaveLength(1)
  })

  it('a reload keeps a character at work while any of its runs is still listed', () => {
    let s = reduceOffice(office(), spawn('airbnb-analis', 'v-1'), env()).state
    s = reduceOffice(s, spawn('airbnb-analis', 'v-2'), env()).state
    s = reduceOffice(s, spawn('airbnb-analis', 'v-2'), env()).state // a replayed spawn adds no run
    expect(s.agents.find(a => a.staffType === 'airbnb-analis')!.runs).toEqual(['v-1', 'v-2'])
    s = reduceOffice(s, {
      type: 'snapshot',
      activeAgents: [{ id: 'v-2', name: 'Valen', role: 'performance-engineer', task: 'x', state: 'working', agentType: 'airbnb-analis', sessionId: 's1' }],
      sessions: [],
    } as never, env()).state
    expect(isIdleStaff(s.agents.find(a => a.staffType === 'airbnb-analis')!)).toBe(false)
  })

  it('a busy day of generic, repeated and stale workers still shows the boss, the 11 staff and the session\'s Claude', () => {
    let s = reduceOffice(office(), session('s1'), env()).state
    const generic = ['general-purpose', 'Explore', 'Plan', 'fork', 'web-fetch', 'claude', 'claude-code-guide', 'caveman:cavecrew-investigator', 'statusline-setup']
    generic.forEach((t, i) => { s = reduceOffice(s, spawn(t, `g-${i}`), env()).state })
    for (let i = 0; i < 3; i++) s = reduceOffice(s, spawn('backend-senior-engineer', `ll-${i}`), env()).state
    // A reload whose snapshot still lists workers that never clocked out
    s = reduceOffice(s, {
      type: 'snapshot',
      activeAgents: [...generic.map((t, i) => ({ id: `stale-${i}`, name: 'Agent', role: 'general-purpose', task: 'x', state: 'working', agentType: t, sessionId: 's1' })),
        { id: 'll-0', name: 'Linglong', role: 'code-reviewer', task: 'audit', state: 'working', agentType: 'backend-senior-engineer', sessionId: 's1' }],
      sessions: [{ id: 's1', project: 'claude-workspace', state: 'active' }],
    } as never, env()).state
    expect(s.agents).toHaveLength(1 + 11 + 1)
    expect(s.agents.filter(a => a.name === 'Linglong')).toHaveLength(1)
  })

  it('a reload during the job: the snapshot puts the staff member to work', () => {
    const r = reduceOffice(office(), {
      type: 'snapshot',
      activeAgents: [{ id: 'agent-9', name: 'Ricky', role: 'architect-reviewer', task: 'riset', state: 'working', agentType: 'pajak-riset-regulasi', sessionId: 's1' }],
      sessions: [],
    } as never, env())
    expect(r.state.agents.find(a => a.id === 'agent-9')?.staffType).toBe('pajak-riset-regulasi')
    expect(r.state.agents.some(a => a.id === staffAgentId('pajak-riset-regulasi'))).toBe(false)
  })

  it('the team lead works by the meeting room whiteboard when that room is open, else at a desk', () => {
    const open = reduceOffice(office(ALL_ROOMS), spawn('elaine'), env({ openRooms: ALL_ROOMS })).state
    expect(open.agents.find(a => a.id === 'agent-elaine')).toMatchObject({ assignedRoom: 'meeting-room', assignedSpotId: WHITEBOARD_SPOT })
    const closed = reduceOffice(office(), spawn('elaine'), env()).state
    expect(closed.agents.find(a => a.id === 'agent-elaine')!.assignedSpotId).toMatch(/^spot-\d+$/)
    expect(ROOMS['meeting-room'].agentSpots.some(sp => sp.id === WHITEBOARD_SPOT)).toBe(true)
  })

  it('waits in the lobby when every desk is taken', () => {
    let s = office()
    for (let i = 0; i < 12; i++) s = reduceOffice(s, session(`w-${i}`), env()).state
    expect(s.lobby.length).toBeGreaterThan(0)
    const r = reduceOffice(s, spawn('ui-ux-designer'), env())
    const adel = r.state.agents.find(a => a.id === 'agent-ui-ux-designer')!
    expect(adel.state).toBe('waiting')
    expect(r.state.lobby).toContain('agent-ui-ux-designer')
  })
})
