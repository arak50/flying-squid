'use strict'
// Armour, held weapon/tool and equipment (necklace/cloak/belt/gloves).
// Stats come straight from the item's lore stat lines, which Hypixel already
// computes with enchants, reforge, gems, stars etc. folded into the total.
function addItem (ctx, push, item, group) {
  const dungeon = !!ctx.context.dungeon
  for (const [stat, s] of Object.entries(item.parsed.stats)) {
    push({ stat, amount: s.total + (dungeon ? s.dungeon : 0), group, label: item.name, itemId: item.id, parts: s.parts, dungeonBonus: dungeon ? s.dungeon : 0 })
  }
}

module.exports = {
  id: 'items',
  collect (ctx, push) {
    const { armor, held, equipment } = ctx.sources
    for (const it of armor) if (it) addItem(ctx, push, it, 'armor')
    for (const it of equipment) if (it) addItem(ctx, push, it, 'equipment')
    if (held) {
      ctx.shared.held = { name: held.name, id: held.id, role: held.role, counts: held.countsWhenHeld, damage: held.parsed.damage }
      if (held.countsWhenHeld) addItem(ctx, push, held, 'held')
    } else ctx.shared.held = null
  }
}
