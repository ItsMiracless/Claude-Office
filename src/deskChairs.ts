/**
 * deskChairs.ts - a swivel chair at every desk, and who sits in one.
 *
 * The main office's desks are drawn without chairs, so each desk spot
 * (src/rooms.ts, type 'desk') gets one here, built from the spot itself: it
 * stands where the person works and is turned the way they face (the spot's
 * spriteFacing). Moving a spot with /?helper moves its chair with it.
 *
 * Layering follows the meeting room (rooms.ts meet-chair-*): someone facing
 * away from us (rear-*) sits behind the chair's backrest, so the chair is one
 * step above the spot's z; someone facing us (front-*) sits in front of
 * theirs, so it is one step below. The character itself is lifted onto the
 * seat by Character.tsx (the `seated` prop, office.css .seated) while it is
 * at a seat whose type is in SEATED_SPOT_TYPES.
 */

import type { AgentSpot, FurnitureItem, SpriteFacing } from './rooms'

/**
 * Spot types a character sits at (a chair is drawn there) rather than stands.
 * Only desks for now: the lunch room's and meeting room's chairs are part of
 * their backdrops, and a sitter lifted there floated over the seat.
 */
export const SEATED_SPOT_TYPES: ReadonlySet<AgentSpot['type']> = new Set(['desk'])

/** The chair sprite (src/assets.ts) for each way a sitter can face */
export const DESK_CHAIR_SPRITE: Readonly<Record<SpriteFacing, string>> = {
  'front-left': 'desk-chair-front-left',
  'front-right': 'desk-chair-front-right',
  'rear-left': 'desk-chair-rear-left',
  'rear-right': 'desk-chair-rear-right',
}

/**
 * Where a chair stands relative to its spot (% of the room), so the seat is
 * under the sitter and not under their feet: the chair's wheels are a little
 * behind the person, i.e. away from the desk they face.
 * Measured on /?sim screenshots of the 754 px stage.
 */
export const DESK_CHAIR_OFFSET: Readonly<Record<SpriteFacing, { dx: number; dy: number }>> = {
  'front-left': { dx: 0.3, dy: -0.6 },
  'front-right': { dx: -0.3, dy: -0.6 },
  'rear-left': { dx: 0.3, dy: -0.5 },
  'rear-right': { dx: -0.3, dy: -0.5 },
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** Whether someone at a spot facing this way has the chair's backrest between them and us */
export function backToViewer(facing: SpriteFacing): boolean {
  return facing.startsWith('rear')
}

/** The chair for one desk spot, or null for a spot that is not a desk */
export function deskChairFor(spot: AgentSpot): FurnitureItem | null {
  if (spot.type !== 'desk') return null
  const facing: SpriteFacing = spot.spriteFacing ?? 'front-right'
  const z = spot.zIndex ?? Math.round(spot.y)
  const { dx, dy } = DESK_CHAIR_OFFSET[facing]
  return {
    id: `chair-${spot.id}`,
    type: 'desk-chair',
    sprite: DESK_CHAIR_SPRITE[facing],
    x: round1(spot.x + dx),
    y: round1(spot.y + dy),
    zIndex: backToViewer(facing) ? z + 1 : z - 1,
  }
}

/** A chair for every desk spot of a room, in spot order */
export function deskChairs(spots: readonly AgentSpot[]): FurnitureItem[] {
  return spots.map(deskChairFor).filter((c): c is FurnitureItem => c !== null)
}

/**
 * How a desk chair is built, in px of the 754 px stage.
 * `backrest`: the top of a backrest seen from behind, above the sitter's spot
 * (desk-chair-rear-*: 36 px tall, its base 2-3 px behind the spot).
 * `seat`: the seat's height, the least a sitter is lifted.
 * `faceUs`: how high a sitter facing us is lifted. They sit behind the desk,
 * whose monitors would otherwise hide all of them (spot-3, spot-10): lifted
 * this far their head and shoulders clear the screens, as a seated person's
 * do. Their chair and legs are behind the desk, so the lift does not show.
 */
export const SEAT_GEOMETRY: Readonly<Record<string, { backrest: number; seat: number; faceUs: number }>> = {
  desk: { backrest: 38, seat: 15, faceUs: 30 },
}

/** Share of a sitter's body the backrest hides when they sit with their back to us */
export const BACKREST_COVER = 0.45

/**
 * How far to lift a sitter's sprite onto the seat (px).
 * Facing away, the lift puts the backrest's top BACKREST_COVER of the way up
 * their body, whatever their height (the cast runs from 24 to 42 px), so a
 * short character is not lost behind it nor a tall one floating over it;
 * the clamp only keeps the extremes sensible. Facing us, see `faceUs`.
 * @param spotType the seat's spot type (SEATED_SPOT_TYPES)
 * @param backToUs whether the sitter faces away from us (rear-*)
 * @param bodyPx the visible height of the sprite's figure, if measured
 */
export function seatLift(spotType: string, backToUs: boolean, bodyPx?: number): number {
  const g = SEAT_GEOMETRY[spotType] ?? SEAT_GEOMETRY.desk
  if (!backToUs) return g.faceUs
  const body = bodyPx && bodyPx > 0 ? bodyPx : 33
  return Math.round(Math.min(g.backrest - 10, Math.max(g.seat, g.backrest - BACKREST_COVER * body)))
}
