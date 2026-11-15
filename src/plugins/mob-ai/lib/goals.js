'use strict'

const { Vec3 } = require('vec3')
const { Goal, Control } = require('./goalSelector')
const { reducedTickDelay, withinMeleeRange } = require('./vanilla')

const rand = (a, b) => a + Math.random() * (b - a)
const randInt = (a, b) => Math.floor(rand(a, b + 1))

/**
 * Goals ported from vanilla behaviour (cross-checked against Horizon's goals.rs).
 *
 * Timers are counted in *goal ticks*. A goal that is not `requiresUpdateEveryTick` is ticked every
 * second server tick, so its delays go through `adjustedTickDelay` (halved) to keep the same wall time.
 *
 * Vanilla priorities (lower = more important), e.g. a pig:
 *   0 Float, 1 Panic(1.25), 3 Breed, 4 Tempt, 5 FollowParent, 6 Stroll, 7 LookAtPlayer, 8 RandomLookAround
 */

// ---------------------------------------------------------------------------------------------
/** FloatGoal: keep swimming up while in water. Ticked every tick. */
class SwimGoal extends Goal {
  constructor (mob) { super(mob, Control.JUMP) }
  get requiresUpdateEveryTick () { return true }
  canStart () { return this.mob.inWater }
  tick () { this.mob.nav.swimUp = true }
}

// ---------------------------------------------------------------------------------------------
/**
 * PanicGoal. Panics for 40 ticks after the last damage (or while on fire), running to a random
 * spot (5 blocks, 4 vertical); when it arrives and is still in panic it picks another one.
 * Speed modifiers by species (vanilla): cow 2.0, pig/sheep 1.25, chicken 1.4, rabbit 2.2.
 * `config.panicFleesAttacker` additionally biases the flight away from whoever hit it.
 */
class PanicGoal extends Goal {
  constructor (mob, speed = 1.25) {
    super(mob, Control.MOVE)
    this.speedMul = speed
    this.picking = false
  }

  canStart () { return !this.picking && this.mob.shouldPanic() }
  shouldContinue () { return this.picking || this.mob.nav.isMoving }
  stop () { this.picking = false; this.mob.nav.stop() }

  start () {
    const ai = this.mob
    this.picking = true
    const from = ai.config.panicFleesAttacker ? ai.lastAttackerPos : null
    const pick = from ? ai.randomStandablePosAway(from, 5, 4) : ai.randomStandablePos(5, 4)
    pick.then(spot => {
      this.picking = false
      if (spot && ai.selector.isRunning(this)) ai.nav.moveTo(spot, ai.speed(this.speedMul))
    }).catch(() => { this.picking = false })
  }
}

// ---------------------------------------------------------------------------------------------
/** TargetGoal base shared by the two targeting goals: range + line of sight with unseen memory. */
class TargetGoal extends Goal {
  constructor (mob, { mustSee = true, memory = 60 } = {}) {
    super(mob, Control.TARGET)
    this.mustSee = mustSee
    this.memory = memory
    this.unseen = 0
  }

  canContinueTarget () {
    const ai = this.mob
    const t = ai.target
    if (!t || !ai.isTargetablePlayer(t) || !ai.hostilesEnabled()) return false
    if (ai.profile.type === 'neutral' && ai.angryTicks <= 0) return false
    if (t.position.distanceTo(ai.mob.position) > ai.attributes.followRange) return false
    if (this.mustSee) {
      if (ai.canSee(t)) this.unseen = 0
      else if (++this.unseen > this.adjustedTickDelay(this.memory)) return false
    }
    return true
  }

  shouldContinue () { return this.canContinueTarget() }
  start () { this.unseen = 0 }
  stop () { if (this.mob.target && !this.canContinueTarget()) this.mob.target = null }
}

/**
 * NearestAttackableTargetGoal: 1 in reduced(10) full ticks it looks for the nearest visible player in
 * follow range (scaled by sneaking / mob-head visibility, never below 2 blocks).
 */
class NearestAttackableTargetGoal extends TargetGoal {
  constructor (mob, opts = {}) {
    super(mob, { mustSee: opts.mustSee !== false, memory: 60 })
    this.randomInterval = opts.interval === undefined ? 10 : opts.interval
    this.found = null
  }

  canStart () {
    const ai = this.mob
    if (ai.target) return false
    if (this.randomInterval > 0 && randInt(0, this.adjustedTickDelay(this.randomInterval) - 1) !== 0) return false
    if (ai.profile.neutralInDay && ai.isDay() && ai.angryTicks <= 0) return false
    this.found = ai.findTarget()
    return !!this.found
  }

  start () { this.mob.target = this.found; super.start() }
  stop () { this.mob.target = null }
}

/**
 * HurtByTargetGoal: retaliate against whoever damaged the mob last. Remembers the attacker for 300
 * ticks without seeing it. `alertOthers` also turns nearby mobs of the same kind against it.
 */
class HurtByTargetGoal extends TargetGoal {
  constructor (mob, { alertOthers = false } = {}) {
    super(mob, { mustSee: true, memory: 300 })
    this.alertOthers = alertOthers
    this.stamp = -1
  }

  canStart () {
    const ai = this.mob
    const who = ai.lastHurtBy
    return !!who && ai.lastHurtByTick !== this.stamp && ai.isTargetablePlayer(who) && ai.hostilesEnabled()
  }

  start () {
    const ai = this.mob
    ai.target = ai.lastHurtBy
    this.stamp = ai.lastHurtByTick
    super.start()
    if (ai.profile.type === 'neutral') ai.angryTicks = Math.max(ai.angryTicks, 600)
    if (this.alertOthers) ai.alertNearby(ai.lastHurtBy)
  }

  stop () { this.mob.target = null }
}

// ---------------------------------------------------------------------------------------------
/**
 * MeleeAttackGoal. Re-paths every 4-10 ticks (more when far away), attacks once the 20 tick cooldown
 * is over and the target is inside the mob's attack box (hitbox + 0.83 blocks horizontally).
 * Ticked every tick. canUse is throttled to once per 20 ticks.
 */
class MeleeAttackGoal extends Goal {
  constructor (mob, speed = 1.0, followEvenIfNotSeen = false) {
    super(mob, Control.MOVE | Control.LOOK)
    this.speedMul = speed
    this.followEvenIfNotSeen = followEvenIfNotSeen
    this.lastCanUse = -100
    this.repath = 0
    this.cooldown = 0
    this.pathedTo = null
  }

  get requiresUpdateEveryTick () { return true }

  canStart () {
    const ai = this.mob
    if (ai.ticks - this.lastCanUse < 20) return false
    this.lastCanUse = ai.ticks
    return ai.targetValid()
  }

  shouldContinue () { return this.mob.targetValid(1) }

  start () {
    this.repath = 0
    this.cooldown = 0
    this.pathedTo = null
    this.mob.setAggressive(true)
  }

  stop () {
    const ai = this.mob
    ai.setAggressive(false)
    ai.nav.stop()
    if (!ai.targetValid(1)) ai.target = null
  }

  tick () {
    const ai = this.mob
    const t = ai.target
    if (!t) return
    ai.lookAt(t.position.offset(0, 1.62, 0))
    this.repath--

    const seen = this.followEvenIfNotSeen || ai.canSee(t)
    if (seen && this.repath <= 0 && (!this.pathedTo || t.position.distanceTo(this.pathedTo) >= 1 || Math.random() < 0.05)) {
      this.pathedTo = t.position.clone()
      let delay = 4 + randInt(0, 6)
      const d2 = t.position.distanceSquared ? t.position.distanceSquared(ai.mob.position) : t.position.distanceTo(ai.mob.position) ** 2
      if (d2 > 1024) delay += 10
      else if (d2 > 256) delay += 5
      this.repath = delay
      ai.nav.moveTo(t.position, ai.speed(this.speedMul), { reachDist: 0.5 })
    }

    this.cooldown = Math.max(0, this.cooldown - 1)
    if (this.cooldown === 0 && ai.inMeleeRange(t) && (this.followEvenIfNotSeen || ai.canSee(t) || ai.inMeleeRange(t, 0))) {
      this.cooldown = 20
      ai.attack(t)
    }
  }
}

// ---------------------------------------------------------------------------------------------
/**
 * RangedBowAttackGoal (skeleton). Walks until within `radius` blocks with 20 ticks of line of sight, then
 * strafes while drawing for 20 ticks, shoots a real arrow and waits `attackInterval` ticks (20 on
 * hard, 40 otherwise). Gives up drawing after 3 s without line of sight. Ticked every tick.
 */
class RangedAttackGoal extends Goal {
  constructor (mob, { speed = 1.0, radius = 15 } = {}) {
    super(mob, Control.MOVE | Control.LOOK)
    this.speedMul = speed
    this.radius = radius
    this._reset()
  }

  get requiresUpdateEveryTick () { return true }

  _reset () {
    this.seeTime = 0
    this.attackTime = -1
    this.strafingTime = -1
    this.clockwise = false
    this.backwards = false
    this.repath = 0
  }

  get attackInterval () { return this.mob.difficulty() >= 3 ? 20 : 40 }

  canStart () { return this.mob.targetValid() }
  shouldContinue () { return this.mob.targetValid(1.2) }

  start () {
    this._reset()
    this.mob.setAggressive(true)
  }

  stop () {
    this.mob.stopUsingItem()
    this.mob.setAggressive(false)
    this.mob.nav.stop()
    this._reset()
  }

  tick () {
    const ai = this.mob
    const t = ai.target
    if (!t) return
    const p = ai.mob.position
    const dx = t.position.x - p.x
    const dy = t.position.y - p.y
    const dz = t.position.z - p.z
    const d2 = dx * dx + dy * dy + dz * dz
    const r2 = this.radius * this.radius

    const sees = ai.canSee(t)
    if (sees !== (this.seeTime > 0)) this.seeTime = 0
    if (sees) this.seeTime++
    else this.seeTime--

    if (d2 > r2 || this.seeTime < 20) {
      if (--this.repath <= 0 || !ai.nav.isMoving) {
        this.repath = 10
        ai.nav.moveTo(t.position, ai.speed(this.speedMul), { reachDist: 2 })
      }
      this.strafingTime = -1
    } else {
      ai.nav.stop()
      this.strafingTime++
    }

    if (this.strafingTime >= 20) {
      if (Math.random() < 0.3) this.clockwise = !this.clockwise
      if (Math.random() < 0.3) this.backwards = !this.backwards
      this.strafingTime = 0
    }
    if (this.strafingTime > -1) {
      if (d2 > r2 * 0.75) this.backwards = false
      else if (d2 < r2 * 0.25) this.backwards = true
      ai.nav.strafe(this.backwards ? -0.5 : 0.5, this.clockwise ? 0.5 : -0.5, dx, dz)
    }
    ai.lookAt(t.position.offset(0, 1.62, 0))

    if (ai.isUsingItem) {
      if (!sees && this.seeTime < -60) {
        ai.stopUsingItem()
      } else if (sees && ai.usingTicks >= 20) {
        ai.stopUsingItem()
        ai.shootArrow(t)
        this.attackTime = this.attackInterval
      }
    } else if (--this.attackTime <= 0 && this.seeTime >= -60) {
      ai.startUsingItem()
    }
  }
}

// ---------------------------------------------------------------------------------------------
/**
 * FleeSunGoal: only active while the mob is already burning in daylight with open sky and no helmet.
 * It runs to a spot with no sky exposure.
 */
class FleeSunGoal extends Goal {
  constructor (mob, speed = 1.0) {
    super(mob, Control.MOVE)
    this.speedMul = speed
    this.picking = false
  }

  canStart () {
    const ai = this.mob
    return !this.picking && !ai.target && ai.isDay() && ai.burning > 0 && ai.sunExposed
  }

  shouldContinue () { return this.picking || this.mob.nav.isMoving }
  stop () { this.picking = false; this.mob.nav.stop() }

  start () {
    const ai = this.mob
    this.picking = true
    ai.findShade().then(spot => {
      this.picking = false
      if (spot && ai.selector.isRunning(this)) ai.nav.moveTo(spot, ai.speed(this.speedMul))
    }).catch(() => { this.picking = false })
  }
}

// ---------------------------------------------------------------------------------------------
/**
 * AvoidEntityGoal: run from the nearest mob of one of `types` within `maxDist` blocks, to a spot
 * further away. Switches from walk to sprint speed when it is closer than 7 blocks.
 */
class AvoidEntityGoal extends Goal {
  constructor (mob, types, maxDist = 6, walkSpeed = 1.0, sprintSpeed = 1.2) {
    super(mob, Control.MOVE)
    this.types = new Set([].concat(types))
    this.maxDist = maxDist
    this.walkSpeed = walkSpeed
    this.sprintSpeed = sprintSpeed
    this.toAvoid = null
    this.picking = false
  }

  canStart () {
    if (this.picking) return false
    this.toAvoid = this.mob.nearestMob(this.types, this.maxDist)
    return !!this.toAvoid
  }

  shouldContinue () { return this.picking || this.mob.nav.isMoving }
  stop () { this.picking = false; this.toAvoid = null; this.mob.nav.stop() }

  start () {
    const ai = this.mob
    const from = this.toAvoid.position.clone()
    this.picking = true
    ai.randomStandablePosAway(from, 16, 7).then(spot => {
      this.picking = false
      if (spot && ai.selector.isRunning(this)) ai.nav.moveTo(spot, ai.speed(this.walkSpeed))
    }).catch(() => { this.picking = false })
  }

  tick () {
    const ai = this.mob
    if (!this.toAvoid || !ai.nav.isMoving) return
    const close = this.toAvoid.position.distanceTo(ai.mob.position) < 7
    ai.nav.speed = ai.speed(close ? this.sprintSpeed : this.walkSpeed)
  }
}

// ---------------------------------------------------------------------------------------------
/**
 * WaterAvoidingRandomStrollGoal: roughly once every `interval` ticks (120) it walks to a random spot
 * 10 blocks away (7 vertical).
 */
class WanderAroundGoal extends Goal {
  constructor (mob, speed = 1.0, interval = 120) {
    super(mob, Control.MOVE)
    this.speedMul = speed
    this.interval = interval
    this.picking = false
  }

  canStart () {
    if (this.picking || this.mob.target) return false
    return randInt(0, this.adjustedTickDelay(this.interval) - 1) === 0
  }

  start () {
    const ai = this.mob
    this.picking = true
    ai.randomStandablePos(10, 7).then(spot => {
      this.picking = false
      if (spot && ai.selector.isRunning(this)) ai.nav.moveTo(spot, ai.speed(this.speedMul))
    }).catch(() => { this.picking = false })
  }

  shouldContinue () { return this.picking || this.mob.nav.isMoving }
  stop () { this.picking = false; this.mob.nav.stop() }
}

// ---------------------------------------------------------------------------------------------
/** LookAtPlayerGoal: 2 % per full tick to stare at a player within `radius` for 40-80 ticks. */
class LookAtEntityGoal extends Goal {
  constructor (mob, radius = 8, chance = 0.02) {
    super(mob, Control.LOOK)
    this.radius = radius
    this.chance = chance
    this.who = null
    this.ticks = 0
  }

  canStart () {
    const ai = this.mob
    if (Math.random() >= this.chance) return false
    this.who = ai.target || ai.nearestPlayer(this.radius)
    return !!this.who
  }

  start () { this.ticks = this.adjustedTickDelay(40 + randInt(0, 39)) }

  shouldContinue () {
    const w = this.who
    return this.ticks > 0 && !!w && w.world === this.mob.mob.world && w.position.distanceTo(this.mob.mob.position) <= this.radius
  }

  tick () {
    this.ticks--
    this.mob.lookAt(this.who.position.offset(0, 1.62, 0))
  }

  stop () { this.who = null }
}

// ---------------------------------------------------------------------------------------------
/** RandomLookAroundGoal: 2 % per full tick, glance in a random direction for 20-39 ticks. */
class RandomLookAroundGoal extends Goal {
  constructor (mob) {
    super(mob, Control.MOVE | Control.LOOK)
    this.relX = 0
    this.relZ = 0
    this.lookTime = 0
  }

  get requiresUpdateEveryTick () { return true }
  canStart () { return Math.random() < 0.02 }
  shouldContinue () { return this.lookTime >= 0 }

  start () {
    const a = Math.PI * 2 * Math.random()
    this.relX = Math.cos(a)
    this.relZ = Math.sin(a)
    this.lookTime = 20 + randInt(0, 19)
  }

  tick () {
    this.lookTime--
    const e = this.mob.eye()
    this.mob.lookAt(new Vec3(e.x + this.relX, e.y, e.z + this.relZ))
  }
}

// ---------------------------------------------------------------------------------------------
/**
 * LeapAtTargetGoal (spider): when the target is 2 to 4 blocks away and the mob is on the ground, a
 * 1 in reduced(5) chance per full tick makes it jump towards the target with vertical power `yd`.
 */
class LeapAtTargetGoal extends Goal {
  constructor (mob, yd = 0.4) {
    super(mob, Control.JUMP | Control.MOVE)
    this.yd = yd
  }

  canStart () {
    const ai = this.mob
    const t = ai.target
    if (!t || !ai.nav.onGround) return false
    const d = t.position.distanceTo(ai.mob.position)
    if (d < 2 || d > 4) return false
    return randInt(0, this.adjustedTickDelay(5) - 1) === 0
  }

  shouldContinue () { return !this.mob.nav.onGround }

  start () {
    const ai = this.mob
    const t = ai.target
    const dx = t.position.x - ai.mob.position.x
    const dz = t.position.z - ai.mob.position.z
    const n = Math.hypot(dx, dz) || 1
    ai.leap(dx / n, dz / n, this.yd)
  }
}

// ---------------------------------------------------------------------------------------------
/**
 * SwellGoal (creeper). Starts the fuse when a target is within 3 blocks, keeps it burning while the
 * target stays within 7 blocks in line of sight, and defuses otherwise. Ticked every tick.
 */
class SwellGoal extends Goal {
  constructor (mob) {
    super(mob, Control.MOVE)
  }

  get requiresUpdateEveryTick () { return true }

  canStart () {
    const ai = this.mob
    const t = ai.target
    if (!ai.config.creeperExplosions) return false
    return ai.swellDir > 0 || (!!t && t.position.distanceTo(ai.mob.position) < 3)
  }

  start () { this.mob.nav.stop() }
  stop () { this.mob.setSwellDir(-1) }

  tick () {
    const ai = this.mob
    const t = ai.target
    if (!t) ai.setSwellDir(-1)
    else if (t.position.distanceTo(ai.mob.position) > 7) ai.setSwellDir(-1)
    else if (!ai.canSee(t)) ai.setSwellDir(-1)
    else ai.setSwellDir(1)
  }
}

module.exports = {
  SwimGoal,
  FloatGoal: SwimGoal,
  PanicGoal,
  TargetGoal,
  NearestAttackableTargetGoal,
  HurtByTargetGoal,
  MeleeAttackGoal,
  RangedAttackGoal,
  FleeSunGoal,
  AvoidEntityGoal,
  WanderAroundGoal,
  RandomStrollGoal: WanderAroundGoal,
  LookAtEntityGoal,
  RandomLookAroundGoal,
  LeapAtTargetGoal,
  SwellGoal,
  reducedTickDelay,
  withinMeleeRange
}
