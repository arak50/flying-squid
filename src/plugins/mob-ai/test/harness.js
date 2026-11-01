'use strict'
// Shared fakes for the unit tests: a flat world, a fake server and fake mobs / players.
// Entity and item data come from the real 26.1 registry; only the block table is faked so the world is trivial.

const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const plugin = require('..')

const real = require('prismarine-registry')('26.1')
const mockBlocks = {
  0: { name: 'air', boundingBox: 'empty' },
  1: { name: 'stone', boundingBox: 'block' },
  2: { name: 'water', boundingBox: 'empty' },
  3: { name: 'lava', boundingBox: 'empty' }
}
const registry = Object.create(real, { blocks: { value: mockBlocks, enumerable: true } })
const Item = require('prismarine-item')(real)

/** Flat world: stone for y <= 0, so the walkable surface is y = 1. `extra` maps "x,y,z" -> block id. */
function makeWorld (extra = {}) {
  return {
    async getBlockType (v) {
      const k = `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`
      if (k in extra) return extra[k]
      return Math.floor(v.y) <= 0 ? 1 : 0
    }
  }
}

/** Helper for building walls / pools: fills the box [x0..x1] x [y0..y1] x [z0..z1] with a block id. */
function fill (extra, id, x0, x1, y0, y1, z0, z1) {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) extra[`${x},${y},${z}`] = id
  return extra
}

let nextId = 1
const entityTypeId = name => (real.entitiesByName[name] || {}).id

function makeMob (world, name, x, y, z) {
  const m = {
    id: nextId++,
    type: 'mob',
    entityType: entityTypeId(name),
    name,
    world,
    position: new Vec3(x, y, z),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    health: 20,
    onGround: true,
    damage: [],
    packets: [],
    metaLog: [],
    equipment: [],
    async sendPosition (p, onGround) { m.position = p; m.onGround = onGround },
    _writeOthersNearby (name, payload) { m.packets.push([name, payload]) },
    sendMetadata (meta) { m.metaLog.push(meta) },
    takeDamage (d) { m.damage.push(d); m.health -= d.damage },
    destroy () { m.dead = true }
  }
  return m
}

function makeInventory () {
  const slots = new Array(46).fill(null)
  return {
    slots,
    updateSlot (slot, item) { slots[slot] = item || null },
    firstEmptyInventorySlot () {
      for (let i = 9; i <= 44; i++) if (!slots[i]) return i
      return null
    }
  }
}

function makePlayer (world, x, y, z) {
  const client = Object.assign(new EventEmitter(), { written: [], write (name, payload) { this.written.push([name, payload]) } })
  return Object.assign(new EventEmitter(), {
    id: nextId++,
    type: 'player',
    entityType: entityTypeId('player'),
    world,
    position: new Vec3(x, y, z),
    yaw: 0,
    pitch: 0,
    heldItemSlot: 0,
    health: 20,
    gameMode: 0,
    damage: [],
    inventory: makeInventory(),
    _client: client,
    takeDamage (d) { this.damage.push(d); this.health -= d.damage }
  })
}

/** @param {object} [cfg] plugin settings; `difficulty` goes to the server options. */
function makeServer (cfg = {}) {
  const { difficulty = 1, ...settings } = cfg
  const serv = new EventEmitter()
  Object.assign(serv, {
    registry,
    entities: {},
    players: [],
    time: 18000, // night, so sun logic stays out of the way
    tickCount: 0,
    info () {},
    err (m) { throw new Error(m) },
    commands: { add () {} },
    getNearby ({ world, position, radius = 128 }) {
      return serv.players.filter(p => p.world === world && p.position.distanceTo(position) <= radius)
    },
    initEntity (type, entityType, world, position) {
      const e = {
        id: nextId++,
        type,
        entityType,
        world,
        position,
        packets: [],
        async sendPosition (p, onGround) { e.position = p; e.onGround = onGround },
        _writeOthersNearby (n, payload) { e.packets.push([n, payload]) },
        _writeNearby (n, payload) { e.packets.push([n, payload]) },
        updateAndSpawn () {},
        destroy () { delete serv.entities[e.id] }
      }
      serv.entities[e.id] = e
      return e
    },
    destroyEntity (e) { delete serv.entities[e.id] }
  })
  plugin.server.call({ settings: { activeRange: 20, hysteresis: 4, ...settings } }, serv, { difficulty })
  return serv
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Drive the plugin like the server does: emit 'tick' and let the async batch finish. */
async function run (serv, ticks) {
  for (let i = 0; i < ticks; i++) {
    serv.tickCount++
    serv.emit('tick', 0.05, serv.tickCount)
    await sleep(1)
  }
  await sleep(20)
}

function createRunner () {
  const state = { passed: 0, failed: 0 }
  return {
    state,
    async test (name, fn) {
      try {
        await fn()
        state.passed++
        console.log('  ok   ' + name)
      } catch (e) {
        state.failed++
        console.log('  FAIL ' + name + '\n       ' + (e.stack || e))
        process.exitCode = 1
      }
    }
  }
}

module.exports = { Vec3, Item, registry, real, makeWorld, fill, makeMob, makePlayer, makeServer, sleep, run, createRunner, plugin }
