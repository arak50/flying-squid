'use strict'

/**
 * Vanilla bow / arrow numbers. Everything here is pure so it can be unit tested.
 * Speeds are in blocks per tick (vanilla's unit); one tick = 1/20 s.
 */

const { Vec3 } = require('vec3')

const MAX_INT = 2147483647
const ARROW_GRAVITY = 0.05 // blocks / tick^2
const ARROW_DRAG_AIR = 0.99
const ARROW_DRAG_WATER = 0.6
const FULL_DRAW_SPEED = 3.0 // blocks / tick at full draw
const MOB_ARROW_SPEED = 1.6 // skeletons
const MIN_POWER = 0.1 // a bow released with less power than this does not fire

/** BowItem.getPowerForTime: ticks the bow was drawn -> 0..1 (reaches 1.0 at 20 ticks). */
function powerForTicks (ticks) {
  let f = ticks / 20
  f = (f * f + f * 2) / 3
  return f > 1 ? 1 : f
}

/**
 * AbstractArrow damage on hit: ceil(speed * baseDamage), and a critical hit adds
 * a random 0 .. floor(damage / 2) + 2 (inclusive).
 */
function arrowDamage (speed, baseDamage, critical, rand = Math.random) {
  let dmg = Math.ceil(Math.min(speed * baseDamage, MAX_INT))
  if (critical) dmg = Math.min(dmg + Math.floor(rand() * (Math.floor(dmg / 2) + 3)), MAX_INT)
  return dmg
}

/** Triangular distribution around `center` with maximum deviation `maxDev` (vanilla RandomSource.triangle). */
const triangle = (center, maxDev, rand = Math.random) => center + maxDev * (rand() - rand())

/** Unit vector for vanilla yaw / pitch degrees (yaw 0 faces +z, positive pitch looks down). */
function directionFromAngles (yawDeg, pitchDeg) {
  const yaw = yawDeg * Math.PI / 180
  const pitch = pitchDeg * Math.PI / 180
  const c = Math.cos(pitch)
  return new Vec3(-Math.sin(yaw) * c, -Math.sin(pitch), Math.cos(yaw) * c)
}

/**
 * Projectile.shoot: normalise, add random spread (0.0172275 * divergence per axis, triangular), scale by speed.
 * Players use divergence 1.0; skeletons 14 - 4 * difficulty.
 */
function aimVelocity (direction, speed, divergence, rand = Math.random) {
  const len = Math.hypot(direction.x, direction.y, direction.z) || 1
  const spread = 0.0172275 * divergence
  return new Vec3(
    direction.x / len + triangle(0, spread, rand),
    direction.y / len + triangle(0, spread, rand),
    direction.z / len + triangle(0, spread, rand)
  ).scaled(speed)
}

/** Arrow rotation in degrees as vanilla keeps it (yaw = atan2(vx, vz), pitch = atan2(vy, horizontal)). */
function arrowAngles (vel) {
  return {
    yaw: Math.atan2(vel.x, vel.z) * 180 / Math.PI,
    pitch: Math.atan2(vel.y, Math.hypot(vel.x, vel.z)) * 180 / Math.PI
  }
}

/** Enchantment levels of a bow item as { power, punch, flame, infinity }, tolerating whatever the item exposes. */
function bowEnchants (item) {
  const out = { power: 0, punch: 0, flame: 0, infinity: 0 }
  let list = []
  try { list = (item && item.enchants) || [] } catch { list = [] }
  for (const e of list) {
    const name = String(e.name || '').replace(/^minecraft:/, '')
    if (name in out) out[name] = Number(e.lvl ?? e.level ?? 1) || 0
  }
  return out
}

/** Base damage of an arrow fired from a bow: 2.0, +0.5 * level + 0.5 with Power. */
const baseDamageForPower = level => 2.0 + (level > 0 ? level * 0.5 + 0.5 : 0)

module.exports = {
  ARROW_GRAVITY,
  ARROW_DRAG_AIR,
  ARROW_DRAG_WATER,
  FULL_DRAW_SPEED,
  MOB_ARROW_SPEED,
  MIN_POWER,
  powerForTicks,
  arrowDamage,
  triangle,
  directionFromAngles,
  aimVelocity,
  arrowAngles,
  bowEnchants,
  baseDamageForPower
}
