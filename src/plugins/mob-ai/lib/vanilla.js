'use strict'

/**
 * Vanilla constants and pure helpers for the mob AI.
 *
 * The behaviour here was cross-checked against Horizon (https://github.com/horizon-rust/horizon, MIT),
 * a Rust rewrite of Java Edition that is verified against vanilla with differential harnesses. Only
 * numbers and algorithms are ported, no code is copied. Where a value is our own derivation rather
 * than something read out of Horizon it is marked "derived".
 */

// ---- scheduling ------------------------------------------------------------------------------
// Mob.serverAiStep runs the full goal selector tick only when (age + entityId) is even; on the
// other ticks only goals that ask for it (requiresUpdateEveryTick) are ticked. Every start delay
// is therefore halved so that it still measures the same wall time.
const reducedTickDelay = n => Math.ceil(n / 2)
const isFullTick = (age, id) => ((age + id) & 1) === 0

// ---- movement --------------------------------------------------------------------------------
// Mob.setSpeed(f) also sets the forward input (zza = f), and LivingEntity.aiStep scales the input
// by 0.98. Ground acceleration at normal friction (0.6) is  speed * input,  and the mob then loses
// 1 - 0.6 * 0.91 of its velocity every tick. (derived from Horizon's ground_move_tick / set_speed)
const GROUND_DRAG = 0.6 * 0.91
const INPUT_SCALE = 0.98

/** Terminal ground speed in blocks/second for `speed = movementSpeedAttribute * speedModifier`. */
function groundSpeedBps (speed) {
  const accel = speed * speed * INPUT_SCALE
  return 20 * accel / (1 - GROUND_DRAG)
}

/** Same thing but by running the actual per-tick recurrence, used by the tests to cross-check. */
function simulateGroundSpeedBps (speed, ticks = 200) {
  let v = 0
  let moved = 0
  for (let i = 0; i < ticks; i++) {
    v += speed * speed * INPUT_SCALE
    moved = v
    v *= GROUND_DRAG
  }
  return moved * 20
}

// ---- combat ----------------------------------------------------------------------------------
/** Mob.DEFAULT_ATTACK_REACH: the melee box is the mob's hitbox inflated by this much horizontally. */
const ATTACK_REACH = Math.sqrt(2.04) - 0.6

/** Axis aligned box of an entity: { minX, minY, minZ, maxX, maxY, maxZ } from feet position + size. */
function boxOf (pos, width, height) {
  const h = width / 2
  return { minX: pos.x - h, minY: pos.y, minZ: pos.z - h, maxX: pos.x + h, maxY: pos.y + height, maxZ: pos.z + h }
}

function boxesIntersect (a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ
}

/** Mob.isWithinMeleeAttackRange: inflated attack box (x/z only) against the target's hitbox. */
function withinMeleeRange (mobPos, mobDims, targetPos, targetDims, reach = ATTACK_REACH) {
  const m = boxOf(mobPos, mobDims.w, mobDims.h)
  m.minX -= reach; m.maxX += reach; m.minZ -= reach; m.maxZ += reach
  return boxesIntersect(m, boxOf(targetPos, targetDims.w, targetDims.h))
}

/** Mean of two uniform randoms minus one: the triangular spread used by arrows and loot. */
const triangle = (center, maxDeviation, rand = Math.random) => center + maxDeviation * (rand() - rand())

// ---- targeting -------------------------------------------------------------------------------
// LivingEntity.getVisibilityPercent: sneaking players are harder to notice, and wearing the
// matching mob head halves the range again. Invisibility with armour is scaled by coverage.
const MOB_HEADS = { skeleton: 'skeleton_skull', zombie: 'zombie_head', creeper: 'creeper_head' }

function visibilityPercent (player, mobName) {
  let v = 1
  if (player.crouching || player.sneaking) v = 0.8
  // `headItemName` is filled in by the caller: item naming differs between forks
  if (player.headItemName && MOB_HEADS[mobName] === player.headItemName) v *= 0.5
  return v
}

/** TargetingConditions range test: scaled by visibility but never below 2 blocks. */
function inTargetRange (distance, range, visibility = 1) {
  return distance <= Math.max(range * visibility, 2)
}

// ---- pathfinding -----------------------------------------------------------------------------
/** PathNavigation: nodes the A* may visit before giving up = followRange * 16. */
const maxVisitedNodes = followRange => Math.floor(followRange * 16)

/** Mob.getMaxFallDistance: 3 without a target, more when it is chasing and healthy. */
function maxFallDistance (health, maxHealth, hasTarget) {
  if (!hasTarget) return 3
  const extra = Math.floor(health - maxHealth * 0.33)
  return Math.max(0, extra) + 3
}

/** Path node costs (PathType malus). -1 means impassable. */
const PATH_MALUS = Object.freeze({
  walkable: 0, water: 8, damage_fire: 16, danger_fire: 8, lava: -1, fire: -1, cactus: -1, trapdoor: 0
})

// ---- fire ------------------------------------------------------------------------------------
const IGNITE_SECONDS = 8 // Zombie/Skeleton sun burn: igniteForSeconds(8)
const FIRE_DAMAGE_INTERVAL = 20 // 1 damage per second while burning

/**
 * Mob.isSunBurnTick: brightness above 0.5, sky visible, and a random chance of
 * (brightness - 0.4) * 2 / 30 per tick.
 */
function sunBurnChance (brightness) {
  return brightness > 0.5 ? Math.min(1, ((brightness - 0.4) * 2) / 30) : 0
}

// ---- attribute table -------------------------------------------------------------------------
// Vanilla base attributes. speed is the raw movement speed attribute (NOT blocks/second:
// convert with groundSpeedBps). follow is blocks, kbr is knockback resistance 0..1.
const ATTRIBUTES = Object.freeze({
  // passive
  cow: { health: 10, speed: 0.2 },
  mooshroom: { health: 10, speed: 0.2 },
  pig: { health: 10, speed: 0.25 },
  sheep: { health: 8, speed: 0.23 },
  chicken: { health: 4, speed: 0.25 },
  rabbit: { health: 3, speed: 0.3 },
  horse: { health: 22, speed: 0.225 },
  donkey: { health: 22, speed: 0.175 },
  mule: { health: 22, speed: 0.175 },
  llama: { health: 22, speed: 0.175 },
  cat: { health: 10, speed: 0.3 },
  ocelot: { health: 10, speed: 0.3 },
  goat: { health: 10, speed: 0.2 },
  villager: { health: 20, speed: 0.5 },
  // hostile
  zombie: { health: 20, speed: 0.23, damage: 3, follow: 35 },
  husk: { health: 20, speed: 0.23, damage: 3, follow: 35 },
  drowned: { health: 20, speed: 0.23, damage: 3, follow: 35 },
  zombie_villager: { health: 20, speed: 0.23, damage: 3, follow: 35 },
  skeleton: { health: 20, speed: 0.25, damage: 2, follow: 16 },
  stray: { health: 20, speed: 0.25, damage: 2, follow: 16 },
  bogged: { health: 16, speed: 0.25, damage: 2, follow: 16 },
  spider: { health: 16, speed: 0.3, damage: 2, follow: 16 },
  cave_spider: { health: 12, speed: 0.3, damage: 2, follow: 16 },
  creeper: { health: 20, speed: 0.25, follow: 16 },
  silverfish: { health: 8, speed: 0.25, damage: 1, follow: 16 },
  endermite: { health: 8, speed: 0.25, damage: 2, follow: 16 },
  // neutral
  wolf: { health: 8, speed: 0.3, damage: 4, follow: 16 },
  iron_golem: { health: 100, speed: 0.25, damage: 15, follow: 16, kbr: 1 },
  zombified_piglin: { health: 20, speed: 0.23, damage: 5, follow: 35 },
  enderman: { health: 40, speed: 0.3, damage: 7, follow: 64 }
})

module.exports = {
  reducedTickDelay,
  isFullTick,
  GROUND_DRAG,
  groundSpeedBps,
  simulateGroundSpeedBps,
  ATTACK_REACH,
  boxOf,
  boxesIntersect,
  withinMeleeRange,
  triangle,
  visibilityPercent,
  inTargetRange,
  maxVisitedNodes,
  maxFallDistance,
  PATH_MALUS,
  IGNITE_SECONDS,
  FIRE_DAMAGE_INTERVAL,
  sunBurnChance,
  ATTRIBUTES
}
