'use strict'
/**
 * The drop animation as captured: the item stand gets a sync_entity_position every tick; y moves 0.01 per tick in a triangle wave
 * between -0.2 and +0.2 of its spawn height (one tick held at each end, so a period is 82 ticks), and yaw turns 2 degrees per tick.
 * The name stand does not move.
 */
const STEP = 0.01; const LIMIT = 0.2; const SPIN = 2

function createBob (yaw0 = 0) {
  let off = 0; let dir = 1; let yaw = yaw0
  return {
    /** Advance one tick -> { dy, yaw } (yaw in degrees, as sync_entity_position wants it). */
    step () {
      const next = Math.round((off + dir * STEP) * 100) / 100
      if (Math.abs(next) > LIMIT + 1e-9) dir = -dir; else off = next
      yaw = (yaw + SPIN) % 360
      return { dy: off, yaw }
    }
  }
}

// Stand heights relative to the floor the item lies on (the dungeon floor is y 69 in the capture): [item stand, name stand]
const OFFSET = { head: [-0.71875, -0.46875], held: [-0.5, -0.46875] }

module.exports = { createBob, OFFSET, STEP, LIMIT, SPIN }
