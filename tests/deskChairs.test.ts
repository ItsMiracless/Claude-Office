/**
 * src/deskChairs.ts — a swivel chair at every desk of the main office, laid
 * out from the desk spots themselves, and how high a sitter is lifted.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ASSETS } from '../src/assets'
import {
  backToViewer,
  DESK_CHAIR_SPRITE,
  deskChairFor,
  deskChairs,
  SEAT_GEOMETRY,
  SEATED_SPOT_TYPES,
  seatLift,
} from '../src/deskChairs'
import { OFFICE_ROOM, ROOMS, type AgentSpot } from '../src/rooms'

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))
const MAIN = ROOMS[OFFICE_ROOM]
const DESKS = MAIN.agentSpots.filter(s => s.type === 'desk')
const CHAIRS = deskChairs(MAIN.agentSpots)

describe('deskChairs', () => {
  it('puts exactly one chair at every desk spot, and none elsewhere', () => {
    expect(DESKS.length).toBeGreaterThan(0)
    expect(CHAIRS).toHaveLength(DESKS.length)
    expect(CHAIRS.map(c => c.id)).toEqual(DESKS.map(s => `chair-${s.id}`))
    expect(new Set(CHAIRS.map(c => c.id)).size).toBe(CHAIRS.length)
    for (const spot of MAIN.agentSpots.filter(s => s.type !== 'desk')) {
      expect(deskChairFor(spot)).toBeNull()
    }
  })

  it('turns each chair the way its sitter faces', () => {
    for (const spot of DESKS) {
      const chair = deskChairFor(spot)!
      expect(chair.sprite).toBe(DESK_CHAIR_SPRITE[spot.spriteFacing ?? 'front-right'])
    }
  })

  it('draws the backrest over a sitter facing away and behind one facing us', () => {
    for (const spot of DESKS) {
      const chair = deskChairFor(spot)!
      const z = spot.zIndex ?? Math.round(spot.y)
      if (backToViewer(spot.spriteFacing ?? 'front-right')) expect(chair.zIndex).toBeGreaterThan(z)
      else expect(chair.zIndex).toBeLessThan(z)
    }
  })

  it('stands each chair right at its spot', () => {
    for (const spot of DESKS) {
      const chair = deskChairFor(spot)!
      expect(Math.abs(chair.x - spot.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(chair.y - spot.y)).toBeLessThanOrEqual(1)
    }
  })

  it('follows a moved spot', () => {
    const moved: AgentSpot = { ...DESKS[0], x: DESKS[0].x + 10, y: DESKS[0].y + 5 }
    const chair = deskChairFor(moved)!
    expect(chair.x).toBeCloseTo(deskChairFor(DESKS[0])!.x + 10, 5)
    expect(chair.y).toBeCloseTo(deskChairFor(DESKS[0])!.y + 5, 5)
  })

  it('has every chair sprite in ASSETS and on disk', () => {
    for (const key of Object.values(DESK_CHAIR_SPRITE)) {
      const asset = ASSETS[key]
      expect(asset, key).toBeDefined()
      expect(asset.category).toBe('furniture')
      expect(existsSync(PUBLIC + asset.path), asset.path).toBe(true)
    }
  })

  it('seats people at desks only', () => {
    expect([...SEATED_SPOT_TYPES]).toEqual(['desk'])
  })
})

describe('seatLift', () => {
  it('lifts a sitter facing us clear of the seat, the same for everyone', () => {
    expect(seatLift('desk', false)).toBe(SEAT_GEOMETRY.desk.faceUs)
    expect(seatLift('desk', false)).toBeGreaterThanOrEqual(SEAT_GEOMETRY.desk.seat)
    expect(seatLift('desk', false)).toBeLessThanOrEqual(40)
    expect(seatLift('desk', false, 24)).toBe(seatLift('desk', false, 42))
  })

  it('keeps a sitter facing away within sensible bounds for the whole cast', () => {
    for (let body = 20; body <= 50; body++) {
      const lift = seatLift('desk', true, body)
      expect(lift).toBeGreaterThanOrEqual(SEAT_GEOMETRY.desk.seat)
      expect(lift).toBeLessThanOrEqual(SEAT_GEOMETRY.desk.backrest)
      expect(lift).toBeLessThanOrEqual(40)
    }
    const fallback = seatLift('desk', true)
    expect(fallback).toBeGreaterThan(0)
    expect(fallback).toBeLessThanOrEqual(40)
  })

  it('lifts a shorter sitter facing away higher, so the backrest does not hide them', () => {
    let prev = Infinity
    for (let body = 20; body <= 50; body++) {
      const lift = seatLift('desk', true, body)
      expect(lift).toBeLessThanOrEqual(prev)
      prev = lift
    }
    expect(seatLift('desk', true, 24)).toBeGreaterThan(seatLift('desk', true, 42))
  })

  it('falls back to the desk geometry for an unknown seat type', () => {
    expect(seatLift('nowhere', true, 30)).toBe(seatLift('desk', true, 30))
  })
})
