'use strict'
// Standalone tests: no Minecraft server needed. Run with:  node test/mob-ai.test.js
// (from src/plugins/mob-ai inside a flying-squid checkout so `vec3` resolves)

const assert = require('assert')
const { Vec3 } = require('vec3')
const { Goal, GoalSelector, Control } = require('../lib/goalSelector')
const { BlockView } = require('../lib/blockView')
const { Pathfinder } = require('../lib/pathfinder')
const { registry, makeWorld, makeMob, makePlayer, makeServer, run, createRunner } = require('./harness')

const runner = createRunner()
const test = runner.test

;(async () => {
  console.log('goal selector')

  await test('lower priority number preempts a conflicting goal; non-conflicting goals run together', async () => {
    const log = []
    class G extends Goal {
      constructor (name, controls, can) { super(null, controls); this.n = name; this.can = can }
      canStart () { return this.can() }
      start () { log.push('start ' + this.n) }
      stop () { log.push('stop ' + this.n) }
    }
    let combat = false
    const sel = new GoalSelector({ startInterval: 1 })
    const wander = new G('wander', Control.MOVE, () => true)
    const attack = new G('attack', Control.MOVE | Control.LOOK, () => combat)
    const look = new G('look', Control.LOOK, () => true)
    sel.add(3, wander); sel.add(2, attack); sel.add(4, look)
    sel.tick()
    assert.deepStrictEqual(log, ['start wander', 'start look'])
    combat = true
    sel.tick()
    assert.ok(sel.isRunning(attack) && !sel.isRunning(wander) && !sel.isRunning(look))
    assert.ok(log.includes('stop wander') && log.includes('stop look'))
    combat = false
    sel.tick()
    assert.ok(!sel.isRunning(attack) && sel.isRunning(wander))
  })

  await test('a lower precedence goal cannot steal controls from a running higher one', async () => {
    const sel = new GoalSelector({ startInterval: 1 })
    class Always extends Goal { canStart () { return true } }
    const hi = new Always(null, Control.MOVE)
    const lo = new Always(null, Control.MOVE)
    sel.add(1, hi); sel.add(5, lo)
    sel.tick(); sel.tick()
    assert.ok(sel.isRunning(hi) && !sel.isRunning(lo))
  })

  console.log('pathfinder')

  await test('walks around a wall', async () => {
    const extra = {}
    for (let z = -4; z <= 4; z++) for (let y = 1; y <= 2; y++) extra[`5,${y},${z}`] = 1
    const world = makeWorld(extra)
    const pf = new Pathfinder(new BlockView(registry))
    const res = await pf.find(world, new Vec3(2.5, 1, 0.5), new Vec3(8.5, 1, 0.5), { maxNodes: 600 })
    assert.ok(res && !res.partial, 'path found')
    const last = res.path[res.path.length - 1]
    assert.strictEqual(Math.floor(last.x), 8)
    assert.ok(res.path.every(p => !(Math.floor(p.x) === 5 && Math.abs(Math.floor(p.z)) <= 4)), 'never goes through the wall')
  })

  await test('steps up one block but not two', async () => {
    const world = makeWorld({ '4,1,0': 1, '6,1,0': 1, '6,2,0': 1 })
    const view = new BlockView(registry)
    const pf = new Pathfinder(view)
    const up = await pf.find(world, new Vec3(3.5, 1, 0.5), new Vec3(4.5, 2, 0.5))
    assert.ok(up && up.path.some(p => p.y === 2))
    const blocked = await pf.find(world, new Vec3(5.5, 1, 0.5), new Vec3(6.5, 3, 0.5))
    assert.ok(!blocked || blocked.partial || blocked.path.every(p => !(Math.floor(p.x) === 6 && Math.floor(p.z) === 0 && p.y < 3)), 'two-high wall is not walked through')
  })

  await test('avoids lava', async () => {
    const extra = {}
    // a lava river wider than the search range, so there is no way round it
    for (let z = -60; z <= 60; z++) extra[`4,0,${z}`] = 3
    const pf = new Pathfinder(new BlockView(registry))
    const res = await pf.find(makeWorld(extra), new Vec3(2.5, 1, 0.5), new Vec3(7.5, 1, 0.5), { maxNodes: 800 })
    assert.ok(!res || res.partial, 'a lava river across the only route is not crossed')
    if (res) assert.ok(res.path.every(p => Math.floor(p.x) < 4), 'partial path stops at the bank')
  })

  console.log('plugin')

  await test('mob near a player wanders; AI freezes beyond range and wakes again', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = makePlayer(world, 0, 1, 0)
    serv.players.push(player); serv.entities[player.id] = player
    const cow = makeMob(world, 'cow', 4.5, 1, 4.5)
    serv.entities[cow.id] = cow

    // a wandering mob can end anywhere, so measure how far it got rather than where it ended
    // (wandering starts with a 1/120 per tick chance, so wait for it instead of using a fixed window)
    const travelled = async (ticks) => {
      const from = cow.position.clone()
      let far = 0
      for (let i = 0; i < ticks && far <= 0.5; i += 20) {
        await run(serv, 20)
        far = Math.max(far, cow.position.distanceTo(from))
      }
      return far
    }
    assert.ok(await travelled(3000) > 0.5, 'cow wandered')
    assert.ok(serv.mobAI.get(cow), 'controller attached')
    assert.ok(!serv.mobAI.get(cow).frozen)

    // player teleports far away -> frozen
    player.position = new Vec3(500, 1, 500)
    await run(serv, 5)
    const ai = serv.mobAI.get(cow)
    assert.ok(ai.frozen, 'frozen when out of range')
    assert.deepStrictEqual(ai.selector.running, [], 'no goals running while frozen')
    const parked = cow.position.clone()
    await run(serv, 200)
    assert.ok(cow.position.equals(parked), 'frozen mob did not move')

    // back in range -> thaws and moves again
    player.position = parked.offset(3, 0, 3)
    const far = await travelled(3000)
    assert.ok(!ai.frozen, 'thawed when a player returns')
    assert.ok(far > 0.5, 'moves again after thaw')
  })

  await test('hysteresis: a mob just past the wake range stays awake', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = makePlayer(world, 0, 1, 0)
    serv.players.push(player); serv.entities[player.id] = player
    const pig = makeMob(world, 'pig', 22, 1, 0.5) // range 20, hysteresis 4 -> sleeps only beyond 24
    serv.entities[pig.id] = pig
    await run(serv, 5)
    assert.ok(serv.mobAI.get(pig).frozen === false)
  })

  await test('mob in another world than every player is frozen', async () => {
    const serv = makeServer()
    const w1 = makeWorld()
    const w2 = makeWorld()
    const player = makePlayer(w1, 0, 1, 0)
    serv.players.push(player); serv.entities[player.id] = player
    const pig = makeMob(w2, 'pig', 1.5, 1, 1.5)
    serv.entities[pig.id] = pig
    await run(serv, 5)
    assert.ok(serv.mobAI.get(pig).frozen)
  })

  await test('no players online freezes everything', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const pig = makeMob(world, 'pig', 1.5, 1, 1.5)
    serv.entities[pig.id] = pig
    await run(serv, 5)
    assert.ok(serv.mobAI.get(pig).frozen)
  })

  await test('zombie chases and hits a survival player', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = makePlayer(world, 0.5, 1, 0.5)
    serv.players.push(player); serv.entities[player.id] = player
    player.health = 1e6 // keep the mock player alive: a dead player is (correctly) no longer a target
    const z = makeMob(world, 'zombie', 9.5, 1, 0.5)
    serv.entities[z.id] = z
    await run(serv, 400)
    assert.ok(player.damage.length > 0, 'player was hit')
    assert.ok(z.position.distanceTo(player.position) < 3, 'zombie closed in: ' + z.position)
  })

  await test('zombie ignores a creative-mode player', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = makePlayer(world, 0.5, 1, 0.5)
    player.gameMode = 1
    serv.players.push(player); serv.entities[player.id] = player
    const z = makeMob(world, 'zombie', 5.5, 1, 0.5)
    serv.entities[z.id] = z
    await run(serv, 200)
    assert.strictEqual(player.damage.length, 0)
  })

  await test('provoking a passive mob makes it panic away from the attacker', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = makePlayer(world, 0.5, 1, 0.5)
    serv.players.push(player); serv.entities[player.id] = player
    const cow = makeMob(world, 'cow', 2.5, 1, 0.5)
    serv.entities[cow.id] = cow
    await run(serv, 3)
    const before = cow.position.distanceTo(player.position)
    serv.mobAI.get(cow).provoke(player)
    await run(serv, 60)
    assert.ok(cow.position.distanceTo(player.position) > before + 2, 'ran away')
  })

  await test('mobs fall to the ground and settle even when frozen', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = makePlayer(world, 0, 1, 0)
    serv.players.push(player); serv.entities[player.id] = player
    const cow = makeMob(world, 'cow', 1.5, 6, 1.5)
    cow.onGround = false
    serv.entities[cow.id] = cow
    await run(serv, 60)
    assert.ok(Math.abs(cow.position.y - 1) < 0.01, 'landed on y=1, got ' + cow.position.y)
  })

  await test('mobs without a profile are ignored; removed mobs are released', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = makePlayer(world, 0, 1, 0)
    serv.players.push(player); serv.entities[player.id] = player
    const bat = makeMob(world, 'bat', 1.5, 3, 1.5)
    const pig = makeMob(world, 'pig', 2.5, 1, 2.5)
    serv.entities[bat.id] = bat; serv.entities[pig.id] = pig
    await run(serv, 3)
    assert.ok(!serv.mobAI.get(bat))
    assert.ok(serv.mobAI.get(pig))
    delete serv.entities[pig.id]
    await run(serv, 3)
    assert.ok(!serv.mobAI.get(pig))
    assert.strictEqual(serv.mobAI.stats().total, 0)
  })

  console.log(`\n${runner.state.passed} passed, ${runner.state.failed} failed`)
  process.exit(process.exitCode || 0)
})()
