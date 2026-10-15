'use strict'
// Modifier view of a stat computation — the shape of Hypixel's "<Stat> ➜ Flat Bonuses / Additive Buffs" pages
// (see docs/skyblock/ARCHITECTURE.md §3.3).
//
//   Modifier { stat, kind:'flat'|'additive', category, label, value, group, from:{ name, item }|null, level? }
//
// Item contributions are split the way the recording shows: Base Value (Basic), Enchantment, Reforge, Attachment
// (Hot Potato Books), Gemstone. Anything the lore does not let us attribute stays in Base Value so totals stay exact.

const GRANTS = /Grants \+([\d,.]+)(%?)\s+(.+?)\.?$/
const ENCH = /^([A-Za-z' -]+? [IVXLCDM]+)(?:,|$)/
const glyphless = s => String(s).replace(/§./g, '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim()
const num = s => parseFloat(String(s).replace(/,/g, ''))
const { resolveStatName } = require('../../hypixel-api/lib/statDefs')

const GROUP_CATEGORY = { base: 'Innate', sb_level: 'SkyBlock Levels', skills: 'Skill', power: 'Thaumaturgist Power', effects: 'Potion Effect' }
const ITEM_GROUPS = { armor: 'Armor', equipment: 'Equipment', accessories: 'Accessory Bag', held: 'Held Item' }
// gem type -> stat, only the pairs present in the recordings
const GEM_BY_STAT = { health: 'Ruby', defense: 'Amethyst', foraging_fortune: 'Citrine' }

/** [{ label:'Growth V', stat:'health', amount:75 }] from the enchantment description lines in an item's lore */
function enchantGrants (lore) {
  const out = []
  const lines = (lore || []).map(glyphless)
  for (let i = 0; i + 1 < lines.length; i++) {
    const e = ENCH.exec(lines[i]); const g = GRANTS.exec(lines[i + 1])
    if (!e || !g) continue
    const stat = resolveStatName(g[3])
    if (stat) out.push({ label: e[1], stat: stat.id || stat, amount: num(g[1]) })
  }
  return out
}

const cap = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

/** Split one item's contribution to one stat into modifier rows. */
function splitItem (item, entry, stat) {
  const total = entry.amount
  const parts = entry.parts || []
  const sum = kind => parts.filter(p => p.kind === kind).reduce((a, p) => a + p.amount, 0)
  const ench = enchantGrants(item.lore).filter(g => g.stat === stat)
  const enchSum = ench.reduce((a, g) => a + g.amount, 0)
  const reforge = sum('reforge'); const gem = sum('gemstone'); const upgrade = sum('upgrade')
  const base = total - enchSum - reforge - gem - upgrade
  const from = { name: item.displayName || item.name, item }
  const rows = []
  const add = (category, label, value, extra) => { if (value) rows.push({ stat, kind: 'flat', category, label, value, group: entry.group, from, ...extra }) }
  add('Basic', 'Base Value', base)
  for (const g of ench) add('Enchantment', g.label, g.amount)
  add('Reforge', cap(item.extra && item.extra.modifier) || 'Reforge', reforge)
  add('Attachment', 'Hot Potato Books', upgrade)
  add('Gemstone', GEM_BY_STAT[stat] || 'Gemstone', gem)
  return rows
}

/**
 * @param result  engine result ({ stats: { id: { total, breakdown:[{group,label,amount,kind,itemId,parts}] } } })
 * @param items   { armor:[SbItem], equipment:[SbItem], accessories:[SbItem], held:SbItem }
 * @returns { [statId]: { flat: Modifier[], additive: Modifier[], sources: Modifier[] } }
 *   `sources` is the un-flattened view: one row per item (Armor / Equipment / Accessory Bag), the others as in `flat`.
 */
function buildModifiers (result, items) {
  const all = {}
  const find = (group, entry) => {
    const pool = group === 'held' ? [items.held] : (items[group] || [])
    return pool.find(it => it && it.id === entry.itemId && (it.displayName === entry.label || it.name === entry.label || !entry.label)) ||
      pool.find(it => it && it.id === entry.itemId)
  }
  for (const [stat, s] of Object.entries(result.stats)) {
    const flat = []; const additive = []; const sources = []
    for (const e of s.breakdown) {
      const kind = e.kind === 'mult' ? 'additive' : 'flat'
      if (ITEM_GROUPS[e.group] && e.itemId) {
        const item = find(e.group, e)
        if (item && kind === 'flat') {
          flat.push(...splitItem(item, e, stat))
          sources.push({ stat, kind, category: ITEM_GROUPS[e.group], label: item.displayName || item.name, value: e.amount, group: e.group, from: { name: item.displayName || item.name, item }, parts: e.parts })
          continue
        }
      }
      let label = e.label
      if (e.group === 'base') label = 'Base Value'
      if (e.group === 'power') label = 'Power: ' + String(e.label).replace(/ Power.*$/, '')
      const m = { stat, kind, category: e.category || GROUP_CATEGORY[e.group] || cap(e.group), label, value: e.amount, group: e.group, from: null, level: e.level }
      ;(kind === 'additive' ? additive : flat).push(m)
      sources.push(m)
    }
    const rank = (a, b) => b.value - a.value // stable: ties keep engine order (boots, leggings, chestplate, helmet)
    all[stat] = { flat: flat.sort(rank), additive: additive.sort(rank), sources: sources.sort(rank) }
  }
  return all
}

module.exports = { buildModifiers, splitItem, enchantGrants }
