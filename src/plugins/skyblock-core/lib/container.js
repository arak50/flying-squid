'use strict'
// Containers hold prismarine Items (26.1 components). All state changes go through set()/swap()/move()
// so one 'change' event is raised per slot — the stat engine and (later) menus subscribe to those.

const { invWindowSlot, ARMOR_WINDOW_SLOT } = require('./layout')

class Container {
  constructor (name, size) { this.name = name; this._size = size; this.onChange = null }
  get size () { return this._size }
  get (i) { return this._get(i) || null }
  set (i, item, reason = 'set') {
    if (i < 0 || i >= this.size) throw new RangeError(`${this.name}[${i}] out of range (size ${this.size})`)
    this._set(i, item || null)
    if (this.onChange) this.onChange({ container: this.name, index: i, reason })
  }

  /** index of first empty slot in `order` (default ascending), or -1 */
  firstEmpty (order) {
    for (const i of order || [...Array(this.size).keys()]) if (!this.get(i)) return i
    return -1
  }

  items () { const out = []; for (let i = 0; i < this.size; i++) out.push(this.get(i)); return out }
  count () { return this.items().filter(Boolean).length }
}

class ArrayContainer extends Container {
  constructor (name, size, items = []) { super(name, size); this.slots = Array.from({ length: size }, (_, i) => items[i] || null) }
  _get (i) { return this.slots[i] }
  _set (i, item) { this.slots[i] = item }
}

/** A view over the player's real inventory window; the window stays the object the client interacts with. */
class WindowContainer extends Container {
  constructor (name, player, slotMap) { super(name, slotMap.length); this.player = player; this.map = slotMap }
  _get (i) { return this.player.inventory.slots[this.map[i]] }
  _set (i, item) { this.player.inventory.updateSlot(this.map[i], item) } // built-in plugin sends set_slot / equipment
  windowSlot (i) { return this.map[i] }
  indexOfWindowSlot (w) { return this.map.indexOf(w) }
}

const inventoryContainer = player => new WindowContainer('inventory', player, [...Array(36).keys()].map(invWindowSlot))
const armorContainer = player => new WindowContainer('armor', player, ARMOR_WINDOW_SLOT)

module.exports = { Container, ArrayContainer, WindowContainer, inventoryContainer, armorContainer }
