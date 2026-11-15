'use strict'
/**
 * What a room drops. Pure: pass `rng`.
 *
 * Rule (Hypixel's "last required mob always drops items"; the capture shows two items per room kill: blessing + TNT, Blood Key + TNT,
 * blessing + Revive Stone):
 *   slot 1  the room's key when it holds one (dungeon-run drops that, so no entry here), otherwise a Blessing
 *   slot 2  Superboom TNT or a Revive Stone (`tntWeight` : `reviveWeight`, 2 : 1 in the capture - three samples, so tunable)
 * A miniboss that is not the last required mob drops a Blessing with `minibossBlessing` chance (assumed, not captured).
 */
const { rollLevel } = require('./items')
const { BLESSINGS } = require('./catalog')

const DEFAULTS = { tntWeight: 2, reviveWeight: 1, minibossBlessing: 0.5 }

function blessing (floor, master, rng) {
  const types = Object.keys(BLESSINGS)
  return { type: types[Math.floor(rng() * types.length)], level: rollLevel(floor, master, rng) }
}

/** kind 'lastMob' | 'miniboss' -> [{ type, level? }] in drop order. */
function planDrops ({ kind, hasKey = false, floor = 0, master = false, rng = Math.random, table = {} }) {
  const t = { ...DEFAULTS, ...table }
  const out = []
  if (kind === 'lastMob') {
    if (!hasKey) out.push(blessing(floor, master, rng))
    out.push({ type: rng() * (t.tntWeight + t.reviveWeight) < t.tntWeight ? 'superboom_tnt' : 'revive_stone' })
  } else if (kind === 'miniboss') {
    if (rng() < t.minibossBlessing) out.push(blessing(floor, master, rng))
  }
  return out
}

module.exports = { planDrops, DEFAULTS }
