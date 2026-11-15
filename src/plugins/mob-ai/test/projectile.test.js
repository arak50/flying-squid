'use strict'
// Standalone tests for the projectile side of the vanilla port:  node src/plugins/mob-ai/test/projectile.test.js

const assert = require('assert')
const { Vec3 } = require('vec3')
const bow = require('../lib/bow')
const physics = require('../../projectile-motion/lib/physics')
const { makeWorld, makeMob, makeServer, createRunner } = require('./harness')

const runner = createRunner()
const test = runner.test

async function stepArrows (serv, n) {
  for (let i = 0; i < n; i++) { serv.tickCount++; await serv.mobAI.projectiles.tick() }
}

const zombieAt = (serv, world, x) => {
  const z = makeMob(world, 'zombie', x, 1, 0.5)
  serv.entities[z.id] = z
  return z
}

;(async () => {
  console.log('piercing')

  await test('without Piercing an arrow stops at the first entity', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const [a, b] = [6.5, 9.5].map(x => zombieAt(serv, world, x))
    serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 2, 0.5), velocity: new Vec3(3, 0, 0) })
    await stepArrows(serv, 8)
    assert.strictEqual(a.damage.length, 1)
    assert.strictEqual(b.damage.length, 0)
    assert.strictEqual(serv.mobAI.projectiles.count, 0)
  })

  await test('Piercing I goes through one entity and is used up by the second; nobody is hit twice', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const [a, b, c] = [6.5, 9.5, 12.5].map(x => zombieAt(serv, world, x))
    const hits = []
    serv.on('arrowHit', h => hits.push(h.target))
    const arrow = serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 2, 0.5), velocity: new Vec3(3, 0, 0), pierce: 1 })
    await stepArrows(serv, 2)
    assert.strictEqual(a.damage.length, 1, 'first zombie hit')
    assert.ok(serv.entities[arrow.entity.id], 'still flying after the first hit')
    await stepArrows(serv, 12)
    assert.strictEqual(a.damage.length, 1)
    assert.strictEqual(b.damage.length, 1)
    assert.strictEqual(c.damage.length, 0, 'the third is spared')
    assert.deepStrictEqual(hits, [a, b])
    assert.strictEqual(serv.mobAI.projectiles.count, 0, 'arrow used up')
  })

  await test('a pierced arrow that runs out of targets still ends up in a wall', async () => {
    const serv = makeServer()
    const world = makeWorld({ '20,2,0': 1, '20,1,0': 1, '20,3,0': 1 })
    const a = zombieAt(serv, world, 6.5)
    serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 2, 0.5), velocity: new Vec3(3, 0, 0), pierce: 2 })
    await stepArrows(serv, 30)
    assert.strictEqual(a.damage.length, 1)
    const arrows = [...serv.mobAI.projectiles.arrows.values()]
    assert.strictEqual(arrows.length, 1)
    assert.strictEqual(arrows[0].stuck, true)
  })

  console.log('constants shared with the /projectile calculator')

  await test('arrow gravity and drag are the same numbers the calculator uses', () => {
    const arrow = physics.PROJECTILES.arrow
    assert.strictEqual(bow.ARROW_GRAVITY, arrow.gravity)
    assert.strictEqual(bow.ARROW_DRAG_AIR, arrow.drag.h)
    assert.strictEqual(bow.ARROW_DRAG_WATER, arrow.waterDrag.h)
    assert.strictEqual(arrow.tickOrder, 'position-drag-gravity')
  })

  await test('verification flags say what was checked against the vanilla-accurate reference', () => {
    const P = physics.PROJECTILES
    for (const name of ['arrow', 'spectral_arrow', 'trident', 'snowball', 'egg', 'ender_pearl', 'splash_potion', 'lingering_potion', 'experience_bottle']) {
      assert.strictEqual(P[name].verified, true, name)
      assert.ok(P[name].verifiedFields.includes('gravity'), name)
    }
    assert.strictEqual(P.trident.waterDrag.h, 0.99) // unlike arrows (0.6)
    assert.strictEqual(P.arrow.waterDrag.h, 0.6)
    assert.strictEqual(P.splash_potion.gravity, 0.05)
    assert.strictEqual(P.experience_bottle.gravity, 0.07)
    assert.strictEqual(P.snowball.gravity, 0.03)
    assert.strictEqual(P.llama_spit.gravity, 0.06)
    assert.strictEqual(P.llama_spit.verified, false) // only the gravity was confirmed
    assert.strictEqual(P.fishing_bobber.verified, false)
    assert.ok(P.fishing_bobber.approximate)
    assert.strictEqual(P.snowball.tickOrder, 'gravity-drag-position')
  })

  console.log(`\n${runner.state.passed} passed, ${runner.state.failed} failed`)
  process.exit(runner.state.failed ? 1 : 0)
})()
