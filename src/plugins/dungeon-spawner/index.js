'use strict'
/**
 * dungeon-spawner — plans and spawns the mobs of a dungeon room (split out of dungeon-run).
 *
 *   * reads the room sidecar JSONs (dungeon-room-schematics/<cat>/<Room>.json): a room with a `mobs` block (schema:
 *     dungeon-room-schematics/room-mobs.schema.json) spawns from that list and its star mobs are drawn from it; every other
 *     room uses the generic random planner (lib/plan.js)
 *   * spawns the planned mobs through dungeon-mobs, standing on the floor, and reports the ones that vanished
 *
 * Settings:
 *   schematics   folder with the room schematics + sidecars   [serv.dungeon.schematicsDir, else ./dungeon-room-schematics]
 *   groundScan   [fromY, toY] block scan for the floor under a spawn without a sidecar height   [doorBaseY - 2, 100]
 *   placement    [true] check every planned spot against the real blocks before spawning (lib/walkable.js): a mob that would stand
 *                inside a wall, over a hole or in a closed-off pocket is moved onto floor the party can walk to from the room's doors
 *   spacing      [1.5] blocks kept between mobs when one has to be moved
 *   scanRange    [-24, 46] y range of the placement scan, relative to the floor's door height
 *
 * API (serv.dungeonSpawner):
 *   plannerFor(layout)       -> ctx => plan        hand it to `new DungeonRun({ mobPlanner })`
 *   session({ world, layout, warn }) -> { spawn(plan, onFail), gone(), deathOf(mobId), despawn(mobId), clear(), entities }
 *   sidecars / problems      the loaded sidecars and what was wrong with them
 *   validate(block, size)    errors of a `mobs` block
 */
const path = require('path')
const fs = require('fs')
const { Vec3 } = require('vec3')
const { planRoom } = require('./lib/plan')
const { validateMobs } = require('./lib/schema')
const { loadSidecars } = require('./lib/sidecars')
const walkable = require('./lib/walkable')
const { mobs: CATALOG } = require('../dungeon-mobs/lib/catalog')

module.exports.server = function (serv, options) {
  const config = Object.assign({ schematics: null, groundScan: null, placement: true, spacing: 1.5, scanRange: [-24, 46] }, (this && this.settings) || {})
  const log = m => serv.info?.(`[dungeon-spawner] ${m}`)
  const warn = m => serv.err?.(`[dungeon-spawner] ${m}`)

  let loaded = null
  function sidecars () {
    if (loaded) return loaded
    const dir = config.schematics || (serv.dungeon && serv.dungeon.schematicsDir) || path.resolve('dungeon-room-schematics')
    loaded = fs.existsSync(dir) ? loadSidecars(dir) : { byName: new Map(), problems: [] }
    for (const p of loaded.problems) warn(p)
    const withMobs = [...loaded.byName.values()].filter(e => e.mobs).length
    if (loaded.byName.size) log(`${loaded.byName.size} room sidecars, ${withMobs} with a mobs block`)
    return loaded
  }

  function plannerFor (layout) {
    const { byName } = sidecars()
    return ctx => planRoom({ ...ctx, sidecar: ctx.room.template ? byName.get(ctx.room.template) || null : null, layoutRoom: layout.rooms[ctx.room.id] })
  }

  /**
   * Read the blocks of a room (its cells' bounding box, floor-to-ceiling band) into a walkable.Volume. A real world is read a
   * chunk column at a time; a world that only answers getBlockStateId / getBlockType (tests, other servers) block by block.
   */
  async function loadVolume (world, box, y0, y1) {
    const v = new walkable.Volume(box.x0, y0, box.z0, box.x1, y1, box.z1)
    const registry = serv.registry
    const cls = walkable.classifier(registry)
    if (typeof world.getColumn === 'function' && registry) {
      for (let cx = box.x0 >> 4; cx <= box.x1 >> 4; cx++) {
        for (let cz = box.z0 >> 4; cz <= box.z1 >> 4; cz++) {
          const col = await world.getColumn(cx, cz)
          for (let x = Math.max(box.x0, cx << 4); x <= Math.min(box.x1, (cx << 4) + 15); x++) {
            for (let z = Math.max(box.z0, cz << 4); z <= Math.min(box.z1, (cz << 4) + 15); z++) {
              for (let y = y0; y <= y1; y++) v.set(x, y, z, cls(col.getBlockStateId(new Vec3(x & 15, y, z & 15))))
            }
          }
        }
      }
    } else {
      const state = typeof world.getBlockStateId === 'function' && registry
      for (let x = box.x0; x <= box.x1; x++) {
        for (let z = box.z0; z <= box.z1; z++) {
          for (let y = y0; y <= y1; y++) {
            const p = new Vec3(x, y, z)
            v.set(x, y, z, state ? cls(await world.getBlockStateId(p)) : (await world.getBlockType(p)) ? walkable.SOLID : walkable.FREE)
          }
        }
      }
    }
    return v
  }

  function session ({ world, layout, groundScan, warn: w = warn }) {
    const entities = new Map() // mobId -> entity
    const deaths = new Map() // mobId -> { x, y, z } where it was when it went
    const scans = new Map() // roomId -> Promise<scan | null>
    let open = true

    /** Standing spots of a room, scanned from the world once per session. null = cannot be told (no cells / no door), callers keep the plan. */
    function roomScan (roomId) {
      if (scans.has(roomId)) return scans.get(roomId)
      const job = (async () => {
        const room = layout && layout.rooms && layout.rooms[roomId]
        if (!room || !room.cells || !room.cells.length) return null
        const P = layout.cellPitch || 32; const S = layout.roomSize || 31
        const doors = (layout.doors || []).filter(d => d.rooms && d.rooms.includes(roomId) && d.center)
        if (!doors.length) return null
        const base = layout.doorBaseY ?? 66
        const volume = await loadVolume(world, walkable.cellBox(room.cells, P, S), base + config.scanRange[0], base + config.scanRange[1])
        return walkable.scanRoom({ volume, cells: room.cells, doors, P, S })
      })().catch(err => { w(`room ${roomId}: placement scan failed: ${err.message}`); return null })
      scans.set(roomId, job)
      return job
    }

    /** Where each entry of the plan will stand: Map mobId -> { x, y, z, moved }, empty when placement is off or the room cannot be scanned. */
    async function place (plan) {
      if (!config.placement) return new Map()
      const scan = await roomScan(plan.roomId)
      if (!scan) return new Map()
      const placed = walkable.placeEntries(plan.entries, scan, { floorY: (layout.doorBaseY ?? 66) + 1, minSeparation: config.spacing, roomId: plan.roomId })
      const moved = [...placed.values()].filter(p => p.moved).length
      if (moved) log(`room ${plan.roomId}: ${moved} of ${plan.entries.length} mobs were not on reachable floor and were moved (${scan.size} spots)`)
      return placed
    }

    async function groundY (x, z) {
      const base = layout.doorBaseY ?? 66
      const [from, to] = groundScan || config.groundScan || [base - 2, 100]
      const bx = Math.floor(x); const bz = Math.floor(z)
      try {
        for (let y = from; y <= to; y++) { // bottom up: the floor, not the roof
          if (await world.getBlockType(new Vec3(bx, y, bz)) === 0) continue
          if (await world.getBlockType(new Vec3(bx, y + 1, bz)) === 0 && await world.getBlockType(new Vec3(bx, y + 2, bz)) === 0) return y + 1
        }
      } catch (err) { w(`ground scan failed: ${err.message}`) }
      return base + 3
    }

    return {
      entities,
      place,
      /**
       * Spawn a plan; `onFail(mobId)` is called for a mob that could not be spawned (so a room never waits for it).
       * `{ place: false }` spawns exactly where the plan says (the Watcher's guardians stand where the capture puts them).
       */
      async spawn (plan, onFail = () => {}, { place: doPlace = true } = {}) {
        const placed = doPlace ? await place(plan) : new Map()
        for (const e of plan.entries) {
          if (!open) return
          try {
            if (!serv.dungeonMobs) throw new Error('dungeon-mobs plugin missing')
            const at = placed.get(e.mobId) || { x: e.position.x, y: e.position.y ?? await groundY(e.position.x, e.position.z), z: e.position.z }
            if (!open) return
            const mob = serv.dungeonMobs.spawn(e.mob, new Vec3(at.x, at.y, at.z), {
              world, star: e.star, floor: plan.floor, master: plan.master, modifier: e.modifier, roomId: plan.roomId, roomsExplored: plan.roomsExplored, yaw: e.yaw === undefined ? undefined : e.yaw * Math.PI / 180
            })
            entities.set(e.mobId, mob)
          } catch (err) {
            w(`could not spawn ${e.mob} (${e.mobId}): ${err.message}`)
            onFail(e.mobId)
          }
        }
      },
      /** Mobs that left the world or are at 0 hp since the last call (removed from the session). */
      gone () {
        const out = []
        for (const [mobId, ent] of entities) {
          if (!serv.entities[ent.id] || ent.health <= 0) {
            entities.delete(mobId); out.push(mobId)
            if (ent.position) deaths.set(mobId, { x: ent.position.x, y: ent.position.y, z: ent.position.z })
          }
        }
        return out
      },
      /** Where a mob was when gone() reported it (feet position), or undefined. */
      deathOf: mobId => deaths.get(mobId),
      despawn (mobId) {
        const ent = entities.get(mobId)
        entities.delete(mobId)
        if (!ent) return
        ent.health = 0
        try { serv.destroyEntity(ent) } catch (e) { /* gone already */ }
      },
      /** The run is over: remove every mob and refuse further spawns. */
      clear () {
        open = false
        for (const ent of entities.values()) { try { serv.destroyEntity?.(ent) } catch (e) { /* gone already */ } }
        entities.clear()
      }
    }
  }

  serv.dungeonSpawner = {
    catalog: CATALOG,
    get sidecars () { return sidecars().byName },
    get problems () { return sidecars().problems },
    plannerFor,
    session,
    walkable,
    validate: (block, size) => validateMobs(block, { catalog: CATALOG, size })
  }
}
