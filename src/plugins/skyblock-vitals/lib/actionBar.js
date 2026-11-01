'use strict'
const { STATS } = require('../../hypixel-api/lib/statDefs')

// SkyBlock action bar, RECORDED from Hypixel (protocol 26.1, 131 packets, one every ~0.5 s) as a plain text component, the
// segments separated by five spaces, a trailing five spaces after the mana segment (U+E010 / U+E008 / U+E003 / U+E067 are the
// resource-pack glyphs, matching statDefs `icon`):
//
//   §c4,124/4,124\uE010     §a1,008§a\uE008 Defense     §b953/953\uE003 Mana     "
//   §64,499/4,124\uE010     §7\uE067 §bColosseum        §b687/953\uE003 Mana     "   gold health = absorption; zone replaces Defense
//   §64,499/4,124\uE010     §a1,008§a\uE008 Defense     §c§lNOT ENOUGH MANA"       replaces only the mana segment, no trailing spaces
//
// NOT in the recording (UNVERIFIED): the overflow segment, a mana-cost flash and the rounding of the numbers.
const n = (v) => Math.floor(v + 1e-9).toLocaleString('en-US')
const SEP = '     '
const ZONE_ICON = '\uE067'
const ZONE_ICON_LEGACY = '⏣'

function renderActionBar (s, { legacy = false } = {}) {
  const icon = (id) => (legacy ? STATS[id].legacyIcon : STATS[id].icon)
  const absorbing = (s.absorption || 0) > 0
  const hp = s.dead ? 0 : Math.max(1, Math.floor(s.health + (s.absorption || 0) + 1e-9))
  const parts = [`${absorbing && !s.dead ? '§6' : '§c'}${n(hp)}/${n(s.maxHealth)}${icon('health')}`]
  parts.push(s.zone
    ? `§7${legacy ? ZONE_ICON_LEGACY : ZONE_ICON} §${s.zone.color || 'b'}${s.zone.name}`
    : `§a${n(s.defense)}§a${icon('defense')} Defense`)
  if (s.notEnough) return [...parts, '§c§lNOT ENOUGH MANA'].join(SEP)
  parts.push(s.flash ? `§b${s.flash}` : `§b${n(s.mana)}/${n(s.maxMana)}${icon('intelligence')} Mana`)
  if (s.overflow > 0) parts.push(`§3${n(s.overflow)}ʬ`)
  return parts.join(SEP) + SEP
}

module.exports = { renderActionBar }
