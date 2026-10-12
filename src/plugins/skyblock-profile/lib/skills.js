// Skill XP tables + level maths.
// STANDARD is verified against the sniffed menu (Combat/Farming/Mining/Foraging/Carpentry/Hunting all reproduce
// the exact "xxx/yyy" progress numbers). Runecrafting and Social use different tables - those are loaded from
// /v2/resources/skyblock/skills when available (see hypixel-api plugin), otherwise the captured lines are kept.

// XP needed to go from level n-1 to level n (n = 1..60)
const STANDARD = [50, 125, 200, 300, 500, 750, 1000, 1500, 2000, 3500, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 75000, 100000, 200000,
  300000, 400000, 500000, 600000, 700000, 800000, 900000, 1000000, 1100000, 1200000, 1300000, 1400000, 1500000, 1600000, 1700000, 1800000, 1900000, 2000000, 2100000, 2200000,
  2300000, 2400000, 2500000, 2600000, 2750000, 2900000, 3100000, 3400000, 3700000, 4000000, 4300000, 4600000, 4900000, 5200000, 5500000, 5800000, 6100000, 6400000, 6700000, 7000000]

// the skills the menu counts for "Skill Avg. (non-cosmetic)" - verified: (53+52+50+58+50+60+50+60+25+34)/10 = 49.2
const AVERAGE_SKILLS = ['FARMING', 'MINING', 'COMBAT', 'FORAGING', 'FISHING', 'ENCHANTING', 'ALCHEMY', 'TAMING', 'HUNTING', 'CARPENTRY']
const ALL_SKILLS = [...AVERAGE_SKILLS, 'RUNECRAFTING', 'SOCIAL']

function baseCap (skill, member) {
  const exp = member.player_data?.experience || {}
  switch (skill) {
    case 'FARMING': return 50 + (member.jacobs_contest?.perks?.farming_level_cap || 0)
    case 'FORAGING': return 50 + (exp.SKILL_FORAGING_extra_level_cap || 0)
    case 'TAMING': return 50 + Math.min(10, (member.pets_data?.pet_care?.pet_types_sacrificed || []).length)
    case 'MINING': case 'COMBAT': case 'ENCHANTING': return 60
    case 'FISHING': case 'ALCHEMY': case 'CARPENTRY': return 50
    case 'HUNTING': return 50 // not verifiable past 25 from the sample
    case 'RUNECRAFTING': return 25
    case 'SOCIAL': return 25
    default: return 50
  }
}

/**
 * @param {number} xp total xp
 * @param {number} cap highest reachable level
 * @param {number[]} table per-level xp costs
 */
function levelFor (xp, cap, table = STANDARD) {
  let level = 0; let rem = xp
  for (let i = 0; i < cap && i < table.length; i++) {
    if (rem >= table[i]) { rem -= table[i]; level++ } else break
  }
  const maxed = level >= cap || level >= table.length
  const need = maxed ? 0 : table[level]
  return { level, xp, into: maxed ? 0 : rem, need, progress: need ? rem / need : 0, maxed, cap, nextLevel: maxed ? null : level + 1 }
}

// tables: optional { SKILL: number[] } from the resources API
function computeSkills (member, tables = {}) {
  const exp = member.player_data?.experience || {}
  const out = {}
  for (const sk of ALL_SKILLS) {
    const xp = exp['SKILL_' + sk]
    const table = tables[sk] || (sk === 'RUNECRAFTING' || sk === 'SOCIAL' ? null : STANDARD)
    if (!table) { out[sk] = xp == null ? null : { level: null, xp, unknownTable: true }; continue }
    out[sk] = levelFor(xp || 0, baseCap(sk, member), table)
  }
  const lv = AVERAGE_SKILLS.map(s => out[s]?.level ?? 0)
  const average = lv.reduce((a, b) => a + b, 0) / lv.length
  return { skills: out, average }
}

module.exports = { STANDARD, AVERAGE_SKILLS, ALL_SKILLS, baseCap, levelFor, computeSkills }
