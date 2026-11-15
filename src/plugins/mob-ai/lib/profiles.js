'use strict'

const G = require('./goals')
const { ATTRIBUTES } = require('./vanilla')

/**
 * Per-mob AI profiles. `attributes` use vanilla names:
 *   maxHealth, speedAttribute (the raw vanilla movement speed attribute; converted to blocks/second
 *   by vanilla.groundSpeedBps), attackDamage, followRange (blocks), knockbackResistance (0..1).
 * Older profiles may still give `movementSpeed` in blocks/second instead of `speedAttribute`.
 * `goals` is a list of [priority, factory(ai) => Goal]; lower priority number = higher precedence.
 * Goals using the TARGET control flag are routed to the target selector automatically.
 *
 * Goal sets and priorities follow vanilla (e.g. pig: Float 0, Panic 1, Stroll 6, LookAtPlayer 7,
 * RandomLookAround 8; zombie: Melee 2, Stroll 7, Look 8; skeleton: FleeSun 3, AvoidEntity 3, Bow 4 ...).
 */

const attrs = name => {
  const a = ATTRIBUTES[name]
  return {
    maxHealth: a.health,
    speedAttribute: a.speed,
    attackDamage: a.damage,
    followRange: a.follow || 16,
    knockbackResistance: a.kbr || 0
  }
}

const float = [0, ai => new G.SwimGoal(ai)]
const stroll = (prio, speed = 1) => [prio, ai => new G.WanderAroundGoal(ai, speed)]
const lookAtPlayer = (prio, range = 8) => [prio, ai => new G.LookAtEntityGoal(ai, range)]
const randomLook = prio => [prio, ai => new G.RandomLookAroundGoal(ai)]
const panic = (speed, prio = 1) => [prio, ai => new G.PanicGoal(ai, speed)]
const melee = (prio, speed = 1, follow = false) => [prio, ai => new G.MeleeAttackGoal(ai, speed, follow)]
const hurtBy = (prio = 1, alertOthers = false) => [prio, ai => new G.HurtByTargetGoal(ai, { alertOthers })]
const nearestPlayer = (prio = 2, mustSee = true) => [prio, ai => new G.NearestAttackableTargetGoal(ai, { mustSee })]
const fleeSun = prio => [prio, ai => new G.FleeSunGoal(ai, 1.0)]
const avoid = (prio, types, speed = 1.0, sprint = 1.2) => [prio, ai => new G.AvoidEntityGoal(ai, types, 6, speed, sprint)]

const animal = (name, { panicSpeed = 1.25, strokeSpeed = 1, height = 1, extra = {} } = {}) => ({
  type: 'passive',
  height,
  attributes: attrs(name),
  goals: [float, panic(panicSpeed), stroll(6, strokeSpeed), lookAtPlayer(7, 6), randomLook(8)],
  ...extra
})

const hostile = (name, extra = {}) => ({
  type: 'hostile',
  height: 2,
  reach: 1.7,
  attributes: attrs(name),
  goals: [float, melee(2), stroll(7), lookAtPlayer(8), randomLook(8), hurtBy(1), nearestPlayer(2)],
  ...extra
})

const profiles = {
  // ---- passive animals --------------------------------------------------------------
  cow: animal('cow', { panicSpeed: 2.0, height: 1.4 }),
  mooshroom: animal('mooshroom', { panicSpeed: 2.0, height: 1.4 }),
  pig: animal('pig'),
  sheep: animal('sheep'),
  chicken: animal('chicken', { panicSpeed: 1.4 }),
  rabbit: animal('rabbit', { panicSpeed: 2.2, strokeSpeed: 0.6 }),
  horse: animal('horse', { panicSpeed: 1.2, strokeSpeed: 0.7, height: 1.6 }),
  donkey: animal('donkey', { panicSpeed: 1.2, strokeSpeed: 0.7, height: 1.6 }),
  mule: animal('mule', { panicSpeed: 1.2, strokeSpeed: 0.7, height: 1.6 }),
  llama: animal('llama', { panicSpeed: 1.2, strokeSpeed: 0.7, height: 1.9 }),
  goat: animal('goat', { panicSpeed: 2.0, height: 1.3 }),
  cat: animal('cat', { panicSpeed: 1.5, strokeSpeed: 0.8 }),
  ocelot: animal('ocelot', { panicSpeed: 1.4, strokeSpeed: 0.8 }),
  villager: {
    type: 'passive',
    height: 2,
    attributes: attrs('villager'),
    goals: [float, panic(0.5), stroll(6, 0.35), lookAtPlayer(9, 8), randomLook(9)]
  },

  // ---- hostile ----------------------------------------------------------------------
  // Zombies burn in sunlight but have no flee-sun goal in vanilla; they just keep chasing.
  zombie: hostile('zombie', { burnsInSun: true, goals: [float, melee(2), stroll(7), lookAtPlayer(8), randomLook(8), hurtBy(1), nearestPlayer(2)] }),
  husk: hostile('husk'),
  drowned: hostile('drowned'),
  zombie_villager: hostile('zombie_villager', { burnsInSun: true }),
  skeleton: hostile('skeleton', {
    burnsInSun: true,
    holdsBow: true,
    eyeHeight: 1.74,
    goals: [float, fleeSun(3), avoid(3, 'wolf'), [4, ai => new G.RangedAttackGoal(ai)], stroll(5), lookAtPlayer(6), randomLook(6), hurtBy(1), nearestPlayer(2)]
  }),
  stray: hostile('stray', {
    holdsBow: true,
    eyeHeight: 1.74,
    goals: [float, avoid(3, 'wolf'), [4, ai => new G.RangedAttackGoal(ai)], stroll(5), lookAtPlayer(6), randomLook(6), hurtBy(1), nearestPlayer(2)]
  }),
  // Spiders only start fights in the dark (neutralInDay); the leap needs the target 2-4 blocks away.
  spider: hostile('spider', {
    height: 1,
    reach: 1.5,
    neutralInDay: true,
    goals: [[1, ai => new G.SwimGoal(ai)], [3, ai => new G.LeapAtTargetGoal(ai, 0.4)], melee(4), stroll(5, 0.8), lookAtPlayer(6), randomLook(6), hurtBy(1), nearestPlayer(2)]
  }),
  cave_spider: hostile('cave_spider', {
    height: 1,
    reach: 1.3,
    goals: [[1, ai => new G.SwimGoal(ai)], [3, ai => new G.LeapAtTargetGoal(ai, 0.4)], melee(4), stroll(5, 0.8), lookAtPlayer(6), randomLook(6), hurtBy(1), nearestPlayer(2)]
  }),
  silverfish: hostile('silverfish', { height: 1, reach: 1.2 }),
  endermite: hostile('endermite', { height: 1, reach: 1.2 }),
  // Creepers swell within 3 blocks and explode after a 30 tick fuse (see MobAI#explode).
  creeper: hostile('creeper', {
    height: 1.7,
    explodes: true,
    attributes: { ...attrs('creeper'), attackDamage: 0 },
    goals: [[1, ai => new G.SwimGoal(ai)], [2, ai => new G.SwellGoal(ai)], avoid(3, ['cat', 'ocelot']), melee(4), stroll(5, 0.8), lookAtPlayer(6), randomLook(6), nearestPlayer(1), hurtBy(2)]
  }),

  // ---- neutral (only fight back once provoked) -------------------------------------
  wolf: hostile('wolf', { type: 'neutral', height: 0.85, goals: [float, melee(4, 1.0, true), stroll(8), lookAtPlayer(9), randomLook(9), hurtBy(1)] }),
  iron_golem: hostile('iron_golem', { type: 'neutral', height: 2.7, reach: 2.2, goals: [float, melee(1), stroll(5, 0.6), lookAtPlayer(7), randomLook(8), hurtBy(1)] }),
  zombified_piglin: hostile('zombified_piglin', { type: 'neutral', goals: [float, melee(2), stroll(7), lookAtPlayer(8), randomLook(8), hurtBy(1, true)] }),
  enderman: hostile('enderman', { type: 'neutral', height: 2.9, goals: [float, melee(2), stroll(10, 1), lookAtPlayer(11), randomLook(11), hurtBy(1)] })
}

/** Mobs that must never get ground AI when `aiForUnknownMobs` is on (they fly or swim). */
const NO_GROUND_AI = new Set([
  'bat', 'bee', 'parrot', 'allay', 'vex', 'phantom', 'ghast', 'blaze', 'wither', 'ender_dragon', 'happy_ghast',
  'squid', 'glow_squid', 'cod', 'salmon', 'tropical_fish', 'pufferfish', 'dolphin', 'guardian', 'elder_guardian', 'axolotl', 'turtle',
  'armor_stand', 'item_frame', 'painting', 'shulker', 'slime', 'magma_cube', 'tadpole', 'fish'
])

const normalise = name => String(name || '').toLowerCase().replace(/[\s-]+/g, '_').replace(/^minecraft:/, '')

module.exports = { profiles, NO_GROUND_AI, normalise }
