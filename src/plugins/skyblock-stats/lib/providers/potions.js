'use strict'
// Active potion effects from the profile (player_data.active_effects: [{effect, level}]), values per level from SkyCrypt POTION_EFFECTS.
// Effects the table has no bonuses for add nothing; unknown effect ids raise a warning rather than being guessed.
const potions = require('../../data/skycrypt/potions.json')

module.exports = {
  id: 'potions',
  collect (ctx, push) {
    const active = ctx.profile && ctx.profile.player_data && ctx.profile.player_data.active_effects
    for (const e of active || []) {
      const def = potions[e.effect]
      if (!def) { ctx.warnings.push(`potion effect "${e.effect}" has no data - no stats applied`); continue }
      for (const [stat, values] of Object.entries(def.bonuses)) {
        const amount = values[(e.level || 1) - 1]
        if (amount) push({ stat, amount, group: 'potions', label: def.name, category: 'Potion Effect', level: e.level })
      }
    }
  }
}
