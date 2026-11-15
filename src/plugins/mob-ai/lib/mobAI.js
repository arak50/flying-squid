'use strict'

const { Vec3 } = require('vec3')
const { GoalSelector, Control } = require('./goalSelector')
const { Navigation } = require('./navigation')
const bow = require('./bow')
const vanilla = require('./vanilla')
const { computeExplosion } = require('./explosion')

const MAX_TURN_DEG = 35 // per tick
const toByte = deg => {
  let b = Math.floor((deg % 360) * 256 / 360)
  if (b < -128) b += 256
  else if (b > 127) b -= 256
  return b
}
const wrap180 = a => ((a + 540) % 360) - 180

/**
 * Vanilla keeps goals and target goals in two separate selectors. This facade keeps the old
 * single-selector API (`add`, `isRunning`, `stopAll`, `running`) working for both: a goal that uses the
 * TARGET control flag goes into the target selector.
 */
class SelectorPair {
  constructor () {
    this.goals = new GoalSelector()
    this.targets = new GoalSelector()
  }

  add (priority, goal) { return (goal.controls & Control.TARGET ? this.targets : this.goals).add(priority, goal) }
  remove (goal) { return this.goals.remove(goal) || this.targets.remove(goal) }
  isRunning (goal) { return this.goals.isRunning(goal) || this.targets.isRunning(goal) }
  get running () { return [...this.targets.running, ...this.goals.running] }
  get entries () { return [...this.targets.entries, ...this.goals.entries] }
  stopAll () { this.targets.stopAll(); this.goals.stopAll() }
  disableControl (f) { this.goals.disableControl(f); this.targets.disableControl(f) }
  enableControl (f) { this.goals.enableControl(f); this.targets.enableControl(f) }

  /** Mob.serverAiStep: full pass on even (age + id) ticks, cheap pass in between. */
  step (full) {
    if (full) { this.targets.tick(); this.goals.tick() } else { this.targets.tickRunning(false); this.goals.tickRunning(false) }
  }
}

/**
 * Per-mob AI controller: owns the GoalSelector, Navigation and the helper API the goals use
 * (targeting, looking, attacking, sensing).
 */
class MobAI {
  constructor (manager, mob, profile) {
    this.manager = manager
    this.serv = manager.serv
    this.config = manager.config
    this.view = manager.view
    this.pathfinder = manager.pathfinder
    this.mob = mob
    this.profile = profile
    this.attributes = { ...profile.attributes }

    this.selector = new SelectorPair()
    this.nav = new Navigation(this)
    for (const [prio, make] of profile.goals) this.selector.add(prio, make(this))

    this.frozen = false
    this.ticks = 0
    this.busy = false
    this.inWater = false
    this.target = null
    this.angryTicks = 0
    this.lastAttackerPos = null
    this.provokedAt = -10
    this.sightCache = new Map() // player id -> { ok, at }
    this.sunExposed = false
    this.burnTimer = 0
    this.burning = 0 // remaining fire ticks (vanilla remainingFireTicks)
    this.lastHurtBy = null // who damaged us last (HurtByTargetGoal) and when, in AI ticks
    this.lastHurtByTick = -1000
    this.lastHurtTick = -1000 // last time we took any damage (PanicGoal)
    this.swell = 0 // creeper fuse
    this.swellDir = -1
    this.lookExpires = 0
    this.dims = this._ownDims()
    this.kb = new Vec3(0, 0, 0) // knockback velocity (blocks/s), decays over time
    this.usingTicks = -1 // >= 0 while a bow is being drawn
    this._initFlags()

    this.lookTarget = null
    this.faceDir = null
    this.yawDeg = (mob.yaw || 0) * 360 / 256
    this.pitchDeg = (mob.pitch || 0) * 360 / 256
    this.lastYawByte = null
    this.lastPitchByte = null

    mob.gravity = null // AI mobs run their own kinematics (see navigation.js)
    mob.velocity = new Vec3(0, 0, 0)
    mob.health = this.attributes.maxHealth
    if (profile.holdsBow) this._equipBow()
    this.lastHealth = mob.health
    this._hasHurtByGoal = this.selector.entries.some(e => e.goal.constructor.name === 'HurtByTargetGoal')
  }

  // ---- freeze / thaw ---------------------------------------------------------------------
  freeze () {
    this.frozen = true
    this.selector.stopAll()
    this.stopUsingItem()
    this.setAggressive(false)
    this.nav.stop()
    this.target = null
    this.lookTarget = null
    this.faceDir = null
    this.swell = 0
    this.swellDir = -1
  }

  thaw () { this.frozen = false }

  /** Frozen mobs only need to be left alone once they are standing still on the ground. */
  get settled () { return this.nav.onGround && this.nav.vy === 0 && this.kb.norm() < 0.05 }

  // ---- small helpers used by goals -------------------------------------------------------
  /**
   * Walking speed in blocks/second for a speed modifier. Profiles give either the vanilla
   * `speedAttribute` (converted with vanilla.groundSpeedBps) or a legacy `movementSpeed` in blocks/s.
   */
  speed (mul = 1) {
    const a = this.attributes
    if (a.speedAttribute !== undefined) return vanilla.groundSpeedBps(a.speedAttribute * mul)
    return a.movementSpeed * mul
  }

  requestPathBudget () { return this.manager.takePathBudget() }
  isDay () { return (this.serv.time % 24000) < 12000 }
  onVoid () { this.mob.destroy() }

  hostilesEnabled () {
    return this.manager.settings.difficulty !== 0 || this.profile.type !== 'hostile'
  }

  lookAt (vec) { this.lookTarget = vec; this.lookExpires = this.ticks + 3 }
  faceDirection (dx, dz) { this.faceDir = { dx, dz } }

  eye () { return this.mob.position.offset(0, this.profile.height * 0.85, 0) }

  isTargetablePlayer (p) {
    return !!p && p.type === 'player' && p.world === this.mob.world && p.health > 0 && (p.gameMode === 0 || p.gameMode === 2) && !!this.serv.entities[p.id]
  }

  nearestPlayer (radius) {
    let best = null
    let bd = radius
    const pos = this.mob.position
    for (const p of this.serv.players) {
      if (p.world !== this.mob.world || p.gameMode === 3) continue
      const d = p.position.distanceTo(pos)
      if (d <= bd) { bd = d; best = p }
    }
    return best
  }

  /** Visibility multiplier for a player (sneaking, mob heads): shrinks the distance mobs notice it from. */
  visibilityOf (p) {
    return vanilla.visibilityPercent({ crouching: p.crouching, headItemName: p.headItemName }, this.entityName)
  }

  /**
   * Nearest survival player the mob can notice: inside follow range scaled by visibility (never
   * below 2 blocks) and, beyond arm's reach, in line of sight. Sight is refreshed asynchronously.
   */
  findTarget () {
    if (!this.hostilesEnabled()) return null
    const range = this.attributes.followRange
    let best = null
    let bd = Infinity
    const pos = this.mob.position
    for (const p of this.serv.players) {
      if (!this.isTargetablePlayer(p)) continue
      const d = p.position.distanceTo(pos)
      if (!vanilla.inTargetRange(d, range, this.visibilityOf(p))) continue
      if (d > 2 && !this.canSee(p)) continue
      if (d < bd) { bd = d; best = p }
    }
    return best
  }

  /** Cached line of sight to `t` (re-queried every 10 ticks). Optimistic at touching distance. */
  canSee (t) {
    if (t.position.distanceTo(this.mob.position) < 1.5) return true
    const e = this.sightCache.get(t.id)
    if (!e || this.ticks - e.at >= 10) this._refreshSight(t)
    return !!this.sightCache.get(t.id).ok
  }

  _refreshSight (p) {
    const entry = this.sightCache.get(p.id) || { ok: false, at: -100 }
    entry.at = this.ticks // mark first so we do not queue the same check repeatedly
    this.sightCache.set(p.id, entry)
    this.hasLineOfSight(p).then(ok => { entry.ok = ok }, () => {})
  }

  targetValid (rangeMul = 1) {
    const t = this.target
    if (!t || !this.isTargetablePlayer(t) || !this.hostilesEnabled()) return false
    if (this.profile.type === 'neutral' && this.angryTicks <= 0) return false
    return t.position.distanceTo(this.mob.position) <= this.attributes.followRange * rangeMul
  }

  hasLineOfSight (t) {
    return this.view.lineClear(this.mob.world, this.eye(), t.position.offset(0, 1.62, 0))
  }

  /** Called when a player hits this mob (from the 'attack' event) */
  provoke (player) {
    this.provokedAt = this.ticks
    this.lastAttackerPos = player.position.clone()
    this.lastHurtBy = player
    this.lastHurtByTick = this.ticks
    this.lastHurtTick = this.ticks
    // Profiles with a HurtByTargetGoal retaliate through it. Older profiles without one get the direct behaviour.
    if (this.profile.type !== 'passive' && !this._hasHurtByGoal && this.isTargetablePlayer(player)) {
      this.target = player
      this.angryTicks = 600
    }
  }

  /** Compatibility: remaining panic ticks (vanilla panics for 40 ticks after damage, or while burning). */
  get panicTicks () { return this.burning > 0 ? Math.max(1, this.burning) : Math.max(0, 40 - (this.ticks - this.lastHurtTick)) }

  /** PanicGoal trigger: damaged within the last 40 ticks, or on fire. */
  shouldPanic () { return this.ticks - this.lastHurtTick < 40 || this.burning > 0 }

  /** Handles damage that did not come through the player attack event (fire, fall, other mods ...) */
  _watchHealth () {
    const h = this.mob.health
    if (h < this.lastHealth && this.ticks - this.provokedAt > 2) this.lastHurtTick = this.ticks
    this.lastHealth = h
  }

  ignite (seconds) { this.burning = Math.max(this.burning, Math.round(seconds * 20)) }

  _tickFire () {
    if (this.burning <= 0) return
    if (this.inWater) { this.burning = 0; return }
    this.burning--
    if (this.burning % vanilla.FIRE_DAMAGE_INTERVAL === 0) this.mob.takeDamage({ damage: 1, animation: true, damageType: 'on_fire' })
  }

  // ---- sizes, neighbours, geometry ---------------------------------------------------------------
  _ownDims () {
    const def = this.serv.registry.entities && this.serv.registry.entities[this.mob.entityType]
    this.entityName = (def && def.name) || this.profile.name || ''
    if (def && def.width && def.height) return { w: def.width, h: def.height }
    return { w: 0.6, h: this.profile.height || 1.8 }
  }

  dimsOf (e) {
    if (e === this.mob) return this.dims
    const def = this.serv.registry.entities && this.serv.registry.entities[e.entityType]
    if (def && def.width && def.height) return { w: def.width, h: def.height }
    return e.type === 'player' ? { w: 0.6, h: e.crouching ? 1.5 : 1.8 } : { w: 0.6, h: 1.8 }
  }

  /** Mob.isWithinMeleeAttackRange (hitbox inflated by ~0.83 blocks horizontally). */
  inMeleeRange (t, reach = vanilla.ATTACK_REACH) {
    return vanilla.withinMeleeRange(this.mob.position, this.dims, t.position, this.dimsOf(t), reach)
  }

  /** Nearest mob whose registry name is in `names`, within `radius` blocks. */
  nearestMob (names, radius) {
    let best = null
    let bd = radius
    const pos = this.mob.position
    for (const id of Object.keys(this.serv.entities)) {
      const e = this.serv.entities[id]
      if (e === this.mob || e.type !== 'mob' || e.world !== this.mob.world || !e.position || e.health <= 0) continue
      const def = this.serv.registry.entities && this.serv.registry.entities[e.entityType]
      if (!def || !names.has(def.name)) continue
      const d = e.position.distanceTo(pos)
      if (d <= bd) { bd = d; best = e }
    }
    return best
  }

  /** HurtByTargetGoal.alertOthers: nearby mobs of the same kind (without a target) join in. */
  alertNearby (who) {
    const range = this.attributes.followRange
    for (const id of Object.keys(this.serv.entities)) {
      const e = this.serv.entities[id]
      if (e === this.mob || e.type !== 'mob' || e.entityType !== this.mob.entityType || e.world !== this.mob.world) continue
      if (Math.abs(e.position.x - this.mob.position.x) > range || Math.abs(e.position.z - this.mob.position.z) > range || Math.abs(e.position.y - this.mob.position.y) > 10) continue
      const other = this.manager.get(e)
      if (!other || other.target || !other.isTargetablePlayer(who)) continue
      other.target = who
      if (other.profile.type === 'neutral') other.angryTicks = 600
    }
  }

  /** Spider leap: a quick hop towards (dx, dz) with vertical speed `yd` blocks/tick. */
  leap (dx, dz, yd) {
    this.nav.vy = yd * 20
    this.nav.onGround = false
    this.kb.x += dx * 8
    this.kb.z += dz * 8
  }

  attack (t) {
    const dmg = this.attributes.attackDamage === undefined ? 1 : this.attributes.attackDamage
    if (dmg <= 0) return
    const dir = t.position.minus(this.mob.position)
    const n = Math.hypot(dir.x, dir.z) || 1
    this._swing()
    t.takeDamage({
      damage: dmg,
      velocity: new Vec3((dir.x / n) * 4, 3, (dir.z / n) * 4),
      maxVelocity: new Vec3(8, 8, 8),
      animation: true,
      damageType: 'mob_attack',
      cause: this.mob
    })
  }

  difficulty () {
    const d = this.manager.settings.difficulty
    return d === undefined || d === null ? 2 : d
  }

  /**
   * AbstractSkeleton.performRangedAttack: aim at the target's lower body with a 0.2 * distance lob,
   * speed 1.6 blocks/tick, inaccuracy 14 - 4 * difficulty, base damage 2 + triangle(difficulty * 0.11, 0.57425).
   */
  shootArrow (t) {
    const projectiles = this.manager.projectiles
    if (!projectiles) return null
    const diff = Math.max(0, this.difficulty())
    const eyeHeight = this.profile.eyeHeight !== undefined ? this.profile.eyeHeight : this.profile.height * 0.85
    const mobPos = this.mob.position
    const origin = mobPos.offset(0, eyeHeight - 0.1, 0)
    const targetHeight = projectiles._dims(t).h
    const dx = t.position.x - mobPos.x
    const dz = t.position.z - mobPos.z
    const dy = t.position.y + targetHeight / 3 - origin.y
    const dist = Math.hypot(dx, dz)
    const velocity = bow.aimVelocity(new Vec3(dx, dy + dist * 0.2, dz), bow.MOB_ARROW_SPEED, 14 - diff * 4)
    const arrow = projectiles.shoot({
      owner: this.mob,
      world: this.mob.world,
      origin,
      velocity,
      baseDamage: 2.0 + bow.triangle(diff * 0.11, 0.57425),
      pickup: 'allowed'
    })
    projectiles.sound(this.mob.world, mobPos, 'entity.skeleton.shoot', { volume: 1, pitch: 1 / (Math.random() * 0.4 + 0.8), category: 5 })
    this.serv.emit('mobAi:rangedAttack', { mob: this.mob, target: t, arrow })
    return arrow
  }

  // ---- drawing a bow ("using an item") -----------------------------------------------------
  get isUsingItem () { return this.usingTicks >= 0 }

  startUsingItem () {
    if (this.usingTicks >= 0) return
    this.usingTicks = 0
    this._setUsingFlag(true)
  }

  stopUsingItem () {
    if (this.usingTicks < 0) return
    this.usingTicks = -1
    this._setUsingFlag(false)
  }

  // ---- entity flag bytes ---------------------------------------------------------------------
  // Metadata indices come from minecraft-data's per-entity `metadataKeys` (26.1 skeleton: living_entity_flags = 8,
  // mob_flags = 15), with the vanilla indices as fallback.
  //   living_entity_flags: 0x01 using item (the bow is being drawn)
  //   mob_flags:           0x01 no AI, 0x02 left handed, 0x04 aggressive
  // The client draws a skeleton's raised-bow pose (and a zombie's outstretched arms) from `aggressive`.
  _initFlags () {
    const def = this.serv.registry.entities && this.serv.registry.entities[this.mob.entityType]
    const keys = (def && def.metadataKeys) || []
    const index = (name, fallback) => { const i = keys.indexOf(name); return i === -1 ? fallback : i }
    this.flagKeys = { living: index('living_entity_flags', 8), mob: index('mob_flags', 15) }
    this.flags = { living: 0, mob: 0 }
  }

  _setFlag (which, bit, on) {
    const current = this.flags[which]
    const next = on ? (current | bit) : (current & ~bit)
    if (next === current) return
    this.flags[which] = next
    const key = this.flagKeys[which]
    const entry = { key, type: 0, value: next } // type 0 = byte
    // keep the stored metadata in step: it is what players receive when they start seeing the mob
    this.mob.metadata = (this.mob.metadata || []).filter(e => e.key !== key)
    if (next !== 0) this.mob.metadata.push(entry)
    try { this.mob.sendMetadata([entry]) } catch (e) { this.manager.debug('metadata failed: ' + e.message) }
  }

  get isAggressive () { return (this.flags.mob & 0x04) !== 0 }
  setAggressive (on) { this._setFlag('mob', 0x04, on) }
  _setUsingFlag (on) { this._setFlag('living', 0x01, on) }

  /** Give the mob its bow in the main hand and show it to players who already see the mob. */
  _equipBow () {
    const bowDef = this.serv.registry.itemsByName.bow
    if (!bowDef) return
    const item = new this.manager.Item(bowDef.id, 1)
    this.mob.equipment = this.mob.equipment || []
    this.mob.equipment[0] = item // players that see the mob later get it from the stock spawn code
    try {
      this.mob._writeOthersNearby('entity_equipment', { entityId: this.mob.id, equipments: [{ slot: 0, item: this.manager.Item.toNotch(item) }] })
    } catch (e) { this.manager.debug('equipment failed: ' + e.message) }
  }

  _swing () {
    try { this.mob._writeOthersNearby('animation', { entityId: this.mob.id, animation: 0 }) } catch { /* version without this packet shape */ }
  }

  // ---- world sensing -----------------------------------------------------------------------
  async inSunlight () {
    if (!this.isDay() || this.inWater) return false
    const p = this.mob.position
    return this.view.skyExposed(this.mob.world, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 40)
  }

  async findShade () {
    const p = this.mob.position
    const w = this.mob.world
    for (let i = 0; i < 14; i++) {
      const x = Math.floor(p.x + (Math.random() * 2 - 1) * 10)
      const z = Math.floor(p.z + (Math.random() * 2 - 1) * 10)
      const s = await this.view.findStandable(w, x, Math.floor(p.y), z, 3, this.profile.height > 1 ? 2 : 1)
      if (s && !(await this.view.skyExposed(w, s.x, s.y, s.z, 40))) return new Vec3(s.x + 0.5, s.y, s.z + 0.5)
    }
    return null
  }

  async randomStandablePos (horizontal = 10, vertical = 3) {
    const p = this.mob.position
    const w = this.mob.world
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(p.x + (Math.random() * 2 - 1) * horizontal)
      const z = Math.floor(p.z + (Math.random() * 2 - 1) * horizontal)
      const s = await this.view.findStandable(w, x, Math.floor(p.y), z, Math.min(vertical, 3), this.profile.height > 1 ? 2 : 1)
      if (s) return new Vec3(s.x + 0.5, s.y, s.z + 0.5)
    }
    return null
  }

  /** Like randomStandablePos but only accepts spots further from `from` than the mob is now. */
  async randomStandablePosAway (from, horizontal = 5, vertical = 4) {
    const p = this.mob.position
    const w = this.mob.world
    const here = Math.hypot(p.x - from.x, p.z - from.z)
    let best = null
    let bestD = here
    for (let i = 0; i < 8; i++) {
      const x = Math.floor(p.x + (Math.random() * 2 - 1) * horizontal)
      const z = Math.floor(p.z + (Math.random() * 2 - 1) * horizontal)
      const s = await this.view.findStandable(w, x, Math.floor(p.y), z, Math.min(vertical, 3), this.profile.height > 1 ? 2 : 1)
      if (!s) continue
      const d = Math.hypot(s.x + 0.5 - from.x, s.z + 0.5 - from.z)
      if (d > bestD) { bestD = d; best = new Vec3(s.x + 0.5, s.y, s.z + 0.5) }
    }
    return best || this.randomStandablePos(horizontal, vertical)
  }

  // ---- creeper -------------------------------------------------------------------------------
  setSwellDir (dir) {
    if (dir === this.swellDir) return
    this.swellDir = dir
    this._sendSwellDir(dir)
  }

  _sendSwellDir (dir) {
    const def = this.serv.registry.entities && this.serv.registry.entities[this.mob.entityType]
    const key = ((def && def.metadataKeys) || []).indexOf('swell_dir')
    if (key === -1) return
    const entry = { key, type: 1, value: dir } // type 1 = varint
    this.mob.metadata = (this.mob.metadata || []).filter(e => e.key !== key)
    this.mob.metadata.push(entry)
    try { this.mob.sendMetadata([entry]) } catch (e) { this.manager.debug('swell metadata failed: ' + e.message) }
  }

  _tickCreeper () {
    if (!this.profile.explodes || !this.config.creeperExplosions) return
    if (this.swellDir > 0 && this.swell === 0) {
      this.manager.projectiles?.sound(this.mob.world, this.mob.position, 'entity.creeper.primed', { volume: 1, pitch: 0.5, category: 5 })
    }
    this.swell = Math.max(0, this.swell + this.swellDir)
    if (this.swell >= 30) {
      this.swell = 30
      this.explode(3).catch(err => this.manager.debug('explosion failed: ' + err.message))
    }
  }

  /**
   * Vanilla explosion centred on the mob. Entities are always hurt; blocks are only destroyed when
   * `config.creeperBlockDamage` is on (off by default).
   */
  async explode (radius) {
    if (this._exploded) return
    this._exploded = true
    const world = this.mob.world
    const center = this.mob.position.clone()
    const registry = this.serv.registry
    const entities = []
    for (const id of Object.keys(this.serv.entities)) {
      const e = this.serv.entities[id]
      if (e === this.mob || !e.position || e.world !== world || e.health <= 0) continue
      if (e.type !== 'player' && e.type !== 'mob') continue
      if (e.type === 'player' && (e.gameMode === 1 || e.gameMode === 3)) continue
      if (e.position.distanceTo(center) > radius * 2 + 3) continue
      const other = e.type === 'mob' ? this.manager.get(e) : null
      entities.push({ ref: e, pos: e.position.clone(), ...this.dimsOf(e), kbr: other ? other.attributes.knockbackResistance : 0 })
    }
    const resistanceAt = async (x, y, z) => {
      const id = await world.getBlockType(new Vec3(x, y, z))
      const def = registry.blocks[id]
      if (!def || def.name === 'air' || def.name === 'cave_air' || def.name === 'void_air') return null
      return def.resistance !== undefined ? def.resistance : 0
    }
    const result = await computeExplosion({
      center,
      radius,
      resistanceAt,
      lineClear: (a, b) => this.view.lineClear(world, a, b),
      entities,
      breakBlocks: !!this.config.creeperBlockDamage
    })
    for (const h of result.hits) {
      h.ref.takeDamage({
        damage: h.damage,
        velocity: h.knockback.scaled(10),
        maxVelocity: new Vec3(12, 12, 12),
        animation: true,
        damageType: 'explosion',
        cause: this.mob
      })
    }
    for (const b of result.blocks) {
      try { await this.serv.setBlock(world, b, 0) } catch (e) { this.manager.debug('setBlock failed: ' + e.message) }
    }
    this.manager.projectiles?.sound(world, center, 'entity.generic.explode', { volume: 4, pitch: 1, category: 5 })
    this.serv.emit('mobAi:explosion', { mob: this.mob, center, radius, hits: result.hits.length, blocks: result.blocks.length })
    this.mob.destroy()
  }

  // ---- ticking -----------------------------------------------------------------------------
  /** Take over velocity added by the stock combat code (knockback) and run it through our kinematics. */
  absorbVelocity () {
    const v = this.mob.velocity
    if (v && (v.x !== 0 || v.y !== 0 || v.z !== 0)) {
      this.kb.x += v.x
      this.kb.z += v.z
      if (v.y > 0) this.nav.vy = Math.max(this.nav.vy, v.y)
      v.x = 0; v.y = 0; v.z = 0
    }
  }

  async tick (dt) {
    if (this.busy) return
    this.busy = true
    try {
      this.ticks++
      if (this.usingTicks >= 0) this.usingTicks++
      this.absorbVelocity()
      this._watchHealth()
      if (this.angryTicks > 0 && --this.angryTicks === 0 && this.profile.type === 'neutral') this.target = null
      if (this.target && !this.targetValid(2)) this.target = null

      if (this.ticks > this.lookExpires) this.lookTarget = null
      this.faceDir = null
      this.selector.step(vanilla.isFullTick(this.ticks, this.mob.id))
      this._tickCreeper()
      this._tickFire()

      const idle = !this.nav.strafeCmd && !this.nav.path && !this.nav.pending && this.nav.onGround && this.nav.vy === 0 && this.kb.norm() < 0.05
      if (!idle || this.ticks % 10 === 0 || this.shouldPanic()) await this.nav.update(dt)

      await this._updateLook(dt)
      await this._sunBurn()
    } finally {
      this.busy = false
    }
  }

  /** Let a frozen mob finish falling / sliding without running any goals. */
  async settle (dt) {
    if (this.busy) return
    this.busy = true
    try {
      this.absorbVelocity()
      await this.nav.update(dt)
    } finally {
      this.busy = false
    }
  }

  /**
   * Zombie/skeleton sun burn: with open sky in daylight each tick has a (brightness - 0.4) * 2 / 30
   * chance to set the mob alight for 8 seconds (which then burns for 1 damage per second).
   */
  async _sunBurn () {
    if (!this.profile.burnsInSun || !this.config.undeadBurnInSun) return
    if (++this.burnTimer >= 20) {
      this.burnTimer = 0
      this.sunExposed = await this.inSunlight()
    }
    if (this.sunExposed && this.isDay() && Math.random() < vanilla.sunBurnChance(1)) this.ignite(vanilla.IGNITE_SECONDS)
  }

  async _updateLook (dt) {
    let wantYaw = null
    let wantPitch = 0
    if (this.lookTarget) {
      const e = this.eye()
      const dx = this.lookTarget.x - e.x
      const dz = this.lookTarget.z - e.z
      const dy = this.lookTarget.y - e.y
      wantYaw = Math.atan2(-dx, dz) * 180 / Math.PI
      wantPitch = -Math.atan2(dy, Math.hypot(dx, dz) || 1) * 180 / Math.PI
    } else if (this.faceDir && (this.faceDir.dx || this.faceDir.dz)) {
      wantYaw = Math.atan2(-this.faceDir.dx, this.faceDir.dz) * 180 / Math.PI
    }
    if (wantYaw === null) return
    const turn = MAX_TURN_DEG * Math.max(1, dt * 20)
    const dyaw = wrap180(wantYaw - this.yawDeg)
    this.yawDeg += Math.max(-turn, Math.min(turn, dyaw))
    this.pitchDeg += Math.max(-20, Math.min(20, wantPitch - this.pitchDeg))

    const yawByte = toByte(this.yawDeg)
    const pitchByte = toByte(this.pitchDeg)
    if (yawByte === this.lastYawByte && pitchByte === this.lastPitchByte) return
    this.lastYawByte = yawByte
    this.lastPitchByte = pitchByte
    this.mob.yaw = yawByte
    this.mob.pitch = pitchByte
    try {
      this.mob._writeOthersNearby('entity_look', { entityId: this.mob.id, yaw: yawByte, pitch: pitchByte, onGround: this.mob.onGround !== false })
      this.mob._writeOthersNearby('entity_head_rotation', { entityId: this.mob.id, headYaw: yawByte })
    } catch (e) {
      this.manager.debug('look packet failed: ' + e.message)
    }
  }
}

module.exports = { MobAI }
