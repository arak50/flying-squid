'use strict'
// Small permanent sources from SkyCrypt's calculate-player-stats.ts:
//   Pet score        -> Magic Find (PET_REWARDS thresholds). Score is computed from the profile's pets: best rarity per pet type
//                       (common 1 ... mythic 6) + 1 per type owned at its max level. Pets in inventories are not included.
//   Jacob's perk     -> +4 Farming Fortune per Double Drops level
//   Harp songs       -> Intelligence per completed song
//   Reaper peppers   -> +1 Health each
//   Century cakes    -> player_data.temp_stat_buffs entries "cake_<stat>"
const { harpQuest, centuryCakeStats } = require('../../data/skycrypt/misc.json')
const pet = require('../../data/skycrypt/petScore.json')
const { resolveStatName } = require('../../../hypixel-api/lib/statDefs')
const { petLevel } = require('../pets')

function petScore (pets) {
  const rarity = {}; const maxed = {}
  for (const p of pets || []) {
    if (pet.ignored.includes(p.type)) continue
    const v = pet.petValue[String(p.tier).toLowerCase()] || 0
    if (!(p.type in rarity) || v > rarity[p.type]) rarity[p.type] = v
    const max = pet.maxLevel[p.type]
    if (max && petLevel(p.tier, p.exp, p.type) >= max) maxed[p.type] = 1
  }
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0)
  return sum(rarity) + sum(maxed)
}

function petScoreMagicFind (score) {
  let mf = 0
  for (const k of Object.keys(pet.petRewards).map(Number).sort((a, b) => a - b)) if (k <= score) mf = pet.petRewards[k].magic_find
  return mf
}

module.exports = {
  id: 'misc_sources',
  petScore,
  petScoreMagicFind,
  collect (ctx, push) {
    const m = ctx.profile || {}
    const pd = m.player_data || {}
    const mf = petScoreMagicFind(petScore(m.pets_data && m.pets_data.pets))
    if (mf) push({ stat: 'magic_find', amount: mf, group: 'pet_score', label: 'Pet Score', category: 'Pet Score' })

    const dd = m.jacobs_contest && m.jacobs_contest.perks && m.jacobs_contest.perks.double_drops
    if (dd) push({ stat: 'farming_fortune', amount: dd * 4, group: 'perks', label: "Jacob's Farming Shop", category: 'Perks', level: dd })

    const harp = Object.entries((m.quests && m.quests.harp_quest) || {}).filter(([k, v]) => harpQuest[k] && v !== undefined).reduce((a, [k]) => a + harpQuest[k], 0)
    if (harp) push({ stat: 'intelligence', amount: harp, group: 'perks', label: 'Melody\'s Harp', category: 'Perks' })

    if (pd.reaper_peppers_eaten) push({ stat: 'health', amount: pd.reaper_peppers_eaten, group: 'perks', label: 'Reaper Peppers', category: 'Consumable' })

    for (const b of pd.temp_stat_buffs || []) {
      if (!String(b.key).startsWith('cake_')) continue
      const id = b.key.slice(5)
      const stat = resolveStatName((centuryCakeStats[id] || id).replace(/_/g, ' ')) || centuryCakeStats[id] || id
      push({ stat: stat.id || stat, amount: b.amount, group: 'effects', label: 'Century Cake', category: 'Consumable' })
    }
  }
}
