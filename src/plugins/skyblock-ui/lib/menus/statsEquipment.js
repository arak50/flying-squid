'use strict'
// "Stats & Equipment" — layout, texts and behaviour from statsmenupackets.txt.
//   equipment: necklace 10, cloak 19, belt 28, gloves 37     armour: helmet 11, chestplate 20, leggings 29, boots 38
//   clicking a worn piece unequips it into the first free inventory slot (hotbar first); clicking an equippable piece in the
//   inventory part of the window equips it. Every action re-opens the window (new id), like the real server.
const { fmt } = require('../format')
const { resolveStatName } = require('../../../hypixel-api/lib/statDefs')

const SLOTS = [
  { key: 'NECKLACE', slot: 10, container: 'equipment', index: 0, empty: 'EQUIPMENT' },
  { key: 'CLOAK', slot: 19, container: 'equipment', index: 1, empty: 'EQUIPMENT' },
  { key: 'BELT', slot: 28, container: 'equipment', index: 2, empty: 'EQUIPMENT' },
  { key: 'GLOVES', slot: 37, container: 'equipment', index: 3, empty: 'EQUIPMENT' },
  { key: 'HELMET', slot: 11, container: 'armor', index: 0, empty: 'HELMET' },
  { key: 'CHESTPLATE', slot: 20, container: 'armor', index: 1, empty: 'CHESTPLATE' },
  { key: 'LEGGINGS', slot: 29, container: 'armor', index: 2, empty: 'LEGGINGS' },
  { key: 'BOOTS', slot: 38, container: 'armor', index: 3, empty: 'BOOTS' }
]
// slots the recording shows as plain glass panes
const FILLER = [0, 1, 3, 4, 5, 6, 7, 8, 9, 12, 13, 17, 18, 21, 22, 26, 27, 30, 31, 33, 35, 36, 39, 40, 41, 42, 43, 44, 45, 46, 52, 53]
const strip = s => String(s).replace(/§./g, '')

/**
 * Equipment is shown without its "Right-click to equip!" and "This item can be reforged!" lines (and the blank line that
 * separated them); everything else, e.g. "* Soulbound *", stays. Derived from the 4 recorded equipment pieces.
 */
function menuLore (lore) {
  const out = lore.filter(l => !/^(Right-click to equip!|This item can be reforged!)$/.test(strip(l).trim()))
  return out.filter((l, i) => !(strip(l).trim() === '' && i > 0 && strip(out[i - 1]).trim() === ''))
}

function statLine (spec, value, struck = false) {
  const v = fmt(value) + (spec.suffix || '')
  return struck ? ` §7§m${spec.glyph} ${spec.name} ${v}` : ` §${spec.color}${spec.glyph} ${spec.name} §f${v}`
}

const valueOf = (stats, name) => { const id = resolveStatName(name); return stats ? stats.get((id && id.id) || id) || 0 : 0 }

module.exports = function statsEquipment (ctx) {
  const { specs, build, profile, stats, conv, core, member } = ctx
  const items = new Array(54).fill(null)
  for (const s of FILLER) items[s] = build(specs.items.filler)
  // Slot 2 is the item in the player's hand, shown exactly as it is in the inventory (recorded with the star and with a sword).
  // What it shows for an empty hand was never recorded, so it stays empty.
  const inHand = profile.container('inventory').get(ctx.player.heldItemSlot || 0)
  if (inHand) items[2] = build(conv.neutralFromItem(inHand))
  if (specs.items.goBack) items[48] = build({ ...specs.items.goBack, lore: ['§7To SkyBlock Menu'] })
  if (specs.items.close) items[49] = build(specs.items.close)

  for (const e of SLOTS) {
    const item = profile.container(e.container).get(e.index)
    items[e.slot] = item ? build({ ...conv.neutralFromItem(item), lore: menuLore(conv.neutralFromItem(item).lore) }) : build(specs.empty[e.empty])
  }

  for (const c of Object.values(specs.categories)) {
    const lore = [...c.desc]
    for (const s of c.stats) lore.push(statLine(s, valueOf(stats, s.name), ctx.isStruck(s.name)))
    lore.push(...c.footer)
    items[c.slot] = build({ ...c.base, lore })
  }

  if (specs.items.activeEffects) {
    const n = ((member.player_data || {}).active_effects || []).length
    items[50] = build({ ...specs.items.activeEffects, lore: specs.items.activeEffects.lore.map(l => l.replace(/(Currently Active: §e)\d+/, `$1${n}`)) })
  }

  return {
    title: 'Stats & Equipment',
    items,
    click ({ player, slot, area, index }) {
      if (area === 'inventory') { // equip the clicked piece
        const r = core.equip(player, { container: 'inventory', index })
        return r.ok ? 'reopen' : undefined // other outcomes were not recorded (see ARCHITECTURE §8)
      }
      const eq = SLOTS.find(e => e.slot === slot)
      if (eq) return core.unequip(player, eq.key).ok ? 'reopen' : undefined
      if (slot === 49) return 'close'
      if (slot === 48 || slot === 2) { ctx.ui.open(require('./skyblockMenu')); return }
      const cat = Object.entries(specs.categories).find(([, c]) => c.slot === slot)
      if (cat) { ctx.ui.open(c => require('./statsBreakdown').page(c, cat[0])); return }
      if (slot === 50) ctx.ui.say('§cActive Effects is not available yet.')
    }
  }
}
module.exports.menuLore = menuLore
module.exports.statLine = statLine
module.exports.valueOf = valueOf
module.exports.SLOTS = SLOTS
