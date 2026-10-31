'use strict'

/**
 * Goal system, modelled on the one described in the Pumpkin docs
 * (https://docs.pumpkinmc.org/developer/entities/ai-and-mobs):
 *
 *  - every behaviour is a Goal with canStart / start / shouldContinue / tick / stop
 *  - a GoalSelector holds goals ordered by priority (LOWER number = HIGHER precedence)
 *  - two goals that share a control flag cannot run together; a higher precedence goal
 *    preempts a lower one, otherwise it has to wait
 */

// Control flags: goals that share a flag are mutually exclusive.
const Control = Object.freeze({ MOVE: 1, LOOK: 2, JUMP: 4, TARGET: 8 })

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
}

class GoalSelector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.startInterval=2] ticks between scans for goals that could start
   */
  constructor ({ startInterval = 2 } = {}) {
    this.entries = [] // sorted by priority, ascending
    this.startInterval = startInterval
    this.tickCount = 0
    this.disabledControls = 0
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

  tick () {
    this.tickCount++

    // 1. stop goals that no longer want to run
    for (const e of this.entries) {
      if (e.running && (!this._enabled(e) || !e.goal.shouldContinue())) this._stop(e)
    }

    // 2. start goals (not every tick: scanning is the expensive part)
    if (this.tickCount % this.startInterval === 0) {
      for (const e of this.entries) {
        if (e.running || !this._enabled(e)) continue
        if (!this._canReplaceConflicts(e)) continue
        if (!e.goal.canStart()) continue
        for (const other of this.entries) {
          if (other.running && (other.goal.controls & e.goal.controls)) this._stop(other)
        }
        e.running = true
        e.goal.start()
      }
    }

    // 3. run active goals
    for (const e of this.entries) {
      if (e.running) e.goal.tick()
    }
  }

  /** Stop everything that is running (used when the AI is frozen). */
  stopAll () {
    for (const e of this.entries) if (e.running) this._stop(e)
  }

  _enabled (e) { return (e.goal.controls & this.disabledControls) === 0 }

  // A goal may start only if every running goal it conflicts with has a lower precedence
  // (higher number) and allows itself to be interrupted.
  _canReplaceConflicts (e) {
    for (const other of this.entries) {
      if (other === e || !other.running) continue
      if (!(other.goal.controls & e.goal.controls)) continue
      if (!(e.priority < other.priority && other.goal.interruptible)) return false
    }
    return true
  }

  _stop (e) {
    e.running = false
    e.goal.stop()
  }
}

module.exports = { Goal, GoalSelector, Control }
