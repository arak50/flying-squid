'use strict'
// Bow / arrow tests. Run from src/plugins/mob-ai inside a flying-squid checkout:  node test/bow.test.js

const assert = require('assert')
const bow = require('../lib/bow')
const { segmentAabb } = require('../lib/projectiles')
const { Vec3, Item, real, makeWorld, fill, makeMob, makePlayer, makeServer, run, createRunner } = require('./harness')

const runner = createRunner()
const test = runner.test
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const bowId = real.itemsByName.bow.id
const arrowId = real.itemsByName.arrow.id

/** Step the arrow manager directly (deterministic, no timers). */
async function stepArrows (serv, n) {
  for (let i = 0; i < n; i++) { serv.tickCount++; await serv.mobAI.projectiles.tick() }
}

;(async () => {
  console.log('bow maths')

  await test('draw power curve: (t^2 + 2t) / 3, full at 20 ticks, nothing below 0.1', () => {
    assert.strictEqual(bow.powerForTicks(0), 0)
    assert.ok(near(bow.powerForTicks(10), (0.25 + 1) / 3))
    assert.strictEqual(bow.powerForTicks(20), 1)
    assert.strictEqual(bow.powerForTicks(200), 1)
    assert.ok(bow.powerForTicks(2) < bow.MIN_POWER && bow.powerForTicks(3) >= bow.MIN_POWER)
  })

  await test('damage = ceil(speed * base); crit adds 0 .. floor(d/2) + 2', () => {
    assert.strictEqual(bow.arrowDamage(3, 2, false), 6) // full draw
    assert.strictEqual(bow.arrowDamage(1.6, 2, false), 4) // skeleton, ceil(3.2)
    assert.strictEqual(bow.arrowDamage(3, 2, true, () => 0), 6)
    assert.strictEqual(bow.arrowDamage(3, 2, true, () => 0.999999), 6 + 5) // 3 + 2
    for (let i = 0; i < 200; i++) { const d = bow.arrowDamage(3, 2, true); assert.ok(d >= 6 && d <= 11) }
  })

  await test('Power raises base damage by 0.5 * level + 0.5', () => {
    assert.strictEqual(bow.baseDamageForPower(0), 2)
    assert.strictEqual(bow.baseDamageForPower(1), 3)
    assert.strictEqual(bow.baseDamageForPower(5), 5)
  })

  await test('aiming: zero divergence is exact, spread grows with divergence, speed is respected', () => {
    const v = bow.aimVelocity(new Vec3(0, 0, 5), 3, 0)
    assert.ok(near(v.x, 0) && near(v.y, 0) && near(v.z, 3))
    let max0 = 0
    let max14 = 0
    for (let i = 0; i < 500; i++) {
      max0 = Math.max(max0, Math.abs(bow.aimVelocity(new Vec3(0, 0, 1), 1, 1).x))
      max14 = Math.max(max14, Math.abs(bow.aimVelocity(new Vec3(0, 0, 1), 1, 14).x))
    }
    assert.ok(max0 <= 0.0172275 + 1e-9 && max14 > max0 && max14 <= 14 * 0.0172275 + 1e-9)
  })

  await test('yaw / pitch -> direction uses the vanilla convention', () => {
    const south = bow.directionFromAngles(0, 0)
    assert.ok(near(south.z, 1) && near(south.x, 0))
    const west = bow.directionFromAngles(90, 0) // yaw 90 faces -x
    assert.ok(near(west.x, -1, 1e-9))
    const down = bow.directionFromAngles(0, 90)
    assert.ok(near(down.y, -1, 1e-9))
  })

  await test('enchant levels are read from whatever the item exposes', () => {
    assert.deepStrictEqual(bow.bowEnchants({ enchants: [{ name: 'power', lvl: 3 }, { name: 'minecraft:flame', lvl: 1 }, { name: 'sharpness', lvl: 5 }] }), { power: 3, punch: 0, flame: 1, infinity: 0 })
    assert.deepStrictEqual(bow.bowEnchants(null), { power: 0, punch: 0, flame: 0, infinity: 0 })
  })

  await test('segment / box intersection', () => {
    const o = new Vec3(0, 0.5, 0.5)
    const d = new Vec3(10, 0, 0)
    assert.ok(near(segmentAabb(o, d, new Vec3(4, 0, 0), new Vec3(5, 1, 1)), 0.4))
    assert.strictEqual(segmentAabb(o, d, new Vec3(4, 2, 0), new Vec3(5, 3, 1)), null)
    assert.strictEqual(segmentAabb(o, new Vec3(3, 0, 0), new Vec3(4, 0, 0), new Vec3(5, 1, 1)), null) // too short
  })

  console.log('arrow flight')

  await test('flight follows pos += vel; vel *= 0.99; vel.y -= 0.05 every tick', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = serv.mobAI.projectiles
    const a = p.shoot({ world, origin: new Vec3(0.5, 20, 0.5), velocity: new Vec3(2, 1, 0) })
    let pos = new Vec3(0.5, 20, 0.5)
    let vel = new Vec3(2, 1, 0)
    for (let i = 0; i < 12; i++) {
      pos = pos.plus(vel)
      vel = vel.scaled(0.99)
      vel.y -= 0.05
      await stepArrows(serv, 1)
      assert.ok(near(a.pos.x, pos.x) && near(a.pos.y, pos.y), `tick ${i + 1}: ${a.pos} vs ${pos}`)
    }
  })

  await test('drag in water is 0.6', async () => {
    const serv = makeServer()
    const extra = fill({}, 2, 5, 30, 1, 10, -3, 3)
    const world = makeWorld(extra)
    const a = serv.mobAI.projectiles.shoot({ world, origin: new Vec3(3.5, 3, 0.5), velocity: new Vec3(2, 0, 0) })
    await stepArrows(serv, 1) // moves to x 5.5, which is inside the water
    assert.ok(near(a.vel.x, 2 * 0.6), 'drag applied: ' + a.vel.x)
  })

  await test('sticks into a wall 0.05 in front of the surface, stays, and despawns after its lifetime', async () => {
    const serv = makeServer({ arrowLifetime: 40 })
    const world = makeWorld(fill({}, 1, 10, 10, 1, 4, -5, 5))
    const a = serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 2.5, 0.5), velocity: new Vec3(3, 0, 0) })
    await stepArrows(serv, 6)
    assert.ok(a.stuck, 'stuck')
    assert.ok(a.pos.x > 9.9 && a.pos.x < 10, 'in front of the wall face: ' + a.pos.x)
    const where = a.pos.clone()
    await stepArrows(serv, 10)
    assert.ok(a.pos.equals(where), 'does not move once stuck')
    assert.ok(serv.entities[a.entity.id], 'still there')
    await stepArrows(serv, 40)
    assert.ok(!serv.entities[a.entity.id], 'despawned')
    assert.strictEqual(serv.mobAI.projectiles.count, 0)
  })

  await test('hits the floor, and a stuck arrow falls again when its block is removed', async () => {
    const serv = makeServer()
    const extra = fill({}, 1, 10, 10, 1, 4, -5, 5)
    const world = makeWorld(extra)
    const a = serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 2.5, 0.5), velocity: new Vec3(3, 0, 0) })
    await stepArrows(serv, 6)
    assert.ok(a.stuck)
    fill(extra, 0, 10, 10, 1, 4, -5, 5) // wall removed
    await stepArrows(serv, 6) // the support check runs every 5 ticks
    assert.ok(!a.stuck, 'resumed flying')
  })

  console.log('arrow hits')

  await test('full-draw arrow does 6 to a mob and is consumed; shooter is excluded', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const zombie = makeMob(world, 'zombie', 8.5, 1, 0.5)
    serv.entities[zombie.id] = zombie
    const hits = []
    serv.on('arrowHit', h => hits.push(h))
    const a = serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 2, 0.5), velocity: new Vec3(3, 0, 0), baseDamage: 2 })
    await stepArrows(serv, 5)
    assert.strictEqual(zombie.damage.length, 1)
    assert.strictEqual(zombie.damage[0].damage, 6)
    assert.ok(zombie.damage[0].velocity.x > 0, 'knocked away from the shooter')
    assert.ok(!serv.entities[a.entity.id], 'arrow removed')
    assert.strictEqual(hits.length, 1)
    assert.strictEqual(hits[0].target, zombie)
  })

  await test('the owner is not hit by its own fresh arrow', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const skel = makeMob(world, 'skeleton', 0.5, 1, 0.5)
    serv.entities[skel.id] = skel
    serv.mobAI.projectiles.shoot({ owner: skel, world, origin: new Vec3(0.5, 1.6, 0.5), velocity: new Vec3(0.3, 0, 0) })
    await stepArrows(serv, 4)
    assert.strictEqual(skel.damage.length, 0)
  })

  await test('arrows hit players, Punch adds knockback and Flame burns for 5 s', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const victim = makePlayer(world, 8.5, 1, 0.5)
    serv.players.push(victim); serv.entities[victim.id] = victim
    serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 1.5, 0.5), velocity: new Vec3(3, 0, 0), punch: 2, flame: true })
    await stepArrows(serv, 5)
    assert.strictEqual(victim.damage.length, 1)
    assert.ok(victim.damage[0].velocity.x > 8 + 12, 'punch 2 pushes harder')
    const before = victim.damage.length
    await stepArrows(serv, 100)
    const burn = victim.damage.length - before
    assert.ok(burn >= 4 && burn <= 5, 'about 1 damage per second for 5 s, got ' + burn)
  })

  await test('creative players cannot be hurt: the arrow bounces off', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = makePlayer(world, 8.5, 1, 0.5)
    p.gameMode = 1
    serv.players.push(p); serv.entities[p.id] = p
    const a = serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 1.5, 0.5), velocity: new Vec3(3, 0, 0) })
    await stepArrows(serv, 5)
    assert.strictEqual(p.damage.length, 0)
    assert.ok(a.vel.x < 0, 'reversed')
  })

  await test('spectators are ignored by arrows', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = makePlayer(world, 8.5, 1, 0.5)
    p.gameMode = 3
    serv.players.push(p); serv.entities[p.id] = p
    const a = serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 1.5, 0.5), velocity: new Vec3(3, 0, 0) })
    await stepArrows(serv, 5)
    assert.strictEqual(p.damage.length, 0)
    assert.ok(a.pos.x > 12, 'flew straight through')
  })

  await test('a player shooting a mob provokes it', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const shooter = makePlayer(world, 0.5, 1, 0.5)
    serv.players.push(shooter); serv.entities[shooter.id] = shooter
    const cow = makeMob(world, 'cow', 8.5, 1, 0.5)
    serv.entities[cow.id] = cow
    await run(serv, 3) // attaches the AI
    serv.mobAI.projectiles.shoot({ owner: shooter, world, origin: new Vec3(0.5, 1.5, 0.5), velocity: new Vec3(3, 0, 0) })
    await stepArrows(serv, 5)
    assert.ok(serv.mobAI.get(cow).panicTicks > 0, 'cow panics')
  })

  console.log('pickup')

  await test('stuck arrows are picked up after the shake delay; creative-only arrows are not', async () => {
    const serv = makeServer()
    const world = makeWorld(fill({}, 1, 10, 10, 1, 4, -5, 5))
    const player = makePlayer(world, 9.7, 1, 1.3) // beside the arrows' line of flight (z = 0.5), not in it
    serv.players.push(player); serv.entities[player.id] = player
    const mine = serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 1.5, 0.5), velocity: new Vec3(3, 0, 0), pickup: 'allowed' })
    const creativeOnly = serv.mobAI.projectiles.shoot({ world, origin: new Vec3(0.5, 1.7, 0.5), velocity: new Vec3(3, 0, 0), pickup: 'creative' })
    await stepArrows(serv, 6)
    assert.ok(mine.stuck && creativeOnly.stuck)
    await stepArrows(serv, 3)
    assert.ok(serv.entities[mine.entity.id], 'not yet: the arrow just landed')
    await stepArrows(serv, 10)
    assert.ok(!serv.entities[mine.entity.id], 'picked up')
    const stack = player.inventory.slots.find(s => s && s.type === arrowId)
    assert.ok(stack && stack.count === 1)
    assert.ok(serv.entities[creativeOnly.entity.id], 'a survival player cannot take a creative-only arrow')
  })

  console.log('player bow')

  /** A player holding a bow in hotbar slot 0 with `arrows` arrows in slot 1. */
  function bowPlayer (serv, world, { arrows = 5, gameMode = 0, enchants = null } = {}) {
    const p = makePlayer(world, 0.5, 1, 0.5)
    p.gameMode = gameMode
    const b = new Item(bowId, 1)
    if (enchants) Object.defineProperty(b, 'enchants', { value: enchants })
    p.inventory.slots[36] = b
    if (arrows) p.inventory.slots[37] = new Item(arrowId, arrows)
    serv.players.push(p); serv.entities[p.id] = p
    return p
  }
  const arrowsOf = serv => Object.values(serv.entities).filter(e => e.name === 'arrow')
  const draw = (serv, p, ticks) => {
    p._client.emit('use_item', { hand: 'main_hand' })
    serv.tickCount += ticks
    p._client.emit('block_dig', { status: 5 })
  }

  await test('full draw fires a speed-3 critical arrow and uses one arrow', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = bowPlayer(serv, world)
    require('..').player(p, serv)
    const shots = []
    serv.on('bowShot', s => shots.push(s))
    draw(serv, p, 20)
    assert.strictEqual(arrowsOf(serv).length, 1)
    const arrow = shots[0].arrow
    const speed = arrow.vel.norm()
    assert.ok(Math.abs(speed - 3) < 0.15, 'speed ~3 blocks/tick, got ' + speed)
    assert.ok(arrow.vel.z > 2.8, 'fired along +z (yaw 0)')
    assert.strictEqual(arrow.critical, true)
    assert.strictEqual(arrow.baseDamage, 2)
    assert.strictEqual(p.inventory.slots[37].count, 4)
    assert.ok(p._client.written.some(([n]) => n === 'sound_effect'), 'shoot sound sent')
  })

  await test('half draw is slower and not critical; a tap fires nothing', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = bowPlayer(serv, world)
    require('..').player(p, serv)
    draw(serv, p, 10)
    const a = [...serv.mobAI.projectiles.arrows.values()][0]
    assert.ok(Math.abs(a.vel.norm() - 3 * bow.powerForTicks(10)) < 0.1)
    assert.strictEqual(a.critical, false)
    draw(serv, p, 1)
    assert.strictEqual(arrowsOf(serv).length, 1, 'the 1-tick tap added nothing')
    assert.strictEqual(p.inventory.slots[37].count, 4, 'and used no arrow')
  })

  await test('no arrows: survival cannot draw, creative can and keeps its inventory', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const empty = bowPlayer(serv, world, { arrows: 0 })
    require('..').player(empty, serv)
    draw(serv, empty, 20)
    assert.strictEqual(arrowsOf(serv).length, 0)

    const creative = bowPlayer(serv, world, { arrows: 0, gameMode: 1 })
    require('..').player(creative, serv)
    draw(serv, creative, 20)
    assert.strictEqual(arrowsOf(serv).length, 1)
    assert.strictEqual([...serv.mobAI.projectiles.arrows.values()][0].pickup, 'creative')
  })

  await test('Infinity keeps the arrow, Power and Punch and Flame are applied', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = bowPlayer(serv, world, { enchants: [{ name: 'infinity', lvl: 1 }, { name: 'power', lvl: 3 }, { name: 'punch', lvl: 2 }, { name: 'flame', lvl: 1 }] })
    require('..').player(p, serv)
    draw(serv, p, 20)
    const a = [...serv.mobAI.projectiles.arrows.values()][0]
    assert.strictEqual(p.inventory.slots[37].count, 5, 'arrow not used up')
    assert.strictEqual(a.baseDamage, 4) // 2 + 0.5*3 + 0.5
    assert.strictEqual(a.punch, 2)
    assert.strictEqual(a.flame, true)
    assert.strictEqual(a.pickup, 'creative')
  })

  await test('switching hotbar slot cancels the draw', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = bowPlayer(serv, world)
    require('..').player(p, serv)
    p._client.emit('use_item', { hand: 'main_hand' })
    p._client.emit('held_item_slot', { slotId: 3 })
    serv.tickCount += 20
    p._client.emit('block_dig', { status: 5 })
    assert.strictEqual(arrowsOf(serv).length, 0)
  })

  console.log('skeleton')

  await test('a skeleton holds a bow, draws for 20 ticks, shoots real arrows and waits between shots', async () => {
    const serv = makeServer() // difficulty 1 -> 40 tick interval
    const world = makeWorld()
    const player = makePlayer(world, 0.5, 1, 0.5)
    player.health = 1e6
    serv.players.push(player); serv.entities[player.id] = player
    const skel = makeMob(world, 'skeleton', 12.5, 1, 0.5)
    serv.entities[skel.id] = skel
    const shotTicks = []
    serv.on('mobAi:rangedAttack', () => shotTicks.push(serv.tickCount))
    await run(serv, 800)

    assert.strictEqual(skel.equipment[0].type, bowId, 'bow in the main hand')
    assert.ok(skel.packets.some(([n]) => n === 'entity_equipment'), 'equipment sent to nearby players')
    assert.ok(shotTicks.length >= 2, 'shot repeatedly: ' + shotTicks.length)
    for (let i = 1; i < shotTicks.length; i++) {
      assert.ok(shotTicks[i] - shotTicks[i - 1] >= 55, `20 tick draw + 40 tick interval, got ${shotTicks[i] - shotTicks[i - 1]}`)
    }
    // 26.1 metadata keys: living_entity_flags = 8 (0x01 using item), mob_flags = 15 (0x04 aggressive)
    const byKey = k => skel.metaLog.map(m => m[0]).filter(e => e.key === k).map(e => e.value)
    assert.ok(byKey(15).includes(4), 'aggressive flag (arms-up bow pose) was sent: ' + byKey(15))
    assert.ok(byKey(8).includes(1) && byKey(8).includes(0), 'using-item flag goes up and down while drawing: ' + byKey(8))
    assert.ok(skel.metadata.some(e => e.key === 15 && e.value === 4), 'stored metadata matches, so players who spawn it mid-fight see the pose')
    assert.ok(player.damage.length >= 1, 'arrows hit the player')
    assert.ok(player.damage.every(d => d.damage >= 1 && d.damage <= 6), 'skeleton arrow damage is small: ' + player.damage.map(d => d.damage))
    assert.ok(skel.position.distanceTo(player.position) <= 16, 'stays within bow range')
  })

  await test('hard difficulty shoots faster (20 tick interval) and more accurately', async () => {
    const serv = makeServer({ difficulty: 3 })
    const world = makeWorld()
    const player = makePlayer(world, 0.5, 1, 0.5)
    player.health = 1e6
    serv.players.push(player); serv.entities[player.id] = player
    const skel = makeMob(world, 'skeleton', 12.5, 1, 0.5)
    serv.entities[skel.id] = skel
    const shotTicks = []
    serv.on('mobAi:rangedAttack', () => shotTicks.push(serv.tickCount))
    await run(serv, 700)
    assert.ok(shotTicks.length >= 3)
    const gaps = shotTicks.slice(1).map((t, i) => t - shotTicks[i])
    assert.ok(Math.min(...gaps) >= 35 && Math.max(...gaps) < 70, 'about 40 ticks apart: ' + gaps)
  })

  await test('skeleton arrows use speed 1.6 and the difficulty-dependent spread', async () => {
    const serv = makeServer({ difficulty: 2 })
    const world = makeWorld()
    const player = makePlayer(world, 0.5, 1, 0.5)
    player.health = 1e6
    serv.players.push(player); serv.entities[player.id] = player
    const skel = makeMob(world, 'skeleton', 10.5, 1, 0.5)
    serv.entities[skel.id] = skel
    const speeds = []
    serv.on('arrowShot', ({ arrow }) => speeds.push(arrow.vel.norm()))
    await run(serv, 500)
    assert.ok(speeds.length >= 1)
    // vanilla adds the spread to the unit direction before scaling, so the speed varies a little around 1.6
    for (const s of speeds) assert.ok(s > 1.4 && s < 1.8, 'speed ~1.6, got ' + s)
  })

  await test('the flag indices are read from the registry (26.1: 8 and 15)', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = makePlayer(world, 0.5, 1, 0.5)
    serv.players.push(p); serv.entities[p.id] = p
    const skel = makeMob(world, 'skeleton', 12.5, 1, 0.5)
    serv.entities[skel.id] = skel
    await run(serv, 3)
    const ai = serv.mobAI.get(skel)
    assert.deepStrictEqual(ai.flagKeys, { living: 8, mob: 15 })
    const keys = real.entities[skel.entityType].metadataKeys
    assert.strictEqual(keys[ai.flagKeys.living], 'living_entity_flags')
    assert.strictEqual(keys[ai.flagKeys.mob], 'mob_flags')
  })

  await test('a chasing zombie raises its arms (aggressive flag), and lowers them when the target is gone', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = makePlayer(world, 0.5, 1, 0.5)
    p.health = 1e6
    serv.players.push(p); serv.entities[p.id] = p
    const z = makeMob(world, 'zombie', 8.5, 1, 0.5)
    serv.entities[z.id] = z
    await run(serv, 120)
    const flags = z.metaLog.map(m => m[0]).filter(e => e.key === 15).map(e => e.value)
    assert.ok(flags.includes(4), 'aggressive while chasing')
    p.gameMode = 1 // creative: no longer a valid target
    await run(serv, 40)
    assert.strictEqual(flags.length && z.metaLog.map(m => m[0]).filter(e => e.key === 15).pop().value, 0)
  })

  await test('a stray skeleton also carries a bow; a zombie does not', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const p = makePlayer(world, 0.5, 1, 0.5)
    serv.players.push(p); serv.entities[p.id] = p
    const stray = makeMob(world, 'stray', 5.5, 1, 5.5)
    const zombie = makeMob(world, 'zombie', 6.5, 1, 6.5)
    serv.entities[stray.id] = stray; serv.entities[zombie.id] = zombie
    await run(serv, 3)
    assert.strictEqual(stray.equipment[0] && stray.equipment[0].type, bowId)
    assert.strictEqual(zombie.equipment[0], undefined)
  })

  await test('a frozen skeleton lowers its bow', async () => {
    const serv = makeServer()
    const world = makeWorld()
    const player = makePlayer(world, 0.5, 1, 0.5)
    player.health = 1e6
    serv.players.push(player); serv.entities[player.id] = player
    const skel = makeMob(world, 'skeleton', 12.5, 1, 0.5)
    serv.entities[skel.id] = skel
    await run(serv, 120)
    const ai = serv.mobAI.get(skel)
    ai.startUsingItem()
    player.position = new Vec3(900, 1, 900)
    await run(serv, 5)
    assert.ok(ai.frozen && !ai.isUsingItem && !ai.isAggressive)
    const last = k => skel.metaLog.map(m => m[0]).filter(e => e.key === k).pop().value
    assert.strictEqual(last(8), 0, 'bow lowered')
    assert.strictEqual(last(15), 0, 'no longer aggressive')
  })

  console.log(`\n${runner.state.passed} passed, ${runner.state.failed} failed`)
  process.exit(process.exitCode || 0)
})()
