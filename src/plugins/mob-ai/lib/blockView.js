'use strict'

const { Vec3 } = require('vec3')

// Bit flags describing a block cell for AI purposes.
const Cell = Object.freeze({
  AIR: 0,
  SOLID: 1, // blocks movement (has a full collision box)
  WATER: 2, // swimmable liquid / underwater plants
  DANGER: 4, // mobs avoid standing in or on it (lava, fire, cactus, ...)
  UNKNOWN: 8 // could not be read (unloaded chunk, error); treated as solid, never walkable
})

const WATER_BLOCKS = new Set(['water', 'flowing_water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])
const DANGER_BLOCKS = new Set([
  'lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'magma', 'cactus', 'sweet_berry_bush',
  'campfire', 'soul_campfire', 'wither_rose', 'powder_snow', 'cobweb', 'web',
  'nether_portal', 'portal', 'end_portal', 'end_gateway'
])

/**
 * Cached, async view over a world's blocks.
 * Many mobs ask about the same cells every tick, so lookups are cached for a short
 * time (two generations of `ttlTicks`) and `tick()` must be called once per server tick.
 */
class BlockView {
  constructor (registry, { ttlTicks = 40 } = {}) {
    this.registry = registry
    this.ttl = ttlTicks
    this.ticks = 0
    this.worlds = new WeakMap()
    this.idCache = new Map()
  }

  tick () { this.ticks++ }

  get generation () { return Math.floor(this.ticks / this.ttl) }

  _cacheFor (world) {
    let c = this.worlds.get(world)
    const gen = this.generation
    if (!c) {
      c = { gen, cur: new Map(), prev: new Map() }
      this.worlds.set(world, c)
    } else if (c.gen !== gen) {
      c.prev = gen - c.gen === 1 ? c.cur : new Map()
      c.cur = new Map()
      c.gen = gen
    }
    return c
  }

  _cellOfId (id) {
    let v = this.idCache.get(id)
    if (v !== undefined) return v
    const b = this.registry.blocks[id]
    if (!b) v = Cell.UNKNOWN | Cell.SOLID
    else {
      v = Cell.AIR
      if (b.boundingBox === 'block') v |= Cell.SOLID
      if (WATER_BLOCKS.has(b.name)) v |= Cell.WATER
      if (DANGER_BLOCKS.has(b.name)) v |= Cell.DANGER
    }
    this.idCache.set(id, v)
    return v
  }

  /** @returns {Promise<number>} Cell bit flags of the block at integer coordinates. */
  async cell (world, x, y, z) {
    if (y > 400) return Cell.AIR
    const c = this._cacheFor(world)
    const key = x + ',' + y + ',' + z
    let v = c.cur.get(key)
    if (v !== undefined) return v
    v = c.prev.get(key)
    if (v === undefined) {
      try {
        v = this._cellOfId(await world.getBlockType(new Vec3(x, y, z)))
      } catch {
        v = Cell.UNKNOWN | Cell.SOLID
      }
    }
    c.cur.set(key, v)
    return v
  }

  async isSolid (world, x, y, z) { return ((await this.cell(world, x, y, z)) & Cell.SOLID) !== 0 }

  /** Cell a mob can occupy: not solid and not harmful. */
  async isFree (world, x, y, z) {
    const c = await this.cell(world, x, y, z)
    return (c & (Cell.SOLID | Cell.DANGER)) === 0
  }

  /**
   * Can a mob of `height` blocks stand with its feet in cell (x, y, z)?
   * Needs: solid harmless floor below, free cells for the body.
   */
  async standable (world, x, y, z, height = 2) {
    const floor = await this.cell(world, x, y - 1, z)
    if ((floor & Cell.SOLID) === 0 || (floor & (Cell.DANGER | Cell.UNKNOWN)) !== 0) return false
    for (let h = 0; h < height; h++) {
      if (!(await this.isFree(world, x, y + h, z))) return false
    }
    return true
  }

  /** Nearest standable feet position in the column (x, z) around y, or null. */
  async findStandable (world, x, y, z, range = 4, height = 2) {
    for (let d = 0; d <= range; d++) {
      if (await this.standable(world, x, y + d, z, height)) return new Vec3(x, y + d, z)
      if (d > 0 && await this.standable(world, x, y - d, z, height)) return new Vec3(x, y - d, z)
    }
    return null
  }

  /** True when nothing solid sits above (x, y, z) up to `limit` blocks: the sun can reach it. */
  async skyExposed (world, x, y, z, limit = 48) {
    for (let dy = 2; dy <= limit; dy++) {
      if (((await this.cell(world, x, y + dy, z)) & Cell.SOLID) !== 0) return false
    }
    return true
  }

  /** Coarse line-of-sight: no solid cell between `from` and `to` (both in world coordinates). */
  async lineClear (world, from, to) {
    const delta = to.minus(from)
    const dist = delta.norm()
    if (dist < 0.5) return true
    const steps = Math.ceil(dist / 0.5)
    const step = delta.scaled(1 / steps)
    const p = from.clone()
    for (let i = 1; i < steps; i++) {
      p.add(step)
      if (await this.isSolid(world, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) return false
    }
    return true
  }
}

module.exports = { BlockView, Cell }
