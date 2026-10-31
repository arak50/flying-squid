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
  }

  stop () {
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
/** Keeps its distance and shoots (skeletons). Uses a hitscan hit rather than a projectile entity. */
class RangedAttackGoal extends Goal {
  constructor (mob, { speed = 1.0, minRange = 5, maxRange = 14, interval = 40 } = {}) {
    super(mob, Control.MOVE | Control.LOOK)
    Object.assign(this, { speedMul: speed, minRange, maxRange, interval })
    this.cooldown = 0
    this.repath = 0
    this.sight = false
  }

  canStart () { return this.mob.targetValid() }
  shouldContinue () { return this.mob.targetValid(1.2) }
  start () { this.cooldown = 20; this.repath = 0 }
  stop () {
    this.mob.nav.stop()
    if (!this.mob.targetValid(1.2)) this.mob.target = null
  }

  tick () {
    const ai = this.mob
    const t = ai.target
    const p = ai.mob.position
    ai.lookAt(t.position.offset(0, 1.5, 0))
    this.cooldown = Math.max(0, this.cooldown - 1)
    const dist = p.distanceTo(t.position)
    if (--this.repath <= 0) {
      this.repath = randInt(10, 16)
      ai.hasLineOfSight(t).then(v => { this.sight = v })
      if (dist > this.maxRange || !this.sight) {
        ai.nav.moveTo(t.position, ai.speed(this.speedMul), { reachDist: this.maxRange * 0.7 })
      } else if (dist < this.minRange) {
        const away = p.minus(t.position)
        const n = Math.hypot(away.x, away.z) || 1
        ai.nav.moveTo(new Vec3(p.x + (away.x / n) * 6, p.y, p.z + (away.z / n) * 6), ai.speed(this.speedMul))
      } else {
        ai.nav.stop() // in the sweet spot: stand and shoot
      }
    }
    if (this.sight && dist <= this.maxRange && this.cooldown === 0) {
      this.cooldown = this.interval
      ai.rangedAttack(t, dist)
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
