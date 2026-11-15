'use strict'

const { boxOf, boxesIntersect } = require('./vanilla')

/**
 * Entity-vs-entity collision, the way vanilla does it: there is no hard collision, overlapping entities
 * shove each other apart a little every tick (LivingEntity.pushEntities -> Entity.push), and a crowd of
 * `maxEntityCramming` or more hurts the ones inside it. Cross-checked against Horizon's mobs/ai.rs.
 */

const PUSH_STRENGTH = 0.05 // blocks/tick per overlapping neighbour at full strength
const MIN_SEPARATION = 0.01 // pairs closer than this on both axes are left alone (no direction to push in)
const CRAMMING_DAMAGE = 6

/**
 * Entity.push(other): velocity (blocks/tick, x and z) to ADD to the entity at `selfPos`; the other entity gets
 * the negative of it. Strength falls off with distance (1 / sqrt(max axis distance), capped at 1) and is
 * scaled by 0.05. Returns null when the two are on top of each other.
 */
function pushImpulse (selfPos, otherPos) {
  let xa = selfPos.x - otherPos.x
  let za = selfPos.z - otherPos.z
  let dd = Math.max(Math.abs(xa), Math.abs(za))
  if (dd < MIN_SEPARATION) return null
  dd = Math.sqrt(dd)
  xa /= dd
  za /= dd
  const pow = Math.min(1 / dd, 1)
  return { x: xa * pow * PUSH_STRENGTH, z: za * pow * PUSH_STRENGTH }
}

/** LivingEntity.pushEntities cramming rule: a quarter of the ticks, with `limit` or more others around. */
function crammingHurts (neighbours, limit, rand = Math.random) {
  return limit > 0 && neighbours > limit - 1 && Math.floor(rand() * 4) === 0
}

/**
 * Spatial hash of pushable entities. Rebuilt once per server tick; a query returns the entries whose box
 * overlaps the given box. An entry is { ref, world, pos, w, h, ai? } (ai = its MobAI when it has one).
 */
class PushGrid {
  constructor (cell = 2) {
    this.cell = cell
    this.worlds = new Map() // world -> Map("cx,cz" -> entry[])
  }

  rebuild (entries) {
    this.worlds = new Map()
    for (const e of entries) {
      e.box = boxOf(e.pos, e.w, e.h)
      let cells = this.worlds.get(e.world)
      if (!cells) { cells = new Map(); this.worlds.set(e.world, cells) }
      for (const key of this._keys(e.box)) {
        const list = cells.get(key)
        if (list) list.push(e)
        else cells.set(key, [e])
      }
    }
  }

  _keys (box) {
    const c = this.cell
    const keys = []
    for (let x = Math.floor(box.minX / c); x <= Math.floor(box.maxX / c); x++) {
      for (let z = Math.floor(box.minZ / c); z <= Math.floor(box.maxZ / c); z++) keys.push(x + ',' + z)
    }
    return keys
  }

  query (world, box) {
    const cells = this.worlds.get(world)
    if (!cells) return []
    const seen = new Set()
    const out = []
    for (const key of this._keys(box)) {
      const list = cells.get(key)
      if (!list) continue
      for (const e of list) {
        if (seen.has(e)) continue
        seen.add(e)
        if (boxesIntersect(box, e.box)) out.push(e)
      }
    }
    return out
  }
}

module.exports = { PUSH_STRENGTH, CRAMMING_DAMAGE, pushImpulse, crammingHurts, PushGrid }
