'use strict'
// Catacombs level -> Health (SkyCrypt STATS_BONUS.skill_dungeoneering: +2 Health per level, levels 1-50).
// Level from dungeons.dungeon_types.catacombs.experience and SkyCrypt's DUNGEONEERING_XP table (per-level xp, 51 = 200M overflow step).
const table = require('../../data/skycrypt/levels.json').dungeoneeringXp
const bonuses = require('../../data/skycrypt/bonuses.json')
const { stepBonus } = require('./slayer')

function level (xp) {
  let lv = 0
  for (let i = 1; i <= 50; i++) { if (xp >= table[i]) { xp -= table[i]; lv = i } else break }
  return lv
}

module.exports = {
  id: 'catacombs',
  level,
  collect (ctx, push) {
    const d = ctx.profile && ctx.profile.dungeons && ctx.profile.dungeons.dungeon_types && ctx.profile.dungeons.dungeon_types.catacombs
    if (!d || !d.experience) return
    const lv = level(d.experience)
    for (const [stat, amount] of Object.entries(stepBonus(bonuses.skill_dungeoneering, lv, 50))) {
      if (amount) push({ stat, amount, group: 'skills', label: 'Dungeoneering Skill', category: 'Skill', level: lv })
    }
  }
}
