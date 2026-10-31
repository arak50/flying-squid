'use strict'
// Bestiary milestone -> Health. SkyCrypt (src/stats/bestiary.js + public/resources/ts/calculate-player-stats.ts):
//   family tier   = number of its bracket thresholds (<= the family's cap) that the family's summed kills have reached
//   milestone     = sum of all family tiers;   Health = floor(milestone / 10)
// Data: data/skycrypt/bestiary.json (tools/extract-skycrypt.js). Not yet checked against a Bestiary recording.
const data = require('../../data/skycrypt/bestiary.json')

function milestone (kills) {
  let total = 0
  for (const fam of data.families) {
    const bracket = data.brackets[fam.bracket]
    if (!bracket) continue
    const n = fam.mobs.reduce((a, m) => a + (kills[m] || 0), 0)
    const next = bracket.find(t => n < t && t <= fam.cap)
    total += next !== undefined ? bracket.indexOf(next) : bracket.indexOf(fam.cap) + 1
  }
  return total
}

module.exports = {
  id: 'bestiary',
  milestone,
  collect (ctx, push) {
    const kills = ctx.profile && ctx.profile.bestiary && ctx.profile.bestiary.kills
    if (!kills) return
    const m = milestone(kills)
    if (m >= 10) push({ stat: 'health', amount: Math.floor(m / 10), group: 'bestiary', label: 'Bestiary', category: 'Bestiary', level: m })
  }
}
