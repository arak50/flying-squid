'use strict'
// Accessory Powers. Weights / unique bonuses are from the wiki's `Bucket:Power`
// data (partial - only powers whose values were verifiable are listed). A
// selected power that isn't here produces a warning instead of silent zeros.
// To add one: powers.mythical = { name:'Mythical', weights:{...}, bonus:{...} }
const powers = {
  silky: { name: 'Silky', weights: { speed: 5, crit_damage: 95 }, bonus: { attack_speed: 5 } },
  bloody: { name: 'Bloody', weights: { crit_damage: 45, strength: 45, intelligence: 10 }, bonus: { attack_speed: 10 } },
  sweet: { name: 'Sweet', weights: { speed: 10, defense: 45, health: 45 }, bonus: { speed: 5 } },
  demonic: { name: 'Demonic', weights: { strength: 23, intelligence: 77 }, bonus: { crit_damage: 50 } },
  forceful: { name: 'Forceful', weights: { crit_damage: 20, strength: 75, health: 5 }, bonus: { ferocity: 4 } },
  scorching: { name: 'Scorching', weights: { crit_damage: 40, strength: 35, attack_speed: 25 }, bonus: { ferocity: 7 } },
  pleasant: { name: 'Pleasant', weights: { health: 40, defense: 60 }, bonus: {} },
  sighted: { name: 'Sighted', weights: { intelligence: 100 }, bonus: { ability_damage: 3 } },
  hurtful: { name: 'Hurtful', weights: { strength: 20, crit_damage: 80 }, bonus: { attack_speed: 15 } },
  strong: { name: 'Strong', weights: { strength: 50, crit_damage: 50 }, bonus: { strength: 25, crit_damage: 25 } },
  healthy: { name: 'Healthy', weights: { health: 100 }, bonus: { health: 200 } }
}
powers.plesant = powers.pleasant // wiki bucket spelling

// stat = weight * MULT_SCALE * ln(1 + 0.0019 * MP)^1.2
//   Maths Enjoyer NPC: Stats Mult = 29.97 * (ln(0.0019*MP + 1))^1.2 ; the wiki's
//   weights are normalised by /40 (calibrated: Scorching @250 MP = 8.4 Str /
//   9.6 CD / 1.8 AS matches the Scorched Books page).
const MULT_SCALE = 29.97 / 40
// Per-stat conversion on top of that. attack_speed x0.3 is verified (Scorching).
// health is UNRESOLVED (Precious Pearl page implies ~x1.39) - left at 1 until confirmed.
const STAT_FACTOR = { attack_speed: 0.3 }

// Tuning points -> stat per point. NOT re-verified in this session (from the
// wiki as remembered) - check before relying on these.
const TUNING_PER_POINT = {
  health: ['health', 5],
  defense: ['defense', 1],
  walk_speed: ['speed', 1.5],
  strength: ['strength', 1],
  critical_damage: ['crit_damage', 1],
  critical_chance: ['crit_chance', 0.2],
  attack_speed: ['attack_speed', 0.3],
  intelligence: ['intelligence', 2]
}

module.exports = { powers, MULT_SCALE, STAT_FACTOR, TUNING_PER_POINT }
