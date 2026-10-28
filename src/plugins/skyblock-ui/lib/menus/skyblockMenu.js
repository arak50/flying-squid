'use strict'
// Main SkyBlock Menu. Layout and items are the recording's; only "Stats & Equipment" is wired to a real menu so far,
// the other sections show their recorded items (static) until they are modelled — see docs/skyblock/ARCHITECTURE.md §6.
const { fmt } = require('../format')
const { valueOf } = require('./statsEquipment')

// The Stats & Equipment item lists these stats, always in this order, followed by "and more..." (identical in all 43 recorded
// opens); only the numbers change, so the recorded lines are kept and their values replaced with the current ones.
const HOVER_STAT = /^(.*?)(Speed|Strength|Defense|Crit Damage|Crit Chance|Health|Intelligence) §f[\d.,]+(%?)$/

module.exports = function skyblockMenu (ctx) {
  const { specs, build } = ctx
  const items = new Array(54).fill(null)
  for (const [slot, n] of Object.entries(specs.skyblockMenu)) items[+slot] = build(+slot === 13 && ctx.stats ? liveStats(n, ctx.stats) : n)
  const names = Object.fromEntries(Object.entries(specs.skyblockMenu).map(([s, n]) => [s, n.name.replace(/§./g, '')]))
  return {
    title: 'SkyBlock Menu',
    items,
    click ({ slot, area }) {
      if (area !== 'menu') return
      if (slot === 49) return 'close'
      if (slot === 13) { ctx.ui.open(require('./statsEquipment')); return }
      if (names[slot] === 'Storage') { ctx.ui.open(require('./storage')); return }
      if (names[slot] && names[slot] !== ' ') ctx.ui.say(`§c${names[slot]} is not available yet.`)
    }
  }
}

function liveStats (neutral, stats) {
  return { ...neutral, lore: neutral.lore.map(line => { const m = HOVER_STAT.exec(line); return m ? `${m[1]}${m[2]} §f${fmt(valueOf(stats, m[2]))}${m[3]}` : line }) }
}
