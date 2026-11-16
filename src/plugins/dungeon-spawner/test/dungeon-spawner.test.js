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
const { resolveDensity, scaleCounts } = require('../lib/density')
const walkable = require('../lib/walkable')
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
  a.position = { x: 41.5, y: 67, z: 11.5 } // real entities carry a position
  delete serv.entities[a.id]
  assert.deepStrictEqual(session.gone(), ['m1.0'])
  assert.deepStrictEqual(session.gone(), [], 'reported once')
  assert.deepStrictEqual(session.deathOf('m1.0'), { x: a.position.x, y: a.position.y, z: a.position.z }, 'where it fell')
  assert.strictEqual(session.deathOf('nope'), undefined)
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

// ---------------------------------------------------------------------------------------------------------------------
// mob density
// ---------------------------------------------------------------------------------------------------------------------
const cellsOf = n => Array.from({ length: n }, (_, i) => ({ x: 1 + i, z: 1 }))
const planFor = (percent, cells, extra = {}) => randomPlan({
  room: { id: 3, type: 'Normal', cells: cellsOf(cells) },
  floor: 2,
  master: false,
  seed: 5,
  exploredCells: 1,
  P: 32,
  S: 31,
  roomCenter: { x: 47.5, z: 47.5 },
  cfg: resolve(percent === undefined ? {} : { mobDensity: { percent, ...extra } }),
  ...extra.ctx
})
const countOf2 = plan => ({ stars: plan.entries.filter(e => e.star).length, fillers: plan.entries.filter(e => !e.star).length, all: plan.entries.length })

test('density: the default (100 %) leaves the plan exactly as the planner made it', () => {
  const noKey = resolve(); delete noKey.mobDensity // a config from before the setting existed
  for (const cells of [1, 2, 3, 4]) {
    const base = randomPlan({ room: { id: 3, type: 'Normal', cells: cellsOf(cells) }, floor: 2, master: false, seed: 5, exploredCells: 1, P: 32, S: 31, roomCenter: { x: 47.5, z: 47.5 }, cfg: noKey })
    assert.deepStrictEqual(planFor(100, cells), base, `${cells} cell(s)`)
    assert.deepStrictEqual(planFor(undefined, cells), base)
  }
})

test('density: more or fewer mobs with the percentage, and the limits grow with the size of the room', () => {
  for (const cells of [1, 2, 4]) {
    const at = p => countOf2(planFor(p, cells))
    const counts = [10, 50, 100, 150, 300].map(at)
    for (let i = 1; i < counts.length; i++) assert.ok(counts[i].all >= counts[i - 1].all, `${cells} cells: ${JSON.stringify(counts.map(c => c.all))} never goes down`)
    assert.ok(at(50).all < at(100).all && at(150).all > at(100).all, `${cells} cells: 50 % < 100 % < 150 %`)
    const d = resolveDensity()
    for (const c of counts) {
      assert.ok(c.all >= d.minPerCell * cells && c.all <= d.maxPerCell * cells, `${cells} cells: ${c.all} within ${d.minPerCell * cells}..${d.maxPerCell * cells}`)
      assert.ok(c.stars >= d.minStars, 'a room keeps its star mobs')
    }
  }
  const big = countOf2(planFor(300, 4)); const small = countOf2(planFor(300, 1))
  assert.ok(big.all > small.all * 2, `a 2x2 room (${big.all}) holds far more than a 1x1 (${small.all}) at the same percentage`)
  assert.ok(planFor(100, 1).entries.map(e => e.mobId).every((id, i, a) => a.indexOf(id) === i), 'ids stay unique')
})

test('density: the percent is clamped to its limits, and the per-cell limits are settings too', () => {
  assert.deepStrictEqual(countOf2(planFor(999, 2)), countOf2(planFor(300, 2)), 'above maxPercent = maxPercent')
  assert.deepStrictEqual(countOf2(planFor(0, 2)), countOf2(planFor(10, 2)), 'below minPercent = minPercent')
  assert.deepStrictEqual(countOf2(planFor(NaN, 2)), countOf2(planFor(100, 2)), 'nonsense = stock')
  assert.strictEqual(resolveDensity({ percent: 500, maxPercent: 400 }).percent, 400)
  assert.ok(planFor(300, 1, { maxPerCell: 3 }).entries.length <= 3 && planFor(300, 4, { maxPerCell: 3 }).entries.length <= 12, 'maxPerCell is per cell of the room')
  assert.ok(planFor(10, 3, { minPerCell: 4 }).entries.length >= 12, 'minPerCell is per cell of the room')
  assert.strictEqual(planFor(10, 1, { minStars: 2 }).entries.filter(e => e.star).length, 2)
  assert.deepStrictEqual(scaleCounts({ stars: 0, fillers: 4 }, 1, { percent: 10 }), { stars: 0, fillers: 1 }, 'no stars to begin with: none invented')
  // a crowded room keeps its mix instead of turning into all star mobs
  const crowded = countOf2(planFor(300, 1))
  assert.ok(crowded.fillers >= 2 && crowded.stars >= 5, JSON.stringify(crowded))
  // boss rooms hold one mini boss whatever the percentage
  const boss = randomPlan({ room: { id: 9, type: 'Boss', cells: cellsOf(1) }, floor: 3, master: false, seed: 5, exploredCells: 1, P: 32, S: 31, roomCenter: { x: 47.5, z: 47.5 }, cfg: resolve({ mobDensity: { percent: 300 } }) })
  assert.strictEqual(boss.entries.length, 1)
})

test('density: sidecar rooms lose fillers first, gain extras next to the listed spawns, never lose a required mob', () => {
  const stock = sidecarPlan(ctx())
  const withPct = (percent, extra = {}) => sidecarPlan(ctx({ cfg: resolve({ mobDensity: { percent, ...extra } }) }))
  assert.deepStrictEqual(withPct(100), stock, 'default = the authored list')
  const half = withPct(50)
  assert.ok(half.entries.length < stock.entries.length)
  assert.ok(half.entries.filter(e => e.star).length >= 1 && half.entries.every(e => stock.entries.some(s => s.mobId === e.mobId)), 'only entries of the list remain')
  const more = withPct(300)
  assert.ok(more.entries.length > stock.entries.length && more.entries.length <= resolveDensity().maxPerCell)
  assert.ok(more.entries.filter(e => e.star).length > stock.entries.filter(e => e.star).length)
  assert.ok(more.entries.every(e => e.position.y !== undefined && e.position.x >= 32 && e.position.x <= 64 && e.position.z >= 32 && e.position.z <= 64), 'extras stay in the room')
  assert.strictEqual(new Set(more.entries.map(e => e.mobId)).size, more.entries.length, 'unique ids')
  assert.deepStrictEqual(withPct(300), more, 'seeded')
  // a mini boss / required filler is never scaled away
  const b = block(); b.spawns[4] = { ...b.spawns[4], mob: 'crypt_lurker', required: true }
  const plan = sidecarPlan(ctx({ sidecar: { mobs: b, size: { x: 31, y: 40, z: 31 }, floorYWorld: 66 }, cfg: resolve({ mobDensity: { percent: 10 } }) }))
  assert.ok(plan.entries.some(e => e.spawnId === 'e'), 'required entry kept at 10 %')
})

// ---------------------------------------------------------------------------------------------------------------------
// placement: where mobs may stand
// ---------------------------------------------------------------------------------------------------------------------
/** A 1x1 room at cell (0, 0): floor at y 66 (feet 67), a wall block, a 6-deep pit, a sealed pocket and a door on the west side. */
function testRoom () {
  const v = new walkable.Volume(0, 40, 0, 30, 100, 30)
  const { SOLID } = walkable
  for (let x = 0; x <= 30; x++) for (let z = 0; z <= 30; z++) { v.set(x, 66, z, SOLID); v.set(x, 90, z, SOLID) } // floor + roof
  for (let y = 66; y < 90; y++) for (let i = 0; i <= 30; i++) { v.set(0, y, i, SOLID); v.set(30, y, i, SOLID); v.set(i, y, 0, SOLID); v.set(i, y, 30, SOLID) } // walls
  for (let y = 66; y < 90; y++) for (let z = 10; z <= 12; z++) v.set(0, y, z, walkable.FREE) // the doorway
  for (let y = 67; y <= 69; y++) v.set(15, y, 15, SOLID) // a pillar
  for (let x = 20; x <= 22; x++) for (let z = 20; z <= 22; z++) { v.set(x, 66, z, walkable.FREE); v.set(x, 65, z, walkable.FREE); v.set(x, 64, z, walkable.FREE); v.set(x, 63, z, walkable.FREE); v.set(x, 62, z, walkable.FREE); v.set(x, 61, z, SOLID) } // a pit, 5 deep
  for (let x = 5; x <= 7; x++) {
    for (let z = 25; z <= 27; z++) {
      for (let y = 67; y <= 69; y++) { // a sealed 1x1 pocket cut into a block of stone
        v.set(x, y, z, SOLID)
      }
    }
  }
  v.set(6, 67, 26, walkable.FREE); v.set(6, 68, 26, walkable.FREE) // standable pocket (floor 66 is solid), but enclosed
  return v
}
const roomDoors = [{ center: { x: 0, y: 66, z: 11 } }]
const roomCells = [{ x: 0, z: 0 }]

test('walkable: spots are standable, inside the room and reachable from a door; pits, pockets and walls are not', () => {
  const scan = walkable.scanRoom({ volume: testRoom(), cells: roomCells, doors: roomDoors })
  assert.ok(scan && scan.size > 500)
  assert.ok(scan.has(10, 67, 10), 'open floor')
  assert.ok(!scan.has(6, 67, 26), 'a pocket nobody can walk into')
  assert.ok(!scan.has(15, 67, 15) && !scan.has(15, 70, 15), 'not inside the pillar')
  assert.deepStrictEqual(scan.column(21, 21), [], 'the bottom of a 5-deep pit: not reachable (drop limit 3)')
  assert.ok(scan.spots.every(s => s.y === 67 || s.y === 70), 'floor level, or on top of the pillar when it can be climbed')
  assert.ok(scan.roomy.length > 0 && scan.roomy.every(s => Math.hypot(s.x - 0, s.z - 11) > 2.5), 'roomy spots keep away from the door')
  assert.strictEqual(walkable.scanRoom({ volume: testRoom(), cells: roomCells, doors: [] }), null, 'no door, nothing to start from')
})

test('walkable: gap columns between two cells of a room count, other rooms do not', () => {
  const inside = walkable.roomMask([{ x: 0, z: 0 }, { x: 1, z: 0 }])
  assert.ok(inside(5, 5) && inside(31, 5) && inside(40, 5), 'both cells and the gap between them')
  assert.ok(!inside(31, 31) && !inside(70, 5) && !inside(5, 40), 'the corner gap, a third cell, a cell below')
  const one = walkable.roomMask([{ x: 0, z: 0 }])
  assert.ok(!one(31, 5), 'the gap next to a single cell is a doorway, not room floor')
})

test('placement: valid spots stay, the rest move onto reachable floor, deterministically', () => {
  const scan = walkable.scanRoom({ volume: testRoom(), cells: roomCells, doors: roomDoors })
  const entries = [
    { mobId: 'ok', position: { x: 10.5, z: 10.5 } }, // fine
    { mobId: 'pit', position: { x: 21.5, z: 21.5 } }, // over the pit: its column has a spot at floor level? no, the pit is open down to y 62
    { mobId: 'wall', position: { x: 0.5, z: 5.5 } }, // inside the west wall
    { mobId: 'pocket', position: { x: 6.5, z: 26.5 } },
    { mobId: 'authored', position: { x: 12.5, y: 67, z: 12.5 } }, // hand-placed, fine
    { mobId: 'authoredBad', position: { x: 15.5, y: 67, z: 15.5 } } // hand-placed inside the pillar
  ]
  const placed = walkable.placeEntries(entries, scan, { floorY: 67, roomId: 1 })
  const at = id => placed.get(id)
  assert.deepStrictEqual([at('ok').x, at('ok').y, at('ok').z, at('ok').moved], [10.5, 67, 10.5, false])
  assert.deepStrictEqual([at('authored').x, at('authored').y, at('authored').moved], [12.5, 67, false])
  for (const id of ['pit', 'wall', 'pocket', 'authoredBad']) {
    const p = at(id); assert.ok(scan.has(Math.floor(p.x), p.y, Math.floor(p.z)), `${id} ends up on a reachable spot (${p.x}, ${p.y}, ${p.z})`)
  }
  assert.ok(at('wall').moved && at('pocket').moved && at('authoredBad').moved)
  assert.ok(Math.hypot(at('authoredBad').x - 15.5, at('authoredBad').z - 15.5) < 3, 'a hand-placed mob is moved to the nearest spot, not somewhere random')
  assert.deepStrictEqual([...walkable.placeEntries(entries, scan, { floorY: 67, roomId: 1 })], [...placed], 'same input, same answer')
  assert.deepStrictEqual(walkable.placeEntries([], scan), new Map())
  assert.strictEqual(walkable.placeEntries(entries, null).size, 0, 'no scan: the plan is left alone')
  // relocated mobs do not pile up
  const crowd = Array.from({ length: 12 }, (_, i) => ({ mobId: `w${i}`, position: { x: 0.5, z: 3.5 } }))
  const out = [...walkable.placeEntries(crowd, scan, { roomId: 1 }).values()]
  let close = 0; for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) if (Math.hypot(out[i].x - out[j].x, out[i].z - out[j].z) < 1.5) close++
  assert.strictEqual(close, 0, 'at least 1.5 blocks apart')
})

test('session: a mob planned inside a wall is spawned on the floor instead; with placement off the plan is used as it is', async () => {
  const vol = testRoom()
  const layout = { cellPitch: 32, roomSize: 31, doorBaseY: 66, rooms: [{ id: 0, cells: roomCells }], doors: [{ rooms: [0, 1], center: { x: 0, y: 66, z: 11 } }] }
  const w = { async getBlockType (p) { return vol.get(p.x, p.y, p.z) === walkable.SOLID ? 1 : 0 } } // the minimal world: only block types
  const plan = { roomId: 0, floor: 2, master: false, roomsExplored: 1, entries: [{ mobId: 'm0.0', mob: 'zombie_grunt', star: true, modifier: null, position: { x: 0.5, z: 5.5 } }, { mobId: 'm0.1', mob: 'zombie_grunt', star: false, modifier: null, position: { x: 10.5, z: 10.5 } }] }
  const run = async settings => {
    const serv = fakeServ()
    plugin.server.call({ settings: { schematics: sidecarDir(), ...settings } }, serv)
    await serv.dungeonSpawner.session({ world: w, layout }).spawn(plan, () => {})
    return serv.dungeonMobs.spawned
  }
  const [a, b] = await run({})
  assert.ok(a.pos.x >= 1 && a.pos.x < 30 && a.pos.y === 67, `moved inside the room: ${a.pos}`)
  assert.deepStrictEqual([b.pos.x, b.pos.y, b.pos.z], [10.5, 67, 10.5], 'a good spot is untouched')
  const [c] = await run({ placement: false })
  assert.strictEqual(c.pos.x, 0.5, 'placement: false = the old behaviour')

  // the Watcher's guardians stand where the plan puts them (a ring the capture defines), however the blocks look there
  const serv = fakeServ()
  plugin.server.call({ settings: { schematics: sidecarDir() } }, serv)
  await serv.dungeonSpawner.session({ world: w, layout }).spawn(plan, () => {}, { place: false })
  assert.deepStrictEqual(serv.dungeonMobs.spawned.map(m => [m.pos.x, m.pos.z]), [[0.5, 5.5], [10.5, 10.5]], '{ place: false } spawns exactly as planned')
})

test('placement on real generated floors: no mob in a wall, over a hole or cut off from the room, at any density', async () => {
  const gen = require(path.join(root, 'catacombs-generator.js'))
  const registry = require('prismarine-registry')('1.21.4')
  const cls = walkable.classifier(registry)
  let rooms = 0; let mobs = 0; let rawBad = 0; let moved = 0
  for (const [seed, floor] of [[1, 0], [2, 3], [3, 6]]) {
    const dg = gen.buildDungeon(registry, { dungeonSeed: seed, floor, schematicsDir: path.join(root, 'dungeon-room-schematics'), lighting: 'fullbright', heads: false, log: () => {} })
    const layout = gen.exportLayout(dg)
    const state = (x, y, z) => (x < 0 || z < 0 || x >= dg.SX || z >= dg.SZ || y < dg.yMin || y >= dg.yMax) ? 0 : dg.grid[((y - dg.yMin) * dg.SZ + z) * dg.SX + x]
    const solid = (x, y, z) => cls(state(x, y, z)) === walkable.SOLID
    const free = (x, y, z) => cls(state(x, y, z)) === walkable.FREE
    const serv = fakeServ(); serv.registry = registry
    plugin.server.call({ settings: { schematics: path.join(root, 'dungeon-room-schematics') } }, serv)
    const session = serv.dungeonSpawner.session({ world: { async getBlockStateId (p) { return state(p.x, p.y, p.z) } }, layout })
    for (const percent of [50, 100, 300]) {
      for (const lr of layout.rooms.filter(r => r.type === 'Normal' && r.template)) {
        const plan = planRoom({ room: { id: lr.id, type: lr.type, template: lr.template, cells: lr.cells }, layoutRoom: lr, floor, master: false, seed, exploredCells: 1, cfg: resolve({ mobDensity: { percent } }), P: 32, S: 31, roomCenter: { x: lr.cells[0].x * 32 + 15.5, z: lr.cells[0].z * 32 + 15.5 }, sidecar: null })
        const placed = await session.place(plan)
        assert.strictEqual(placed.size, plan.entries.length, 'every mob got a place')
        if (percent === 100) rooms++
        for (const e of plan.entries) {
          const p = placed.get(e.mobId); const bx = Math.floor(p.x); const by = Math.floor(p.y); const bz = Math.floor(p.z)
          assert.ok(free(bx, by, bz) && free(bx, by + 1, bz), `seed ${seed} floor ${floor} room ${lr.id} ${e.mobId}: feet / head are free`)
          assert.ok(solid(bx, by - 1, bz), `seed ${seed} floor ${floor} room ${lr.id} ${e.mobId}: standing on something`)
          assert.ok(lr.cells.some(c => bx >= c.x * 32 && bx <= c.x * 32 + 31 && bz >= c.z * 32 && bz <= c.z * 32 + 31), 'inside the room')
          if (percent === 100) { mobs++; if (p.moved) moved++ }
        }
      }
    }
    // the same rooms without placement: the planned x / z with the plugin's old floor scan
    for (const lr of layout.rooms.filter(r => r.type === 'Normal' && r.template)) {
      const plan = planRoom({ room: { id: lr.id, type: lr.type, template: lr.template, cells: lr.cells }, layoutRoom: lr, floor, master: false, seed, exploredCells: 1, cfg: resolve(), P: 32, S: 31, roomCenter: { x: 0, z: 0 }, sidecar: null })
      for (const e of plan.entries) {
        const bx = Math.floor(e.position.x); const bz = Math.floor(e.position.z)
        let y = 69; for (let yy = 64; yy <= 100; yy++) { if (solid(bx, yy, bz) && free(bx, yy + 1, bz) && free(bx, yy + 2, bz)) { y = yy + 1; break } }
        const lowPit = y < 66 || !free(bx, y, bz) // the old scan picks the lowest floor of the column: a pit or hole floor
        if (lowPit) rawBad++
      }
    }
  }
  assert.ok(rooms >= 15 && mobs >= 100, `${rooms} rooms, ${mobs} mobs checked`)
  assert.ok(moved > 0, 'some mobs did need moving')
  assert.ok(rawBad > 0, 'sanity: the old floor scan did put mobs in holes on these floors')
})

;(async () => {
  let ok = 0
  for (const [name, fn] of tests) {
    try { await fn(); ok++; console.log('  ok  ', name) } catch (e) { console.log('  FAIL', name); console.log('      ' + String(e.stack || e).split('\n').join('\n      ')) }
  }
  console.log(`\n${ok}/${tests.length} passed`)
  process.exit(ok === tests.length ? 0 : 1)
})()
