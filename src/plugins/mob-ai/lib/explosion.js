'use strict'

const { Vec3 } = require('vec3')

/**
 * Vanilla explosion algorithm (cross-checked against Horizon's game/explosion.rs):
 *
 *  1. Cast 16 * 16 * 16 shell rays from the centre. Each ray starts with `radius * (0.7 + 0.6 * random)`
 *     power and walks in 0.3 block steps. Every step costs 0.225, plus (resistance + 0.3) * 0.3 for
 *     the block it is inside. Blocks reached while power is still above zero are destroyed.
 *  2. Entities within 2 * radius are hurt by  floor((i * i + i) / 2 * 7 * diameter + 1)  where
 *     i = (1 - distance / diameter) * exposure, and pushed away by  i * (1 - knockbackResistance).
 *
 * World access is injected so the maths can be tested without a server:
 *   resistanceAt(x, y, z)  -> number | null   (null = air, no cost besides the step)
 *   lineClear(from, to)    -> Promise<boolean> (used for exposure)
 */

const STEP = 0.3

async function collectBlocks (center, radius, resistanceAt, random = Math.random) {
  const cache = new Map()
  const resist = async (x, y, z) => {
    const k = `${x},${y},${z}`
    if (!cache.has(k)) cache.set(k, await resistanceAt(x, y, z))
    return cache.get(k)
  }

  const destroyed = new Map()
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      for (let k = 0; k < 16; k++) {
        if (i !== 0 && i !== 15 && j !== 0 && j !== 15 && k !== 0 && k !== 15) continue
        let dx = (i / 15) * 2 - 1
        let dy = (j / 15) * 2 - 1
        let dz = (k / 15) * 2 - 1
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
        dx = (dx / len) * STEP; dy = (dy / len) * STEP; dz = (dz / len) * STEP
        let x = center.x; let y = center.y; let z = center.z
        let power = radius * (0.7 + random() * 0.6)
        while (power > 0) {
          const bx = Math.floor(x); const by = Math.floor(y); const bz = Math.floor(z)
          const r = await resist(bx, by, bz)
          if (r !== null && r !== undefined) {
            power -= (r + 0.3) * STEP
            if (power > 0) destroyed.set(`${bx},${by},${bz}`, new Vec3(bx, by, bz))
          }
          power -= 0.225
          x += dx; y += dy; z += dz
        }
      }
    }
  }
  return [...destroyed.values()]
}

/** Fraction (0..1) of a grid of points on the entity's box that can see the explosion centre. */
async function exposure (center, box, lineClear) {
  const sx = 1 / ((box.maxX - box.minX) * 2 + 1)
  const sy = 1 / ((box.maxY - box.minY) * 2 + 1)
  const sz = 1 / ((box.maxZ - box.minZ) * 2 + 1)
  if (sx < 0 || sy < 0 || sz < 0) return 0
  const ox = (1 - Math.floor(1 / sx) * sx) / 2
  const oz = (1 - Math.floor(1 / sz) * sz) / 2
  let seen = 0
  let total = 0
  for (let fx = 0; fx <= 1; fx += sx) {
    for (let fy = 0; fy <= 1; fy += sy) {
      for (let fz = 0; fz <= 1; fz += sz) {
        const p = new Vec3(
          box.minX + (box.maxX - box.minX) * fx + ox,
          box.minY + (box.maxY - box.minY) * fy,
          box.minZ + (box.maxZ - box.minZ) * fz + oz
        )
        if (await lineClear(p, center)) seen++
        total++
      }
    }
  }
  return total === 0 ? 0 : seen / total
}

/**
 * @param {object} o
 * @param {Vec3} o.center
 * @param {number} o.radius
 * @param {Function} o.resistanceAt
 * @param {Function} o.lineClear
 * @param {Array<{ref:any,pos:Vec3,w:number,h:number,eyeHeight?:number,kbr?:number}>} o.entities
 * @param {boolean} [o.breakBlocks=true] when false no block list is produced (entities are still hurt)
 * @returns {Promise<{blocks: Vec3[], hits: Array<{ref:any,damage:number,knockback:Vec3,impact:number}>}>}
 */
async function computeExplosion ({ center, radius, resistanceAt, lineClear, entities = [], breakBlocks = true, random = Math.random }) {
  const blocks = breakBlocks ? await collectBlocks(center, radius, resistanceAt, random) : []
  const diameter = radius * 2
  const hits = []
  for (const e of entities) {
    const eye = new Vec3(e.pos.x, e.pos.y + (e.eyeHeight !== undefined ? e.eyeHeight : e.h * 0.85), e.pos.z)
    const dist = Math.sqrt((e.pos.x - center.x) ** 2 + ((e.pos.y + e.h / 2) - center.y) ** 2 + (e.pos.z - center.z) ** 2) / diameter
    if (dist > 1) continue
    let dir = eye.minus(center)
    const n = dir.norm()
    if (n === 0) continue
    dir = dir.scaled(1 / n)
    const half = e.w / 2
    const box = { minX: e.pos.x - half, minY: e.pos.y, minZ: e.pos.z - half, maxX: e.pos.x + half, maxY: e.pos.y + e.h, maxZ: e.pos.z + half }
    const seen = await exposure(center, box, lineClear)
    const impact = (1 - dist) * seen
    if (impact <= 0) continue
    const damage = Math.floor(((impact * impact + impact) / 2) * 7 * diameter + 1)
    const knock = impact * (1 - (e.kbr || 0))
    hits.push({ ref: e.ref, damage, impact, knockback: dir.scaled(knock) })
  }
  return { blocks, hits }
}

module.exports = { computeExplosion, collectBlocks, exposure }
