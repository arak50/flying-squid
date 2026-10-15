'use strict'
const { TUNING_PER_POINT } = require('../data/powers')

module.exports = {
  id: 'tuning',
  collect (ctx, push) {
    const slot = ctx.state.tuning
    if (!slot) return
    for (const [key, [stat, per]] of Object.entries(TUNING_PER_POINT)) {
      const pts = slot[key]
      if (pts) push({ stat, amount: pts * per, group: 'tuning', label: `Tuning (${pts} pts)` })
    }
  }
}
