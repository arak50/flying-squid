'use strict'
const overrides = require('../data/accessoryFamilies.json')
const RARITY_RANK = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4, MYTHIC: 5, SPECIAL: 6, VERY_SPECIAL: 7 }

// Heuristic family key: BAT_TALISMAN / BAT_RING / BAT_ARTIFACT -> BAT,
// CAMPFIRE_TALISMAN_7 -> CAMPFIRE, BEASTMASTER_CREST_RARE -> BEASTMASTER_CREST.
// Anything it can't group is its own family, so the failure mode is double
// counting, never dropping. Add exact ids to data/accessoryFamilies.json.
function familyOf (id) {
  if (!id) return null
  if (overrides[id]) return overrides[id]
  return id
    .replace(/_(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC)$/, '')
    .replace(/_\d+$/, '')
    .replace(/_(TALISMAN|RING|ARTIFACT|RELIC)$/, '')
}

module.exports = {
  id: 'accessories',
  familyOf,
  collect (ctx, push) {
    const best = new Map()
    for (const it of ctx.sources.accessories) {
      if (!it || !it.id) continue
      // Only one hat accessory ("hatccessory") counts. Verified against the sample:
      // two 3-MP hats made MP 781 vs the API's highest_magical_power 778.
      const fam = (it.footer && /^HATC?CESSORY$/.test(it.footer.type)) ? '__HATCCESSORY' : familyOf(it.id)
      const cur = best.get(fam)
      const score = (i) => i.parsed.accessoryPower * 10 + (RARITY_RANK[(i.rarity || '').replace(' ', '_')] || 0)
      if (!cur || score(it) > score(cur.item)) best.set(fam, { item: it, ignored: cur ? [...cur.ignored, cur.item.id] : [] })
      else cur.ignored.push(it.id)
    }
    let mp = 0
    const active = []
    for (const [family, { item, ignored }] of best) {
      mp += item.parsed.accessoryPower
      active.push({ family, id: item.id, name: item.name, power: item.parsed.accessoryPower, ignored })
      for (const [stat, s] of Object.entries(item.parsed.stats)) {
        push({ stat, amount: s.total, group: 'accessories', label: item.name, itemId: item.id, parts: s.parts })
      }
    }
    // Hegemony Artifact counts its Accessory Power twice.
    const heg = active.find(a => a.id === 'HEGEMONY_ARTIFACT')
    if (heg) mp += heg.power
    ctx.shared.magicalPower = mp
    ctx.shared.accessories = { active, count: ctx.sources.accessories.length, unique: active.length }
  }
}
