'use strict'
// Speed stat -> Minecraft movement (Hypixel SkyBlock wiki, checked 2026-10-31):
//   Speed is a percentage of the default walk speed: 100 = normal, 200 = twice as fast.   movement = base x Speed/100
//   Default cap 400 (raised by items/pets: Racing Helmet -> 500, Black Cat +100 ...; the engine applies cap bonuses).
//   "the real speed of the player can never be higher than 5x the normal walking speed" (Minecraft limit) -> hard ceiling 500.
//   The Rift uses its own stat (Rift Speed, base 100, cap 400).
// Vanilla constants: movement_speed attribute 0.1; walking 4.317 blocks/s, sprinting x1.3 (the client adds the sprint modifier itself).
const BASE_ATTRIBUTE = 0.1
const WALK_BLOCKS_PER_SECOND = 4.317
const SPRINT_FACTOR = 1.3
const HARD_CEILING = 500

/** Speed stat -> value of the `movement_speed` attribute */
function attributeFor (speed) { return BASE_ATTRIBUTE * Math.max(0, Math.min(speed, HARD_CEILING)) / 100 }

function blocksPerSecond (speed, sprinting = false) {
  return WALK_BLOCKS_PER_SECOND * Math.max(0, Math.min(speed, HARD_CEILING)) / 100 * (sprinting ? SPRINT_FACTOR : 1)
}

/** @param result engine result; returns the stat that applies in the player's dimension */
function speedStat (result) {
  const rift = result && result.context && result.context.dimension === 'rift'
  return (result && result.stats[rift ? 'rift_speed' : 'speed']) || null
}

module.exports = { attributeFor, blocksPerSecond, speedStat, BASE_ATTRIBUTE, HARD_CEILING, WALK_BLOCKS_PER_SECOND, SPRINT_FACTOR }
