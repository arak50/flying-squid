'use strict'
// node src/plugins/dungeon-spawner/test/dungeon-spawner.test.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { validateMobs } = require('../lib/schema')
const { sidecarPlan, randomPlan, planRoom, toWorld } = require('../lib/plan')
const { loadSidecars } = require('../lib/sidecars')
const { DungeonRun } = require('../../dungeon-run/lib/run')
const { resolve } = require('../../dungeon-run/lib/config')
const { mobs: CATALOG } = require('../../dungeon-mobs/lib/catalog')
const plugin = require('..')

const tests = []
const test = (name, fn) => tests.push([name, fn])
const root = path.resolve(__dirname, '../../../..')

const block = (extra = {}) => ({
  version: 1,
  pools: { undead: ['zombie_grunt', 'skeleton_grunt'] },
  spawns: [
    { id: 'a', mob: 'zombie_grunt', pos: { x: 5.5, y: 1, z: 6.5 } },
    { id: 'b', mob: 'skeleton_grunt', pos: { x: 10.5, y: 1, z: 6.5 }, yaw: 90 },
    { id: 'c', mob: 'pool:undead', pos: { x: 15.5, y: 1, z: 6.5 } },
    { id: 'd', mob: 'random', pos: { x: 20.5, y: 1, z: 6.5 } },
    { id: 'e', mob: 'crypt_lurker', pos: { x: 25.5, y: 1, z: 6.5 }, star: 'never' },
    { id: 'f', mob: 'tank_zombie', pos: { x: 5.5, y: 1, z: 20.5 }, chance: 0 },
    { id: 'g', mob: 'sniper', pos: { x: 10.5, y: 1, z: 20.5 }, floors: [3, 7] }
  ],
  star: { count: 2 },
  ...extra
})
const ctx = (over = {}) => ({
  room: { id: 4, type: 'Normal', cells: [{ x: 1, z: 1 }], template: 'Test-1' },
  layoutRoom: { blockMin: { x: 32, z: 32 }, rotationQuarterTurns: 0 },
  sidecar: { mobs: block(), size: { x: 31, y: 40, z: 31 }, floorYWorld: 66 },
  floor: 2,
  master: false,
  seed: 99,
  exploredCells: 3,
  cfg: resolve(),
  P: 32,
  S: 31,
  roomCenter: { x: 47.5, z: 47.5 },
  ...over
})

// ---------------------------------------------------------------------------------------------------------------------
test('schema: a good block passes, every kind of mistake is named', () => {
  assert.deepStrictEqual(validateMobs(block(), { catalog: CATALOG, size: { x: 31, y: 40, z: 31 } }), [])
  const bad = (mut, re) => {
    const b = block(); mut(b)
    const errs = validateMobs(b, { catalog: CATALOG, size: { x: 31, y: 40, z: 31 } })
    assert.ok(errs.some(e => re.test(e)), `${re}: ${JSON.stringify(errs)}`)
  }
  bad(b => { b.version = 2 }, /version/)
  bad(b => { b.spawns[0].mob = 'no_such_mob' }, /unknown mob/)
  bad(b => { b.spawns[2].mob = 'pool:nope' }, /unknown pool/)
  bad(b => { b.pools.undead = [] }, /non-empty/)
  bad(b => { b.pools.undead = ['zzz'] }, /unknown mob "zzz"/)
  bad(b => { b.spawns[1].id = 'a' }, /duplicate id/)
  bad(b => { b.spawns[0].id = 'Bad Id' }, /id/)
  bad(b => { b.spawns[0].pos = { x: 1, y: 1 } }, /pos/)
  bad(b => { b.spawns[0].pos.x = 99 }, /outside the room/)
  bad(b => { b.spawns[0].floors = [5, 2] }, /floors/)
  bad(b => { b.spawns[0].modes = ['hard'] }, /modes/)
  bad(b => { b.spawns[0].chance = 2 }, /chance/)
  bad(b => { b.spawns[0].star = 'sometimes' }, /star/)
  bad(b => { b.star.count = [3, 1] }, /star.count/)
  bad(b => { b.star.from = ['nope'] }, /unknown spawn id/)
  bad(b => { b.spawns[0].colour = 'red' }, /unknown property/)
  bad(b => { b.extra = 1 }, /unknown property/)
})

test('schema file: lists exactly the properties the validator accepts', () => {
  const s = JSON.parse(fs.readFileSync(path.join(root, 'dungeon-room-schematics/room-mobs.schema.json'), 'utf8'))
  assert.deepStrictEqual(Object.keys(s.properties).sort(), ['pools', 'spawns', 'star', 'version'])
  assert.deepStrictEqual(Object.keys(s.$defs.spawn.properties).sort(), ['chance', 'floors', 'id', 'mob', 'modes', 'pos', 'required', 'star', 'yaw'])
  assert.deepStrictEqual(Object.keys(s.properties.star.properties).sort(), ['count', 'from'])
})

test('toWorld: quarter turns match the generator (x, z) -> (L - z, x), height = floor + y', () => {
  const geo = rot => ({ origin: { x: 100, z: 200 }, rot, size: { x: 63, y: 40, z: 31 }, floorY: 66 }) // a 1x2 room: 63 x 31
  const at = (rot, p = { x: 2.5, y: 1, z: 3.5 }) => { const w = toWorld(p, geo(rot)); return [w.x - 100, w.y, w.z - 200] }
  assert.deepStrictEqual(at(0), [2.5, 67, 3.5])
  assert.deepStrictEqual(at(1), [27.5, 67, 2.5]) // (31 - 3.5, 2.5), the room is now 31 x 63
  assert.deepStrictEqual(at(2), [60.5, 67, 27.5]) // (63 - 2.5, 27.5), 63 x 31 again
  assert.deepStrictEqual(at(3), [3.5, 67, 60.5]) // (31 - 27.5, 60.5)
  assert.deepStrictEqual(at(4), [2.5, 67, 3.5], 'four turns are the identity')
})

test('toWorld agrees with the real generator: solid blocks of a stamped room land on solid blocks of the world', () => {
  const gen = require(path.join(root, 'catacombs-generator.js'))
  const registry = require('prismarine-registry')('1.21.4')
  let checked = 0; const rotSeen = new Set(); let bad = 0
  for (const seed of [11, 22, 33]) {
    const dg = gen.buildDungeon(registry, { dungeonSeed: seed, floor: 4, schematicsDir: path.join(root, 'dungeon-room-schematics'), lighting: 'fullbright', heads: false, log: () => {} })
    for (const q of dg.layout.rooms) {
      if (!q.template) continue
      const sc = q.template.sc
      const air = new Set(sc.names.map((n, i) => /(^|:)(cave_|void_)?air$/.test(n) ? i : -1).filter(i => i >= 0))
      const geo = { origin: { x: q.gx0 * 32, z: q.gz0 * 32 }, rot: q.rot || 0, size: { x: sc.W, y: sc.H, z: sc.L }, floorY: q.template.y0 }
      rotSeen.add(geo.rot)
      let n = 0
      for (let y = 0; y < sc.H && n < 150; y += 3) {
        for (let z = 0; z < sc.L && n < 150; z += 5) {
          for (let x = 0; x < sc.W && n < 150; x += 5) {
            if (air.has(sc.data[(y * sc.L + z) * sc.W + x])) continue
            n++
            const w = toWorld({ x: x + 0.5, y, z: z + 0.5 }, geo)
            const gx = Math.floor(w.x); const gz = Math.floor(w.z); const gy = geo.floorY + y
            if (gx < 0 || gz < 0 || gx >= dg.SX || gz >= dg.SZ || gy < dg.yMin || gy >= dg.yMax) { bad++; continue }
            if (dg.grid[((gy - dg.yMin) * dg.SZ + gz) * dg.SX + gx] === 0) bad++
            checked++
          }
        }
      }
    }
  }
  assert.ok(checked > 1000, `checked ${checked}`)
  assert.ok(rotSeen.size >= 3, 'rotations seen: ' + [...rotSeen])
  assert.ok(bad / checked < 0.03, `${bad} of ${checked} solid schematic blocks are air in the world`) // doors / tunnels carve a few
})

// ---------------------------------------------------------------------------------------------------------------------
test('sidecar plan: stars come from the list; chance, floors, star:never and required are respected', () => {
  const plan = sidecarPlan(ctx())
  const ids = plan.entries.map(e => e.spawnId)
  assert.deepStrictEqual(ids, ['a', 'b', 'c', 'd', 'e'], 'f has chance 0, g is for floors 3-7; file order is kept')
  const stars = plan.entries.filter(e => e.star)
  assert.strictEqual(stars.length, 2, 'star.count = 2')
  assert.ok(stars.every(e => e.required && CATALOG[e.mob].star))
  const e = plan.entries.find(x => x.spawnId === 'e')
  assert.strictEqual(e.star, false, 'star: never')
  assert.strictEqual(e.required, false, 'a filler does not have to die')
  assert.ok(plan.entries.every(x => /^m4\.\d$/.test(x.mobId)) && plan.roomId === 4 && plan.roomsExplored === 3)
  assert.ok(['zombie_grunt', 'skeleton_grunt'].includes(plan.entries.find(x => x.spawnId === 'c').mob), 'pool:undead')
  assert.ok(CATALOG[plan.entries.find(x => x.spawnId === 'd').mob].kind === 'basic', 'random = a basic mob of the floor')
  const f3 = sidecarPlan(ctx({ floor: 3 }))
  assert.ok(f3.entries.some(x => x.spawnId === 'g'), 'floor 3 opens g')
  assert.ok(sidecarPlan(ctx({ master: true })).entries.length === 5)
})

test('sidecar plan: deterministic, seeds differ, stars drawn only from star.from, always + range counts', () => {
  const key = p => p.entries.filter(e => e.star).map(e => e.spawnId).join()
  assert.deepStrictEqual(sidecarPlan(ctx()), sidecarPlan(ctx()))
  const picks = new Set(); for (let seed = 1; seed < 40; seed++) picks.add(key(sidecarPlan(ctx({ seed }))))
  assert.ok(picks.size > 3, 'different seeds draw different stars: ' + [...picks])

  const from = ctx({ sidecar: { mobs: block({ star: { count: 2, from: ['a', 'b'] } }), size: { x: 31, y: 40, z: 31 }, floorYWorld: 66 } })
  for (let seed = 1; seed < 20; seed++) assert.strictEqual(key(sidecarPlan({ ...from, seed })), 'a,b')

  const always = block({ star: { count: [1, 3] } }); always.spawns[4].star = 'always'; always.spawns[4].mob = 'crypt_lurker'
  const al = ctx({ sidecar: { mobs: always, size: { x: 31, y: 40, z: 31 }, floorYWorld: 66 } })
  for (let seed = 1; seed < 20; seed++) {
    const p = sidecarPlan({ ...al, seed })
    assert.ok(p.entries.find(e => e.spawnId === 'e').star, 'always is always')
    assert.ok(p.entries.filter(e => e.star).length >= 1 && p.entries.filter(e => e.star).length <= 3)
  }
  const none = ctx({ sidecar: { mobs: block({ star: { count: 0 } }), size: { x: 31, y: 40, z: 31 }, floorYWorld: 66 } })
  assert.strictEqual(sidecarPlan(none).entries.filter(e => e.star).length, 0)
  // a spawn whose mob can never be a star (a miniboss) is not drawn
  const mini = block({ star: { count: 5 } }); mini.spawns[0].mob = 'lost_adventurer'
  const mp = sidecarPlan(ctx({ sidecar: { mobs: mini, size: { x: 31, y: 40, z: 31 }, floorYWorld: 66 } }))
  assert.ok(!mp.entries.find(e => e.spawnId === 'a').star)
  assert.ok(mp.entries.find(e => e.spawnId === 'a').miniboss && mp.entries.find(e => e.spawnId === 'a').required, 'a miniboss must die by default')
})

test('sidecar plan: positions are rotated into the world, with the room height and facing', () => {
  const flat = sidecarPlan(ctx())
  const a0 = flat.entries.find(e => e.spawnId === 'b')
  assert.deepStrictEqual([a0.position.x, a0.position.y, a0.position.z, a0.yaw], [32 + 10.5, 67, 32 + 6.5, 90])
  const turned = sidecarPlan(ctx({ layoutRoom: { blockMin: { x: 32, z: 32 }, rotationQuarterTurns: 1 } }))
  const a1 = turned.entries.find(e => e.spawnId === 'b')
  assert.deepStrictEqual([a1.position.x, a1.position.y, a1.position.z, a1.yaw], [32 + 31 - 6.5, 67, 32 + 10.5, 180])
})

test('planRoom: no sidecar (or no origin) = the generic planner, same as before the split', () => {
  const c = ctx({ sidecar: null })
  assert.deepStrictEqual(planRoom(c), randomPlan(c))
  const p = planRoom(c)
  assert.ok(p.entries.some(e => e.star) && p.entries.every(e => e.position.y === undefined))
})

// ---------------------------------------------------------------------------------------------------------------------
function fixtureLayout () {
  const room = (id, type, x, z, template) => ({ id, type, shape: '1x1', template, rotationQuarterTurns: 0, blockMin: { x: x * 32, z: z * 32 }, cells: [{ x, z }] })
  const door = (a, b, kind, axis, x, z) => ({ rooms: [a, b], kind, axis, center: { x, y: 66, z } })
  return {
    floor: 2,
    seed: 5,
    cellPitch: 32,
    roomSize: 31,
    doorBaseY: 66,
    rooms: [room(0, 'Entrance', 0, 0, null), room(1, 'Normal', 1, 0, 'Test-1'), room(2, 'Blood', 2, 0, null)],
    doors: [door(0, 1, 'entrance', 'east-west', 31, 15), door(1, 2, 'blood', 'east-west', 63, 15)]
  }
}
const sidecarDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-sidecars-'))
  fs.mkdirSync(path.join(dir, '1x1'))
  const put = (name, j) => fs.writeFileSync(path.join(dir, '1x1', name + '.json'), JSON.stringify(j))
  put('Test-1', { name: 'Test-1', category: '1x1', size: { x: 31, y: 40, z: 31 }, floorYWorld: 66, mobs: block(), secrets: { version: 1, spawns: [{ id: 's1', type: 'chest', pos: { x: 3.5, y: 1, z: 3.5 } }, { id: 's2', type: 'bat', pos: { x: 9.5, y: 4, z: 3.5 }, counts: false }] } })
  put('Broken-1', { name: 'Broken-1', category: '1x1', size: { x: 31, y: 40, z: 31 }, mobs: { version: 1, spawns: [{ id: 'x', mob: 'nope', pos: { x: 1, y: 1, z: 1 } }] } })
  put('NoSize-1', { name: 'NoSize-1', category: '1x1', mobs: block() })
  put('Plain-1', { name: 'Plain-1', category: '1x1', size: { x: 31, y: 40, z: 31 } })
  fs.writeFileSync(path.join(dir, '1x1', 'Garbage-1.json'), '{ not json')
  return dir
}

test('loadSidecars: keeps good blocks, drops and reports the broken ones; the repo sidecars still load', () => {
  const dir = sidecarDir()
  const { byName, problems } = loadSidecars(dir)
  assert.ok(byName.get('Test-1').mobs && byName.get('Test-1').size.x === 31)
  assert.strictEqual(byName.get('Broken-1').mobs, null)
  assert.strictEqual(byName.get('NoSize-1').mobs, null)
  assert.strictEqual(byName.get('Plain-1').mobs, null)
  assert.ok(problems.some(p => /Broken-1.*unknown mob "nope"/.test(p)) && problems.some(p => /NoSize-1.*size/.test(p)) && problems.some(p => /Garbage-1/.test(p)))
  const repo = loadSidecars(path.join(root, 'dungeon-room-schematics'))
  assert.deepStrictEqual(repo.problems, [])
  assert.ok(repo.byName.size >= 30 && repo.byName.get('Crypts-1'))
})

// ---------------------------------------------------------------------------------------------------------------------
function fakeServ () {
  const serv = new EventEmitter()
  let nextId = 1
  Object.assign(serv, {
    entities: {},
    errors: [],
    info () {},
    err (m) { serv.errors.push(m) },
    destroyEntity (e) { delete serv.entities[e.id] },
    dungeonMobs: { spawned: [], spawn (key, pos, opts) { const e = { id: nextId++, health: 20, key, pos, opts }; serv.entities[e.id] = e; this.spawned.push(e); return e } }
  })
  return serv
}
const world = { async getBlockType (v) { return v.y === 66 ? 1 : 0 } }

test('plugin: plannerFor feeds the run from the sidecars; the run spawns them, stars gate the clear', async () => {
  const serv = fakeServ()
  plugin.server.call({ settings: { schematics: sidecarDir() } }, serv)
  const layout = fixtureLayout()
  const run = new DungeonRun({ layout, seed: 7, party: [{ id: 'p' }], mobPlanner: serv.dungeonSpawner.plannerFor(layout) })
  run.start(); while (run.state === 'COUNTDOWN') run.tick()
  const c = run.roomCenter(run.rooms[1])
  run.playerMoved('p', c.x, c.z)
  const spawn = run.log.filter(e => e.type === 'spawnMobs').pop()
  assert.deepStrictEqual(spawn.plan.entries.map(e => e.spawnId), ['a', 'b', 'c', 'd', 'e'])
  const stars = spawn.plan.entries.filter(e => e.star)
  assert.strictEqual(stars.length, 2)
  for (const e of spawn.plan.entries.filter(x => !x.star)) run.mobDied(e.mobId)
  assert.ok(run.rooms[1].machine.is('ENTERED'), 'fillers do not clear the room')
  stars.forEach(e => run.mobDied(e.mobId))
  assert.ok(run.rooms[1].machine.is('CLEARED', 'COMPLETED'))
  // the same layout without the planner (generic) still works, and the two differ in where mobs stand
  const plain = new DungeonRun({ layout, seed: 7, party: [{ id: 'p' }] })
  plain.start(); while (plain.state === 'COUNTDOWN') plain.tick()
  plain.playerMoved('p', c.x, c.z)
  assert.ok(plain.log.filter(e => e.type === 'spawnMobs').pop().plan.entries.every(e => e.spawnId === undefined))
})

test('session: spawns at the sidecar height (or the scanned floor), reports deaths, failures, despawn and clear', async () => {
  const serv = fakeServ()
  plugin.server.call({ settings: { schematics: sidecarDir() } }, serv)
  const layout = fixtureLayout()
  const failed = []
  const session = serv.dungeonSpawner.session({ world, layout })
  const plan = {
    roomId: 1,
    floor: 2,
    master: false,
    roomsExplored: 2,
    entries: [
      { mobId: 'm1.0', spawnId: 'a', mob: 'zombie_grunt', star: true, modifier: null, position: { x: 40.5, y: 67, z: 10.5 }, yaw: 90 },
      { mobId: 'm1.1', mob: 'skeleton_grunt', star: false, modifier: null, position: { x: 41.5, z: 11.5 } }
    ]
  }
  await session.spawn(plan, id => failed.push(id))
  const [a, b] = serv.dungeonMobs.spawned
  assert.strictEqual(a.pos.y, 67, 'sidecar height used as is')
  assert.ok(Math.abs(a.opts.yaw - Math.PI / 2) < 1e-9, 'yaw in radians')
  assert.strictEqual(b.pos.y, 67, 'no height: the floor at y 66 is scanned')
  assert.ok(a.opts.star && a.opts.roomId === 1 && a.opts.roomsExplored === 2 && !b.opts.star)
  assert.deepStrictEqual(session.gone(), [])
  delete serv.entities[a.id]
  assert.deepStrictEqual(session.gone(), ['m1.0'])
  assert.deepStrictEqual(session.gone(), [], 'reported once')
  session.despawn('m1.1')
  assert.ok(!serv.entities[b.id] && b.health === 0)
  serv.dungeonMobs.spawn = () => { throw new Error('boom') }
  await session.spawn({ ...plan, entries: [plan.entries[0]] }, id => failed.push(id))
  assert.deepStrictEqual(failed, ['m1.0'])
  assert.ok(serv.errors.some(e => /could not spawn/.test(e)))
  session.clear()
  await session.spawn(plan, id => failed.push(id))
  assert.strictEqual(failed.length, 1, 'a cleared session spawns nothing')
})

;(async () => {
  let ok = 0
  for (const [name, fn] of tests) {
    try { await fn(); ok++; console.log('  ok  ', name) } catch (e) { console.log('  FAIL', name); console.log('      ' + String(e.stack || e).split('\n').join('\n      ')) }
  }
  console.log(`\n${ok}/${tests.length} passed`)
  process.exit(ok === tests.length ? 0 : 1)
})()
