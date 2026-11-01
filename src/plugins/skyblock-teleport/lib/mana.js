'use strict'
// What an ability costs, read from the held item's own tooltip (its `lore` data component) instead of a hard-coded table:
//
//   §6Ability: Instant Transmission  §e§lRIGHT CLICK
//   §7Teleport §a8 blocks§7 ahead of you and
//   §7gain §a+50 §f Speed§7 for §a3 seconds§7.
//   §8Mana Cost: §3§b19                              <- 19, already reduced by Ultimate Wise V and friends
//
//   §6Ability: Ether Transmission  §e§lSNEAK RIGHT CLICK
//   §7Teleport to your targeted block up
//   §7to §a57 blocks §7away.
//   §7§8Soulflow Cost: §31
//   §8Mana Cost: §3§b74
//
// (A Warped Aspect of the Void from the sample API response. The recorded action bar of the same account loses exactly
// 19 per Instant Transmission and 74 per Ether Transmission, never the wiki's 45 / 90.)
// Each "Mana Cost" / "Soulflow Cost" line belongs to the closest "Ability:" header above it; a blank line ends the section.

const nbt = require('prismarine-nbt')

const HEADER = /Ability:\s*(.+?)\s+(?:(?:SNEAK|LEFT|RIGHT)\s+)*(?:CLICK|SNEAK)\s*$/
const MANA = /Mana Cost:\s*([\d,]+(?:\.\d+)?)/
const SOULFLOW = /Soulflow Cost:\s*([\d,]+(?:\.\d+)?)/

const strip = (s) => String(s).replace(/§[0-9a-fk-or]/gi, '')
const num = (s) => parseFloat(String(s).replace(/,/g, ''))

// a typed or simplified NBT text component (or plain string) -> its text without any formatting
function flatten (c) {
  if (c === undefined || c === null) return ''
  if (typeof c === 'string') return c
  if (typeof c === 'object' && c.type && 'value' in c) c = nbt.simplify(c)
  if (Array.isArray(c)) return c.map(flatten).join('')
  return (c.text !== undefined ? String(c.text) : '') + flatten(c.extra)
}

/** Plain-text lore lines of a live prismarine item (26.1 stores them in the `lore` component). [] if it has none. */
function loreLines (item) {
  if (!item || !item.components) return []
  const c = item.components.find(c => c.type === 'lore')
  if (!c || !Array.isArray(c.data)) return []
  return c.data.map(flatten)
}

/**
 * Costs per ability name, from lore lines (legacy "§" strings or plain text).
 * @returns {Object<string, { mana: number|null, soulflow: number|null }>}
 */
function parseAbilityCosts (lines) {
  const out = {}
  let cur = null
  for (const raw of lines || []) {
    const line = strip(raw).trim()
    const h = HEADER.exec(line)
    if (h) { cur = out[h[1].trim()] = { mana: null, soulflow: null }; continue }
    if (!line) { cur = null; continue }
    if (!cur) continue
    const m = MANA.exec(line)
    if (m) cur.mana = num(m[1])
    const s = SOULFLOW.exec(line)
    if (s) cur.soulflow = num(s[1])
  }
  return out
}

/** Costs printed on a live item, e.g. abilityCostsOf(held)['Ether Transmission'] -> { mana: 74, soulflow: 1 }. */
function abilityCostsOf (item) {
  return parseAbilityCosts(loreLines(item))
}

module.exports = { parseAbilityCosts, abilityCostsOf, loreLines }
