'use strict'
// Main SkyBlock Menu. Layout and items are the recording's; only "Stats & Equipment" is wired to a real menu so far,
// the other sections show their recorded items (static) until they are modelled — see docs/skyblock/ARCHITECTURE.md §6.
module.exports = function skyblockMenu (ctx) {
  const { specs, build } = ctx
  const items = new Array(54).fill(null)
  for (const [slot, n] of Object.entries(specs.skyblockMenu)) items[+slot] = build(n)
  const names = Object.fromEntries(Object.entries(specs.skyblockMenu).map(([s, n]) => [s, n.name.replace(/§./g, '')]))
  return {
    title: 'SkyBlock Menu',
    items,
    click ({ slot, area }) {
      if (area !== 'menu') return
      if (slot === 49) return 'close'
      if (slot === 13) { ctx.ui.open(require('./statsEquipment')); return }
      if (names[slot] && names[slot] !== ' ') ctx.ui.say(`§c${names[slot]} is not available yet.`)
    }
  }
}
