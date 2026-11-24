/**
 * residentStaff.ts - the owner's own subagents as resident staff.
 *
 * Every subagent on the roster (shared/resident-staff.json, or office.config.json's
 * `staff` field: shared/staff.js) is in the office all day as an employee. While
 * it has no work it lives its own office life - lunch room, coffee and water,
 * a chat at a table, a sit at a spare desk, a stroll - and when Claude Code
 * really runs that subagent (an agent_spawned whose agentType is on the
 * roster) the same character goes to a desk and works; when it is done it
 * goes back to its routine instead of leaving the building.
 *
 * Here: the roster, the idle characters and the choice of what an idle one
 * does next, all pure. The reducer (src/officeReducer.ts) claims a staff
 * member on spawn, releases it on completion and walks it between activities.
 *
 * An idle staff member's id is `staff-<agentType>`: the server has never heard
 * of it, so it is never a session, a worker, payroll or an incident; while it
 * works it carries the server's agent id like any worker, and keeps
 * `staffType` so the office knows whom to send back to the routine.
 */

import type { Agent, EffectKind, Position } from './types'
import { AGENT_CONFIGS } from './types'
import { ROOMS, OFFICE_ROOM, findSpot, type AgentSpot, type RoomId, type SpriteFacing } from './rooms'
import { heldSpotIds, roomOf } from './roomTransfer'
import { LUNCH_ROOM, MEETING_ROOM } from './roomRules'
import { staffRoster, type StaffMember } from '../shared/staff.js'
import DEFAULT_ROSTER from '../shared/resident-staff.json'
import { t } from './i18n'
import { BUILD_TIME_STAFF_SETTING } from './config'

export type { StaffMember }

/** Prefix of an idle staff member's id */
export const STAFF_PREFIX = 'staff-'

/** Free office desks an idle staff member leaves for real work before it sits at one */
export const STAFF_DESK_RESERVE = 3

/** The manager's place by the meeting room's whiteboard (src/rooms.ts) */
export const WHITEBOARD_SPOT = 'meet-board'

let roster: StaffMember[] = staffRoster(BUILD_TIME_STAFF_SETTING, DEFAULT_ROSTER)

/** The resident staff in force */
export function getStaffRoster(): readonly StaffMember[] { return roster }

/**
 * Replace the roster (office.config.json at build time and from GET /config, src/config.ts).
 * @param setting a `staff` setting or an already cleaned list; [] switches the staff off
 */
export function setStaffRoster(setting: unknown): readonly StaffMember[] {
  roster = staffRoster(setting, DEFAULT_ROSTER)
  return roster
}

/** The roster entry for a subagent type, if it is staff */
export function staffMember(agentType: string | undefined): StaffMember | undefined {
  return agentType ? roster.find(m => m.agentType === agentType) : undefined
}

export function staffAgentId(agentType: string): string {
  return `${STAFF_PREFIX}${agentType}`
}

/** A staff member with nothing to do (its id is its staff id, not a real agent's) */
export function isIdleStaff(a: Pick<Agent, 'id' | 'staffType'>): boolean {
  return !!a.staffType && a.id === staffAgentId(a.staffType)
}

/** "Rio · AirBNB" */
export function staffLabel(member: Pick<StaffMember, 'name' | 'title'>): string {
  return member.title ? `${member.name} · ${member.title}` : member.name
}

// ---------------------------------------------------------------------------
// What an idle staff member does
// ---------------------------------------------------------------------------

export type StaffKind = 'lunch' | 'chat' | 'coffee' | 'water' | 'desk' | 'wander' | 'printer' | 'rounds' | 'whiteboard'

export interface StaffActivity {
  kind: StaffKind
  room: RoomId
  target: Position
  /** The spot it holds there (a seat, a counter place), if any */
  spotId?: string
  facing?: SpriteFacing
  /** The status line: what it is up to */
  status: string
}

/** How long it stays at an activity before it picks the next one, [min, max] ms */
const DWELL: Record<StaffKind, [number, number]> = {
  lunch: [25_000, 60_000],
  chat: [20_000, 45_000],
  coffee: [10_000, 20_000],
  water: [8_000, 16_000],
  desk: [25_000, 60_000],
  wander: [5_000, 12_000],
  printer: [6_000, 12_000],
  rounds: [8_000, 15_000],
  whiteboard: [20_000, 40_000],
}

export function staffDwellMs(kind: StaffKind, random: () => number): number {
  const [lo, hi] = DWELL[kind]
  return lo + Math.floor(random() * (hi - lo))
}

/** The state it is shown in once it is there: a cup at the counters, else standing / sitting about */
export function staffSettledState(kind: StaffKind): { state: Agent['state']; effectKind?: EffectKind } {
  if (kind === 'coffee') return { state: 'coffee-break' }
  if (kind === 'water') return { state: 'coffee-break', effectKind: 'water' }
  return { state: 'idle' }
}

// Open floor to stroll to in each room: waypoints in the aisles, off every desk and seat
const STROLL: Partial<Record<RoomId, string[]>> = {
  'main-office': ['W-new-1', 'W-new-6', 'W-new-10', 'W-new-22', 'W-new-18', 'W-new-4'],
  'lunch-room': ['W-lunch-mid', 'W-lunch-east', 'W-lunch-west'],
  'meeting-room': ['W-meet-near-1', 'W-meet-far-1', 'W-meet-end'],
}

function waypoint(room: RoomId, id: string): Position | null {
  const wp = ROOMS[room].waypoints?.find(w => w.id === id)
  return wp ? { x: wp.x, y: wp.y } : null
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length]
}

function freeSpots(room: RoomId, taken: ReadonlySet<string>, ...types: AgentSpot['type'][]): AgentSpot[] {
  return ROOMS[room].agentSpots.filter(s => types.includes(s.type) && !taken.has(s.id))
}

function atSpot(kind: StaffKind, room: RoomId, spot: AgentSpot, status: string): StaffActivity {
  return { kind, room, target: { x: spot.x, y: spot.y }, spotId: spot.id, facing: spot.spriteFacing, status }
}

/** Lunch room seats next to somebody first (that is a chat), else any free one */
function tableSeat(room: RoomId, taken: ReadonlySet<string>, agents: readonly Agent[], random: () => number): { spot: AgentSpot; company: boolean } | null {
  const seats = freeSpots(room, taken, room === MEETING_ROOM ? 'meeting-seat' : 'lounge')
  if (seats.length === 0) return null
  const occupied = ROOMS[room].agentSpots.filter(s => agents.some(a => roomOf(a) === room && (a.visitSpotId === s.id || a.assignedSpotId === s.id)))
  const close = seats.filter(s => occupied.some(o => Math.hypot(o.x - s.x, o.y - s.y) < 12))
  return close.length > 0 ? { spot: pick(close, random), company: true } : { spot: pick(seats, random), company: false }
}

/**
 * Choose what an idle staff member does next.
 * @param agent the staff member (idle, settled)
 * @param member its roster entry
 * @param agents everyone in the office (who holds which spot, who is working)
 * @param open the rooms in use (undefined: the office alone)
 * @param random the reducer's random source
 * @returns the activity, or null to stay put a little longer
 */
export function pickStaffActivity(
  agent: Agent, member: StaffMember, agents: readonly Agent[], open: ReadonlySet<RoomId> | undefined, random: () => number,
): StaffActivity | null {
  const taken = heldSpotIds(agents as Agent[])
  // Its own spot is not taken from itself
  if (agent.visitSpotId) taken.delete(agent.visitSpotId)
  const has = (room: RoomId) => room === OFFICE_ROOM || !!open?.has(room)
  const options: { weight: number; make: () => StaffActivity | null }[] = []
  const add = (weight: number, make: () => StaffActivity | null) => options.push({ weight, make })

  const counter = (kind: 'coffee' | 'water') => () => {
    const room: RoomId = has(LUNCH_ROOM) && random() < 0.5 ? LUNCH_ROOM : OFFICE_ROOM
    const spots = freeSpots(room, taken, kind)
    return spots.length ? atSpot(kind, room, pick(spots, random), kind === 'coffee' ? t('ui.staff.coffee') : t('ui.staff.water')) : null
  }
  const stroll = () => {
    const room = roomOf(agent) in STROLL ? roomOf(agent) : OFFICE_ROOM
    const ids = STROLL[room] ?? []
    const at = ids.length ? waypoint(room, pick(ids, random)) : null
    return at ? { kind: 'wander' as const, room, target: at, status: t('ui.staff.wander') } : null
  }

  if (member.manager) {
    // A team lead: does the rounds of whoever is working, reports to the boss, plans at the whiteboard
    add(4, () => {
      const busy = agents.filter(a => a.id !== agent.id && a.state === 'working' && roomOf(a) === OFFICE_ROOM && !isIdleStaff(a))
      const boss = agents.find(a => a.role === 'boss')
      const who = busy.length > 0 ? pick(busy, random) : boss
      if (!who) return null
      const near = nearestStroll(OFFICE_ROOM, who.deskPosition)
      if (!near) return null
      const status = who === boss ? t('ui.staff.reporting', { name: who.name }) : t('ui.staff.rounds', { name: who.name })
      return { kind: 'rounds', room: OFFICE_ROOM, target: near, status }
    })
    if (has(MEETING_ROOM)) add(2, () => {
      const board = ROOMS[MEETING_ROOM].agentSpots.find(s => s.id === WHITEBOARD_SPOT)
      return board && !taken.has(board.id) ? atSpot('whiteboard', MEETING_ROOM, board, t('ui.staff.whiteboard')) : null
    })
    add(1, counter('coffee'))
    add(1, stroll)
  } else {
    if (has(LUNCH_ROOM)) add(3, () => {
      const seat = tableSeat(LUNCH_ROOM, taken, agents, random)
      return seat ? atSpot(seat.company ? 'chat' : 'lunch', LUNCH_ROOM, seat.spot, seat.company ? t('ui.staff.chat') : t('ui.staff.lunch')) : null
    })
    if (has(MEETING_ROOM)) add(1, () => {
      const seat = tableSeat(MEETING_ROOM, taken, agents, random)
      return seat?.company ? atSpot('chat', MEETING_ROOM, seat.spot, t('ui.staff.chat')) : null
    })
    add(2, counter('coffee'))
    add(2, counter('water'))
    add(2, () => {
      const desks = freeSpots(OFFICE_ROOM, taken, 'desk')
      return desks.length > STAFF_DESK_RESERVE ? atSpot('desk', OFFICE_ROOM, pick(desks, random), t('ui.staff.desk')) : null
    })
    add(1, () => {
      const printer = freeSpots(OFFICE_ROOM, taken, 'printer')
      return printer.length ? atSpot('printer', OFFICE_ROOM, printer[0], t('ui.staff.printer')) : null
    })
    add(2, stroll)
  }

  // Weighted draw; an option that cannot happen right now (full, closed) hands over to the next
  const total = options.reduce((n, o) => n + o.weight, 0)
  let roll = random() * total
  const start = Math.max(0, options.findIndex(o => (roll -= o.weight) < 0))
  for (let i = 0; i < options.length; i++) {
    const made = options[(start + i) % options.length].make()
    if (made) return made
  }
  return null
}

function nearestStroll(room: RoomId, to: Position): Position | null {
  let best: Position | null = null
  for (const id of STROLL[room] ?? []) {
    const at = waypoint(room, id)
    if (at && (!best || Math.hypot(at.x - to.x, at.y - to.y) < Math.hypot(best.x - to.x, best.y - to.y))) best = at
  }
  return best
}

/**
 * Where a staff member works when it is called in: the manager by the meeting
 * room's whiteboard when that room is open and the place is free, everyone
 * else (and the manager otherwise) at a free office desk.
 * @returns the spot, or null when every desk is taken (it waits in the lobby)
 */
export function staffWorkSpot(member: StaffMember, others: readonly Agent[], open: ReadonlySet<RoomId> | undefined, deskPick: () => AgentSpot | null): { room: RoomId; spot: AgentSpot } | null {
  if (member.manager && open?.has(MEETING_ROOM)) {
    const board = findSpot(WHITEBOARD_SPOT)
    if (board && !heldSpotIds(others as Agent[]).has(board.spot.id)) return board
  }
  const desk = deskPick()
  return desk ? { room: OFFICE_ROOM, spot: desk } : null
}

// ---------------------------------------------------------------------------
// The idle characters
// ---------------------------------------------------------------------------

/**
 * A staff member with nothing to do, standing at `at` in `room`.
 * @param member its roster entry
 * @param room where it is
 * @param at its position there
 * @param now the clock (hiredAt)
 */
export function createStaffAgent(member: StaffMember, room: RoomId, at: Position, now: number, facing?: SpriteFacing, spotId?: string): Agent {
  const cfg = AGENT_CONFIGS[member.role] ?? AGENT_CONFIGS['default']
  return {
    id: staffAgentId(member.agentType),
    name: member.name,
    type: 'subagent',
    role: member.role,
    staffType: member.agentType,
    state: 'idle',
    position: { ...at },
    targetPosition: { ...at },
    deskPosition: { ...at },
    room,
    assignedRoom: OFFICE_ROOM,
    visitSpotId: spotId,
    spriteFacing: facing ?? 'front-left',
    task: member.title,
    statusText: t('ui.staff.arrived'),
    color: cfg.color,
    emoji: cfg.emoji,
    hiredAt: now,
    pathQueue: [],
  }
}

/**
 * The whole roster in the building at once, each at its own first activity,
 * so the office is lived in from the first frame (no parade through the door).
 * @param others who is already there (the boss, the ?sim Claude): their desks are taken
 */
export function initialStaff(others: readonly Agent[], open: ReadonlySet<RoomId> | undefined, random: () => number, now: number, list: readonly StaffMember[] = roster): Agent[] {
  const placed: Agent[] = []
  for (const member of list) {
    const stand = createStaffAgent(member, OFFICE_ROOM, ROOMS[OFFICE_ROOM].entryPoint, now)
    const act = pickStaffActivity(stand, member, [...others, ...placed], open, random)
    const room = act?.room ?? OFFICE_ROOM
    const at = act?.target ?? ROOMS[OFFICE_ROOM].entryPoint
    const settled = act ? staffSettledState(act.kind) : { state: 'idle' as const }
    placed.push({
      ...createStaffAgent(member, room, at, now, act?.facing, act?.spotId),
      state: settled.state,
      effectKind: settled.effectKind,
      statusText: act?.status ?? t('ui.staff.arrived'),
    })
  }
  return placed
}
