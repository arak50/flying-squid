'use strict'
// Temporary / external modifiers (potions, power orbs, buffs, pets later...).
// modifier = { id, label, group?, stats:{stat:flat}, multipliers:{stat:percent}, caps:{stat:amount}, expiresAt? }
module.exports = {
  id: 'effects',
  collect (ctx, push) {
    const now = Date.now()
    for (const m of ctx.modifiers) {
      if (m.expiresAt && m.expiresAt <= now) continue
      for (const [stat, amount] of Object.entries(m.stats || {})) push({ stat, amount, group: m.group || 'effects', label: m.label || m.id })
      for (const [stat, amount] of Object.entries(m.multipliers || {})) push({ stat, amount, kind: 'mult', group: m.group || 'effects', label: m.label || m.id })
      for (const [stat, amount] of Object.entries(m.caps || {})) push({ stat, amount, kind: 'cap', group: m.group || 'effects', label: m.label || m.id })
    }
  }
}
