'use strict'
const { STATS } = require('../../hypixel-api/lib/statDefs')

// SkyBlock action bar: "<hp>/<max>❤   <defense>❈ Defense   <mana>/<max>✎ Mana   <overflow>ʬ".
// FORMAT UNVERIFIED against a recording of the action-bar packet - everything is in this one function so it is a one-line fix.
const n = (v) => Math.floor(v + 1e-9).toLocaleString('en-US')

function renderActionBar (s, { legacy = false } = {}) {
  const icon = (id) => (legacy ? STATS[id].legacyIcon : STATS[id].icon)
  const hp = s.dead ? 0 : Math.max(1, Math.floor(s.health))
  const parts = [`§c${n(hp)}/${n(s.maxHealth)}${icon('health')}`]
  parts.push(`§a${n(s.defense)}${icon('defense')} Defense`)
  parts.push(s.flash ? `§b${s.flash}` : `§b${n(s.mana)}/${n(s.maxMana)}${icon('intelligence')} Mana`)
  if (s.overflow > 0) parts.push(`§3${n(s.overflow)}ʬ`)
  return parts.join('     ')
}

module.exports = { renderActionBar }
