'use strict'
/**
 * The door opening animation, as seen in the real-run capture (Entrance, wither door at 3:21, blood door at 3:45).
 *
 * For every block of the door's 3 x 4 x 3 box the server spawns an invisible BAT with a FALLING BLOCK of the door's material
 * riding on it. The real blocks become barrier at once, the bats then sink 3.75 blocks in four equal steps and everything is
 * removed again; the real blocks turn to air while the copies are still on their way down:
 *
 *   +0 ms     spawn_entity bat + falling_block (objectData = block state), entity_metadata (bat: invisible flag 32)
 *   +33       set_passengers bat -> falling block, door box -> barrier
 *   +305      sync_entity_position: the bat sits 0.30625 lower
 *   +486, +634, +799, +937   rel_entity_move dY = -3840 (-0.9375 block) each
 *   +736      door box -> air
 *   +1132     entity_destroy (all of them)
 *
 * Pure: `timeline()` returns what to send / do and when, `apply` in index.js does it. Entity ids and uuids come from the caller.
 */
const BAT_Y_OFFSET = -0.65625 // [capture] a bat at y 68.34375 carries the block of the cell y 69
const STEPS_MS = { passengers: 33, barrier: 33, sync: 305, move: [486, 634, 799, 937], air: 736, destroy: 1132 }
const MOVE_DY = -3840 // 1/4096 block units, [capture]
const SYNC_DY = -0.30625

/** Door materials seen in the capture; any other door kind falls back to `normal`. */
const DOOR_BLOCKS = { entrance: 'infested_chiseled_stone_bricks', wither: 'coal_block', blood: 'red_terracotta', normal: 'stone_bricks' }

/** The 36 block positions of a door: 3 wide, 4 high from y0, 3 deep, centred on `center`. */
function doorBox (center, axis, y0) {
  const ew = axis === 'east-west'
  const out = []
  for (let w = -1; w <= 1; w++) for (let dd = -1; dd <= 1; dd++) for (let y = y0; y < y0 + 4; y++) out.push({ x: center.x + (ew ? dd : w), y, z: center.z + (ew ? w : dd) })
  return out
}

/**
 * @param o { positions, state, ids: () => entityId, uuid: () => string, types: { bat, falling_block } }
 * @returns { entityIds, steps: [{ at, packets: [[name, params]], blocks?: 'barrier' | 'air' }] } sorted by `at`
 */
function timeline ({ positions, state, ids, uuid, types, steps = STEPS_MS }) {
  const spawn = []; const meta = []; const rides = []; const sync = []; const moves = steps.move.map(() => []); const entityIds = []
  for (const p of positions) {
    const bat = ids(); const block = ids()
    entityIds.push(bat, block)
    const x = p.x + 0.5; const y = p.y + BAT_Y_OFFSET; const z = p.z + 0.5
    const base = { velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, headPitch: 0 }
    spawn.push(['spawn_entity', { entityId: bat, objectUUID: uuid(), type: types.bat, x, y, z, ...base, objectData: 0 }])
    spawn.push(['spawn_entity', { entityId: block, objectUUID: uuid(), type: types.falling_block, x, y, z, ...base, objectData: state }])
    meta.push(['entity_metadata', { entityId: bat, metadata: [{ key: 0, type: 'byte', value: 32 }, { key: 5, type: 'boolean', value: true }] }]) // invisible, no gravity
    rides.push(['set_passengers', { entityId: bat, passengers: [block] }])
    sync.push(['sync_entity_position', { entityId: bat, x, y: y + SYNC_DY, z, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, onGround: false }])
    moves.forEach(m => m.push(['rel_entity_move', { entityId: bat, dX: 0, dY: MOVE_DY, dZ: 0, onGround: false }]))
  }
  const out = [
    { at: 0, packets: [...spawn, ...meta] },
    { at: steps.passengers, packets: rides, blocks: 'barrier' },
    { at: steps.sync, packets: sync },
    ...steps.move.map((at, i) => ({ at, packets: moves[i] })),
    { at: steps.air, packets: [], blocks: 'air' },
    { at: steps.destroy, packets: [['entity_destroy', { entityIds }]] }
  ].sort((a, b) => a.at - b.at)
  return { entityIds, steps: out }
}

module.exports = { timeline, doorBox, DOOR_BLOCKS, STEPS_MS, MOVE_DY }
