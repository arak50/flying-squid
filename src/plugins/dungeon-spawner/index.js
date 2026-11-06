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
 *
 * API (serv.dungeonSpawner):
 *   plannerFor(layout)       -> ctx => plan        hand it to `new DungeonRun({ mobPlanner })`
 *   session({ world, layout, warn }) -> { spawn(plan, onFail), gone(), despawn(mobId), clear(), entities }
 *   sidecars / problems      the loaded sidecars and what was wrong with them
 *   validate(block, size)    errors of a `mobs` block
 */
const path = require('path')
const fs = require('fs')
const { Vec3 } = require('vec3')
const { planRoom } = require('./lib/plan')
const { validateMobs } = require('./lib/schema')
const { loadSidecars } = require('./lib/sidecars')
const { mobs: CATALOG } = require('../dungeon-mobs/lib/catalog')

module.exports.server = function (serv, options) {
  const config = Object.assign({ schematics: null, groundScan: null }, (this && this.settings) || {})
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

  function session ({ world, layout, groundScan, warn: w = warn }) {
    const entities = new Map() // mobId -> entity
    let open = true

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
      /** Spawn a plan; `onFail(mobId)` is called for a mob that could not be spawned (so a room never waits for it). */
      async spawn (plan, onFail = () => {}) {
        for (const e of plan.entries) {
          if (!open) return
          try {
            if (!serv.dungeonMobs) throw new Error('dungeon-mobs plugin missing')
            const y = e.position.y ?? await groundY(e.position.x, e.position.z)
            if (!open) return
            const mob = serv.dungeonMobs.spawn(e.mob, new Vec3(e.position.x, y, e.position.z), {
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
        for (const [mobId, ent] of entities) if (!serv.entities[ent.id] || ent.health <= 0) { entities.delete(mobId); out.push(mobId) }
        return out
      },
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
    validate: (block, size) => validateMobs(block, { catalog: CATALOG, size })
  }
}
