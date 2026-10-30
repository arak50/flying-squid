'use strict'
// The two teleport raycasts. Ported from Skyblocker (PredictiveSmoothAOTE.raycast / TeleportOverlay), which itself
// mirrors Hypixel's server-side behaviour. `info(x, y, z)` is async and returns { air, through, floor } (see blocks.js).

const { Vec3 } = require('vec3')

/** Minecraft look vector for a yaw/pitch in degrees. */
function lookVector (yaw, pitch) {
  const y = yaw * Math.PI / 180
  const p = pitch * Math.PI / 180
  return new Vec3(-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p))
}

const f = Math.floor

/**
 * Instant Transmission. Walks the ray one block at a time (as Hypixel does), stopping before the first block that
 * can't be teleported through or whose head-height block is blocked. Returns the vector from `start` (the eye) to the
 * last good sample, or null when the teleport can't happen at all (blocked at the very start).
 */
async function raycastInstant (info, distance, dir, start) {
  const xd = dir.x > 0 ? 1 : -1
  const zd = dir.z > 0 ? 1 : -1
  const floorAt = async (x, y, z) => (await info(x, y, z)).floor
  const through = async (x, y, z) => (await info(x, y, z)).through
  let closeFloorY = Infinity

  for (let offset = 0; offset <= distance; offset++) {
    const pos = start.plus(dir.scaled(offset))
    const cx = f(pos.x); const cy = f(pos.y); const cz = f(pos.z)

    if (!(await through(cx, cy, cz))) {
      if (offset === 0) return null
      return dir.scaled(offset - 1)
    }

    if (!(await through(cx, cy + 1, cz))) {
      if (offset === 0) {
        const just = start.plus(dir.scaled(0.2))
        if ((just.y - f(just.y)) <= 0.495) continue // starting low: ignore the head block for the first step
        return null
      }
      return dir.scaled(offset - 1)
    }

    // Hypixel's diagonal-wall quirk: only blocks in some directions (Skyblocker emulates it the same way)
    if (offset !== 0 && dir.x < 0 && await floorAt(cx + 1, cy, cz)) {
      const prev = pos.minus(dir)
      if (await floorAt(f(prev.x), f(prev.y), f(prev.z) + zd)) return dir.scaled(offset - 1)
    }
    if (offset !== 0 && dir.z < 0 && dir.x < 0 && await floorAt(cx, cy, cz + 1)) {
      const prev = pos.minus(dir)
      if (await floorAt(f(prev.x) + xd, f(prev.y), f(prev.z))) return dir.scaled(offset - 1)
    }

    // close to a floor (incl. diagonally): remember it and finish once the ray drops to that level
    if (((await floorAt(cx, cy - 1, cz)) || ((await floorAt(cx + xd, cy - 1, cz)) && (await floorAt(cx, cy - 1, cz + zd)))) &&
        (pos.y - f(pos.y)) < 0.31) {
      closeFloorY = cy - 1
    }
    if (closeFloorY === cy) return dir.scaled(offset - 1)
  }

  // full distance, no collision. Hypixel moves the destination a block down when there is no floor under it.
  const end = start.plus(dir.scaled(distance))
  if (!(await floorAt(f(end.x), f(end.y - 1), f(end.z)))) return dir.scaled(distance).minus(new Vec3(0, 1, 0))
  return dir.scaled(distance)
}

/**
 * Instant Transmission destination (feet position) or null. Hypixel snaps to x.5 / z.5 and drops the player to
 * ceil(eyeY) - 1 — verified against the packet capture (see test/replay-capture.js).
 */
async function instantDestination (info, { pos, eyeHeight, yaw, pitch, distance }) {
  const dir = lookVector(yaw, pitch)
  const start = pos.offset(0, eyeHeight, 0)
  const vec = await raycastInstant(info, distance, dir, start)
  // a zero-length result means the very first step is blocked: nothing to teleport through (and without this, spamming
  // the item at a wall would nudge the player up a block each time)
  if (!vec || vec.norm() < 1) return null
  const end = start.plus(vec)
  return new Vec3(Math.round(end.x - 0.5) + 0.5, Math.ceil(end.y) - 1, Math.round(end.z - 0.5) + 0.5)
}

/**
 * Ether Transmission: exact voxel traversal (Amanatides & Woo) from the eye to the first block that can't be passed
 * through, within `range`. Returns { target: {x,y,z}, dest: Vec3 } or { error }.
 * Landing rules (Skyblocker TeleportOverlay + capture): the two blocks above the target must be air; the player
 * stands on top of the target at x.5, y+1(+0.05), z.5.
 */
async function etherDestination (info, { pos, eyeHeight, yaw, pitch, range, landingYOffset = 0.05 }) {
  const dir = lookVector(yaw, pitch)
  const o = pos.offset(0, eyeHeight, 0)
  let x = f(o.x); let y = f(o.y); let z = f(o.z)
  const step = { x: Math.sign(dir.x), y: Math.sign(dir.y), z: Math.sign(dir.z) }
  const tDelta = {
    x: dir.x === 0 ? Infinity : Math.abs(1 / dir.x),
    y: dir.y === 0 ? Infinity : Math.abs(1 / dir.y),
    z: dir.z === 0 ? Infinity : Math.abs(1 / dir.z)
  }
  const frac = (v, s, c) => s === 0 ? Infinity : (s > 0 ? (c + 1 - v) : (v - c)) // distance to the next boundary
  const tMax = {
    x: tDelta.x * frac(o.x, step.x, x),
    y: tDelta.y * frac(o.y, step.y, y),
    z: tDelta.z * frac(o.z, step.z, z)
  }
  if (!(await info(x, y, z)).through) return { error: 'inside_block' }

  let t = 0
  while (true) {
    // advance to the next block along the ray
    if (tMax.x <= tMax.y && tMax.x <= tMax.z) { t = tMax.x; tMax.x += tDelta.x; x += step.x } else if (tMax.y <= tMax.z) { t = tMax.y; tMax.y += tDelta.y; y += step.y } else { t = tMax.z; tMax.z += tDelta.z; z += step.z }
    if (t > range) return { error: 'no_target' }
    if (!(await info(x, y, z)).through) break
  }
  if (!(await info(x, y + 1, z)).air || !(await info(x, y + 2, z)).air) return { error: 'blocked', target: { x, y, z } }
  return { target: { x, y, z }, dest: new Vec3(x + 0.5, y + 1 + landingYOffset, z + 0.5) }
}

module.exports = { lookVector, raycastInstant, instantDestination, etherDestination }
