'use strict'

/**
 * Goal system with vanilla (GoalSelector) semantics:
 *
 *  - every behaviour is a Goal with canStart / start / shouldContinue / tick / stop
 *  - goals are ordered by priority (LOWER number = HIGHER precedence)
 *  - each control flag (MOVE, LOOK, JUMP, TARGET) is locked by at most one running goal; a goal
 *    may take a flag over from a running goal only when its priority number is strictly lower
 *    AND the running goal is interruptible
 *  - tick() is the full pass (stop, start, then tick running goals). tickRunning() is the cheap
 *    pass vanilla runs on the in-between ticks: it only ticks goals that set
 *    requiresUpdateEveryTick. See MobAI.tick for the (age + id) % 2 stagger.
 *
 * Because the full pass only happens every second tick, start delays are expressed through
 * Goal#adjustedTickDelay, which halves them for goals that are not ticked every tick.
 */

// Control flags: goals that share a flag are mutually exclusive.
const Control = Object.freeze({ MOVE: 1, LOOK: 2, JUMP: 4, TARGET: 8 })
const FLAGS = [Control.MOVE, Control.LOOK, Control.JUMP, Control.TARGET]

const reducedTickDelay = n => Math.ceil(n / 2)

class Goal {
  /**
   * @param {object} mob   the MobAI controller this goal belongs to
   * @param {number} controls bitmask of Control flags the goal needs while running
   */
  constructor (mob, controls = 0) {
    this.mob = mob
    this.controls = controls
  }

  /** Evaluates preconditions to decide whether the goal can activate. */
  canStart () { return false }

  /** Called once when the goal goes from inactive to active. */
  start () {}

  /** Whether an active goal keeps running next tick. Defaults to canStart(). */
  shouldContinue () { return this.canStart() }

  /** Per-tick logic while the goal is active. */
  tick () {}

  /** Called when the goal finishes, fails or is preempted. */
  stop () {}

  /** A goal can opt out of being preempted by higher priority goals. */
  get interruptible () { return true }

  /** Goals that need a tick on every game tick (aiming, steering) return true. */
  get requiresUpdateEveryTick () { return false }

  /** Halve a tick count for goals that are only ticked on full selector passes. */
  adjustedTickDelay (n) { return this.requiresUpdateEveryTick ? n : reducedTickDelay(n) }
}

class GoalSelector {
  /** @param {object} [opts] kept for backwards compatibility; start scans now happen on every full pass */
  constructor (opts = {}) {
    this.entries = [] // sorted by priority, ascending
    this.locks = new Map() // control flag -> running entry
    this.tickCount = 0
    this.disabledControls = 0
    this.startInterval = opts.startInterval || 1
  }

  add (priority, goal) {
    const entry = { priority, goal, running: false }
    this.entries.push(entry)
    // stable insert: equal priorities keep registration order
    this.entries.sort((a, b) => a.priority - b.priority)
    return entry
  }

  remove (goal) {
    const i = this.entries.findIndex(e => e.goal === goal)
    if (i === -1) return false
    if (this.entries[i].running) this._stop(this.entries[i])
    this.entries.splice(i, 1)
    return true
  }

  get running () { return this.entries.filter(e => e.running).map(e => e.goal) }

  isRunning (goal) { return this.entries.some(e => e.running && e.goal === goal) }

  disableControl (flag) { this.disabledControls |= flag }
  enableControl (flag) { this.disabledControls &= ~flag }

  /** Full pass: stop finished goals, start eligible ones, then tick everything that runs. */
  tick () {
    this.tickCount++

    for (const e of this.entries) {
      if (e.running && (!this._enabled(e) || !e.goal.shouldContinue())) this._stop(e)
    }

    for (const e of this.entries) {
      if (e.running || !this._enabled(e)) continue
      if (!this._canReplaceAll(e)) continue
      if (!e.goal.canStart()) continue
      for (const flag of FLAGS) {
        if (!(e.goal.controls & flag)) continue
        const holder = this.locks.get(flag)
        if (holder && holder !== e) this._stop(holder)
        this.locks.set(flag, e)
      }
      e.running = true
      e.goal.start()
    }

    this.tickRunning(true)
  }

  /** In-between pass: only goals that need every tick are ticked unless `force`. */
  tickRunning (force = false) {
    for (const e of this.entries) {
      if (e.running && (force || e.goal.requiresUpdateEveryTick)) e.goal.tick()
    }
  }

  /** Stop everything that is running (used when the AI is frozen). */
  stopAll () {
    for (const e of this.entries) if (e.running) this._stop(e)
  }

  _enabled (e) { return (e.goal.controls & this.disabledControls) === 0 }

  // A goal may start only if every goal currently holding one of its flags can be replaced:
  // the holder must be interruptible and have a strictly higher priority number.
  _canReplaceAll (e) {
    for (const flag of FLAGS) {
      if (!(e.goal.controls & flag)) continue
      const holder = this.locks.get(flag)
      if (holder && holder !== e && !(e.priority < holder.priority && holder.goal.interruptible)) return false
    }
    return true
  }

  _stop (e) {
    e.running = false
    for (const flag of FLAGS) if (this.locks.get(flag) === e) this.locks.delete(flag)
    e.goal.stop()
  }
}

module.exports = { Goal, GoalSelector, Control, reducedTickDelay }
