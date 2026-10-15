'use strict'
// Stat registry. Base values / caps / categories come from the Hypixel SkyBlock
// wiki "Stats" page. `icon` is the post-overhaul (v0.26, Jul 2026) private-use
// glyph observed in real item lore; `legacyIcon` is the classic unicode glyph.
// Icons are cosmetic only - override them via `setIcon` if your resource pack differs.

const E = (n) => String.fromCharCode(0xe000 + n)

// [id, name, category, base, cap, color, icon, legacyIcon, {suffix, aliases}]
const RAW = [
  // Combat
  ['health', 'Health', 'combat', 100, null, '§c', E(0x10), '❤'],
  ['defense', 'Defense', 'combat', 0, null, '§a', E(0x08), '❈'],
  ['true_defense', 'True Defense', 'combat', 0, null, '§f', null, '❂'],
  ['strength', 'Strength', 'combat', 0, null, '§c', E(0x0d), '❁'],
  ['crit_chance', 'Crit Chance', 'combat', 30, null, '§9', null, '☣', { suffix: '%' }],
  ['crit_damage', 'Crit Damage', 'combat', 50, null, '§9', E(0x07), '☠', { suffix: '%' }],
  ['attack_speed', 'Bonus Attack Speed', 'combat', 0, 100, '§e', E(0x01), '⚔', { suffix: '%', aliases: ['Attack Speed'] }],
  ['ferocity', 'Ferocity', 'combat', 0, 500, '§c', E(0x0b), '⫽'],
  ['swing_range', 'Swing Range', 'combat', 3, 15, '§e', null, ''],
  ['intelligence', 'Intelligence', 'combat', 0, null, '§b', E(0x03), '✎'],
  ['ability_damage', 'Ability Damage', 'combat', 0, null, '§c', null, '๑', { suffix: '%' }],
  ['health_regen', 'Health Regen', 'combat', 100, null, '§c', E(0x11), '❣'],
  ['vitality', 'Vitality', 'combat', 100, null, '§4', E(0x28), '♨'],
  ['mending', 'Mending', 'combat', 100, null, '§a', null, '☄'],
  // Mining
  ['breaking_power', 'Breaking Power', 'mining', 0, null, '§2', null, 'Ⓟ'],
  ['mining_speed', 'Mining Speed', 'mining', 0, null, '§6', E(0x15), '⸕'],
  ['mining_spread', 'Mining Spread', 'mining', 0, 10000, '§e', E(0x16), ''],
  ['gemstone_spread', 'Gemstone Spread', 'mining', 0, null, '§e', null, ''],
  ['pristine', 'Pristine', 'mining', 0, null, '§5', null, '✧'],
  ['mining_fortune', 'Mining Fortune', 'mining', 0, null, '§6', E(0x53), '☘'],
  ['ore_fortune', 'Ore Fortune', 'mining', 0, null, '§6', null, '☘'],
  ['block_fortune', 'Block Fortune', 'mining', 0, null, '§6', null, '☘'],
  ['dwarven_metal_fortune', 'Dwarven Metal Fortune', 'mining', 0, null, '§6', null, '☘'],
  ['gemstone_fortune', 'Gemstone Fortune', 'mining', 0, null, '§6', null, '☘'],
  // Farming
  ['bonus_pest_chance', 'Bonus Pest Chance', 'farming', 0, null, '§2', E(0x19), 'ൠ', { suffix: '%' }],
  ['overbloom', 'Overbloom', 'farming', 0, null, '§d', null, ''],
  ['farming_fortune', 'Farming Fortune', 'farming', 0, null, '§6', E(0x51), '☘'],
  ...['wheat', 'carrot', 'potato', 'pumpkin', 'sugar_cane', 'melon_slice', 'cactus', 'cocoa_beans', 'mushroom',
    'nether_wart', 'sunflower', 'moonflower', 'wild_rose'].map(c =>
    [c + '_fortune', c.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') + ' Fortune', 'farming', 0, null, '§6', null, '☘']),
  // Foraging
  ['sweep', 'Sweep', 'foraging', 0, null, '§2', E(0x23), '∽'],
  ['foraging_fortune', 'Foraging Fortune', 'foraging', 0, null, '§6', E(0x54), '☘'],
  ['fig_fortune', 'Fig Fortune', 'foraging', 0, null, '§6', null, '☘'],
  ['mangrove_fortune', 'Mangrove Fortune', 'foraging', 0, null, '§6', null, '☘'],
  ['helix_fortune', 'Helix Fortune', 'foraging', 0, null, '§6', null, '☘'],
  ['timber', 'Timber', 'foraging', 0, null, '§4', E(0x2e), ''],
  // Fishing
  ['fishing_speed', 'Fishing Speed', 'fishing', 0, 300, '§b', E(0x0c), '☂'],
  ['sea_creature_chance', 'Sea Creature Chance', 'fishing', 20, null, '§3', E(0x21), 'α', { suffix: '%' }],
  ['double_hook_chance', 'Double Hook Chance', 'fishing', 0, 100, '§9', null, '⚓', { suffix: '%' }],
  ['trophy_chance', 'Trophy Chance', 'fishing', 0, 150, '§6', null, '♔', { suffix: '%' }],
  ['treasure_chance', 'Treasure Chance', 'fishing', 0, null, '§6', E(0x25), '', { suffix: '%' }],
  // Hunting
  ['pull', 'Pull', 'hunting', 0, null, '§b', null, ''],
  ['hunting_fortune', 'Hunting Fortune', 'hunting', 0, null, '§d', null, '☘'],
  ['charm_chance', 'Charm Chance', 'hunting', 0, null, '§d', null, '❣', { suffix: '%' }],
  // Misc
  ['speed', 'Speed', 'misc', 100, 400, '§f', E(0x22), '✦'],
  ['magic_find', 'Magic Find', 'misc', 0, 900, '§b', E(0x1a), '✯'],
  ['tracking', 'Tracking', 'misc', 0, null, '§b', null, ''],
  ['pet_luck', 'Pet Luck', 'misc', 0, null, '§d', E(0x13), '♣'],
  ['heat_resistance', 'Heat Resistance', 'misc', 0, null, '§c', null, '♨'],
  ['cold_resistance', 'Cold Resistance', 'misc', 0, null, '§b', null, '❄'],
  ['respiration', 'Respiration', 'misc', 30, null, '§3', null, ''],
  ['pressure_resistance', 'Pressure Resistance', 'misc', 0, null, '§9', null, ''],
  ['fear', 'Fear', 'misc', 0, null, '§5', null, ''],
  // Wisdom
  ...['combat', 'farming', 'fishing', 'mining', 'foraging', 'enchanting', 'alchemy', 'hunting', 'carpentry',
    'runecrafting', 'taming', 'social'].map(s =>
    [s + '_wisdom', s[0].toUpperCase() + s.slice(1) + ' Wisdom', 'wisdom', 0, null, '§3', null, '☯']),
  // Rift (not shown in the overworld menu)
  ['rift_time', 'Rift Time', 'rift', 480, null, '§a', null, ''],
  ['rift_damage', 'Rift Damage', 'rift', 20, null, '§5', null, ''],
  ['rift_intelligence', 'Rift Intelligence', 'rift', 0, null, '§b', null, ''],
  ['rift_mana_regen', 'Mana Regen', 'rift', 0, null, '§b', null, ''],
  ['rift_speed', 'Rift Speed', 'rift', 100, null, '§f', null, ''],
  ['hearts', 'Hearts', 'rift', 10, null, '§c', null, '']
]

const CATEGORIES = [
  { id: 'combat', name: 'Combat Stats' }, { id: 'mining', name: 'Mining Stats' },
  { id: 'farming', name: 'Farming Stats' }, { id: 'foraging', name: 'Foraging Stats' },
  { id: 'fishing', name: 'Fishing Stats' }, { id: 'hunting', name: 'Hunting Stats' },
  { id: 'misc', name: 'Miscellaneous Stats' }, { id: 'wisdom', name: 'Wisdom Stats' },
  { id: 'rift', name: 'Rift Stats' }
]

const STATS = {}
const BY_NAME = new Map()
RAW.forEach(([id, name, category, base, cap, color, icon, legacyIcon, extra = {}], order) => {
  STATS[id] = { id, name, category, base, cap, color, icon: icon || legacyIcon || '', legacyIcon: legacyIcon || icon || '', suffix: extra.suffix || '', order }
  BY_NAME.set(name.toLowerCase(), id)
  for (const a of extra.aliases || []) BY_NAME.set(a.toLowerCase(), id)
})

// Item-lore-only pseudo stats (not player stats, never part of the menu totals)
const ITEM_ONLY = { Damage: 'damage', 'Gear Score': 'gear_score', 'Accessory Power': 'accessory_power' }

function resolveStatName (name) {
  const k = name.trim().toLowerCase()
  if (BY_NAME.has(k)) return BY_NAME.get(k)
  return null
}

function formatStat (def, value, { legacy = false } = {}) {
  const icon = legacy ? def.legacyIcon : def.icon
  const n = Math.round(value * 100) / 100
  return `${def.color}${icon ? icon + ' ' : ''}${def.name} §f${n.toLocaleString('en-US')}${def.suffix}`
}

module.exports = { STATS, CATEGORIES, ITEM_ONLY, resolveStatName, formatStat }
