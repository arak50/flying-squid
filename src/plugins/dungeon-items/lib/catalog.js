'use strict'
/**
 * Spawnable dungeon items. Each is shown as a floating item on an invisible small armour stand (head item + name), like Hypixel's drops.
 *
 *   kind     'key' | 'blessing' | 'consumable'
 *   style    'head' (item on the stand's helmet) | 'held' (item in its main hand, arm raised); `head` is the vanilla item, `skin` a signed player-head texture, `model` a resource-pack item model
 *   lifetime ms before an unclaimed item vanishes (0 = never). Heads, colours, layout, bob and spin are from the capture; the 30 s lifetime is read off the Superboom TNT despawns
 *   name     display name, `color` its colour
 *   pickup   'party' (goes to a shared pool: keys) | 'player' (applies to whoever picks it up)
 */
const HEADS = require('./heads.json') // signed texture properties copied from the capture (the stand's helmet profile)
const skin = k => ({ value: HEADS[k].value, signature: HEADS[k].signature })
const KEYS = {
  // no Wither Key stand was captured: wither_skeleton_skull is a stand-in until its head texture is known
  wither_key: { kind: 'key', keyType: 'wither', name: 'Wither Key', color: 'dark_gray', head: 'wither_skeleton_skull', pickup: 'party', style: 'head', lifetime: 0 },
  blood_key: { kind: 'key', keyType: 'blood', name: 'Blood Key', color: 'red', head: 'player_head', skin: skin('blood_key'), pickup: 'party', style: 'head', lifetime: 0 }
}

// Blessings. `stats` = what each level adds: `add` per level (flat), `mult` per level (compounding, so level L gives mult^L).
// Power / Stone / Life are read off the capture's "Granted you" lines (Power V: +20.4 & +1.1x Strength, Stone V: +20.4 & +1.1x Defense and +30 Damage,
// Life V: +1.15x HP and +1.15x Health Regen; level 1 and 2 agree). Wisdom and Time were not captured: their numbers are placeholders.
const BLESSINGS = {
  blessing_power: { name: 'Blessing of Power', color: 'light_purple', head: 'player_head', stats: { strength: { add: 4.08, mult: 1.02 } } },
  blessing_life: { name: 'Blessing of Life', color: 'light_purple', head: 'player_head', stats: { health: { mult: 1.03 }, healthRegen: { mult: 1.03 } } },
  blessing_wisdom: { name: 'Blessing of Wisdom', color: 'light_purple', head: 'player_head', stats: { intelligence: { add: 4.08, mult: 1.02 } }, placeholder: true },
  blessing_stone: { name: 'Blessing of Stone', color: 'light_purple', head: 'player_head', stats: { defense: { add: 4.08, mult: 1.02 }, damage: { add: 6 } } },
  blessing_time: { name: 'Blessing of Time', color: 'light_purple', head: 'player_head', stats: { abilityCooldown: { mult: 1.02 } }, placeholder: true }
}
for (const b of Object.values(BLESSINGS)) Object.assign(b, { kind: 'blessing', pickup: 'player', maxLevel: 13, style: 'head', skin: skin('blessing'), lifetime: 30000 })

const CONSUMABLES = {
  superboom_tnt: { kind: 'consumable', name: 'Superboom TNT', color: 'blue', head: 'paper', model: 'hypixel_skyblock:item/uncategorized/superboom_tnt', glint: true, pickup: 'player', consumable: 'superboom', style: 'held', lifetime: 30000 },
  revive_stone: { kind: 'consumable', name: 'Revive Stone', color: 'gold', head: 'player_head', skin: skin('revive_stone'), pickup: 'player', consumable: 'revive_stone', style: 'head', lifetime: 30000 }
}

// how a stat reads in the "Granted you ..." chat line: [label, labelColour code]
const STAT_TEXT = { strength: ['Strength', 'c'], defense: ['Defense', 'a'], damage: ['Damage', 'c'], health: ['HP', 'a'], healthRegen: ['Health Regen', 'c'], intelligence: ['Intelligence', 'b'], abilityCooldown: ['Ability Cooldown', 'c'] }

const ITEMS = { ...KEYS, ...BLESSINGS, ...CONSUMABLES }
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII']
const roman = n => ROMAN[n] || String(n)

/** Resolve 'blood key', 'Blessing of Life', 'life', 'blessing_life' ... to a catalogue key, or null. */
function resolve (ref) {
  const k = String(ref || '').toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_').replace(/^blessing_of_/, 'blessing_')
  if (ITEMS[k]) return k
  if (ITEMS[`blessing_${k}`]) return `blessing_${k}`
  if (ITEMS[`${k}_key`]) return `${k}_key`
  return null
}

module.exports = { STAT_TEXT, ITEMS, KEYS, BLESSINGS, CONSUMABLES, roman, resolve }
