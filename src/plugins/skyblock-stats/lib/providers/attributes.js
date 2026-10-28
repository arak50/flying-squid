'use strict'
// Attribute shards. Data: NEU constants/attribute_shards.json (rarity + level thresholds) and items/ATTRIBUTE_SHARD_*;1.json
// (what each attribute grants per level), reduced by tools/extract-neu.js; the player's shard counts are `attributes.stacks`.
//
//   level          = how many cumulative thresholds of the attribute's rarity the stack count has reached (max 10)
//   flat / additive = per-level value × level
//   special        = "per unique <rarity> Attribute you own" (× count owned), "per digit of <collection>" (× digits, capped),
//                    "Your Tracker attributes are +N% stronger" (boosts the Tracking stat, N × the boosting attribute's level)
// Conditions in the lore: "during the night/day" and "while on <X> Islands" are checked against ctx.context.time / .island;
// anything else (against <mobs>, on Pests, if ..., while <activity>) is not modelled and the effect is not counted.
// Verified against the recorded Attribute rows (tools/verify-neu.js), recorded at night on a Foraging Island.
const { resolveStatName } = require('../../../hypixel-api/lib/statDefs')
const data = require('../../data/neu/attributes.json')

function levelOf (def, stacks) {
  let cum = 0; let level = 0
  for (const t of data.levelling[def.rarity] || []) { cum += t; if (stacks >= cum) level++; else break }
  return level
}

module.exports = {
  id: 'attributes',
  levelOf,
  collect (ctx, push) {
    const stacks = ctx.profile && ctx.profile.attributes && ctx.profile.attributes.stacks
    if (!stacks) return
    const owned = Object.keys(stacks).filter(id => data.attributes[id])
    const levels = Object.fromEntries(owned.map(id => [id, levelOf(data.attributes[id], stacks[id])]))
    const uniqueOf = rarity => owned.filter(id => data.attributes[id].rarity === rarity).length
    const collections = (ctx.profile && ctx.profile.collection) || {}
    // boosts such as Echo of Tracking: +N% per level to every attribute that grants the named stat
    const boosts = []
    for (const id of owned) { const b = data.attributes[id].special && data.attributes[id].special.boostsStat; if (b && levels[id]) boosts.push({ stat: b.stat, pct: b.pct * levels[id] }) }

    const context = ctx.context || {}
    const active = def => { const c = def.cond; return !c || (!c.other && (!c.time || c.time === context.time) && (!c.island || c.island === context.island)) }
    for (const id of owned) {
      const def = data.attributes[id]; const level = levels[id]
      if (!level || !active(def)) continue
      let factor = level
      const sp = def.special || {}
      if (sp.perUniqueRarity) factor *= uniqueOf(sp.perUniqueRarity)
      if (sp.digitsOf) factor *= String(Math.floor(Math.min(collections[sp.digitsOf.collection] || 0, sp.digitsOf.max))).length
      for (const e of def.effects) {
        const stat = resolveStatName(e.stat); const sid = stat && (stat.id || stat)
        if (!sid) continue
        let amount = e.per * factor
        if (e.kind === 'flat') for (const b of boosts) if (b.stat === 'Tracker' && e.stat === 'Tracking') amount *= 1 + b.pct / 100
        push({ stat: sid, amount: Math.round(amount * 1e6) / 1e6, kind: e.kind === 'additive' ? 'mult' : 'flat', group: 'attributes', label: def.name, category: 'Attribute', level })
      }
    }
  }
}
