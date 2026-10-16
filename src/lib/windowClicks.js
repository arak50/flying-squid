'use strict'
// Inventory click modes prismarine-windows leaves "unimplemented": drag (mode 5) and double click (mode 6).
// Vanilla semantics. All changes go through window.updateSlot so listeners (client sync, equipment broadcast) fire.

const DRAG_START = { 0: 'left', 4: 'right', 8: 'middle' }
const DRAG_ADD = { 1: 'left', 5: 'right', 9: 'middle' }
const DRAG_END = { 2: 'left', 6: 'right', 10: 'middle' }

module.exports = function (Item) {
  const same = (a, b) => a && b && Item.equal(a, b, false)
  const copy = (item, count) => { const c = new Item(item.type, count, item.metadata, item.nbt); c.components = item.components; if (item.componentMap) c.componentMap = item.componentMap; for (const k of Object.getOwnPropertyNames(item)) if (k.startsWith('_') && !(k in c)) Object.defineProperty(c, k, { value: item[k], enumerable: false, writable: true, configurable: true }); return c }

  /** @returns {object|null} the drag state to keep, or null when the packet ended / was not a drag packet */
  function dragPacket (win, drag, click) {
    const { slot, mouseButton } = click
    if (slot === -999 && DRAG_START[mouseButton]) return { kind: DRAG_START[mouseButton], slots: [] }
    if (drag && DRAG_ADD[mouseButton] === drag.kind && slot >= 0) { if (!drag.slots.includes(slot)) drag.slots.push(slot); return drag }
    if (drag && DRAG_END[mouseButton] === drag.kind) { applyDrag(win, drag); return null }
    return null
  }

  function applyDrag (win, drag) {
    const cursor = win.selectedItem
    if (!cursor || !drag.slots.length) return
    // a slot takes part only if it is empty or holds the same item
    const slots = drag.slots.filter(s => { const it = win.slots[s]; return !it || same(it, cursor) })
    if (!slots.length) return
    let remaining = cursor.count
    const each = drag.kind === 'right' ? 1 : (drag.kind === 'middle' ? cursor.stackSize : Math.max(1, Math.floor(cursor.count / slots.length)))
    for (const s of slots) {
      if (remaining <= 0) break
      const cur = win.slots[s]
      const have = cur ? cur.count : 0
      const put = Math.min(each, cursor.stackSize - have, remaining)
      if (put <= 0) continue
      win.updateSlot(s, copy(cursor, have + put))
      remaining -= put
    }
    win.selectedItem = remaining > 0 ? copy(cursor, remaining) : null
  }

  /** Double click: gather matching stacks from the inventory onto the cursor, non-full stacks first. */
  function doubleClick (win) {
    const cursor = win.selectedItem
    if (!cursor) return
    let count = cursor.count
    for (const full of [false, true]) {
      for (let s = 9; s <= 44 && count < cursor.stackSize; s++) {
        const it = win.slots[s]
        if (!same(it, cursor) || (it.count >= it.stackSize) !== full) continue
        const take = Math.min(it.count, cursor.stackSize - count)
        count += take
        win.updateSlot(s, take === it.count ? null : copy(it, it.count - take))
      }
    }
    win.selectedItem = copy(cursor, count)
  }

  return { dragPacket, applyDrag, doubleClick }
}
