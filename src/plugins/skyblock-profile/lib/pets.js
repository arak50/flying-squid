// Pet levelling (tables verified: legendary L100 = 25,353,230 · epic = 18,608,500 · common = 5,624,785)
const PET_LEVELS = [100, 110, 120, 130, 145, 160, 175, 190, 210, 230, 250, 275, 300, 330, 360, 400, 440, 490, 540, 600, 660, 730, 800, 880, 960, 1050, 1150, 1260, 1380, 1510, 1650, 1800, 1960, 2130, 2310, 2500, 2700, 2920, 3160, 3420, 3700, 4000, 4350, 4750, 5200, 5700, 6300, 7000, 7800, 8700, 9700, 10800, 12000, 13300, 14700, 16200, 17800, 19500, 21300, 23200, 25200, 27400, 29800, 32400, 35200, 38200, 41400, 44800, 48400, 52200, 56200, 60400, 64800, 69400, 74200, 79200, 84700, 90700, 97200, 104200, 111700, 119700, 128200, 137200, 146700, 156700, 167700, 179700, 192700, 206700, 221700, 237700, 254700, 272700, 291700, 311700, 333700, 357700, 383700, 411700, 441700, 476700, 516700, 561700, 611700, 666700, 726700, 791700, 861700, 936700, 1016700, 1101700, 1191700, 1286700, 1386700, 1496700, 1616700, 1746700, 1886700]
const OFFSET = { COMMON: 0, UNCOMMON: 6, RARE: 11, EPIC: 16, LEGENDARY: 20, MYTHIC: 20 }
const RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC']
const COLOR = { COMMON: 'white', UNCOMMON: 'green', RARE: 'blue', EPIC: 'dark_purple', LEGENDARY: 'gold', MYTHIC: 'light_purple' }
const LEVEL_200 = new Set(['GOLDEN_DRAGON'])
const LAST = PET_LEVELS[PET_LEVELS.length - 1]

function effectiveTier (pet) {
  let i = RARITIES.indexOf(pet.tier)
  if (i < 0) i = 0
  if (pet.heldItem === 'PET_ITEM_TIER_BOOST') i = Math.min(RARITIES.length - 1, i + 1)
  return RARITIES[i]
}

function petLevel (exp, tier, type) {
  const max = LEVEL_200.has(type) ? 200 : 100
  const off = OFFSET[tier] ?? 0
  let level = 1; let rem = exp
  for (let l = 1; l < max; l++) {
    const cost = PET_LEVELS[off + l - 1] ?? LAST
    if (rem >= cost) { rem -= cost; level++ } else break
  }
  const maxed = level >= max
  const need = maxed ? 0 : (PET_LEVELS[off + level - 1] ?? LAST)
  return { level, maxLevel: max, into: maxed ? 0 : rem, need, progress: need ? rem / need : 0, maxed, nextLevel: maxed ? null : level + 1 }
}

module.exports = { PET_LEVELS, RARITIES, COLOR, effectiveTier, petLevel }
