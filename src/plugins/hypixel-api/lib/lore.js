'use strict'
const { resolveStatName, ITEM_ONLY } = require('./statDefs')

const strip = (s) => String(s).replace(/§[0-9a-fk-or]/gi, '')

// "§7Health: §c+81 §9(+6) §8(+347.49)"
//   first number  = TOTAL outside dungeons (already includes enchants, reforge, gems...)
//   parentheticals = breakdown by colour, except gray §8 which is the
//                    dungeon-only bonus that is NOT part of the shown total.
const LINE = /^§7([A-Za-z' ]+?): §([0-9a-fk-or])([+-]?[\d,]*\.?\d+)(%?)((?:\s*§[0-9a-f]\([+-]?[\d,]*\.?\d+%?\))*)/
const PART = /§([0-9a-f])\(([+-]?[\d,]*\.?\d+)(%?)\)/g

// Colour -> source of a breakdown part. Inferred from observed lore; unknown
// colours are reported as `other` rather than guessed.
const PART_KIND = { 9: 'reforge', d: 'gemstone', 2: 'booster', 8: 'dungeon', e: 'upgrade', 6: 'upgrade' }

const num = (s) => parseFloat(String(s).replace(/,/g, ''))

/**
 * Parse every stat line in an item's lore.
 * @returns {{ stats: Object<string,{total:number, dungeon:number, parts:Array}>,
 *             damage:number|null, accessoryPower:number, gearScore:number|null }}
 */
function parseLore (lore) {
  const out = { stats: {}, damage: null, accessoryPower: 0, gearScore: null }
  for (const line of lore || []) {
    const m = LINE.exec(line)
    if (!m) continue
    const name = m[1]
    const total = num(m[3])
    const rest = m[5] || ''
    if (ITEM_ONLY[name] === 'accessory_power') { out.accessoryPower = total; continue }
    if (ITEM_ONLY[name] === 'damage') { out.damage = total; continue }
    if (ITEM_ONLY[name] === 'gear_score') { out.gearScore = total; continue }
    const id = resolveStatName(name)
    if (!id) continue
    const parts = []
    let dungeon = 0
    let p
    PART.lastIndex = 0
    while ((p = PART.exec(rest))) {
      const amount = num(p[2])
      const kind = PART_KIND[p[1]] || 'other'
      if (kind === 'dungeon') dungeon += amount
      else parts.push({ kind, amount })
    }
    // A stat can appear once; keep the first.
    if (!out.stats[id]) out.stats[id] = { total, dungeon, parts }
  }
  return out
}

// Rarity / type footer: "§9§lRARE DUNGEON BOOTS", "§6§lLEGENDARY ACCESSORY"
const RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC', 'DIVINE', 'SPECIAL', 'VERY SPECIAL', 'ULTIMATE', 'ADMIN']
const FOOTER = new RegExp('^(?:a\\s*)?(' + RARITIES.slice().sort((a, b) => b.length - a.length).join('|') + ')\\s*(.*)$')

function parseFooter (lore) {
  for (let i = (lore || []).length - 1; i >= 0; i--) {
    // drop obfuscated (§k) glyphs used by the recombobulator before stripping codes
    const plain = strip(String(lore[i]).replace(/§k[^§]*/g, '')).replace(/[^\x20-\x7e]/g, '').trim()
    const m = FOOTER.exec(plain)
    if (m) {
      const type = m[2].replace(/\b(DUNGEON|RECOMBOBULATED)\b/g, '').replace(/\s+/g, ' ').trim()
      return { rarity: m[1], type, dungeon: /DUNGEON/.test(m[2]) }
    }
  }
  return null
}

module.exports = { strip, parseLore, parseFooter, RARITIES }
