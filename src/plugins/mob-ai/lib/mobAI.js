'use strict'

const { Vec3 } = require('vec3')
const { GoalSelector } = require('./goalSelector')
const { Navigation } = require('./navigation')
const bow = require('./bow')

const MAX_TURN_DEG = 35 // per tick
const toByte = deg => {
  let b = Math.floor((deg % 360) * 256 / 360)
  if (b < -128) b += 256
  else if (b > 127) b -= 256
  return b
}
const wrap180 = a => ((a + 540) % 360) - 180

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

    this.selector = new GoalSelector({ startInterval: 2 })
    this.nav = new Navigation(this)
    for (const [prio, make] of profile.goals) this.selector.add(prio, make(this))

    this.frozen = false
    this.ticks = 0
    this.busy = false
    this.inWater = false
    this.target = null
    this.panicTicks = 0
    this.angryTicks = 0
    this.lastAttackerPos = null
    this.provokedAt = -10
    this.sightCache = new Map() // player id -> { ok, at }
    this.sunExposed = false
    this.burnTimer = 0
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
  }

  thaw () { this.frozen = false }

  /** Frozen mobs only need to be left alone once they are standing still on the ground. */
  get settled () { return this.nav.onGround && this.nav.vy === 0 && this.kb.norm() < 0.05 }

  // ---- small helpers used by goals -------------------------------------------------------
  speed (mul = 1) { return this.attributes.movementSpeed * mul }
  requestPathBudget () { return this.manager.takePathBudget() }
  isDay () { return (this.serv.time % 24000) < 12000 }
  onVoid () { this.mob.destroy() }

  hostilesEnabled () {
    return this.manager.settings.difficulty !== 0 || this.profile.type !== 'hostile'
  }

  lookAt (vec) { this.lookTarget = vec }
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

  /** Nearest survival player in follow range that the mob can see. Sight is refreshed asynchronously. */
  findTarget () {
    if (!this.hostilesEnabled()) return null
    const range = this.attributes.followRange
    let best = null
    let bd = range
    const pos = this.mob.position
    for (const p of this.serv.players) {
      if (!this.isTargetablePlayer(p)) continue
      const d = p.position.distanceTo(pos)
      if (d > bd) continue
      const sight = this.sightCache.get(p.id)
      if (d > 6 && !(sight && sight.ok && this.ticks - sight.at < 40)) {
        if (!sight || this.ticks - sight.at >= 10) this._refreshSight(p)
        continue
      }
      bd = d
      best = p
    }
    return best
  }

  _refreshSight (p) {
    const entry = this.sightCache.get(p.id) || { ok: false, at: -100 }
    entry.at = this.ticks // mark first so we do not queue the same check repeatedly
    this.sightCache.set(p.id, entry)
    this.hasLineOfSight(p).then(ok => { entry.ok = ok })
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
    if (this.profile.type === 'passive') {
      this.panicTicks = 80
    } else if (this.isTargetablePlayer(player)) {
      this.target = player
      this.angryTicks = 600
    }
  }

  /** Handles damage that did not come through the player attack event (fire, fall, other mods ...) */
  _watchHealth () {
    const h = this.mob.health
    if (h < this.lastHealth && this.ticks - this.provokedAt > 2 && this.profile.type === 'passive') this.panicTicks = 60
    this.lastHealth = h
  }

  attack (t) {
    const dmg = this.attributes.attackDamage || 1
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
   * speed 1.6 blocks/tick, inaccuracy 14 - 4 * difficulty, base damage 2 + triangle(difficulty * 0.11, 0.57).
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
      baseDamage: 2.0 + bow.triangle(diff * 0.11, 0.57),
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

      this.lookTarget = null
      this.faceDir = null
      this.selector.tick()

      const idle = !this.nav.strafeCmd && !this.nav.path && !this.nav.pending && this.nav.onGround && this.nav.vy === 0 && this.kb.norm() < 0.05
      if (!idle || this.ticks % 10 === 0 || this.panicTicks > 0) await this.nav.update(dt)

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

  async _sunBurn () {
    if (!this.profile.burnsInSun || !this.config.undeadBurnInSun) return
    if (++this.burnTimer < 20) return
    this.burnTimer = 0
    this.sunExposed = await this.inSunlight()
    if (this.sunExposed) this.mob.takeDamage({ damage: 1, animation: true, damageType: 'on_fire' })
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
