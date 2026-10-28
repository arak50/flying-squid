'use strict'
// Pet levels from NEU constants/pets.json: a pet of rarity R starts at pet_rarity_offset[R] in the shared level table; its level is
// 1 + the number of cumulative thresholds its exp has reached (max 100, or the pet's own max in custom_pet_leveling).
// Verified: all 97 pets in the recorded Pets menus get the recorded [Lvl N].
const data = require('../data/neu/pets.json')

function petLevel (tier, exp, type) {
  const custom = data.custom_pet_leveling && data.custom_pet_leveling[type]
  const maxLevel = (custom && custom.max_level) || 100
  const offset = data.pet_rarity_offset[tier] || 0
  const table = (custom && custom.pet_levels ? custom.pet_levels : data.pet_levels).slice(offset)
  let cum = 0; let level = 1
  for (let i = 0; i < Math.min(table.length, maxLevel - 1); i++) { cum += table[i]; if (exp >= cum) level = i + 2; else break }
  return Math.min(level, maxLevel)
}

const petName = type => data.id_to_display_name[type] || String(type).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

module.exports = { petLevel, petName }
