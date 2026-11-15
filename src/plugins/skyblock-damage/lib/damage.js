'use strict'
// SkyBlock melee damage (Hypixel SkyBlock wiki, "Damage Calculation"):
//   initial = (5 + weaponDamage + floor(strength / 5)) * (1 + strength / 100)
//   final   = initial * (1 + critDamage / 100, on a crit only) * (1 + additive / 100)
// Crit chance is a percentage: the hit is a crit when a roll in [0, 100) lands under it.
// Not covered yet: enchantments (Sharpness, Giant Killer ...), ferocity, reforge multipliers, mob defense.
const BASE_DAMAGE = 5

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * @param {{strength?, critChance?, critDamage?, weaponDamage?, additive?}} s   stats as plain numbers (percent for the crit/additive ones)
 * @param {{rng?: () => number, min?: number, round?: boolean}} [opts]          rng returns [0, 1)
 * @returns {{damage: number, critical: boolean, initial: number}}
 */
function calculate (s, { rng = Math.random, min = 1, round = true } = {}) {
  const strength = num(s.strength)
  const critical = rng() * 100 < num(s.critChance)
  const initial = (BASE_DAMAGE + num(s.weaponDamage) + Math.floor(strength / 5)) * (1 + strength / 100)
  let damage = initial
  if (critical) damage *= 1 + num(s.critDamage) / 100
  damage *= 1 + num(s.additive) / 100
  damage = Math.max(min, round ? Math.round(damage) : damage)
  return { damage, critical, initial }
}

/**
 * Reads the inputs from a player's skyblock-stats. Without a loaded profile (no stats yet) the player hits for the base 5, no crits.
 * @param player  a player with `player.skyblock.stats` (skyblock-stats PlayerStats)
 */
function statsOf (player) {
  const stats = player && player.skyblock && player.skyblock.stats
  if (!stats || !stats.result) return { strength: 0, critChance: 0, critDamage: 0, weaponDamage: 0, additive: 0 }
  const get = id => { try { return Number(stats.get(id)) || 0 } catch (e) { return 0 } }
  const held = stats.result.held // { name, id, role, counts, damage } or null
  return {
    strength: get('strength'),
    critChance: get('crit_chance'),
    critDamage: get('crit_damage'),
    weaponDamage: held && held.counts !== false ? num(held.damage) : 0,
    additive: 0
  }
}

module.exports = { calculate, statsOf, BASE_DAMAGE }
