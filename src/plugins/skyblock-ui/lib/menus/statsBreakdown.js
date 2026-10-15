'use strict'
// "Your Stats Breakdown", "Stats ➜ <Stat>" and "<Stat> ➜ Flat Bonuses / Additive Buffs" — from statsmenupackets.txt.
//
//   Your Stats Breakdown   header (4) + one row per stat (10-16, 19-25, 28-34, 37-43), Go Back 48, Close 49, Toggle Show All 50
//   click a stat           -> "Stats ➜ X" overview when the stat has additive buffs, otherwise straight to "X ➜ Flat Bonuses"
//   modifier pages         28 rows per page, Previous 45 / Next 53, Go Back 48, Close 49, Group By Category 50, Flatten 51
//
// Not recorded, therefore not invented: the page behind "Click to dig even deeper!" on grouped rows, Group+un-flattened
// together, what "Show all stats: No" hides (it hides zero-value stats here), anything for stats missing from the recording.
const { fmt, signed } = require('../format')
const { resolveStatName } = require('../../../hypixel-api/lib/statDefs')
const { statLine, valueOf } = require('./statsEquipment')

const ROW_SLOTS = [...[10, 11, 12, 13, 14, 15, 16], ...[19, 20, 21, 22, 23, 24, 25], ...[28, 29, 30, 31, 32, 33, 34], ...[37, 38, 39, 40, 41, 42, 43]]
const strip = s => String(s).replace(/§./g, '')
const PAPER = { type: 'paper', count: 1, name: null, lore: [], extra: null, extraNbt: null, model: null, style: null, skin: null, skinSig: null, skinId: null, color: null, glint: false, ench: null, unbreakable: false }

// per-player toggles recorded in the menus (Group By Category OFF, Flatten Stats Menu ON, Show all stats Yes); saved with the profile
const settings = ctx => {
  const s = ctx.profile.settings
  s.statMenu = Object.assign({ group: false, flatten: true, showAll: true }, s.statMenu)
  return s.statMenu
}
const statId = name => { const r = resolveStatName(name); return (r && r.id) || r }

function findSpec (specs, name) {
  for (const [cat, c] of Object.entries(specs.categories)) { const s = c.stats.find(x => x.name === name); if (s) return { ...s, category: cat } }
  return null
}

// ---- derived lines, one builder per stat whose lines are evidenced by the recordings -------------------------------------
// each returns lore lines to put after the description; formulas re-derived from the recorded numbers
const DERIVED = {
  defense: (v, c) => {
    const dr = v / (v + 100); const hp = c.value('Health')
    return [`§7Flat: §a${signed(c.flat('defense'))}`, `§7Additive: §a${signed(c.add('defense'), 1)}%`, '', `§7Damage Reduction: §a${fmt(dr * 100, 1)}%`, `§7Effective Health: §c${fmt(hp * (1 + v / 100), 0)}❤`]
  },
  true_defense: v => [`§7Damage Reduction: §f${fmt(v / (v + 100) * 100, 1)}%`],
  strength: v => [`§7Damage Multiplier: §c${fmt(1 + v / 100, 1)}x`],
  crit_damage: (v, c) => [`§7Damage Multiplier: §9${fmt(1 + v / 100, 1)}x`, `§7Critical Chance: §9${fmt(c.value('Crit Chance'), 1)}%`],
  attack_speed: (v, c) => [`§7Flat: §e${signed(c.flat('attack_speed'))}`, '§7Stat Cap: §e100 Attack Speed', '', `§7You now attack §a${fmt(v, 0)}% §7faster!`],
  ferocity: (v, c) => [`§7Flat: §c${signed(c.flat('ferocity'))}`, '§7Stat Cap: §c500 Ferocity', '', `§7Base extra strikes: §c${Math.floor(v / 100)}`, `§7Chance for 1 more: §c${fmt(v % 100, 1)}%`],
  swing_range: (v, c) => [`§7Flat: §e${signed(c.flat('swing_range'))}`, '§7Stat Cap: §e15 Swing Range', ...(v <= 3 ? ['', '§8Your swing range isn\'t modified.'] : [])],
  intelligence: v => [`§7Magic Damage: §b+§b${fmt(v)}%`, `§7Mana Pool: §b${fmt(100 + v)}`],
  ability_damage: v => [`§7Damage Multiplier: §c${fmt(1 + v / 100, 1)}x`]
}

function calc (ctx) {
  const { stats, specs } = ctx
  const mods = stats.statModifiers()
  return {
    value: name => valueOf(stats, name),
    flat: id => ((mods[id] || {}).flat || []).reduce((a, m) => a + m.value, 0),
    add: id => ((mods[id] || {}).additive || []).reduce((a, m) => a + m.value, 0),
    mods,
    specs
  }
}

// description lines of the recorded row (everything before its first blank line)
const descOf = row => { const i = row.lore.indexOf(''); return i < 0 ? row.lore : row.lore.slice(0, i) }

function statRowItem (ctx, c, spec, rowSpec) {
  const id = statId(spec.name); const v = valueOf(ctx.stats, spec.name)
  const base = rowSpec ? { ...rowSpec } : { ...PAPER } // unknown icon -> paper
  const lore = rowSpec ? [...descOf(rowSpec)] : []
  const derived = v !== 0 && DERIVED[id] ? DERIVED[id](v, c) : null
  if (derived) lore.push('', ...derived)
  lore.push('')
  if (v === 0) lore.push('§8You have none of this stat!')
  lore.push('§eClick to view!')
  return { ...base, name: `§${spec.color}${spec.glyph} ${spec.name} §f${fmt(v, 1)}`, lore }
}

// ==== Your Stats Breakdown =====================================================================================
function page (ctx, category) {
  const { specs, build, stats } = ctx
  const cat = specs.categories[category]; const sp = specs.statPages[category]
  const st = settings(ctx)
  const c = calc(ctx)
  const items = new Array(54).fill(null).map((_, i) => (ROW_SLOTS.includes(i) ? null : build(specs.items.filler)))
  const header = { ...(sp ? sp.header : cat.base), lore: [...cat.desc, ...cat.stats.map(s => statLine(s, valueOf(stats, s.name)))] }
  items[4] = build(header)
  const rows = cat.stats.filter(s => st.showAll || valueOf(stats, s.name) !== 0)
  const bySlot = {}
  rows.forEach((spec, i) => {
    if (i >= ROW_SLOTS.length) return
    const rowSpec = sp && Object.values(sp.rows).find(r => strip(r.name).replace(/^\S*\s/, '').replace(/ [\d.,]+$/, '').trim() === spec.name)
    items[ROW_SLOTS[i]] = build(statRowItem(ctx, c, spec, rowSpec)); bySlot[ROW_SLOTS[i]] = spec
  })
  items[48] = build({ ...specs.controls.goBackStats })
  items[49] = build(specs.items.close)
  items[50] = build({ ...specs.controls.toggleShowAll, lore: specs.controls.toggleShowAll.lore.map(l => l.replace(/(Show all stats: §)[ac]\S+/, st.showAll ? '$1aYes' : '$1cNo')) })
  return {
    title: 'Your Stats Breakdown',
    items,
    click ({ slot, area }) {
      if (area !== 'menu') return
      if (slot === 48) { ctx.ui.open(require('./statsEquipment')); return }
      if (slot === 49) return 'close'
      if (slot === 50) { st.showAll = !st.showAll; return 'reopen' }
      const spec = bySlot[slot]; if (!spec) return
      const m = c.mods[statId(spec.name)]
      if (m && m.additive.length) ctx.ui.open(cx => overview(cx, spec.name, category))
      else ctx.ui.open(cx => modifiers(cx, spec.name, 'flat', 1, category))
    }
  }
}

// ==== Stats ➜ <Stat> ===========================================================================================
function overview (ctx, name, category) {
  const { specs, build, stats } = ctx
  const spec = findSpec(specs, name); const id = statId(name); const c = calc(ctx)
  const m = c.mods[id] || { flat: [], additive: [], sources: [] }
  const v = valueOf(stats, name)
  const sp = specs.statPages[spec.category]; const rowSpec = sp && Object.values(sp.rows).find(r => strip(r.name).includes(name))
  const items = new Array(54).fill(null).map(() => build(specs.items.filler))
  const col = spec.color
  const lore = rowSpec ? [...descOf(rowSpec)] : []
  const d = DERIVED[id] ? DERIVED[id](v, c) : null
  lore.push('', ...(d || [`§7Flat: §${col}${signed(c.flat(id))}`, `§7Additive: §${col}${signed(c.add(id), 1)}%`]))
  items[4] = build({ ...(rowSpec || PAPER), name: `§${col}${spec.glyph} ${name} §f${fmt(v, 0)}`, lore })

  const preview = (rows, fmtRow) => { const out = rows.slice(0, 7).map(fmtRow); if (rows.length > 7) out.push(`  §8And ${rows.length - 7} more...`); return out }
  items[21] = build({ ...PAPER, name: `§${col}${spec.glyph} Flat Bonuses`, lore: [`§8${name} Stat`, '§7All of these are summed together', '§7into a base amount.', '', ...preview(m.sources.filter(x => x.kind === 'flat'), r => ` §${col}${signed(r.value)} §f${strip(r.label)}`), '', `§7Adds up to: §${col}${signed(c.flat(id))} ${name}`, '', '§eClick to dig deeper!'] })
  items[22] = build(specs.items.arrowRight)
  items[23] = build({ ...(specs.modifierIcons.Additive || { ...PAPER, type: 'book' }), name: `§${col}${spec.glyph} Additive Buffs`, lore: [`§8${name} Stat`, '§7These stat bonuses are added up', '§7and then converted into the', '§7(additive) multiplier.', '', ...preview(m.additive, r => ` §${col}${fmt(r.value, 1)}% §f${strip(r.label)}`), '', `§7Adds up to: §${col}${signed(c.add(id), 1)}%`, `§7As multiplier: §${col}${fmt(1 + c.add(id) / 100, 2)}x`, '§8Multiplied with flat!', '', '§eClick to dig deeper!'] })
  items[48] = build({ ...specs.controls.goBack })
  items[49] = build(specs.items.close)
  return {
    title: `Stats ➜ ${name}`,
    items,
    click ({ slot, area }) {
      if (area !== 'menu') return
      if (slot === 48) { ctx.ui.open(cx => page(cx, category || spec.category)); return }
      if (slot === 49) return 'close'
      if (slot === 21) ctx.ui.open(cx => modifiers(cx, name, 'flat', 1, category))
      if (slot === 23) ctx.ui.open(cx => modifiers(cx, name, 'additive', 1, category))
    }
  }
}

// ==== <Stat> ➜ Flat Bonuses / Additive Buffs =====================================================================
function rowIcon (ctx, m) {
  const { specs } = ctx
  if (m.from && m.from.item && m.from.item.live) {
    const n = ctx.conv.neutralFromItem(m.from.item.live)
    return { ...PAPER, type: n.type, style: n.style, glint: !!(n.glint || n.ench), skin: n.skin, skinSig: n.skinSig, skinId: n.skinId, color: n.color, model: n.model }
  }
  const exact = specs.modifierIcons[`${m.category}|${m.label}`]
  if (exact) return { ...exact, lore: [] }
  if (['Innate', 'SkyBlock Levels'].includes(m.category) && specs.modifierIcons[m.category]) return { ...specs.modifierIcons[m.category], lore: [] }
  return { ...PAPER } // icon not recorded -> paper
}

function modifierRow (ctx, spec, m, kind, flattened) {
  const col = spec.color
  const value = kind === 'additive' ? `${fmt(m.value, 1)}%` : signed(m.value)
  const desc = (ctx.specs.modifierCategories[m.category] || {}).desc || []
  const lore = [`§8${m.category}`, '', `§7Value: §${col}${value}`]
  if (m.parts && !flattened) { /* per-source row */ }
  if (!flattened && m.from) {
    const sub = ctx.stats.statModifiers()[statId(spec.name)].flat.filter(x => x.from && x.from.item === m.from.item)
    lore.push('', '§7Flat Bonuses:', ...sub.map(x => ` §${col}${signed(x.value)} §f${strip(x.label)}`))
  } else if (m.from) lore.push('', '§7Modifier flattened from:', m.from.name)
  if (desc.length) lore.push('', ...desc)
  return { ...rowIcon(ctx, m), name: `§${col}${spec.glyph} ${m.label}`, lore }
}

function groupRow (ctx, spec, cat, rows, kind) {
  const col = spec.color
  const total = rows.reduce((a, m) => a + m.value, 0)
  const lines = rows.slice(0, 7).map(m => ` §${col}${signed(m.value)} §f${strip(m.label)}`)
  if (rows.length > 7) lines.push(`  §8And ${rows.length - 7} more...`)
  const desc = (ctx.specs.modifierCategories[cat] || {}).desc || []
  return { ...(ctx.specs.groupIcons[cat] || PAPER), name: `§${col}${spec.glyph} Category: ${cat}`, lore: ['§8Grouped', '', `§7Value: §${col}${kind === 'additive' ? fmt(total, 1) + '%' : signed(total)}`, '', ...lines, ...(desc.length ? ['', ...desc] : []), '', '§eClick to dig even deeper!'] }
}

function modifiers (ctx, name, kind, pageNo, category) {
  const { specs, build } = ctx
  const spec = findSpec(specs, name); const id = statId(name)
  const st = settings(ctx)
  const m = ctx.stats.statModifiers()[id] || { flat: [], additive: [], sources: [] }
  const base = kind === 'additive' ? m.additive : (st.flatten ? m.flat : m.sources.filter(x => x.kind === 'flat'))
  let entries
  if (st.group && st.flatten) {
    const groups = new Map()
    for (const r of base) { if (!groups.has(r.category)) groups.set(r.category, []); groups.get(r.category).push(r) }
    entries = [...groups.entries()].map(([cat, rows]) => (rows.length > 1 ? { grouped: true, cat, rows } : { row: rows[0] }))
      .sort((a, b) => (b.grouped ? b.rows.reduce((s, r) => s + r.value, 0) : b.row.value) - (a.grouped ? a.rows.reduce((s, r) => s + r.value, 0) : a.row.value))
  } else entries = base.map(row => ({ row }))
  const pages = Math.max(1, Math.ceil(entries.length / ROW_SLOTS.length))
  const p = Math.min(Math.max(1, pageNo), pages)
  // outside the row area every slot is filler; unused row slots are empty (as recorded)
  const items = new Array(54).fill(null).map((_, i) => (ROW_SLOTS.includes(i) ? null : build(specs.items.filler)))
  entries.slice((p - 1) * ROW_SLOTS.length, p * ROW_SLOTS.length).forEach((e, i) => {
    items[ROW_SLOTS[i]] = build(e.grouped ? groupRow(ctx, spec, e.cat, e.rows, kind) : modifierRow(ctx, spec, e.row, kind, st.flatten))
  })
  items[48] = build({ ...specs.controls.goBack })
  items[49] = build(specs.items.close)
  if (kind === 'flat') {
    const g = st.group ? specs.controls.group_on : specs.controls.group_off
    const f = st.flatten ? specs.controls.flatten_on : specs.controls.flatten_off
    if (g) items[50] = build(g)
    if (f) items[51] = build(f)
  }
  if (p > 1) items[45] = build({ ...specs.controls.prevPage, lore: [`§ePage ${p - 1}`] })
  if (p < pages) items[53] = build({ ...specs.controls.nextPage, lore: [`§ePage ${p + 1}`] })
  return {
    title: `${pages > 1 ? `(${p}/${pages}) ` : ''}${name} ➜ ${kind === 'additive' ? 'Additive Buffs' : 'Flat Bonuses'}`,
    items,
    click ({ slot, area }) {
      if (area !== 'menu') return
      if (slot === 49) return 'close'
      if (slot === 48) {
        const back = m.additive.length ? cx => overview(cx, name, category || spec.category) : cx => page(cx, category || spec.category)
        ctx.ui.open(back); return
      }
      if (slot === 45 && p > 1) { ctx.ui.open(cx => modifiers(cx, name, kind, p - 1, category)); return }
      if (slot === 53 && p < pages) { ctx.ui.open(cx => modifiers(cx, name, kind, p + 1, category)); return }
      if (kind === 'flat' && slot === 50) { st.group = !st.group; ctx.ui.open(cx => modifiers(cx, name, kind, 1, category)); return }
      if (kind === 'flat' && slot === 51) { st.flatten = !st.flatten; ctx.ui.open(cx => modifiers(cx, name, kind, 1, category)) }
    }
  }
}

module.exports = { page, overview, modifiers, ROW_SLOTS, DERIVED }
