'use strict'

const { Vec3 } = require('vec3')
const { Goal, Control } = require('./goalSelector')

const rand = (a, b) => a + Math.random() * (b - a)
const randInt = (a, b) => Math.floor(rand(a, b + 1))

/**
 * Standard goals, named after the ones in Pumpkin's `crates/pumpkin/src/entity/ai/`.
 * Default priorities (lower = more important), matching the docs' table:
 *   1 Swim / Panic / FleeSun / NearestAttackableTarget
 *   2 MeleeAttack / RangedAttack
 *   3 WanderAround
 *   4 LookAtEntity
 */

// ---------------------------------------------------------------------------------------------
class SwimGoal extends Goal {
  constructor (mob) { super(mob, Control.JUMP) }
  canStart () { return this.mob.inWater }
  tick () { this.mob.nav.swimUp = true }
}

// ---------------------------------------------------------------------------------------------
class PanicGoal extends Goal {
  constructor (mob, speed = 1.9) {
    super(mob, Control.MOVE)
    this.speedMul = speed
  }

  canStart () { return this.mob.panicTicks > 0 }
  shouldContinue () { return this.mob.panicTicks > 0 }
  start () { this.flee() }
  stop () { this.mob.nav.stop() }

  flee () {
    const ai = this.mob
    const p = ai.mob.position
    // run away from whatever hurt us, otherwise in a random direction
    let ang = Math.random() * Math.PI * 2
    if (ai.lastAttackerPos) ang = Math.atan2(p.z - ai.lastAttackerPos.z, p.x - ai.lastAttackerPos.x) + rand(-0.8, 0.8)
    const d = rand(5, 9)
    ai.nav.moveTo(new Vec3(p.x + Math.cos(ang) * d, p.y, p.z + Math.sin(ang) * d), ai.speed(this.speedMul))
  }

  tick () {
    const ai = this.mob
    ai.panicTicks--
    if (!ai.nav.isMoving) this.flee()
  }
}

// ---------------------------------------------------------------------------------------------
/** Picks `ai.target` among nearby players (what vanilla calls NearestAttackableTargetGoal). */
class NearestAttackableTargetGoal extends Goal {
  constructor (mob) {
    super(mob, Control.TARGET)
    this.cooldown = 0
  }

  canStart () {
    const ai = this.mob
    if (ai.target) return false
    if (--this.cooldown > 0) return false
    this.cooldown = 8
    if (ai.profile.neutralInDay && ai.isDay() && !ai.angryTicks) return false
    return !!ai.findTarget()
  }

  start () { this.mob.target = this.mob.findTarget() }
  shouldContinue () { return false } // one-shot; the attack goal keeps the target alive
}

// ---------------------------------------------------------------------------------------------
class MeleeAttackGoal extends Goal {
  constructor (mob, speed = 1.0) {
    super(mob, Control.MOVE | Control.LOOK)
    this.speedMul = speed
    this.repath = 0
    this.cooldown = 0
  }

  canStart () { return this.mob.targetValid() }
  shouldContinue () { return this.mob.targetValid(1.5) }

  start () {
    this.repath = 0
    this.cooldown = 10
    this.mob.setAggressive(true) // arms out
  }

  stop () {
    this.mob.setAggressive(false)
    this.mob.nav.stop()
    if (!this.mob.targetValid(1.5)) this.mob.target = null
  }

  tick () {
    const ai = this.mob
    const t = ai.target
    const mobPos = ai.mob.position
    ai.lookAt(t.position.offset(0, 1.62, 0))
    this.cooldown = Math.max(0, this.cooldown - 1)

    const dx = t.position.x - mobPos.x
    const dz = t.position.z - mobPos.z
    const horiz = Math.hypot(dx, dz)
    const vert = Math.abs(t.position.y - mobPos.y)
    const reach = ai.profile.reach

    if (--this.repath <= 0 && (horiz > reach * 0.8 || vert > 1)) {
      this.repath = randInt(8, 14)
      ai.nav.moveTo(t.position, ai.speed(this.speedMul), { reachDist: Math.max(0.5, reach * 0.6) })
    }

    if (horiz <= reach && vert <= 1.6 && this.cooldown === 0) {
      this.cooldown = 20
      ai.attack(t)
    }
  }
}

// ---------------------------------------------------------------------------------------------
/**
 * RangedBowAttackGoal (vanilla skeleton AI). It walks towards the target until it is within `radius`
 * blocks and has had line of sight for 20 ticks, then stands and strafes while it
 * draws the bow for 20 ticks, shoots a real arrow, and waits `attackInterval` ticks
 * (20 on hard, 40 otherwise) before drawing again. It gives up drawing after 3 s without line of sight.
 */
class RangedAttackGoal extends Goal {
  constructor (mob, { speed = 1.0, radius = 15 } = {}) {
    super(mob, Control.MOVE | Control.LOOK)
    this.speedMul = speed
    this.radius = radius
    this._reset()
  }

  _reset () {
    this.seeTime = 0
    this.attackTime = -1
    this.strafingTime = -1
    this.clockwise = false
    this.backwards = false
    this.repath = 0
    this.sight = false
    this.losPending = false
  }

  get attackInterval () { return this.mob.difficulty() >= 3 ? 20 : 40 }

  canStart () { return this.mob.targetValid() }
  shouldContinue () { return this.mob.targetValid(1.2) }

  start () {
    this._reset()
    this.mob.setAggressive(true) // vanilla RangedBowAttackGoal.start: the skeleton raises the bow arm
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
    const p = ai.mob.position
    const dx = t.position.x - p.x
    const dy = t.position.y - p.y
    const dz = t.position.z - p.z
    const d2 = dx * dx + dy * dy + dz * dz
    const r2 = this.radius * this.radius

    // line of sight is an async block query: keep one in flight and use the latest answer
    if (!this.losPending) {
      this.losPending = true
      ai.hasLineOfSight(t).then(v => { this.sight = v; this.losPending = false }, () => { this.losPending = false })
    }
    const sees = this.sight
    const hadSight = this.seeTime > 0
    if (sees !== hadSight) this.seeTime = 0
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
class FleeSunGoal extends Goal {
  constructor (mob, speed = 1.0) {
    super(mob, Control.MOVE)
    this.speedMul = speed
    this.cooldown = 0
    this.exposed = false
    this.checking = false
  }

  canStart () {
    const ai = this.mob
    if (ai.target || !ai.isDay()) return false
    if (--this.cooldown > 0) return this.exposed
    this.cooldown = 10
    if (!this.checking) {
      this.checking = true
      ai.inSunlight().then(v => { this.exposed = v; this.checking = false })
    }
    return this.exposed
  }

  shouldContinue () { return this.mob.nav.isMoving && this.mob.isDay() && !this.mob.target }
  stop () { this.mob.nav.stop() }

  start () {
    const ai = this.mob
    ai.findShade().then(spot => {
      if (spot && ai.selector.isRunning(this)) ai.nav.moveTo(spot, ai.speed(this.speedMul))
    })
  }
}

// ---------------------------------------------------------------------------------------------
class WanderAroundGoal extends Goal {
  constructor (mob, speed = 1.0, chance = 1 / 60) {
    super(mob, Control.MOVE)
    this.speedMul = speed
    this.chance = chance
    this.picking = false
  }

  canStart () {
    const ai = this.mob
    if (ai.target || ai.panicTicks > 0 || this.picking) return false
    return Math.random() < this.chance
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
  stop () { this.mob.nav.stop() }
}

// ---------------------------------------------------------------------------------------------
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
    if (ai.target || Math.random() >= this.chance * 2) return false
    this.who = ai.nearestPlayer(this.radius)
    return !!this.who
  }

  start () { this.ticks = randInt(40, 80) }

  shouldContinue () {
    const w = this.who
    return this.ticks > 0 && !!w && w.world === this.mob.mob.world && w.position.distanceTo(this.mob.mob.position) <= this.radius && !this.mob.target
  }

  tick () {
    this.ticks--
    this.mob.lookAt(this.who.position.offset(0, 1.62, 0))
  }

  stop () { this.who = null }
}

module.exports = {
  SwimGoal,
  PanicGoal,
  NearestAttackableTargetGoal,
  MeleeAttackGoal,
  RangedAttackGoal,
  FleeSunGoal,
  WanderAroundGoal,
  LookAtEntityGoal
}
