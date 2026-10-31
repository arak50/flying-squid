'use strict'
const { CATEGORIES, STATS, formatStat } = require('../../hypixel-api/lib/statDefs')
const { GROUP_LABEL } = require('./engine')

const RARITY_COLOR = { COMMON: '§f', UNCOMMON: '§a', RARE: '§9', EPIC: '§5', LEGENDARY: '§6', MYTHIC: '§d', DIVINE: '§b', SPECIAL: '§c', 'VERY SPECIAL': '§c', ULTIMATE: '§4' }
const ARMOR_SLOTS = ['boots', 'leggings', 'chestplate', 'helmet'] // API order
const EQUIP_SLOTS = ['necklace', 'cloak', 'belt', 'gloves']

const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US')
const signed = (n) => (n >= 0 ? '+' : '-') + fmt(Math.abs(n))

function statLore (s, opts) {
  const def = STATS[s.id]
  const lines = [formatStat(def, s.total, opts), '']
  lines.push('§8Breakdown')
  let lastGroup = null
  for (const b of s.breakdown) {
    if (b.kind === 'cap') continue
    if (b.kind === 'mult') { lines.push(`§7${GROUP_LABEL[b.group] || b.group}: §d+${fmt(b.amount)}%`); continue }
    if (b.group === 'base') { lines.push(`§7Base: §f${signed(b.amount)}`); continue }
    if (b.group !== lastGroup) { lines.push(`§7${GROUP_LABEL[b.group] || b.group}: §f${signed(s.breakdown.filter(x => x.group === b.group && x.kind !== 'mult').reduce((a, x) => a + x.amount, 0))}`); lastGroup = b.group }
    if (opts.itemLines) lines.push(`  §8- §7${b.label} §f${signed(b.amount)}${b.parts && b.parts.length ? ' §8(' + b.parts.map(p => p.kind + ' ' + signed(p.amount)).join(', ') + ')' : ''}`)
  }
  if (s.cap != null) lines.push('', `§7Cap: §f${fmt(s.cap)}${s.capped ? ' §c(capped, uncapped ' + fmt(s.raw) + ')' : ''}`)
  return lines
}

const itemSummary = (it, slot) => it && ({ slot, id: it.id, name: it.name, displayName: it.displayName, rarity: it.rarity, color: RARITY_COLOR[it.rarity] || '§f', lore: it.lore })

/**
 * Data model for the "Your Equipment and Stats" menu. Rendering (chest window,
 * glyphs, click handling) is intentionally left to the UI layer; every number and
 * pre-formatted lore line it needs is here.
 */
function buildStatsMenu (result, sources = {}, options = {}) {
  const opts = { legacy: false, hideZero: true, itemLines: true, ...options }
  const categories = CATEGORIES.filter(c => c.id !== 'rift' || result.context.dimension === 'rift').map(c => {
    const stats = Object.values(result.stats)
      .filter(s => s.category === c.id && (!opts.hideZero || Math.abs(s.total) > 1e-9 || s.base !== 0 || s.breakdown.length))
      .map(s => ({
        id: s.id,
        name: s.name,
        total: s.total,
        display: formatStat(STATS[s.id], s.total, opts),
        capped: s.capped,
        cap: s.cap,
        breakdown: s.breakdown,
        lore: statLore(s, opts)
      }))
    return { id: c.id, name: c.name, stats }
  }).filter(c => c.stats.length)

  const armor = (sources.armor || []).map((it, i) => itemSummary(it, ARMOR_SLOTS[i])).reverse() // helmet first
  const equipment = (sources.equipment || []).map((it, i) => itemSummary(it, EQUIP_SLOTS[i]))
  return {
    title: 'Your Equipment and Stats',
    categories,
    derived: result.derived,
    equipment: { armor, equipment, held: result.held, accessories: result.accessories && { unique: result.accessories.unique, total: result.accessories.count }, magicalPower: result.magicalPower, power: result.power },
    context: result.context,
    warnings: result.warnings
  }
}

module.exports = { buildStatsMenu, statLore }
