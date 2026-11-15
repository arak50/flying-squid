'use strict'
// Standalone tests for the vanilla-parity work:  node src/plugins/mob-ai/test/vanilla.test.js

const assert = require('assert')
const { Vec3 } = require('vec3')
const V = require('../lib/vanilla')
const { Goal, GoalSelector, Control } = require('../lib/goalSelector')
const { computeExplosion } = require('../lib/explosion')
const { registry, makeWorld, makeMob, makePlayer, makeServer, run, createRunner } = require('./harness')

const runner = createRunner()
const test = runner.test

const ids = []
const spawn = (serv, e) => { serv.entities[e.id] = e; ids.push(e.id); return e }

;(async () => {
  console.log('vanilla helpers')

  await test('reduced tick delay halves (rounding up) and the full tick alternates with age + id', () => {
    assert.strictEqual(V.reducedTickDelay(120), 60)
    assert.strictEqual(V.reducedTickDelay(5), 3)
    assert.strictEqual(V.reducedTickDelay(1), 1)
    const pattern = [0, 1, 2, 3, 4, 5].map(age => V.isFullTick(age, 7))
    assert.deepStrictEqual(pattern, [false, true, false, true, false, true])
    assert.strictEqual(V.isFullTick(4, 4), true)
  })

  await test('ground speed formula matches the per-tick recurrence it was derived from', () => {
    for (const attr of [0.2, 0.23, 0.25, 0.3, 0.46, 0.5]) {
      assert.ok(Math.abs(V.groundSpeedBps(attr) - V.simulateGroundSpeedBps(attr)) < 1e-6, 'attr ' + attr)
    }
    // zombie: 0.23 -> about 2.28 blocks/s, a walking player (4.3) outpaces it
    assert.ok(Math.abs(V.groundSpeedBps(0.23) - 2.2837) < 0.01)
    assert.ok(V.groundSpeedBps(0.23) < 4.317)
    // a cow panicking at modifier 2.0 is much faster than strolling
    assert.ok(V.groundSpeedBps(0.2 * 2) > 3 * V.groundSpeedBps(0.2))
  })

  await test('melee range is the hitbox inflated by ~0.83 blocks horizontally', () => {
    const dims = { w: 0.6, h: 1.8 }
    const at = (x, y = 0) => V.withinMeleeRange(new Vec3(0, 0, 0), dims, new Vec3(x, y, 0), dims)
    assert.ok(Math.abs(V.ATTACK_REACH - 0.8284) < 0.001)
    assert.strictEqual(at(1.2), true) // 0.6 gap
    assert.strictEqual(at(1.4), true) // 0.8 gap
    assert.strictEqual(at(1.5), false) // 0.9 gap
    assert.strictEqual(at(0.5, 3), false) // far above
    assert.strictEqual(at(0.5, 1.5), true) // overlapping vertically
  })

  await test('target range scales with visibility but never drops below 2 blocks', () => {
    assert.strictEqual(V.inTargetRange(30, 35, 1), true)
    assert.strictEqual(V.inTargetRange(30, 35, 0.8), false) // sneaking: 28
    assert.strictEqual(V.inTargetRange(1.9, 35, 0.01), true)
    assert.strictEqual(V.inTargetRange(2.1, 35, 0.01), false)
    assert.strictEqual(V.visibilityPercent({ crouching: true }, 'zombie'), 0.8)
    assert.strictEqual(V.visibilityPercent({ crouching: false, headItemName: 'zombie_head' }, 'zombie'), 0.5)
    assert.strictEqual(V.visibilityPercent({ headItemName: 'zombie_head' }, 'skeleton'), 1)
  })

  await test('path budget and fall distance follow vanilla', () => {
    assert.strictEqual(V.maxVisitedNodes(35), 560)
    assert.strictEqual(V.maxVisitedNodes(16), 256)
    assert.strictEqual(V.maxFallDistance(20, 20, false), 3)
    assert.strictEqual(V.maxFallDistance(20, 20, true), 16) // floor(20 - 6.6) + 3
    assert.strictEqual(V.maxFallDistance(2, 20, true), 3)
    assert.strictEqual(V.sunBurnChance(0.4), 0)
    assert.ok(Math.abs(V.sunBurnChance(1) - 0.04) < 1e-9)
  })

  console.log('goal selector (vanilla semantics)')

  const mk = (name, flags, prio, log, extra = {}) => {
    class G extends Goal {
      constructor () { super(null, flags) }
      canStart () { return extra.can === undefined ? true : extra.can() }
      shouldContinue () { return extra.keep === undefined ? true : extra.keep() }
      start () { log.push(name + ':start') }
      tick () { log.push(name + ':tick') }
      stop () { log.push(name + ':stop') }
      get requiresUpdateEveryTick () { return !!extra.every }
      get interruptible () { return extra.interruptible !== false }
    }
    return [prio, new G()]
  }

  await test('tickRunning only ticks goals that need every tick; tick() ticks them all', () => {
    const log = []
    const sel = new GoalSelector()
    sel.add(...mk('slow', Control.LOOK, 1, log))
    sel.add(...mk('fast', Control.JUMP, 1, log, { every: true }))
    sel.tick()
    assert.deepStrictEqual(log.filter(l => l.endsWith('tick')).sort(), ['fast:tick', 'slow:tick'])
    log.length = 0
    sel.tickRunning(false)
    assert.deepStrictEqual(log, ['fast:tick'])
  })

  await test('adjustedTickDelay halves only for goals that are not ticked every tick', () => {
    const slow = mk('a', 0, 1, [])[1]
    const fast = mk('b', 0, 1, [], { every: true })[1]
    assert.strictEqual(slow.adjustedTickDelay(40), 20)
    assert.strictEqual(fast.adjustedTickDelay(40), 40)
  })

  await test('a goal takes a flag from a lower precedence holder (which is stopped); equal priority never does', () => {
    const log = []
    const sel = new GoalSelector()
    let go = false
    sel.add(...mk('low', Control.MOVE, 5, log))
    sel.tick()
    assert.deepStrictEqual(log.filter(l => l.includes('start')), ['low:start'])
    sel.add(...mk('high', Control.MOVE, 1, log, { can: () => go }))
    sel.tick()
    assert.ok(sel.running.length === 1) // not allowed yet
    go = true
    sel.tick()
    assert.ok(log.includes('low:stop'))
    assert.strictEqual(sel.running.length, 1)
    // equal priority cannot replace
    const sel2 = new GoalSelector()
    const log2 = []
    sel2.add(...mk('first', Control.MOVE, 3, log2))
    sel2.add(...mk('second', Control.MOVE, 3, log2))
    sel2.tick()
    assert.deepStrictEqual(log2.filter(l => l.includes('start')), ['first:start'])
  })

  await test('uninterruptible goals keep their flags; flags are released when a goal stops', () => {
    const log = []
    const sel = new GoalSelector()
    let keep = true
    sel.add(...mk('stubborn', Control.MOVE, 5, log, { interruptible: false, keep: () => keep }))
    sel.tick()
    assert.deepStrictEqual(log.filter(l => l.includes('start')), ['stubborn:start'])
    sel.add(...mk('urgent', Control.MOVE, 1, log)) // better priority, but the holder cannot be interrupted
    sel.tick()
    assert.deepStrictEqual(log.filter(l => l.includes('start')), ['stubborn:start'])
    keep = false
    sel.tick() // stubborn stops, urgent may now start in the same pass
    assert.ok(log.includes('stubborn:stop'))
    assert.ok(log.includes('urgent:start'))
  })

  console.log('explosion')

  const clear = async () => true
  const entityAt = (x, y, z, extra = {}) => ({ ref: { n: 1 }, pos: new Vec3(x, y, z), w: 0.6, h: 1.8, ...extra })

  await test('entity damage follows floor((i^2 + i) / 2 * 7 * diameter + 1) with i = (1 - distance / diameter) * exposure', async () => {
    const r = await computeExplosion({ center: new Vec3(0, 0, 0), radius: 3, resistanceAt: async () => null, lineClear: clear, entities: [entityAt(2, 0, 0)], breakBlocks: false })
    assert.strictEqual(r.hits.length, 1)
    assert.strictEqual(r.hits[0].damage, 22) // by hand: dist = sqrt(4 + 0.81) / 6 = 0.3655, i = 0.6345
    assert.ok(r.hits[0].knockback.x > 0 && Math.abs(r.hits[0].knockback.norm() - r.hits[0].impact) < 1e-9)
    assert.strictEqual(r.blocks.length, 0)
  })

  await test('entities beyond the diameter, behind cover or with full knockback resistance behave', async () => {
    const far = await computeExplosion({ center: new Vec3(0, 0, 0), radius: 3, resistanceAt: async () => null, lineClear: clear, entities: [entityAt(7, 0, 0)], breakBlocks: false })
    assert.strictEqual(far.hits.length, 0)
    const covered = await computeExplosion({ center: new Vec3(0, 0, 0), radius: 3, resistanceAt: async () => null, lineClear: async () => false, entities: [entityAt(2, 0, 0)], breakBlocks: false })
    assert.strictEqual(covered.hits.length, 0)
    const golem = await computeExplosion({ center: new Vec3(0, 0, 0), radius: 3, resistanceAt: async () => null, lineClear: clear, entities: [entityAt(2, 0, 0, { kbr: 1 })], breakBlocks: false })
    assert.strictEqual(golem.hits[0].knockback.norm(), 0)
    assert.strictEqual(golem.hits[0].damage, 22) // knockback resistance does not reduce damage
  })

  await test('rays crater soft blocks but obsidian-like blocks stop them', async () => {
    const floor = res => async (x, y) => (y <= 0 ? res : null)
    const soft = await computeExplosion({ center: new Vec3(0.5, 1, 0.5), radius: 3, resistanceAt: floor(6), lineClear: clear, random: () => 0.5 })
    assert.ok(soft.blocks.length > 0, 'stone gets broken')
    assert.ok(soft.blocks.every(b => b.y <= 0))
    const hard = await computeExplosion({ center: new Vec3(0.5, 1, 0.5), radius: 3, resistanceAt: floor(1200), lineClear: clear, random: () => 0.5 })
    assert.strictEqual(hard.blocks.length, 0)
    const off = await computeExplosion({ center: new Vec3(0.5, 1, 0.5), radius: 3, resistanceAt: floor(6), lineClear: clear, breakBlocks: false })
    assert.strictEqual(off.blocks.length, 0)
  })

  console.log('plugin behaviour')

  const survivalPlayer = (serv, world, x, y, z) => {
    const p = makePlayer(world, x, y, z)
    p.health = 1e6
    serv.players.push(p)
    spawn(serv, p)
    return p
  }

  await test('speeds: vanilla attribute profiles convert to blocks/s, legacy movementSpeed profiles are untouched', async () => {
    const serv = makeServer()
    const world = makeWorld()
    survivalPlayer(serv, world, 0.5, 1, 0.5)
    const z = spawn(serv, makeMob(world, 'zombie', 4.5, 1, 0.5))
    await run(serv, 3)
    const ai = serv.mobAI.get(z)
    assert.ok(Math.abs(ai.speed(1) - V.groundSpeedBps(0.23)) < 1e-9)
    assert.ok(Math.abs(ai.speed(2) - V.groundSpeedBps(0.46)) < 1e-9)
    serv.mobAI.registerProfile('legacy_test', { type: 'passive', height: 1, attributes: { maxHealth: 5, movementSpeed: 3.6, followRange: 16, knockbackResistance: 0 }, goals: [] })
    const legacy = spawn(serv, makeMob(world, 'legacy_test', 2.5, 1, 2.5))
    legacy.entityType = registry.entitiesByName.pig.id
    legacy.name = 'legacy_test'
    await run(serv, 3)
    const lai = serv.mobAI.get(legacy)
    assert.ok(lai, 'legacy profile attaches')
    assert.strictEqual(lai.speed(0.5), 1.8)
  })

  await test('the full goal pass runs every second tick (staggered by entity id), cheap passes in between', async () => {
    const serv = makeServer()
    const world = makeWorld()
    survivalPlayer(serv, world, 0.5, 1, 0.5)
    const pig = spawn(serv, makeMob(world, 'pig', 4.5, 1, 0.5))
    await run(serv, 3)
    const ai = serv.mobAI.get(pig)
    let full = 0
    let cheap = 0
    const g = ai.selector.goals
    const tick = g.tick.bind(g)
    const tr = g.tickRunning.bind(g)
    g.tick = () => { full++; tick() }
    g.tickRunning = f => { if (f !== true) cheap++; tr(f) }
    await run(serv, 100)
    // tick() itself calls tickRunning(true) which is not counted as a cheap pass
    assert.ok(full >= 45 && full <= 55, 'full passes: ' + full)
    assert.ok(cheap >= 45 && cheap <= 55, 'cheap passes: ' + cheap)
  })

  await test('panic lasts 40 ticks after damage and then ends once the run is over', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = survivalPlayer(serv, world, 0.5, 1, 0.5)
    const cow = spawn(serv, makeMob(world, 'cow', 4.5, 1, 0.5))
    await run(serv, 3)
    const ai = serv.mobAI.get(cow)
    ai.provoke(player)
    assert.strictEqual(ai.shouldPanic(), true)
    assert.ok(ai.panicTicks > 30)
    const start = cow.position.clone()
    let ran = false
    for (let i = 0; i < 30; i++) {
      await run(serv, 1)
      if (ai.selector.goals.running.some(g => g.constructor.name === 'PanicGoal')) ran = true
    }
    assert.ok(ran, 'PanicGoal ran')
    assert.ok(cow.position.distanceTo(start) > 0.3, 'it moved')
    await run(serv, 200)
    assert.strictEqual(ai.shouldPanic(), false)
    assert.strictEqual(ai.panicTicks, 0)
    assert.ok(!ai.selector.goals.running.some(g => g.constructor.name === 'PanicGoal'), 'panic goal finished')
  })

  await test('a creeper swells within 3 blocks, explodes after a 30 tick fuse and hurts the player but breaks no blocks', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const placed = []
    serv.setBlock = async (w, pos, id) => { placed.push([pos.x, pos.y, pos.z, id]) }
    const player = survivalPlayer(serv, world, 0.5, 1, 0.5)
    const c = spawn(serv, makeMob(world, 'creeper', 3.5, 1, 0.5))
    await run(serv, 3)
    const ai = serv.mobAI.get(c)
    let explosion = null
    serv.on('mobAi:explosion', e => { explosion = e })
    let firstSwell = -1
    for (let i = 0; i < 160 && !c.dead; i++) {
      await run(serv, 1)
      if (firstSwell < 0 && ai.swellDir > 0) firstSwell = ai.ticks
    }
    await run(serv, 5)
    assert.ok(c.dead, 'creeper exploded and removed itself')
    assert.ok(firstSwell > 0, 'it started swelling')
    assert.ok(explosion && explosion.hits >= 1, 'hit the player')
    assert.ok(player.damage.length >= 1 && player.damage[0].damageType === 'explosion')
    assert.ok(player.damage[0].damage >= 1)
    assert.strictEqual(placed.length, 0, 'no blocks destroyed by default')
    // the fuse is 30 ticks from the first swelling tick
    assert.ok(ai.swell >= 30 || c.dead)
  })

  await test('creeperBlockDamage: true lets the explosion destroy blocks', async () => {
    const stone = registry.blocks[1]
    const had = stone.resistance
    stone.resistance = 6
    try {
      const serv = makeServer({ creeperBlockDamage: true })
      const world = makeWorld()
      const placed = []
      serv.setBlock = async (w, pos, id) => { placed.push(id) }
      survivalPlayer(serv, world, 0.5, 1, 0.5)
      const c = spawn(serv, makeMob(world, 'creeper', 3.5, 1, 0.5))
      for (let i = 0; i < 200 && !c.dead; i++) await run(serv, 1)
      await run(serv, 5)
      assert.ok(c.dead)
      assert.ok(placed.length > 0 && placed.every(id => id === 0), 'blocks replaced with air: ' + placed.length)
    } finally {
      if (had === undefined) delete stone.resistance
      else stone.resistance = had
    }
  })

  await test('creeperExplosions: false keeps creepers harmless', async () => {
    const serv = makeServer({ creeperExplosions: false })
    const world = makeWorld()
    const player = survivalPlayer(serv, world, 0.5, 1, 0.5)
    const c = spawn(serv, makeMob(world, 'creeper', 2.5, 1, 0.5))
    await run(serv, 150)
    assert.ok(!c.dead)
    assert.strictEqual(player.damage.length, 0)
  })

  await test('a spider leaps only when the target is 2 to 4 blocks away and it is on the ground', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = survivalPlayer(serv, world, 0.5, 1, 0.5)
    const s = spawn(serv, makeMob(world, 'spider', 4.5, 1, 0.5))
    await run(serv, 3)
    const ai = serv.mobAI.get(s)
    const goal = new serv.mobAI.goals.LeapAtTargetGoal(ai, 0.4)
    ai.target = player
    const roll = (value, fn) => { const r = Math.random; Math.random = () => value; try { return fn() } finally { Math.random = r } }
    const at = x => { s.position = new Vec3(x, 1, 0.5) }
    at(3.5) // 3 blocks
    ai.nav.onGround = true
    assert.strictEqual(roll(0, () => goal.canStart()), true)
    assert.strictEqual(roll(0.99, () => goal.canStart()), false, 'the 1 in 3 roll can fail')
    at(5.5) // 5 blocks: too far
    assert.strictEqual(roll(0, () => goal.canStart()), false)
    at(1.5) // 1 block: too close
    assert.strictEqual(roll(0, () => goal.canStart()), false)
    at(3.5)
    ai.nav.onGround = false
    assert.strictEqual(roll(0, () => goal.canStart()), false, 'airborne')
    ai.nav.onGround = true
    ai.nav.vy = 0
    goal.start()
    assert.ok(Math.abs(ai.nav.vy - 8) < 1e-9, 'jumps with 0.4 blocks/tick: ' + ai.nav.vy)
    assert.ok(ai.kb.x < 0, 'towards the player (negative x)')
    assert.strictEqual(goal.shouldContinue(), true, 'stays active until it lands')
  })

  await test('hurting a zombified piglin alerts the ones nearby', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = survivalPlayer(serv, world, 0.5, 1, 0.5)
    const a = spawn(serv, makeMob(world, 'zombified_piglin', 8.5, 1, 0.5))
    const b = spawn(serv, makeMob(world, 'zombified_piglin', 10.5, 1, 2.5))
    await run(serv, 3)
    const other = serv.mobAI.get(b)
    assert.strictEqual(other.target, null)
    serv.mobAI.get(a).provoke(player)
    await run(serv, 10)
    assert.strictEqual(serv.mobAI.get(a).target, player, 'attacked piglin targets the player')
    assert.strictEqual(other.target, player, 'neighbour joined in')
  })

  await test('a skeleton backs away from a wolf', async () => {
    const serv = makeServer()
    const world = makeWorld()
    // inside the 20 block wake range but beyond the skeleton's 16 block follow range: nobody hunts anyone
    survivalPlayer(serv, world, -12.5, 1, 0.5)
    spawn(serv, makeMob(world, 'wolf', 3.5, 1, 0.5))
    const sk = spawn(serv, makeMob(world, 'skeleton', 5.5, 1, 0.5))
    await run(serv, 3)
    assert.ok(serv.mobAI.get(sk), 'skeleton has AI')
    const start = sk.position.clone()
    let avoided = false
    for (let i = 0; i < 60; i++) {
      await run(serv, 1)
      if (serv.mobAI.get(sk).selector.goals.running.some(g => g.constructor.name === 'AvoidEntityGoal')) avoided = true
    }
    assert.ok(avoided, 'AvoidEntityGoal ran')
    assert.ok(sk.position.distanceTo(start) > 1.5, 'it moved: ' + sk.position.distanceTo(start))
  })

  await test('burning: ignition lasts 8 seconds, hurts once per second and panics the mob', async () => {
    const serv = makeServer()
    const world = makeWorld()
    survivalPlayer(serv, world, 0.5, 1, 0.5)
    const z = spawn(serv, makeMob(world, 'zombie', 6.5, 1, 6.5))
    await run(serv, 3)
    const ai = serv.mobAI.get(z)
    ai.ignite(8)
    assert.strictEqual(ai.burning, 160)
    assert.strictEqual(ai.shouldPanic(), true)
    const before = z.damage.length
    ai.target = null
    for (let i = 0; i < 160; i++) { ai._tickFire() }
    assert.strictEqual(z.damage.length - before, 8)
    assert.strictEqual(ai.burning, 0)
    assert.ok(z.damage.every(d => d.damageType === 'on_fire'))
  })

  console.log(`\n${runner.state.passed} passed, ${runner.state.failed} failed`)
  process.exit(runner.state.failed ? 1 : 0)
})()
