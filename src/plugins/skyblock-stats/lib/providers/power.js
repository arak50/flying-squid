'use strict'
const { powers, MULT_SCALE, STAT_FACTOR } = require('../data/powers')

function powerMultiplier (mp) { return MULT_SCALE * Math.pow(Math.log(1 + 0.0019 * mp), 1.2) }

module.exports = {
  id: 'accessory_power',
  powerMultiplier,
  collect (ctx, push) {
    const id = ctx.state.selectedPower
    const mp = ctx.shared.magicalPower || 0
    if (!id) return
    const p = powers[id.toLowerCase()]
    if (!p) { ctx.warnings.push(`accessory power "${id}" has no data in data/powers.js - no stats applied`); return }
    const m = powerMultiplier(mp)
    const label = `${p.name} Power (${mp} MP)`
    for (const [stat, w] of Object.entries(p.weights)) {
      push({ stat, amount: w * m * (STAT_FACTOR[stat] || 1), group: 'accessory_power', label })
    }
    for (const [stat, v] of Object.entries(p.bonus)) {
      push({ stat, amount: v, group: 'accessory_power', label: `${p.name} unique bonus` })
    }
    ctx.shared.power = { id, name: p.name, magicalPower: mp, multiplier: m }
  }
}
