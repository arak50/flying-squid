'use strict'
/**
 * The Watcher and the blood room fight, as the real run (capture 2026-11-02) draws it. Pure packet builders, no server access.
 *
 * The Watcher is two entities, both created with the blood door opening (t = 0 here) and removed when the dungeon ends:
 *   * a zombie, invisible (flags 32), scale 0.26, max health 3000, wearing a player head (profile below), with the ambient
 *     "entity_effect" particle list in metadata key 10. Its health (key 9) is 3000 minus 375 per dead guardian, 0.1 when all 8 are dead.
 *   * an invisible marker armor stand 2 blocks above it carrying the name " The Watcher" (dark purple glyph, red text).
 *   Both fly the recorded path PATH (up and out over the room while it casts, then back above the centre).
 * A boss bar "§c§l☬" (yellow, full) is shown; with k of 8 guardians dead it shows round(1 - k/8, 2) in red.
 * An aura (smoke, witch, dust, enchant) hangs around the Watcher; every guardian appears with a cloud puff at its spawn point,
 * 5-6 blocks above the floor under the Watcher, and walks down into the room.
 *
 * PATH rows: [ms after spawn, dx, dy, dz, yaw deg, pitch deg]  dx/dz from the blood room centre, dy from the floor (feet).
 */
const { componentToNbt } = require('../../dungeon-mobs/lib/nametag')
const { legacyNbt } = require('./sidebar')

const WATCHER = {
  scale: 0.26, // the attribute is 0.23 in the first packet, 0.26 from 42 ms on
  maxHealth: 3000,
  flags: 32, // invisible
  standLift: 1.97, // the name tag stand sits this far above the zombie
  startDy: 4, // spawn height above the floor
  startYawByte: -128,
  effectParticle: { type: 'entity_effect', data: 645890962 },
  head: { uuid: '4c95c9e0-bfdc-3d28-8103-292523e20c43', texture: 'ewogICJ0aW1lc3RhbXAiIDogMTU4OTU1MDkyNjM2MSwKICAicHJvZmlsZUlkIiA6ICI0ZDcwNDg2ZjUwOTI0ZDMzODZiYmZjOWMxMmJhYjRhZSIsCiAgInByb2ZpbGVOYW1lIiA6ICJzaXJGYWJpb3pzY2hlIiwKICAic2lnbmF0dXJlUmVxdWlyZWQiIDogdHJ1ZSwKICAidGV4dHVyZXMiIDogewogICAgIlNLSU4iIDogewogICAgICAidXJsIiA6ICJodHRwOi8vdGV4dHVyZXMubWluZWNyYWZ0Lm5ldC90ZXh0dXJlLzUxOTY3ZGI1ZTMxOTk5MTYyNTIwMjE5MDNjZjRlOTk1MmVmN2NlYzIyMGZhYWNhMWJhNzliYWZlNTkzOGJkODAiCiAgICB9CiAgfQp9' },
  name: { text: '', extra: [{ text: ' ', color: 'dark_purple' }, { text: 'The Watcher', color: 'red' }] },
  bar: { title: '                                    §c§l☬        ', colorFull: 4, colorHurt: 2 } // 4 = yellow, 2 = red
}
const AURA = { everyTicks: 4, dy: 5, spread: 1.4, particles: [['large_smoke', 2], ['witch', 2], ['dust', 2, { color: -10105499, scale: 1 }], ['enchant', 1], ['entity_effect', 1, { color: 645890962 }]] }
const BURST = { particle: 'cloud', amount: 10, spread: 0.8 } // at each guardian's spawn point
const GUARDIAN_SPAWN_DY = 5.5 // guardians appear 5-6 blocks above the floor, under the Watcher

const PATH = [
  [774, 0.0, 4, 0.0, 180.8, 11.8],
  [18041, -0.38, 4.31, 0.47, 36.6, -23.9],
  [18194, -1.5, 5.28, 1.97, 36.6, -23.9],
  [18354, -2.62, 6.22, 3.47, 36.6, -23.9],
  [18500, -3.75, 7.19, 4.97, 36.6, -23.9],
  [18642, -4.88, 8.16, 6.44, 36.6, -23.9],
  [18794, -6.0, 9.12, 7.94, 36.6, -23.9],
  [18943, -7.09, 10.09, 9.44, 36.6, -23.9],
  [19096, -8.22, 11.06, 10.94, 36.6, -23.9],
  [19247, -8.59, 11.38, 11.44, 36.6, 59.1],
  [19565, -8.06, 11.19, 11.03, -128.0, 18.3],
  [19698, -6.44, 10.56, 9.81, -128.0, 18.3],
  [19847, -4.84, 9.97, 8.59, -128.0, 18.3],
  [19985, -3.22, 9.38, 7.41, -128.0, 18.3],
  [20144, -1.62, 8.78, 6.19, -128.0, 18.3],
  [20282, 0.0, 8.19, 4.97, -128.0, 18.3],
  [20433, 1.59, 7.59, 3.78, -128.0, 18.3],
  [20596, 3.22, 7.0, 2.56, -128.0, 18.3],
  [20738, 4.81, 6.41, 1.34, -128.0, 18.3],
  [20889, 6.44, 5.78, 0.16, -128.0, 18.3],
  [21044, 8.03, 5.19, -1.06, -128.0, 18.3],
  [21191, 9.66, 4.59, -2.25, -128.0, 18.3],
  [21340, 11.25, 4.0, -3.47, -128.0, 18.3],
  [21493, 11.25, 4.0, -3.47, -128.0, 63.3],
  [22552, 11.31, 4.31, -2.84, -5.6, -16.9],
  [22693, 11.5, 5.25, -0.97, -5.6, -16.9],
  [22841, 11.69, 6.19, 0.91, -5.6, -16.9],
  [22991, 11.88, 7.12, 2.75, -5.6, -16.9],
  [23143, 11.94, 7.44, 3.38, -5.6, 63.3],
  [24048, 11.28, 7.56, 3.19, 106.9, -7.0],
  [24194, 9.28, 7.91, 2.56, 106.9, -7.0],
  [24345, 7.31, 8.25, 1.97, 106.9, -7.0],
  [24498, 5.34, 8.62, 1.34, 106.9, -7.0],
  [24647, 3.34, 8.97, 0.75, 106.9, -7.0],
  [24796, 1.38, 9.34, 0.12, 106.9, -7.0],
  [24943, -0.59, 9.69, -0.5, 106.9, -7.0],
  [25092, -2.56, 10.03, -1.09, 106.9, -7.0],
  [25246, -4.56, 10.41, -1.72, 106.9, -7.0],
  [25398, -6.53, 10.75, -2.31, 106.9, -7.0],
  [25542, -8.5, 11.09, -2.94, 106.9, -7.0],
  [25693, -10.47, 11.47, -3.53, 106.9, -7.0],
  [25842, -11.16, 11.56, -3.75, 106.9, 56.2],
  [27046, -10.75, 11.31, -3.62, -71.7, 36.6],
  [27224, -9.56, 10.5, -3.22, -71.7, 36.6],
  [27352, -8.34, 9.69, -2.81, -71.7, 36.6],
  [27525, -7.16, 8.88, -2.41, -71.7, 36.6],
  [27675, -5.97, 8.03, -2.0, -71.7, 36.6],
  [27847, -4.78, 7.22, -1.62, -71.7, 36.6],
  [27974, -3.59, 6.41, -1.22, -71.7, 36.6],
  [28136, -2.38, 5.59, -0.81, -71.7, 36.6],
  [28287, -1.19, 4.78, -0.41, -71.7, 36.6],
  [28408, -0.78, 4.53, -0.28, -71.7, 36.6],
  [28574, -0.78, 4.53, -0.28, -177.2, 12.7],
  [38487, -1.19, 4.62, -0.12, 68.9, -8.4],
  [38643, -2.38, 4.97, 0.31, 68.9, -8.4],
  [38774, -3.56, 5.31, 0.78, 68.9, -8.4],
  [38938, -4.75, 5.66, 1.22, 68.9, -8.4],
  [39090, -5.94, 6.0, 1.69, 68.9, -8.4],
  [39251, -7.12, 6.34, 2.12, 68.9, -8.4],
  [39385, -8.31, 6.66, 2.56, 68.9, -8.4],
  [39539, -9.5, 7.0, 3.03, 68.9, -8.4],
  [39685, -10.66, 7.34, 3.47, 68.9, -8.4],
  [39843, -11.06, 7.47, 3.62, 68.9, 50.6],
  [39981, -11.06, 7.47, 3.62, -135.0, 22.5],
  [41343, -11.06, 7.47, 3.62, -125.2, 22.5],
  [41483, -11.06, 7.47, 3.62, -119.5, 25.3],
  [41995, -11.06, 7.47, 3.62, -126.6, 18.3],
  [44693, -11.06, 7.47, 3.62, -173.0, 18.3],
  [44710, -11.0, 7.38, 3.19, -173.0, 18.3],
  [44843, -10.84, 7.06, 1.94, -173.0, 18.3],
  [45043, -10.69, 6.75, 0.66, -173.0, 18.3],
  [45192, -10.5, 6.47, -0.59, -173.0, 18.3],
  [45344, -10.34, 6.16, -1.88, -173.0, 18.3],
  [45595, -10.19, 5.84, -3.12, -173.0, 18.3],
  [45746, -10.0, 5.56, -4.41, -173.0, 18.3],
  [45856, -9.84, 5.25, -5.66, -173.0, 18.3],
  [45928, -9.69, 4.94, -6.94, -173.0, 18.3],
  [46025, -9.53, 4.66, -8.19, -173.0, 18.3],
  [46131, -9.34, 4.34, -9.47, -173.0, 18.3],
  [46263, -9.19, 4.03, -10.72, -173.0, 18.3],
  [46437, -9.12, 3.94, -11.16, -173.0, 63.3],
  [46575, -9.12, 3.94, -11.16, -68.9, 19.7],
  [46894, -9.12, 3.94, -11.16, -57.7, 21.1],
  [47344, -9.12, 3.94, -11.16, -64.7, 19.7],
  [47641, -9.12, 3.94, -11.16, -73.1, 21.1],
  [48240, -9.12, 3.94, -11.16, -80.2, 23.9],
  [49224, -9.12, 3.94, -11.16, -74.5, 23.9],
  [50707, -8.75, 3.94, -10.94, -63.3, 2.8],
  [50816, -7.59, 3.94, -10.34, -63.3, 2.8],
  [50974, -6.41, 3.91, -9.72, -63.3, 2.8],
  [51129, -5.25, 3.91, -9.12, -63.3, 2.8],
  [51249, -4.09, 3.91, -8.5, -63.3, 2.8],
  [51440, -2.94, 3.88, -7.88, -63.3, 2.8],
  [51580, -1.78, 3.88, -7.28, -63.3, 2.8],
  [51622, -1.38, 3.88, -7.06, -63.3, 2.8],
  [51726, -0.62, 3.84, -6.66, -63.3, 2.8],
  [51941, 0.53, 3.84, -6.06, -63.3, 2.8],
  [52094, 1.72, 3.84, -5.44, -63.3, 2.8],
  [52228, 2.88, 3.81, -4.81, -63.3, 2.8],
  [52399, 4.03, 3.81, -4.22, -63.3, 2.8],
  [52534, 5.19, 3.81, -3.59, -63.3, 2.8],
  [52675, 6.34, 3.78, -3.0, -63.3, 2.8],
  [52808, 7.5, 3.78, -2.38, -63.3, 2.8],
  [52979, 8.66, 3.78, -1.75, -63.3, 2.8],
  [53132, 9.84, 3.75, -1.16, -63.3, 2.8],
  [53342, 11.0, 3.75, -0.53, -63.3, 2.8],
  [53654, 11.0, 3.75, -0.53, 98.4, 16.9],
  [54445, 11.0, 3.75, -0.53, 123.8, 15.5],
  [54727, 11.22, 4.66, -1.34, -164.5, -35.2],
  [54874, 11.56, 6.0, -2.53, -164.5, -35.2],
  [55041, 11.78, 6.91, -3.31, -164.5, 43.6],
  [55195, 11.78, 6.91, -3.31, 99.8, 32.3],
  [56248, 11.78, 6.91, -3.31, 106.9, 32.3],
  [56393, 11.78, 6.91, -3.31, 83.0, 25.3],
  [56744, 11.31, 6.81, -3.19, 73.1, 19.7],
  [56866, 9.91, 6.47, -2.78, 73.1, 19.7],
  [56993, 8.5, 6.09, -2.41, 73.1, 19.7],
  [57184, 7.09, 5.75, -2.0, 73.1, 19.7],
  [57293, 5.69, 5.41, -1.59, 73.1, 19.7],
  [57492, 4.28, 5.06, -1.22, 73.1, 19.7],
  [57628, 2.88, 4.72, -0.81, 73.1, 19.7],
  [57777, 1.47, 4.34, -0.44, 73.1, 19.7],
  [57886, 1.0, 4.25, -0.31, 73.1, 19.7],
  [57946, 1.0, 4.25, -0.31, 178.6, 43.6],
  [58239, 1.0, 4.25, -0.31, 173.0, 53.4],
  [58663, 1.0, 4.25, -0.31, 175.8, 43.6],
  [58965, 1.0, 4.25, -0.31, 178.6, 23.9],
  [59715, 1.0, 4.25, -0.31, -180.0, 18.3],
  [60040, 1.0, 4.25, -0.31, -178.6, 12.7],
  [60526, 1.0, 4.25, -0.31, -178.6, 18.3],
  [60791, 1.0, 4.25, -0.31, 73.1, 59.1],
  [60942, 1.0, 4.25, -0.31, 177.2, 16.9],
  [61574, 1.03, 4.26, -0.29, 176.5, 16.2]
]

const byte = deg => { const b = Math.round(deg / 360 * 256); return b > 127 ? b - 256 : b } // protocol angle byte
const round2 = n => Math.round(n * 100) / 100

/** Health of the Watcher / fraction of the boss bar when `dead` of `total` guardians have fallen. */
const healthOf = (dead, total = 8) => dead >= total ? 0.1 : WATCHER.maxHealth * (total - dead) / total
const barOf = (dead, total = 8) => round2(Math.max(0, 1 - dead / total))

const zombieMeta = health => [
  { key: 0, type: 'byte', value: WATCHER.flags },
  { key: 9, type: 'float', value: health },
  { key: 10, type: 'particles', value: [WATCHER.effectParticle] }
]
const standMeta = () => [
  { key: 0, type: 'byte', value: 32 },
  { key: 2, type: 'optional_component', value: componentToNbt(WATCHER.name) },
  { key: 3, type: 'boolean', value: true },
  { key: 15, type: 'byte', value: 16 } // marker
]
const headItem = itemId => ({ itemCount: 1, itemId, addedComponentCount: 1, removedComponentCount: 0, components: [{ type: 'profile', data: { type: 'partial', uuid: WATCHER.head.uuid, properties: [{ name: 'textures', value: WATCHER.head.texture }], skinPatch: {} } }], removeComponents: [] })

function particle (type, amount, x, y, z, spread, data) {
  return ['world_particles', { longDistance: true, alwaysShow: true, x, y, z, offsetX: spread, offsetY: spread, offsetZ: spread, velocityOffset: 0, amount, particle: data ? { type, data } : { type } }]
}

/**
 * @param o { center: {x,z}, floorY, ids: { watcher, stand }, uuids: { watcher, stand, bar }, types: { zombie, armor_stand }, headItemId }
 */
function createFight (o) {
  const { center, floorY, ids, uuids } = o
  let elapsed = 0; let cursor = 0; let dead = 0
  const at = kf => ({ x: round2(center.x + kf[1]), y: round2(floorY + kf[2]), z: round2(center.z + kf[3]) })
  const spawnAt = { x: center.x, y: floorY + WATCHER.startDy, z: center.z }
  const base = { velocity: { x: 0, y: 0, z: 0 }, objectData: 0 }

  return {
    ids,
    get dead () { return dead },
    get elapsed () { return elapsed },

    /** Packets that create the Watcher and its boss bar. */
    spawn () {
      const yaw = WATCHER.startYawByte
      return [
        ['spawn_entity', { entityId: ids.watcher, objectUUID: uuids.watcher, type: o.types.zombie, ...spawnAt, ...base, pitch: 0, yaw, headPitch: yaw }],
        ['entity_head_rotation', { entityId: ids.watcher, headYaw: yaw }],
        ['entity_update_attributes', { entityId: ids.watcher, properties: [{ key: 'generic.scale', value: WATCHER.scale, modifiers: [] }, { key: 'generic.max_health', value: WATCHER.maxHealth, modifiers: [] }] }],
        ['entity_metadata', { entityId: ids.watcher, metadata: zombieMeta(WATCHER.maxHealth) }],
        ['entity_equipment', { entityId: ids.watcher, equipments: [{ slot: 5, item: headItem(o.headItemId) }] }],
        ['spawn_entity', { entityId: ids.stand, objectUUID: uuids.stand, type: o.types.armor_stand, x: spawnAt.x, y: round2(spawnAt.y + WATCHER.standLift), z: spawnAt.z, ...base, pitch: 0, yaw, headPitch: 0 }],
        ['entity_metadata', { entityId: ids.stand, metadata: standMeta() }],
        ['boss_bar', { entityUUID: uuids.bar, action: 0, title: legacyNbt(WATCHER.bar.title), health: 1, color: WATCHER.bar.colorFull, dividers: 0, flags: 0 }]
      ]
    },

    /** Advance the recorded path by `ms`; returns the movement packets of every keyframe passed. */
    advance (ms) {
      elapsed += ms
      const out = []
      while (cursor < PATH.length && PATH[cursor][0] <= elapsed) {
        const kf = PATH[cursor++]; const p = at(kf)
        out.push(['sync_entity_position', { entityId: ids.watcher, x: p.x, y: p.y, z: p.z, dx: 0, dy: 0, dz: 0, yaw: kf[4], pitch: kf[5], onGround: false }])
        out.push(['entity_head_rotation', { entityId: ids.watcher, headYaw: byte(kf[4]) }])
        out.push(['sync_entity_position', { entityId: ids.stand, x: p.x, y: round2(p.y + WATCHER.standLift), z: p.z, dx: 0, dy: 0, dz: 0, yaw: kf[4], pitch: 0, onGround: false }])
      }
      return out
    },

    /** One guardian fell: the Watcher's health drops by an eighth and so does the bar (yellow -> red from the first). */
    kill (total = 8) {
      dead++
      return [
        ['entity_metadata', { entityId: ids.watcher, metadata: [{ key: 9, type: 'float', value: healthOf(dead, total) }] }],
        ['boss_bar', { entityUUID: uuids.bar, action: 2, health: barOf(dead, total) }],
        ['boss_bar', { entityUUID: uuids.bar, action: 4, color: WATCHER.bar.colorHurt, dividers: 0 }]
      ]
    },

    /** The aura around the Watcher; call every tick, it emits every AURA.everyTicks. */
    aura (tick) {
      if (tick % AURA.everyTicks) return []
      return AURA.particles.map(([type, amount, data]) => particle(type, amount, center.x, floorY + AURA.dy, center.z, AURA.spread, data))
    },

    /** Packets that take the Watcher and its bar away. */
    remove () {
      return [['entity_destroy', { entityIds: [ids.watcher, ids.stand] }], ['boss_bar', { entityUUID: uuids.bar, action: 1 }]]
    }
  }
}

/** The puff where a guardian appears. */
const spawnBurst = pos => particle(BURST.particle, BURST.amount, pos.x, pos.y, pos.z, BURST.spread)

module.exports = { createFight, spawnBurst, healthOf, barOf, WATCHER, AURA, BURST, PATH, GUARDIAN_SPAWN_DY, byte }
