'use strict'
/**
 * Minimal table-driven finite state machine.
 *
 *   const m = new Machine('room', { UNENTERED: { enter: 'ENTERED' }, ENTERED: {} }, 'UNENTERED', (from, event, to, info) => ...)
 *   m.fire('enter')   // true, state is now ENTERED
 *   m.fire('enter')   // false: not allowed from ENTERED, nothing changes
 *
 * An event that the current state does not list is simply refused (returns false), which is what makes the run logic
 * idempotent: a second "last mob died" or a duplicate door request cannot advance anything twice.
 */
class Machine {
  constructor (name, table, initial, onChange) {
    if (!table[initial]) throw new Error(`${name}: unknown initial state ${initial}`)
    this.name = name
    this.table = table
    this.state = initial
    this.onChange = onChange
  }

  can (event) { return this.table[this.state][event] !== undefined }

  is (...states) { return states.includes(this.state) }

  fire (event, info) {
    const to = this.table[this.state][event]
    if (to === undefined) return false
    const from = this.state
    this.state = to
    if (this.onChange) this.onChange(from, event, to, info)
    return true
  }
}

module.exports = { Machine }
