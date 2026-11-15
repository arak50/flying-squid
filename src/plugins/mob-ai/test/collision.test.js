'use strict'
// Standalone tests for entity-vs-entity pushing:  node src/plugins/mob-ai/test/collision.test.js

const assert = require('assert')
const { Vec3 } = require('vec3')
const { Control } = require('../lib/goalSelector')
const { pushImpulse, crammingHurts, PushGrid, PUSH_STRENGTH } = require('../lib/collision')
const { makeWorld, fill, makeMob, makePlayer, makeServer, run, createRunner } = require('./harness')

const runner = createRunner()
const test = runner.test

const spawn = (serv, e) => { serv.entities[e.id] = e; return e }
// attach the AI, then switch off every MOVE goal (strolling, panic ...) so only pushing can move the mobs
const still = async (serv, ...mobs) => {
  await run(serv, 1)
  for (const m of mobs) serv.mobAI.get(m).selector.disableControl(Control.MOVE)
}
const withRandom = async (value, fn) => {
  const r = Math.random
  Math.random = () => value
  try { return await fn() } finally { Math.random = r }
}

;(async () => {
  console.log('push maths')

  await test('impulse points away from the other entity, is symmetric and never exceeds 0.05', () => {
    const a = pushImpulse(new Vec3(0, 0, 0), new Vec3(0.5, 0, 0))
    const b = pushImpulse(new Vec3(0.5, 0, 0), new Vec3(0, 0, 0))
    assert.ok(a.x < 0 && a.z === 0, 'pushed towards -x')
    assert.ok(Math.abs(a.x + b.x) < 1e-12, 'equal and opposite')
    assert.ok(Math.abs(a.x + 0.0353553) < 1e-6, 'by hand: 0.5 / sqrt(0.5) * 1 * 0.05')
    const far = pushImpulse(new Vec3(0, 0, 0), new Vec3(4, 0, 0))
    assert.ok(Math.abs(far.x + PUSH_STRENGTH) < 1e-9, 'distant overlap (big mobs) is capped at 0.05')
    for (const d of [0.05, 0.3, 1, 2, 6]) {
      const v = pushImpulse(new Vec3(0, 0, 0), new Vec3(d, d / 2, 0))
      assert.ok(Math.hypot(v.x, v.z) <= PUSH_STRENGTH + 1e-12, 'distance ' + d)
    }
  })

  await test('entities on top of each other (under 0.01) are not pushed; the push is horizontal only', () => {
    assert.strictEqual(pushImpulse(new Vec3(1, 0, 1), new Vec3(1.005, 0, 1)), null)
    const v = pushImpulse(new Vec3(0, 0, 0), new Vec3(0.3, 5, 0.3))
    assert.deepStrictEqual(Object.keys(v).sort(), ['x', 'z'])
  })

  await test('cramming needs the limit reached and a 1 in 4 roll', () => {
    assert.strictEqual(crammingHurts(24, 24, () => 0), true)
    assert.strictEqual(crammingHurts(23, 24, () => 0), false)
    assert.strictEqual(crammingHurts(30, 24, () => 0.5), false)
    assert.strictEqual(crammingHurts(30, 0, () => 0), false, 'limit 0 disables it')
    let hits = 0
    for (let i = 0; i < 4000; i++) if (crammingHurts(30, 24)) hits++
    assert.ok(hits > 800 && hits < 1200, 'about a quarter: ' + hits)
  })

  console.log('push grid')

  await test('a query returns exactly the overlapping entries, also across cell borders and per world', () => {
    const w1 = {}
    const w2 = {}
    const grid = new PushGrid(2)
    const e = (ref, world, x, z) => ({ ref, world, pos: new Vec3(x, 0, z), w: 0.6, h: 1.8 })
    grid.rebuild([e('a', w1, 0, 0), e('b', w1, 1.8, 0), e('c', w1, 9, 9), e('d', w2, 0, 0)])
    const query = (world, x, z) => grid.query(world, { minX: x - 0.3, maxX: x + 0.3, minY: 0, maxY: 1.8, minZ: z - 0.3, maxZ: z + 0.3 }).map(r => r.ref).sort()
    assert.deepStrictEqual(query(w1, 0.3, 0), ['a'])
    assert.deepStrictEqual(query(w1, 1.4, 0), ['b'], 'b spans the x = 2 cell border')
    assert.deepStrictEqual(query(w1, 1, 0), [], 'a gap between the two touches nobody')
    assert.deepStrictEqual(query(w2, 0, 0), ['d'])
    assert.deepStrictEqual(query(w1, 50, 50), [])
  })

  console.log('plugin behaviour')

  await test('two overlapping cows are pushed apart until they no longer overlap', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const keep = makePlayer(world, 20.5, 1, 0.5) // wakes the AI, far enough to be irrelevant
    serv.players.push(keep); serv.entities[keep.id] = keep
    const a = spawn(serv, makeMob(world, 'cow', 5.4, 1, 0.5))
    const b = spawn(serv, makeMob(world, 'cow', 5.6, 1, 0.5))
    await still(serv, a, b)
    await run(serv, 2)
    assert.ok(a.position.x < 5.4 && b.position.x > 5.6, 'moved apart straight away')
    await run(serv, 40)
    assert.ok(b.position.x - a.position.x >= 0.85, 'a cow is 0.9 wide: ' + (b.position.x - a.position.x))
    assert.ok(Math.abs(a.position.z - 0.5) < 0.2 && Math.abs(b.position.z - 0.5) < 0.2, 'pushed along the line between them')
    assert.ok(serv.mobAI.get(a).pushVel.norm() < 0.06, 'push has died down')
  })

  await test('a player walking into a mob pushes it, but is never pushed by the server', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = makePlayer(world, 5.5, 1, 0.5)
    serv.players.push(player); serv.entities[player.id] = player
    const cow = spawn(serv, makeMob(world, 'cow', 5.9, 1, 0.5))
    const playerStart = player.position.clone()
    await still(serv, cow)
    await run(serv, 15)
    assert.ok(cow.position.x > 5.9 + 0.1, 'cow shoved away from the player: ' + cow.position.x)
    assert.ok(player.position.equals(playerStart), 'player position untouched')
    assert.strictEqual(player.damage.length, 0)
  })

  await test('spectators do not push', async () => {
    const serv = makeServer({ ignoreSpectators: false })
    const world = makeWorld()
    const player = makePlayer(world, 5.5, 1, 0.5)
    player.gameMode = 3
    serv.players.push(player); serv.entities[player.id] = player
    const cow = spawn(serv, makeMob(world, 'cow', 5.7, 1, 0.5))
    await still(serv, cow)
    await run(serv, 15)
    assert.ok(Math.abs(cow.position.x - 5.7) < 0.05, 'cow did not budge: ' + cow.position.x)
  })

  await test('mobCollision: false switches pushing off', async () => {
    const serv = makeServer({ mobCollision: false })
    const world = makeWorld()
    const keep = makePlayer(world, 20.5, 1, 0.5)
    serv.players.push(keep); serv.entities[keep.id] = keep
    const a = spawn(serv, makeMob(world, 'cow', 5.4, 1, 0.5))
    const b = spawn(serv, makeMob(world, 'cow', 5.6, 1, 0.5))
    await still(serv, a, b)
    await run(serv, 3)
    assert.ok(Math.abs(a.position.x - 5.4) < 0.01 && Math.abs(b.position.x - 5.6) < 0.01)
  })

  await test('a pushed mob cannot be shoved into a wall', async () => {
    const extra = fill({}, 1, 6, 6, 1, 3, -5, 5) // wall at x = 6
    const serv = makeServer()
    const world = makeWorld(extra)
    const player = makePlayer(world, 4.9, 1, 0.5)
    serv.players.push(player); serv.entities[player.id] = player
    const cow = spawn(serv, makeMob(world, 'cow', 5.3, 1, 0.5))
    await still(serv, cow)
    await run(serv, 40)
    assert.ok(cow.position.x < 6, 'still on this side of the wall: ' + cow.position.x)
  })

  await test('cramming: a crowd at the limit hurts for 6 (damage type cramming), under the limit it is safe', async () => {
    const crowd = async limit => {
      const serv = makeServer({ maxEntityCramming: limit })
      const world = makeWorld()
      const keep = makePlayer(world, 20.5, 1, 0.5)
      serv.players.push(keep); serv.entities[keep.id] = keep
      const cows = []
      for (let i = 0; i < 5; i++) cows.push(spawn(serv, makeMob(world, 'cow', 5.5 + i * 0.02, 1, 0.5)))
      await withRandom(0, () => run(serv, 6)) // roll 0 on every draw: the 1 in 4 cramming roll always succeeds
      return cows
    }
    const hurt = await crowd(4)
    const crammed = hurt.filter(c => c.damage.some(d => d.damage === 6 && d.damageType === 'cramming'))
    assert.ok(crammed.length >= 3, 'the crowd is hurt for 6 each (the pile flies apart quickly, so not necessarily every cow): ' + crammed.length)
    const safe = await crowd(8)
    assert.ok(safe.every(c => c.damage.length === 0))
    const off = await crowd(0)
    assert.ok(off.every(c => c.damage.length === 0), 'limit 0 disables cramming')
  })
  console.log(`\n${runner.state.passed} passed, ${runner.state.failed} failed`)
  process.exit(runner.state.failed ? 1 : 0)
})()
