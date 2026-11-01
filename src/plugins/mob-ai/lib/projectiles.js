'use strict'

const { Vec3 } = require('vec3')
const UUID = require('uuid-1345')
const { Cell } = require('./blockView')
const bow = require('./bow')

const KNOCKBACK = 8 // blocks/s, vanilla hurt knockback of 0.4 blocks/tick
const OWNER_GRACE_TICKS = 5 // an arrow cannot hit its shooter right after leaving the bow
const SHAKE_TICKS = 7 // a freshly stuck arrow cannot be picked up for this long
const PICKUP_ORDER = [...Array(9).keys()].map(i => 36 + i).concat([...Array(27).keys()].map(i => 9 + i)) // hotbar, then main inventory

/** Entry fraction t (0..1) of the segment o + t*d into the box, or null. A start inside the box gives 0. */
function segmentAabb (o, d, min, max) {
  let t0 = 0
  let t1 = 1
  for (const a of ['x', 'y', 'z']) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < min[a] || o[a] > max[a]) return null
    } else {
      let ta = (min[a] - o[a]) / d[a]
      let tb = (max[a] - o[a]) / d[a]
      if (ta > tb) [ta, tb] = [tb, ta]
      t0 = Math.max(t0, ta)
      t1 = Math.min(t1, tb)
      if (t0 > t1) return null
    }
  }
  return t0
}

/**
 * Arrow entities with vanilla flight and hit rules:
 *  - each tick: move by the velocity, then velocity *= 0.99 (0.6 in water) and vy -= 0.05
 *  - swept collision against blocks (voxel walk) and entities (their box grown by 0.3)
 *  - damage = ceil(speed * baseDamage), critical arrows add a random bonus
 *  - arrows stick into blocks, fall again if the block disappears, despawn after `arrowLifetime` ticks
 *  - stuck arrows can be picked up by players
 * The stock entity physics is bypassed: arrow entities have no `size`, which makes entities.js skip them.
 */
class ProjectileManager {
  constructor (serv, view, config) {
    this.serv = serv
    this.view = view
    this.config = config
    this.arrows = new Map() // entity id -> arrow record
    this.burning = new Map() // entity id -> { entity, ticks, next }
    this.Item = require('prismarine-item')(serv.registry)
    const arrow = serv.registry.entitiesByName.arrow
    this.arrowEntityId = arrow && arrow.id
    const arrowItem = serv.registry.itemsByName.arrow
    this.arrowItemId = arrowItem && arrowItem.id
    this.sound = require('./sounds').createSounds(serv)
  }

  get count () { return this.arrows.size }

  // ---- spawning -----------------------------------------------------------------------------
  /**
   * @param {object} o
   * @param {object|null} o.owner  the shooter entity (player or mob)
   * @param {object} o.world
   * @param {Vec3} o.origin
   * @param {Vec3} o.velocity      blocks per tick
   * @param {number} [o.baseDamage=2]
   * @param {boolean} [o.critical=false]
   * @param {number} [o.punch=0]
   * @param {boolean} [o.flame=false]
   * @param {'allowed'|'creative'|'disallowed'} [o.pickup='allowed']
   * @returns {object|null} the arrow record, or null when the entity limit stopped it
   */
  shoot ({ owner = null, world, origin, velocity, baseDamage = 2, critical = false, punch = 0, flame = false, pickup = 'allowed' }) {
    if (this.arrowEntityId === undefined) return null
    let entity
    try {
      entity = this.serv.initEntity('object', this.arrowEntityId, world, origin.clone())
    } catch (e) {
      if (this.config.debug) this.serv.info?.(`[mob-ai] arrow not spawned: ${e.message}`)
      return null // e.g. 'Too many mobs !' (max-entities)
    }
    const { yaw, pitch } = bow.arrowAngles(velocity)
    entity.uuid = UUID.v4()
    entity.name = 'arrow'
    entity.velocity = velocity.scaled(20) // core wants blocks/second for the spawn packet; entity.size stays unset on purpose
    entity.yaw = Math.round(yaw * 256 / 360)
    entity.pitch = Math.round(pitch * 256 / 360)
    entity.headPitch = 0
    entity.data = owner ? owner.id : 0
    entity.metadata = []
    entity.updateAndSpawn()

    const a = {
      entity,
      owner,
      world,
      pos: origin.clone(),
      vel: velocity.clone(),
      baseDamage,
      critical,
      punch,
      flame,
      pickup,
      age: 0,
      stuck: false,
      stuckTicks: 0,
      shake: 0,
      stuckCell: null
    }
    this.arrows.set(entity.id, a)
    this.serv.emit('arrowShot', { arrow: a, owner })
    return a
  }

  // ---- ticking ------------------------------------------------------------------------------
  async tick () {
    const work = []
    for (const a of this.arrows.values()) {
      work.push(this._tickArrow(a).catch(err => {
        this._remove(a)
        this.serv.err?.(`[mob-ai] arrow failed: ${err.stack || err}`)
      }))
    }
    await Promise.all(work)
    this._tickBurning()
  }

  async _tickArrow (a) {
    if (!this.serv.entities[a.entity.id]) { this.arrows.delete(a.entity.id); return } // destroyed elsewhere
    if (a.stuck) return this._tickStuck(a)

    a.age++
    if (a.age > this.config.arrowLifetime || a.pos.y < -64) return this._remove(a)

    const from = a.pos
    const d = a.vel
    const blockHit = await this._rayBlocks(a.world, from, d)
    const entityHit = this._rayEntities(a, from, d, blockHit ? blockHit.t : 1)

    if (entityHit) {
      const consumed = await this._hitEntity(a, entityHit.entity, entityHit.t)
      if (consumed) return
      return // deflected off an invulnerable target: it keeps its new (reversed) velocity next tick
    }
    if (blockHit) return this._stick(a, blockHit)

    const to = from.plus(d)
    a.pos = to
    const cell = await this.view.cell(a.world, Math.floor(to.x), Math.floor(to.y), Math.floor(to.z))
    const drag = (cell & Cell.WATER) ? bow.ARROW_DRAG_WATER : bow.ARROW_DRAG_AIR
    a.vel = d.scaled(drag)
    a.vel.y -= bow.ARROW_GRAVITY
    a.entity.velocity = a.vel.scaled(20)
    await a.entity.sendPosition(a.pos.clone(), false)
  }

  // ---- collision ----------------------------------------------------------------------------
  /** First solid cell on the segment (voxel walk). Returns { t, point, cell } or null. */
  async _rayBlocks (world, from, d) {
    const view = this.view
    let x = Math.floor(from.x)
    let y = Math.floor(from.y)
    let z = Math.floor(from.z)
    if (await view.isSolid(world, x, y, z)) return { t: 0, point: from.clone(), cell: [x, y, z] }

    const step = { x: Math.sign(d.x), y: Math.sign(d.y), z: Math.sign(d.z) }
    const next = (p, c, dd) => dd > 0 ? (c + 1 - p) / dd : dd < 0 ? (p - c) / -dd : Infinity
    const delta = a => d[a] !== 0 ? Math.abs(1 / d[a]) : Infinity
    let tx = next(from.x, x, d.x)
    let ty = next(from.y, y, d.y)
    let tz = next(from.z, z, d.z)
    const dx = delta('x')
    const dy = delta('y')
    const dz = delta('z')

    for (let i = 0; i < 64; i++) {
      const t = Math.min(tx, ty, tz)
      if (t > 1) return null
      if (t === tx) { x += step.x; tx += dx } else if (t === ty) { y += step.y; ty += dy } else { z += step.z; tz += dz }
      if (await view.isSolid(world, x, y, z)) return { t, point: from.plus(d.scaled(t)), cell: [x, y, z] }
    }
    return null
  }

  _dims (e) {
    const def = this.serv.registry.entities && this.serv.registry.entities[e.entityType]
    if (def && def.width && def.height) return { w: def.width, h: def.height }
    return e.type === 'player' ? { w: 0.6, h: 1.8 } : { w: 0.6, h: 1.8 }
  }

  _rayEntities (a, from, d, tMax) {
    const reach = d.norm() + 4
    let best = null
    for (const id of Object.keys(this.serv.entities)) {
      const e = this.serv.entities[id]
      if (e === a.entity || e.world !== a.world || !e.position) continue
      if (e.type !== 'player' && e.type !== 'mob') continue
      if (e === a.owner && a.age < OWNER_GRACE_TICKS) continue
      if (e.health <= 0 || (e.type === 'player' && e.gameMode === 3)) continue
      if (e.position.distanceTo(from) > reach) continue
      const { w, h } = this._dims(e)
      const g = 0.3 // vanilla grows the target's box by 0.3
      const min = new Vec3(e.position.x - w / 2 - g, e.position.y - g, e.position.z - w / 2 - g)
      const max = new Vec3(e.position.x + w / 2 + g, e.position.y + h + g, e.position.z + w / 2 + g)
      const t = segmentAabb(from, d, min, max)
      if (t !== null && t <= tMax && (!best || t < best.t)) best = { entity: e, t }
    }
    return best
  }

  // ---- hits ---------------------------------------------------------------------------------
  /** @returns {Promise<boolean>} true when the arrow was used up */
  async _hitEntity (a, target, t) {
    const point = a.pos.plus(a.vel.scaled(t))
    if (target.type === 'player' && target.gameMode === 1) {
      // creative players cannot be hurt: the arrow bounces off
      a.vel = a.vel.scaled(-0.1)
      a.pos = point
      a.entity.velocity = a.vel.scaled(20)
      await a.entity.sendPosition(a.pos.clone(), false)
      return false
    }

    const speed = a.vel.norm()
    const damage = bow.arrowDamage(speed, a.baseDamage, a.critical)
    const h = Math.hypot(a.vel.x, a.vel.z) || 1
    const nx = a.vel.x / h
    const nz = a.vel.z / h
    const push = KNOCKBACK + a.punch * 12 // Punch adds 0.6 blocks/tick per level
    target.takeDamage({
      damage,
      velocity: new Vec3(nx * push, KNOCKBACK, nz * push),
      maxVelocity: new Vec3(24, 24, 24),
      animation: true,
      damageType: 'arrow',
      cause: a.owner || null,
      direct: a.entity
    })
    if (a.flame) this.ignite(target, 100)

    this.sound(a.world, point, 'entity.arrow.hit', { volume: 1, pitch: 1.2 / (Math.random() * 0.2 + 0.9), category: 7 })
    if (a.owner && a.owner.type === 'player' && a.owner !== target) {
      this.sound(a.world, a.owner.position, 'entity.arrow.hit_player', { volume: 0.18, pitch: 0.45, category: 7, whitelist: [a.owner] })
    }
    if (a.owner && a.owner.type === 'player' && target.type === 'mob') this.serv.mobAI?.get(target)?.provoke(a.owner)

    this.serv.emit('arrowHit', { arrow: a, owner: a.owner, target, damage, critical: a.critical })
    this._remove(a)
    return true
  }

  async _stick (a, hit) {
    const speed = a.vel.norm() || 1
    a.pos = hit.point.minus(a.vel.scaled(0.05 / speed)) // vanilla leaves it 0.05 in front of the surface
    a.stuck = true
    a.shake = SHAKE_TICKS
    a.stuckTicks = 0
    a.stuckCell = hit.cell
    // the entity keeps its impact velocity so a client that spawns it later (or still simulates it) re-collides and embeds it
    a.entity.velocity = a.vel.scaled(20)
    await a.entity.sendPosition(a.pos.clone(), false)
    this._sendVelocity(a.entity, a.vel)
    this.sound(a.world, a.pos, 'entity.arrow.hit', { volume: 1, pitch: 1.2 / (Math.random() * 0.2 + 0.9), category: 4 })
    this.serv.emit('arrowStuck', { arrow: a })
  }

  _sendVelocity (entity, v) {
    const scaled = v.scaled(8000).floored()
    try {
      entity._writeNearby('entity_velocity', { entityId: entity.id, velocity: v, velocityX: scaled.x, velocityY: scaled.y, velocityZ: scaled.z })
    } catch { /* packet shape differs on other versions */ }
  }

  async _tickStuck (a) {
    a.stuckTicks++
    if (a.shake > 0) a.shake--
    if (a.stuckTicks >= this.config.arrowLifetime) return this._remove(a)

    if (a.stuckTicks % 5 === 0) {
      const [x, y, z] = a.stuckCell
      if (((await this.view.cellFresh(a.world, x, y, z)) & Cell.SOLID) === 0) {
        // the block it was stuck in is gone: it drops again
        a.stuck = false
        a.vel = new Vec3(a.vel.x * Math.random() * 0.2, a.vel.y * Math.random() * 0.2, a.vel.z * Math.random() * 0.2)
        a.entity.velocity = a.vel.scaled(20)
        return
      }
    }
    if (a.shake <= 0) this._tryPickup(a)
  }

  // ---- pickup -------------------------------------------------------------------------------
  _tryPickup (a) {
    if (a.pickup === 'disallowed') return
    for (const p of this.serv.players) {
      if (p.world !== a.world || p.health <= 0 || p.gameMode === 3 || !p.inventory) continue
      if (a.pickup === 'creative' && p.gameMode !== 1) continue
      const dx = p.position.x - a.pos.x
      const dz = p.position.z - a.pos.z
      const dy = a.pos.y - p.position.y
      if (dx * dx + dz * dz > 1.0 || dy < -0.5 || dy > 2.3) continue
      if (p.gameMode !== 1 && !this._giveArrow(p)) continue // creative players do not need the item
      try {
        a.entity._writeOthersNearby('collect', { collectedEntityId: a.entity.id, collectorEntityId: p.id, pickupItemCount: 1 })
      } catch { /* packet shape */ }
      this.sound(a.world, a.pos, 'entity.item.pickup', { volume: 0.2, pitch: (Math.random() - Math.random()) * 1.4 + 2, category: 7 })
      this.serv.emit('arrowPickup', { arrow: a, player: p })
      this._remove(a)
      return
    }
  }

  /** Put one arrow item into the player's inventory (existing stack first). */
  _giveArrow (player) {
    const inv = player.inventory
    for (const slot of PICKUP_ORDER) {
      const item = inv.slots[slot]
      if (item && item.type === this.arrowItemId && item.count < item.stackSize) {
        item.count++
        inv.updateSlot(slot, item)
        return true
      }
    }
    const empty = inv.firstEmptyInventorySlot()
    if (empty === null || empty === undefined || empty === -1) return false
    inv.updateSlot(empty, new this.Item(this.arrowItemId, 1))
    return true
  }

  // ---- fire (Flame) -------------------------------------------------------------------------
  ignite (entity, ticks) {
    this.burning.set(entity.id, { entity, ticks, next: 20 })
  }

  _tickBurning () {
    for (const [id, b] of this.burning) {
      const e = b.entity
      if (!this.serv.entities[id] || e.health <= 0 || --b.ticks <= 0) { this.burning.delete(id); continue }
      if (--b.next <= 0) {
        b.next = 20
        e.takeDamage({ damage: 1, animation: true, damageType: 'on_fire' }) // fire does 1 damage per second
      }
    }
  }

  // ---- cleanup ------------------------------------------------------------------------------
  _remove (a) {
    this.arrows.delete(a.entity.id)
    if (this.serv.entities[a.entity.id]) {
      try { this.serv.destroyEntity(a.entity) } catch { /* already gone */ }
    }
  }

  clear () { for (const a of [...this.arrows.values()]) this._remove(a) }
}

module.exports = { ProjectileManager, segmentAabb }
