'use strict'
// Essence Shop perks (player_data.perks), SkyCrypt FORBIDDEN_STATS: permanent_speed/defense/strength +1 per level,
// permanent_health/intelligence +2 per level, and "unbreaking" = +2 Vitality per level.
const { essenceShop } = require('../../data/skycrypt/misc.json')

module.exports = {
  id: 'essence_shop',
  collect (ctx, push) {
    const perks = ctx.profile && ctx.profile.player_data && ctx.profile.player_data.perks
    if (!perks) return
    for (const [perk, per] of Object.entries(essenceShop)) {
      if (perks[perk]) push({ stat: perk.split('_')[1], amount: perks[perk] * per, group: 'essence_shop', label: 'Essence Shop', category: 'Essence Shop', level: perks[perk] })
    }
    if (perks.unbreaking) push({ stat: 'vitality', amount: perks.unbreaking * 2, group: 'essence_shop', label: 'Essence Shop', category: 'Essence Shop', level: perks.unbreaking })
  }
}
