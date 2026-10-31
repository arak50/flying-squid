'use strict'

const { Vec3 } = require('vec3')
const { Cell } = require('./blockView')

const GRAVITY = 32 // blocks / s^2
const TERMINAL = 40 // blocks / s
const JUMP_SPEED = 8.8 // blocks / s, clears a 1 block step (~1.2 blocks)

/**
 * Navigation: owns the path, steers along waypoints and runs the mob's kinematics
 * (gravity, jumping, water, simple collision). This replaces the stock server physics for
 * AI mobs, which is why the plugin clears `mob.gravity` and keeps `mob.velocity` at zero.
 */
class Navigation {
  constructor (ai) {
    this.ai = ai
    this.path = null
    this.index = 0
    this.speed = 0 // blocks / s currently wanted
    this.pending = null // promise of a path being computed
    this.token = 0 // invalidates path requests that were superseded
    this.vy = 0
    this.onGround = true
    this.stuckTicks = 0
    this.lastProgress = 0
    this.finished = false
    this.failed = false
    this.swimUp = false // set by SwimGoal each tick it runs
  }

  get isMoving () { return !!this.pending || (!!this.path && this.index < this.path.length) }
  get isPathing () { return !!this.pending }

  /** Walk to `pos`. Returns immediately; the path is computed in the background. */
  moveTo (pos, speed, { reachDist = 0 } = {}) {
    const ai = this.ai
    this.stop()
    this.speed = speed
    this.finished = false
    this.failed = false
    const token = ++this.token
    if (!ai.requestPathBudget()) {
      // out of pathfinding budget this tick: retry next tick instead of dropping the request
      this.deferred = { pos: pos.clone(), speed, reachDist, token }
      return
    }
    this._compute(pos, reachDist, token)
  }

  _compute (pos, reachDist, token) {
    const ai = this.ai
    const mob = ai.mob
    this.pending = ai.pathfinder.find(mob.world, mob.position, pos, {
      height: ai.profile.height,
      maxFall: ai.profile.maxFall,
      maxNodes: ai.config.maxPathNodes,
      reachDist
    }).then(res => {
      if (token !== this.token) return
      this.pending = null
      if (!res || !res.path.length) {
        this.failed = !res
        this.finished = !!res
        return
      }
      this.path = res.path
      this.index = 0
      this.stuckTicks = 0
      this.lastProgress = 0
    }).catch(() => {
      if (token !== this.token) return
      this.pending = null
      this.failed = true
    })
  }

  stop () {
    this.token++
    this.deferred = null
    this.path = null
    this.index = 0
    this.pending = null
    this.stuckTicks = 0
  }

  /**
   * Advance one tick of kinematics. Resolves once the mob's new position has been broadcast.
   * @param {number} dt seconds
   */
  async update (dt) {
    const ai = this.ai
    const mob = ai.mob
    const view = ai.view
    const world = mob.world

    if (this.deferred) {
      const d = this.deferred
      if (d.token === this.token && ai.requestPathBudget()) {
        this.deferred = null
        this._compute(d.pos, d.reachDist, d.token)
      }
    }

    const pos = mob.position.clone()
    const fx = Math.floor(pos.x)
    const fz = Math.floor(pos.z)
    const feetCell = await view.cell(world, fx, Math.floor(pos.y + 0.05), fz)
    const inWater = (feetCell & Cell.WATER) !== 0
    ai.inWater = inWater

    // ---- horizontal steering ---------------------------------------------------------------
    let mx = 0
    let mz = 0
    let wantJump = false
    if (this.path && this.index < this.path.length) {
      const wp = this.path[this.index]
      let dx = wp.x - pos.x
      let dz = wp.z - pos.z
      let dist = Math.hypot(dx, dz)
      const climbing = wp.y > pos.y + 0.3

      // reaching a waypoint: close horizontally and not far below it
      if (dist < 0.3 && pos.y >= wp.y - 0.3) {
        this.index++
        this.stuckTicks = 0
        if (this.index >= this.path.length) {
          this.path = null
          this.finished = true
        } else {
          const nx = this.path[this.index]
          dx = nx.x - pos.x
          dz = nx.z - pos.z
          dist = Math.hypot(dx, dz)
        }
      }
      if (this.path && dist > 1e-4) {
        const step = Math.min(this.speed * dt, Math.max(dist, 0.0001) + 0.15)
        mx = (dx / dist) * step
        mz = (dz / dist) * step
        if (climbing && this.onGround && dist < 1.1) wantJump = true
        ai.faceDirection(dx, dz)
      }
    }

    // knockback from the stock combat code, decaying like friction
    const kb = ai.kb
    if (kb.x !== 0 || kb.z !== 0) {
      mx += kb.x * dt
      mz += kb.z * dt
      const decay = this.onGround ? 0.75 : 0.95
      kb.x *= decay
      kb.z *= decay
      if (Math.abs(kb.x) < 0.05) kb.x = 0
      if (Math.abs(kb.z) < 0.05) kb.z = 0
    }

    // ---- collision-checked horizontal move --------------------------------------------------
    let nx = pos.x
    let nz = pos.z
    let moved = false
    const h = ai.profile.height
    const feetY = Math.floor(pos.y + 0.05)
    const canEnter = async (x, z, yy) => {
      for (let i = 0; i < h; i++) {
        if (!(await view.isFree(world, Math.floor(x), yy + i, Math.floor(z)))) return false
      }
      return true
    }
    if (mx !== 0 || mz !== 0) {
      if (await canEnter(pos.x + mx, pos.z + mz, feetY)) { nx += mx; nz += mz; moved = true } else if (mx !== 0 && await canEnter(pos.x + mx, pos.z, feetY)) { nx += mx; moved = true } else if (mz !== 0 && await canEnter(pos.x, pos.z + mz, feetY)) { nz += mz; moved = true }
    }

    // ---- vertical -------------------------------------------------------------------------
    let vy = this.vy
    if (wantJump && this.onGround) vy = JUMP_SPEED
    if (inWater) {
      vy = Math.max(-2, vy - 6 * dt)
      if (this.swimUp || wantJump) vy = Math.max(vy, 3.2)
      else vy *= 1 - Math.min(1, 3 * dt)
    } else {
      vy = Math.max(-TERMINAL, vy - GRAVITY * dt)
    }
    this.swimUp = false

    let ny = pos.y + vy * dt
    // ground below the new feet position (scan a few cells down from the old feet cell)
    let groundTop = null
    for (let cy = Math.floor(Math.max(pos.y, ny) + 0.001); cy >= Math.floor(Math.min(pos.y, ny)) - 1; cy--) {
      if (await view.isSolid(world, Math.floor(nx), cy, Math.floor(nz))) { groundTop = cy + 1; break }
    }
    let onGround = false
    if (groundTop !== null && vy <= 0 && ny <= groundTop + 0.001) {
      ny = groundTop
      vy = 0
      onGround = true
    }
    // head bump
    if (vy > 0 && !(await view.isFree(world, Math.floor(nx), Math.floor(ny + ai.profile.height - 0.05), Math.floor(nz)))) {
      vy = 0
      ny = pos.y
    }
    this.vy = vy
    this.onGround = onGround

    // ---- stuck detection ----------------------------------------------------------------
    if (this.path) {
      const progressed = moved && Math.hypot(nx - pos.x, nz - pos.z) > this.speed * dt * 0.25
      if (progressed) this.stuckTicks = 0
      else if (onGround) this.stuckTicks++
      if (this.stuckTicks > 30) {
        // blocked (door closed behind us, player built a wall, ...): drop the path
        this.path = null
        this.failed = true
        this.stuckTicks = 0
      }
    }

    if (ny < -64) { ai.onVoid(); return }

    if (nx !== pos.x || ny !== pos.y || nz !== pos.z || onGround !== mob.onGround) {
      await mob.sendPosition(new Vec3(nx, ny, nz), onGround)
    }
  }
}

module.exports = { Navigation }
