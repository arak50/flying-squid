'use strict'
// Skill level rewards, read from the Hypixel `skills` resource (data/skills.json, refreshed by hypixel-api).
//   "+2 Health"                                   -> adds 2 per level
//   "Farmhand II   Grants +4➜8  Farming Fortune"  -> the stat's value from this level on is 8 (replaces 4)
// Verified against the recorded breakdown (Health: Farming 202, Fishing 192, Carpentry 34).
const { resolveStatName } = require('../../../hypixel-api/lib/statDefs')
const table = require('../../data/skills.json').skills

// the resource embeds the stat's icon glyph (private-use area, plus a few symbol glyphs) before its name
const clean = s => String(s).replace(/[\uE000-\uF8FF☯❁❈✦☠⚔☣⸕α✎♨❂]/g, '').replace(/\s+/g, ' ').trim()
const num = s => parseFloat(String(s).replace(/,/g, ''))
const PLAIN = /^\+([\d,.]+)\s+(.+)$/
const GRANT = /Grants \+([\d,.]+)(?:➜([\d,.]+))?\s+([A-Za-z' ]+?)(?:[,.]|$)/

function levelFor (skill, xp) {
  let lv = 0
  for (const l of skill.levels) { if (xp >= l.totalExpRequired) lv = l.level; else break }
  return Math.min(lv, skill.maxLevel || lv)
}

/** { stat -> amount } this skill grants at `level` */
function rewards (skill, level) {
  const out = {}
  for (const l of skill.levels) {
    if (l.level > level) break
    for (const raw of l.unlocks || []) {
      const u = clean(raw)
      const g = GRANT.exec(u)
      if (g) { const stat = resolveStatName(g[3]); if (stat) out[stat.id || stat] = num(g[2] || g[1]); continue }
      const p = PLAIN.exec(u)
      if (p) { const stat = resolveStatName(p[2]); if (stat) { const id = stat.id || stat; out[id] = (out[id] || 0) + num(p[1]) } }
    }
  }
  return out
}

const pretty = k => k.charAt(0) + k.slice(1).toLowerCase()

module.exports = {
  id: 'skills',
  levelFor,
  rewards,
  collect (ctx, push) {
    const exp = ctx.profile && ctx.profile.player_data && ctx.profile.player_data.experience
    if (!exp) return
    for (const [key, skill] of Object.entries(table)) {
      const xp = exp['SKILL_' + key]
      if (!xp) continue
      const level = levelFor(skill, xp)
      for (const [stat, amount] of Object.entries(rewards(skill, level))) push({ stat, amount, group: 'skills', label: pretty(key) + ' Skill', category: 'Skill', level })
    }
  }
}
