'use strict'
// Equip / unequip rules.
//
// RECORDED (statsmenupackets.txt, Stats & Equipment):
//   * unequip: clicking an equipped piece moves it to the first empty inventory slot, hotbar 0-8 first, then main 9-35.
//   * equip: clicking the piece in the inventory puts it in its slot (the recording only ever equips into an empty slot).
//   * the slot an item fits is given by the type word on its last lore line (RARE GLOVES, EPIC BOOTS, ...).
// NOT RECORDED (reported as { ok:false, reason, unverified:true } instead of guessed):
//   * equipping onto an occupied slot, unequipping with a full inventory, items without a type line.

const { SbItem } = require('../../hypixel-api/lib/item')
const { ARMOR_KEYS, EQUIPMENT_KEYS, INVENTORY_FILL_ORDER } = require('./layout')

const lastWord = t => String(t || '').trim().split(/\s+/).pop().toUpperCase()

/** -> { container:'armor'|'equipment', index, key } or null */
function slotFor (item) {
  const sb = SbItem.fromPrismarine(item)
  const key = sb && sb.footer ? lastWord(sb.footer.type) : null
  if (!key) return null
  if (ARMOR_KEYS.includes(key)) return { container: 'armor', index: ARMOR_KEYS.indexOf(key), key }
  if (EQUIPMENT_KEYS.includes(key)) return { container: 'equipment', index: EQUIPMENT_KEYS.indexOf(key), key }
  return null
}

function locate (profile, key) {
  if (ARMOR_KEYS.includes(key)) return { container: profile.container('armor'), index: ARMOR_KEYS.indexOf(key) }
  if (EQUIPMENT_KEYS.includes(key)) return { container: profile.container('equipment'), index: EQUIPMENT_KEYS.indexOf(key) }
  throw new Error('unknown equipment slot ' + key)
}

function unequip (profile, key) {
  const { container, index } = locate(profile, key)
  const item = container.get(index)
  if (!item) return { ok: false, reason: 'empty' }
  const inv = profile.container('inventory')
  const free = inv.firstEmpty(INVENTORY_FILL_ORDER)
  if (free < 0) return { ok: false, reason: 'inventory_full', unverified: true }
  container.set(index, null, 'unequip')
  inv.set(free, item, 'unequip')
  return { ok: true, moved: [{ from: { container: container.name, index }, to: { container: 'inventory', index: free } }] }
}

/** @param {{container:string,index:number}} from where the item currently is (normally the inventory) */
function equip (profile, from) {
  const src = profile.container(from.container)
  const item = src.get(from.index)
  if (!item) return { ok: false, reason: 'empty' }
  const slot = slotFor(item)
  if (!slot) return { ok: false, reason: 'not_equippable', unverified: true }
  const { container, index } = locate(profile, slot.key)
  if (container.get(index)) return { ok: false, reason: 'slot_occupied', unverified: true }
  src.set(from.index, null, 'equip')
  container.set(index, item, 'equip')
  return { ok: true, moved: [{ from: { container: src.name, index: from.index }, to: { container: container.name, index } }] }
}

module.exports = { slotFor, equip, unequip }
