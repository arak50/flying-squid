'use strict'
// Slot layouts. Everything here is taken from the packet recordings (see docs/skyblock/ARCHITECTURE.md §3).

// prismarine 'inv' window: 0 result, 1-4 craft, 5-8 armour (helmet..boots), 9-35 main, 36-44 hotbar, 45 offhand
const invWindowSlot = i => (i < 9 ? 36 + i : i) // profile 'inventory' container index (0-8 hotbar, 9-35 main) -> window slot
const ARMOR_WINDOW_SLOT = [5, 6, 7, 8] // profile 'armor' container index (helmet, chestplate, leggings, boots)

const ARMOR_KEYS = ['HELMET', 'CHESTPLATE', 'LEGGINGS', 'BOOTS']
const EQUIPMENT_KEYS = ['NECKLACE', 'CLOAK', 'BELT', 'GLOVES'] // API equipment_contents / EQUIPMENT_SLOT_1..4 order

// "Stats & Equipment" menu slots (recorded)
const EQUIPMENT_MENU_SLOT = { NECKLACE: 10, HELMET: 11, CLOAK: 19, CHESTPLATE: 20, BELT: 28, LEGGINGS: 29, GLOVES: 37, BOOTS: 38 }
const EMPTY_SLOT_NAME = { NECKLACE: 'Empty Equipment Slot', CLOAK: 'Empty Equipment Slot', BELT: 'Empty Equipment Slot', GLOVES: 'Empty Equipment Slot', HELMET: 'Empty Helmet Slot', CHESTPLATE: 'Empty Chestplate Slot', LEGGINGS: 'Empty Leggings Slot', BOOTS: 'Empty Boots Slot' }

// where an item goes when it is taken out of equipment: first empty slot, hotbar first (0-8) then main (9-35) — recorded
const INVENTORY_FILL_ORDER = [...Array(36).keys()]

module.exports = { invWindowSlot, ARMOR_WINDOW_SLOT, ARMOR_KEYS, EQUIPMENT_KEYS, EQUIPMENT_MENU_SLOT, EMPTY_SLOT_NAME, INVENTORY_FILL_ORDER }
