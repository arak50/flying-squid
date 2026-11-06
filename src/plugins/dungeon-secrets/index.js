'use strict'
/**
 * dungeon-secrets — STUB. Reads the secret positions of each room from data/secretlocations.json and gives dungeon-run the
 * secret totals; the secrets themselves (chests, item drops, essence, bats) are not spawned yet.
 *
 * What works now
 *   * totals(layout)       { roomId: secrets } from secretlocations.json, which dungeon-run passes to the run (Secrets Found %)
 *   * list(layout, roomId) the room's secrets with room-local positions rotated into the world
 *   * hints(layout, roomId) the room's helper waypoints (entrance, superboom, stonk, lever, aotv, pearl, fairysoul), not counted
 *   * spawnRoom(ctx)       called when a room is entered; emits `dungeonSecretsSpawn` and returns [] (nothing is spawned)
 *
 * Rooms are matched by template name; a room with no entry in the file (or no sidecar giving its size and floor height)
 * has no secrets. See lib/locations.js for the file format and which categories count.
 *
 * What is left for later (search for TODO)
 *   * spawn each type in the world and call `run.secretFound(playerId, roomId, secretId)` when a player gets it
 *
 * Settings:  schematics   folder with the room schematics + sidecars   [serv.dungeon.schematicsDir, else ./dungeon-room-schematics]
 *            locations    path of a secretlocations.json to use instead of data/secretlocations.json
 */
const path = require('path')
const fs = require('fs')
const { loadLocations, validateLocations, roomSecrets } = require('./lib/locations')
const { loadSidecars } = require('../dungeon-spawner/lib/sidecars')
const { toWorld } = require('../dungeon-spawner/lib/plan')

module.exports.server = function (serv, options) {
  const config = Object.assign({ schematics: null, locations: null }, (this && this.settings) || {})
  const log = m => serv.info?.(`[dungeon-secrets] ${m}`)
  const warn = m => serv.err?.(`[dungeon-secrets] ${m}`)

  let loaded = null
  function data () {
    if (loaded) return loaded
    const dir = config.schematics || (serv.dungeon && serv.dungeon.schematicsDir) || path.resolve('dungeon-room-schematics')
    const sidecars = fs.existsSync(dir) ? loadSidecars(dir, { skipMobs: true }) : { byName: new Map(), problems: [] }
    const locations = config.locations ? loadLocations(config.locations) : loadLocations()
    const problems = [...sidecars.problems, ...validateLocations(locations)]
    for (const p of problems) warn(p)
    loaded = { sidecars, locations, problems, cache: new Map() }
    return loaded
  }
  /** { sidecar, secrets, hints } for a template name, or null when the room has no secret data. */
  function forTemplate (name) {
    const d = data()
    if (d.cache.has(name)) return d.cache.get(name)
    const sc = d.sidecars.byName.get(name); const entries = d.locations.rooms.get(name)
    const out = sc && entries && sc.size && Number.isFinite(sc.floorYWorld) ? { sidecar: sc, ...roomSecrets(entries, sc.floorYWorld) } : null
    d.cache.set(name, out)
    return out
  }
  const dataOf = (layout, roomId) => { const r = layout.rooms[roomId]; return r && r.template ? forTemplate(r.template) : null }

  /** { roomId: number of secrets } for a layout; rooms without secrets are left out. */
  function totals (layout) {
    const out = {}
    for (const r of layout.rooms) { const d = dataOf(layout, r.id); const n = d ? d.secrets.filter(s => s.counts).length : 0; if (n) out[r.id] = n }
    return out
  }

  const place = (r, d, pos) => toWorld(pos, { origin: r.blockMin, rot: r.rotationQuarterTurns || 0, size: d.sidecar.size, floorY: d.sidecar.floorYWorld })

  /** The room's secrets in world coordinates. */
  function list (layout, roomId) {
    const r = layout.rooms[roomId]; const d = dataOf(layout, roomId)
    if (!r || !d || !r.blockMin) return []
    return d.secrets.map(s => ({ id: s.id, type: s.type, name: s.name, numbers: s.numbers, counts: s.counts, data: s.data, position: place(r, d, s.pos) }))
  }

  /** The room's helper waypoints in world coordinates (not secrets). */
  function hints (layout, roomId) {
    const r = layout.rooms[roomId]; const d = dataOf(layout, roomId)
    if (!r || !d || !r.blockMin) return []
    return d.hints.map(h => ({ category: h.category, name: h.name, numbers: h.numbers, label: h.label, position: place(r, d, h.pos) }))
  }

  /** TODO: spawn the secrets of a room in the world. Today it only announces them. */
  function spawnRoom ({ layout, roomId, world }) {
    const secrets = list(layout, roomId)
    if (secrets.length) serv.emit('dungeonSecretsSpawn', { roomId, secrets, hints: hints(layout, roomId), world })
    return []
  }

  serv.dungeonSecrets = { totals, list, hints, spawnRoom, validate: validateLocations, get problems () { return data().problems }, get locations () { return data().locations } }
  serv.on('dungeonRoomEntered', ({ roomId, layout, world }) => { if (layout) spawnRoom({ layout, roomId, world }) })
  log('stub loaded: secret totals from secretlocations.json, nothing is spawned')
}
