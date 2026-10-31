'use strict'
// Slayer level rewards + completion wisdom, following SkyCrypt (src/stats/slayer.js, calculate-player-stats.ts).
//   level = highest claimed level (claimed_levels.level_N[_special]); zombie's legacy level_7/8/9 are ignored
//   rewards = common/constants/bonuses.js STATS_BONUS.slayer_<name>: every step up to the level applies, the latest step
//             at or below each level is what that level grants (so e.g. zombie level 3 = 2 + 2 + 3 health)
//   Combat Wisdom = +1 per tier I-III boss type killed, +2 per tier IV-V, per slayer (a tier counts once, however many kills).
//   NOTE: SkyCrypt's loop also walks its synthetic `kills.total` key, which silently adds +2 per slayer; that is not copied here.
const bonuses = require('../../data/skycrypt/bonuses.json')
const slayerXp = require('../../data/skycrypt/levels.json').slayerXp

function claimedLevel (name, slayer) {
  let level = 0
  for (const key of Object.keys(slayer.claimed_levels || {})) {
    if (name === 'zombie' && ['level_7', 'level_8', 'level_9'].includes(key)) continue
    const n = parseInt(key.split('_')[1])
    if (n > level) level = n
  }
  return level
}

/** Σ over levels 1..level of the step that applies at that level (SkyCrypt getBonusStat) */
function stepBonus (table, level, max) {
  const out = {}
  if (!table) return out
  const steps = Object.keys(table).map(Number).sort((a, b) => a - b)
  for (let x = steps[0]; x <= max; x++) {
    if (level < x) break
    const step = steps.filter(a => a <= x).pop()
    for (const [stat, v] of Object.entries(table[step])) out[stat] = (out[stat] || 0) + v
  }
  return out
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1)

module.exports = {
  id: 'slayer',
  stepBonus,
  claimedLevel,
  collect (ctx, push) {
    const bosses = ctx.profile && ctx.profile.slayer && ctx.profile.slayer.slayer_bosses
    if (!bosses) return
    let wisdom = 0
    for (const [name, s] of Object.entries(bosses)) {
      if (!s.claimed_levels) continue
      const max = Object.keys(slayerXp[name] || {}).length
      const level = claimedLevel(name, s)
      for (const [stat, amount] of Object.entries(stepBonus(bonuses['slayer_' + name], level, max))) {
        if (amount) push({ stat, amount, group: 'slayer', label: cap(name) + ' Slayer', category: 'Slayer', level })
      }
      for (const key of Object.keys(s)) {
        const m = /^boss_kills_tier_(\d+)$/.exec(key)
        if (m) wisdom += (parseInt(m[1]) + 1) <= 3 ? 1 : 2
      }
    }
    if (wisdom) push({ stat: 'combat_wisdom', amount: wisdom, group: 'slayer', label: 'Slayer Completion', category: 'Slayer' })
  }
}
