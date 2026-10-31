'use strict'

const G = require('./goals')

/**
 * Per-mob AI profiles. `attributes` mirror Pumpkin's EntityAttribute names:
 *   maxHealth, movementSpeed (blocks/second here, not vanilla's per-tick unit), attackDamage,
 *   followRange (blocks), knockbackResistance (0..1)
 * `goals` is a list of [priority, factory(ai) => Goal]; lower priority number = higher precedence.
 */

const swim = [1, ai => new G.SwimGoal(ai)]
const look = [4, ai => new G.LookAtEntityGoal(ai)]
const wander = (speed = 1) => [3, ai => new G.WanderAroundGoal(ai, speed)]
const panic = [1, ai => new G.PanicGoal(ai)]
const targetNearest = [1, ai => new G.NearestAttackableTargetGoal(ai)]
const melee = (speed = 1) => [2, ai => new G.MeleeAttackGoal(ai, speed)]
const fleeSun = [1, ai => new G.FleeSunGoal(ai)]

const passive = (extra = {}) => ({
  type: 'passive',
  height: 1,
  attributes: { maxHealth: 10, movementSpeed: 2.0, followRange: 16, knockbackResistance: 0 },
  goals: [swim, panic, wander(1), look],
  ...extra
})

const hostile = (extra = {}) => ({
  type: 'hostile',
  height: 2,
  reach: 1.7,
  attributes: { maxHealth: 20, movementSpeed: 3.6, attackDamage: 3, followRange: 35, knockbackResistance: 0 },
  goals: [swim, targetNearest, melee(1), wander(0.8), look],
  ...extra
})

const profiles = {
  // ---- passive animals --------------------------------------------------------------
  cow: passive({ height: 1.4 }),
  mooshroom: passive({ height: 1.4 }),
  pig: passive({ attributes: { maxHealth: 10, movementSpeed: 2.0, followRange: 16, knockbackResistance: 0 } }),
  sheep: passive({ attributes: { maxHealth: 8, movementSpeed: 2.0, followRange: 16, knockbackResistance: 0 } }),
  chicken: passive({ attributes: { maxHealth: 4, movementSpeed: 2.0, followRange: 16, knockbackResistance: 0 } }),
  rabbit: passive({ attributes: { maxHealth: 3, movementSpeed: 3.0, followRange: 16, knockbackResistance: 0 } }),
  horse: passive({ height: 1.6, attributes: { maxHealth: 20, movementSpeed: 3.0, followRange: 16, knockbackResistance: 0 } }),
  donkey: passive({ height: 1.6 }),
  mule: passive({ height: 1.6 }),
  llama: passive({ height: 1.9 }),
  cat: passive({ goals: [swim, panic, wander(0.8), look] }),
  ocelot: passive(),
  villager: passive({ height: 2, goals: [swim, panic, wander(0.6), look], attributes: { maxHealth: 20, movementSpeed: 2.0, followRange: 16, knockbackResistance: 0 } }),

  // ---- hostile ----------------------------------------------------------------------
  zombie: hostile({ burnsInSun: true, goals: [swim, [1, ai => new G.FleeSunGoal(ai)], targetNearest, melee(1), wander(0.8), look] }),
  husk: hostile(),
  drowned: hostile(),
  zombie_villager: hostile({ burnsInSun: true, goals: [swim, [1, ai => new G.FleeSunGoal(ai)], targetNearest, melee(1), wander(0.8), look] }),
  skeleton: hostile({
    burnsInSun: true,
    ranged: { damage: 3, accuracy: 0.75 },
    attributes: { maxHealth: 20, movementSpeed: 3.0, attackDamage: 3, followRange: 16, knockbackResistance: 0 },
    goals: [swim, fleeSun, targetNearest, [2, ai => new G.RangedAttackGoal(ai)], wander(0.8), look]
  }),
  stray: hostile({
    ranged: { damage: 3, accuracy: 0.75 },
    attributes: { maxHealth: 20, movementSpeed: 3.0, attackDamage: 3, followRange: 16, knockbackResistance: 0 },
    goals: [swim, targetNearest, [2, ai => new G.RangedAttackGoal(ai)], wander(0.8), look]
  }),
  spider: hostile({ height: 1, reach: 1.5, neutralInDay: true, attributes: { maxHealth: 16, movementSpeed: 4.2, attackDamage: 2, followRange: 16, knockbackResistance: 0 } }),
  cave_spider: hostile({ height: 1, reach: 1.3, attributes: { maxHealth: 12, movementSpeed: 4.2, attackDamage: 2, followRange: 16, knockbackResistance: 0 } }),
  silverfish: hostile({ height: 1, reach: 1.2, attributes: { maxHealth: 8, movementSpeed: 4.0, attackDamage: 1, followRange: 16, knockbackResistance: 0 } }),
  pillager: hostile({
    ranged: { damage: 4, accuracy: 0.7 },
    goals: [swim, targetNearest, [2, ai => new G.RangedAttackGoal(ai, { interval: 50, maxRange: 15 })], wander(0.8), look]
  }),
  // creepers just stalk & look: the explosion is not implemented (it would need block destruction)
  creeper: passive({ type: 'hostile', height: 1.7, goals: [swim, wander(0.8), look] }),

  // ---- neutral (only fight back once provoked) -------------------------------------
  wolf: hostile({ type: 'neutral', height: 0.85, attributes: { maxHealth: 8, movementSpeed: 4.0, attackDamage: 4, followRange: 16, knockbackResistance: 0 }, goals: [swim, melee(1.2), wander(0.8), look] }),
  iron_golem: hostile({ type: 'neutral', height: 2.7, reach: 2.2, attributes: { maxHealth: 100, movementSpeed: 3.0, attackDamage: 15, followRange: 16, knockbackResistance: 1 }, goals: [swim, melee(1), wander(0.6), look] }),
  zombified_piglin: hostile({ type: 'neutral', attributes: { maxHealth: 20, movementSpeed: 3.6, attackDamage: 5, followRange: 35, knockbackResistance: 0 }, goals: [swim, melee(1), wander(0.8), look] }),
  enderman: hostile({ type: 'neutral', height: 2.9, attributes: { maxHealth: 40, movementSpeed: 4.3, attackDamage: 7, followRange: 64, knockbackResistance: 0 }, goals: [swim, melee(1), wander(0.8), look] })
}

/** Mobs that must never get ground AI when `aiForUnknownMobs` is on (they fly or swim). */
const NO_GROUND_AI = new Set([
  'bat', 'bee', 'parrot', 'allay', 'vex', 'phantom', 'ghast', 'blaze', 'wither', 'ender_dragon', 'happy_ghast',
  'squid', 'glow_squid', 'cod', 'salmon', 'tropical_fish', 'pufferfish', 'dolphin', 'guardian', 'elder_guardian', 'axolotl', 'turtle',
  'armor_stand', 'item_frame', 'painting', 'shulker', 'slime', 'magma_cube', 'tadpole', 'fish'
])

const normalise = name => String(name || '').toLowerCase().replace(/[\s-]+/g, '_').replace(/^minecraft:/, '')

module.exports = { profiles, NO_GROUND_AI, normalise }
