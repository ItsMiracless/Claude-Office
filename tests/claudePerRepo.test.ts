/**
 * One Claude per project (src/officeReducer.ts): every session of the same
 * repo — PC, cloud, a second terminal — is one Claude in the office. Each
 * session keeps its own main state; the Claude shows the one that matters
 * most (needs-you, then error, then working, then idle) and leaves only when
 * its last session has.
 */

import { describe, expect, it } from 'vitest'
import { reduceOffice, initialOfficeState, MAIN_ROOM, BOSS_ID, type OfficeState, type OfficeEnv, type OfficeAction } from '../src/officeReducer'
import { isMainAgent, claudeSessions } from '../src/mainState'
import { createAgent } from '../src/agentManager'
import type { Agent } from '../src/types'

const T0 = 1_000_000

function env(over: Partial<OfficeEnv> = {}): OfficeEnv {
  return { now: T0, live: true, computePath: () => [], random: () => 0.5, ...over }
}

function office(): OfficeState {
  const spot = MAIN_ROOM.agentSpots.find(s => s.id === 'spot-1')!
  const boss: Agent = { ...createAgent({ id: BOSS_ID, name: 'Irvin', role: 'boss', spot, hiredAt: T0 }), state: 'working', position: { x: spot.x, y: spot.y }, pathQueue: [] }
  return initialOfficeState([boss], T0)
}

function run(state: OfficeState, actions: OfficeAction[], now = T0) {
  let cur = state
  const effects = []
  for (const a of actions) {
    const r = reduceOffice(cur, a, env({ now }))
    cur = r.state
    effects.push(...r.effects)
  }
  return { state: cur, effects }
}

const claudes = (s: OfficeState) => s.agents.filter(a => isMainAgent(a) && a.state !== 'completed')
const PC = { sessionId: 'pc-1', project: 'claude-workspace', cwd: '/home/irvin/claude-workspace' }
const CLOUD = { sessionId: 'cloud-1', project: 'claude-workspace', cwd: '/home/user/claude-workspace' }
const OTHER = { sessionId: 'ain-1', project: 'ain-management', cwd: '/home/user/ain-management' }

describe('one Claude per project', () => {
  it('two sessions of the same repo share one Claude; another repo gets its own', () => {
    const { state } = run(office(), [
      { type: 'session_started', ...PC },
      { type: 'session_started', ...CLOUD },
      { type: 'session_started', ...OTHER },
      { type: 'agent_working', ...CLOUD, status: 'Read CLAUDE.md' },
    ])
    expect(claudes(state).map(a => a.project).sort()).toEqual(['ain-management', 'claude-workspace'])
  })

  it('✋ from one session shows on the shared Claude and stays up while the other session works', () => {
    let { state, effects } = run(office(), [
      { type: 'session_started', ...PC },
      { type: 'session_started', ...CLOUD },
      { type: 'session_needs_you', ...CLOUD, kind: 'permission', toolName: 'Bash', summary: 'git push' },
    ])
    const claude = () => claudes(state)[0]
    expect(claude()).toMatchObject({ mainState: 'needs-you', needsYou: { kind: 'permission', toolName: 'Bash' } })
    expect(effects.some(e => e.kind === 'sfx' && e.sfx === 'needsYou')).toBe(true)

    // The PC session keeps working: the hand stays up
    ;({ state } = run(state, [{ type: 'agent_working', ...PC, status: 'Edit src/a.ts' }]))
    expect(claude().mainState).toBe('needs-you')

    // The cloud session's call ran: its hand comes down, the PC session's work shows
    ;({ state } = run(state, [{ type: 'session_tool_done', ...CLOUD, toolName: 'Bash' }]))
    expect(claude().mainState).toBe('working')
    expect(claudes(state)).toHaveLength(1)
  })

  it('an answered tool on the other session does not lower this session\'s hand', () => {
    const { state } = run(office(), [
      { type: 'session_started', ...PC },
      { type: 'session_started', ...CLOUD },
      { type: 'session_needs_you', ...CLOUD, kind: 'permission', toolName: 'Bash', summary: 'git push' },
      { type: 'session_tool_done', ...PC, toolName: 'Bash' },
    ])
    expect(claudes(state)[0].mainState).toBe('needs-you')
  })

  it('a chat prompt to either session is shouted at the shared Claude, who works on it', () => {
    const { state, effects } = run(office(), [
      { type: 'session_started', ...PC },
      { type: 'session_started', ...CLOUD },
      { type: 'session_turn_end', ...PC },
      { type: 'session_prompt', ...CLOUD, text: 'cek harga unit Canggu' },
    ])
    const claude = claudes(state)[0]
    expect(claude.mainState).toBe('working')
    expect(claude.statusText).toContain('cek harga unit Canggu')
    expect(claude.callout?.kind).toBe('heard')
    expect(effects.some(e => e.kind === 'msg' && e.tag === 'prompt' && e.text === 'cek harga unit Canggu')).toBe(true)
    // ...and the turn end of the other session does not make it look idle
    const after = run(state, [{ type: 'session_turn_end', ...PC }]).state
    expect(claudes(after)[0].mainState).toBe('working')
  })

  it('stays while any session of the repo is live, and leaves after the last one', () => {
    let { state, effects } = run(office(), [
      { type: 'session_started', ...PC },
      { type: 'session_started', ...CLOUD },
      { type: 'session_ended', ...PC, reason: 'exit' },
    ])
    const leave = (sid: string) => effects.find(e => e.kind === 'schedule' && e.action.type === 'session_claude_leave' && (e.action as { sessionId: string }).sessionId === sid)!
    const pcLeave = leave('pc-1')
    ;({ state } = run(state, [(pcLeave as { action: OfficeAction }).action]))
    expect(claudes(state)).toHaveLength(1)

    ;({ state, effects } = run(state, [{ type: 'session_ended', ...CLOUD, reason: 'exit' }]))
    ;({ state } = run(state, [(leave('cloud-1') as { action: OfficeAction }).action]))
    expect(claudes(state)).toHaveLength(0)
  })

  it('a reload: the snapshot lists both sessions, one Claude; a session it no longer lists drops out of it', () => {
    let { state } = run(office(), [{
      type: 'snapshot', activeAgents: [],
      sessions: [{ ...PC, id: 'pc-1', state: 'active', hooked: true }, { ...CLOUD, id: 'cloud-1', state: 'active', hooked: true, main: { state: 'needs-you', needsYou: { kind: 'permission', toolName: 'Bash' } } }],
    } as never])
    expect(claudes(state)).toHaveLength(1)
    expect(claudes(state)[0].mainState).toBe('needs-you')

    ;({ state } = run(state, [{
      type: 'snapshot', activeAgents: [],
      sessions: [{ ...PC, id: 'pc-1', state: 'active', hooked: true, main: { state: 'working' } }],
    } as never]))
    expect(claudes(state)).toHaveLength(1)
    expect(claudes(state)[0].mainState).toBe('working')
  })

  it('the session pills and room marks find the shared Claude for each of its sessions', () => {
    const { state } = run(office(), [{ type: 'session_started', ...PC }, { type: 'session_started', ...CLOUD }, { type: 'session_started', ...OTHER }])
    expect(claudes(state).map(claudeSessions).map(x => x.sort())).toEqual([['cloud-1', 'pc-1'], ['ain-1']])
  })
})
