'use strict'
const assert = require('assert')
const p = require('../lib/physics')
let passed = 0
let failed = 0
const group = name => console.log(name)
const test = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name) } catch (e) { failed++; console.log('  FAIL ' + name + '\n     ' + e.message) } }
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`)
const V = (x, y, z) => ({ pos: { x: 0, y: 0, z: 0 }, vel: { x, y, z } })

group('A. one tick of each projectile (position, velocity, gravity, drag, order)')
test('arrow: position -> drag -> gravity', () => {
  const s = p.step(V(0, 1, 2), { projectile: 'arrow' })
  near(s.pos.y, 1, 1e-12); near(s.pos.z, 2, 1e-12) // moved with the OLD velocity
  near(s.vel.y, 1 * 0.99 - 0.05, 1e-12); near(s.vel.z, 2 * 0.99, 1e-12)
  near(s.moveVel.y, 1, 1e-12)
})
test('spectral arrow and trident use the arrow order', () => {
  for (const name of ['spectral_arrow', 'trident']) {
    const s = p.step(V(0, 1, 2), { projectile: name })
    near(s.pos.y, 1, 1e-12, name); near(s.vel.y, 0.99 - 0.05, 1e-12, name)
  }
})
test('snowball, egg, ender pearl: gravity -> drag -> position', () => {
  for (const name of ['snowball', 'egg', 'ender_pearl']) {
    const s = p.step(V(0, 1, 2), { projectile: name })
    near(s.vel.y, (1 - 0.03) * 0.99, 1e-12, name)
    near(s.pos.y, (1 - 0.03) * 0.99, 1e-12, name + ' moves with the NEW velocity')
    near(s.pos.z, 2 * 0.99, 1e-12, name)
    near(s.moveVel.y, s.vel.y, 1e-12, name)
  }
})
test('potions and experience bottle: their own gravity, same order', () => {
  const g = { splash_potion: 0.05, lingering_potion: 0.05, experience_bottle: 0.07 }
  for (const name of Object.keys(g)) near(p.step(V(0, 1, 0), { projectile: name }).vel.y, (1 - g[name]) * 0.99, 1e-12, name)
})
test('fishing bobber: position -> gravity -> drag', () => {
  const s = p.step(V(1, 1, 0), { projectile: 'fishing_bobber' })
  near(s.pos.y, 1, 1e-12)
  near(s.vel.y, (1 - 0.03) * 0.92, 1e-12)
})
test('item / falling block / tnt: gravity -> position -> drag', () => {
  for (const name of ['item', 'falling_block', 'tnt']) {
    const s = p.step(V(0, 0, 1), { projectile: name })
    near(s.pos.y, -0.04, 1e-12, name); near(s.vel.y, -0.04 * 0.98, 1e-12, name); near(s.vel.z, 0.98, 1e-12, name)
  }
})
test('horizontal and vertical drag are separate', () => {
  const s = p.step(V(1, 1, 1), { projectile: 'arrow', dragH: 0.5, dragV: 0.9, tickOrder: 'drag-position-gravity' })
  near(s.vel.x, 0.5, 1e-12); near(s.vel.z, 0.5, 1e-12); near(s.vel.y, 0.9 - 0.05, 1e-12)
  near(s.pos.y, 0.9, 1e-12)
})
test('every profile has the full structure; unverified ones say so', () => {
  for (const [name, pr] of Object.entries(p.PROJECTILES)) {
    assert.ok(typeof pr.gravity === 'number' && pr.drag.h > 0 && pr.drag.v > 0 && pr.waterDrag.h > 0 && pr.tickOrder, name)
    assert.strictEqual(typeof pr.verified, 'boolean', name)
  }
  assert.ok(p.PROJECTILES.item.approximate && p.PROJECTILES.fishing_bobber.approximate)
})
test('hand-stepped vanilla arrow loop matches simulate()', () => {
  let x = 0; let y = 0; let vx = 3 * Math.cos(Math.PI / 6); let vy = 3 * Math.sin(Math.PI / 6)
  const r = p.simulate({ speed: 3, pitch: 30, keepGoing: true, targetY: -1e9, maxTicks: 40 })
  for (let t = 1; t <= 40; t++) { x += vx; y += vy; vx *= 0.99; vy = vy * 0.99 - 0.05; near(r.path[t].x, x, 1e-9); near(r.path[t].y, y, 1e-9) }
})
test('unknown projectile throws; custom gravity works', () => {
  assert.throws(() => p.simulate({ speed: 1, pitch: 0, projectile: 'nope' }))
  assert.throws(() => p.resolve({ projectile: 'arrow', tickOrder: 'nonsense' }))
  assert.ok(p.simulate({ speed: 1, pitch: 30, gravity: 0.01, drag: 0.99, projectile: 'nope' }).landed)
})

group('B. launch conditions')
test('nominal launch speeds', () => {
  const sp = { snowball: 1.5, egg: 1.5, ender_pearl: 1.5, splash_potion: 0.5, lingering_potion: 0.5, experience_bottle: 0.7, trident: 2.5 }
  for (const [name, s] of Object.entries(sp)) near(p.launchVelocity({ projectile: name }).speed, s, 1e-9, name)
  assert.throws(() => p.launchVelocity({ projectile: 'arrow' }), /no launch speed/)
})
test('potions and bottles are thrown 20 degrees above the look direction', () => {
  for (const name of ['splash_potion', 'lingering_potion', 'experience_bottle']) {
    near(p.launchVelocity({ projectile: name, pitch: 0 }).pitch, 20, 1e-9, name)
    near(p.launchVelocity({ projectile: name, pitch: -30 }).pitch, -10, 1e-9, name)
  }
  near(p.launchVelocity({ projectile: 'snowball', pitch: 10 }).pitch, 10, 1e-9)
})
test('yaw: 0 faces +z, positive yaw turns towards -x', () => {
  const a = p.launchVelocity({ projectile: 'snowball', yaw: 0 })
  near(a.z, 1.5, 1e-9); near(a.x, 0, 1e-9)
  const b = p.launchVelocity({ projectile: 'snowball', yaw: 90 })
  near(b.x, -1.5, 1e-9); near(b.z, 0, 1e-9)
  const c = p.velocityFromAngles(-90, 0, 2)
  near(c.x, 2, 1e-9)
})
test('shooter velocity: horizontal inherited, vertical only when airborne', () => {
  const pv = { x: 0.2, y: 0.4, z: 0.3 }
  const ground = p.launchVelocity({ projectile: 'snowball', pitch: 0, playerVelocity: pv, onGround: true })
  const air = p.launchVelocity({ projectile: 'snowball', pitch: 0, playerVelocity: pv, onGround: false })
  near(ground.x, 0.2, 1e-9); near(ground.z, 1.5 + 0.3, 1e-9); near(ground.y, 0, 1e-9)
  near(air.y, 0.4, 1e-9); near(air.x, 0.2, 1e-9)
})
test('deterministic inaccuracy vector and seeded random inaccuracy', () => {
  const d = p.launchVelocity({ projectile: 'snowball', pitch: 0, spread: { x: 0.01, y: 0, z: 0 } })
  near(d.x, 0.015, 1e-9)
  const a = p.launchVelocity({ projectile: 'snowball', random: () => 0.9 })
  const b = p.launchVelocity({ projectile: 'snowball', random: () => 0.9 })
  assert.deepStrictEqual(a, b)
  const none = p.launchVelocity({ projectile: 'snowball' })
  assert.deepStrictEqual(p.launchVelocity({ projectile: 'snowball', random: () => 0.5 }), none, 'equal draws cancel in the triangle')
})

group('C. water')
test('starts in air / starts in water', () => {
  const air = p.simulate({ speed: 3, pitch: 10 }).range
  const wet = p.simulate({ speed: 3, pitch: 10, water: true }).range
  assert.ok(wet < air / 2)
  near(p.step(V(0, 0, 1), { projectile: 'arrow' }, true).vel.z, 0.6, 1e-12)
})
test('enters and leaves water: per-tick drag matches a hand calculation', () => {
  const r = p.simulate({ speed: 3, pitch: 0, targetY: -1e9, keepGoing: true, maxTicks: 12, inWater: [[3, 5]] })
  let vz = 3
  for (let t = 0; t < 12; t++) { vz *= (t >= 3 && t <= 5) ? 0.6 : 0.99; near(r.path[t + 1].vel.z, vz, 1e-9, 'tick ' + t) }
})
test('several water regions and a function-based environment agree', () => {
  const ranges = [[2, 4], [10, 12]]
  const a = p.simulate({ speed: 3, pitch: 30, inWater: ranges })
  const b = p.simulate({ speed: 3, pitch: 30, inWater: ({ tick }) => ranges.some(r => tick >= r[0] && tick <= r[1]) })
  near(a.range, b.range, 1e-12)
  assert.ok(a.range < p.simulate({ speed: 3, pitch: 30 }).range)
  assert.ok(a.range > p.simulate({ speed: 3, pitch: 30, water: true }).range)
})
test('environment can depend on position (water below y = -2)', () => {
  const r = p.simulate({ speed: 1, pitch: 0, height: 0, targetY: -10, inWater: ({ pos }) => pos.y < -2 })
  assert.ok(r.landed)
})

group('D. trajectory calculations')
test('straight up: apex tick and max height match the closed form', () => {
  const r = p.simulate({ speed: 3, pitch: 90 })
  assert.strictEqual(r.apexTick, 47) // vy_n = -5 + 8 * 0.99^n -> zero at n = 46.8
  near(r.maxHeight, 66.18, 0.05)
  near(r.apexSeconds, 47 / 20, 1e-12)
})
test('range, flight time and impact speed are consistent', () => {
  const r = p.simulate({ speed: 3, pitch: 45 })
  assert.ok(r.landed && r.range > 100 && r.range < 125)
  assert.ok(r.flightTicks > 70 && r.flightTicks < 80)
  near(r.flightSeconds, r.flightTicks / 20, 1e-12)
  const v = r.impactVelocity
  near(r.impactSpeed, Math.hypot(v.x, v.y, v.z), 1e-12)
  assert.ok(v.y < 0)
  // arrows move with the velocity they had BEFORE this tick's drag and gravity: that is the impact velocity
  const last = r.path[Math.ceil(r.flightTicks)]
  near(r.impactSpeed, Math.hypot(last.moveVel.x, last.moveVel.y, last.moveVel.z), 1e-12)
})
test('vacuum-like case stays near v^2 sin(2a) / g (stepping overshoots by a few %)', () => {
  near(p.simulate({ speed: 1, pitch: 45, gravity: 0.05, drag: 1 }).range, 20, 1)
})
test('launch height and target plane', () => {
  assert.ok(p.simulate({ speed: 2, pitch: 20, height: 10 }).range > p.simulate({ speed: 2, pitch: 20 }).range)
  const up = p.simulate({ speed: 3, pitch: 45, targetY: 10 })
  assert.ok(up.landed && up.range < p.simulate({ speed: 3, pitch: 45 }).range)
})
test('low and high angle solutions round-trip', () => {
  const s = p.solvePitch({ speed: 3, distance: 40, dy: 3 })
  assert.ok(s.reachable && s.low < s.high)
  for (const pitch of [s.low, s.high]) near(p.heightAt({ speed: 3, pitch }, 40).y, 3, 0.01)
})
test('unreachable target', () => {
  assert.strictEqual(p.solvePitch({ speed: 1, distance: 200 }).reachable, false)
})
test('solveSpeed just reaches the target', () => {
  const v = p.solveSpeed({ distance: 30 })
  assert.ok(p.solvePitch({ speed: v * 1.001, distance: 30 }).reachable)
  assert.ok(!p.solvePitch({ speed: v * 0.99, distance: 30 }).reachable)
})
test('best range angle is below 45 with drag and beats its neighbours (numerical, not v^2 sin 2a / g)', () => {
  const b = p.bestAngle({ speed: 3 })
  assert.ok(b.pitch < 45 && b.pitch > 30)
  for (const d of [-3, 3]) assert.ok(p.simulate({ speed: 3, pitch: b.pitch + d }).range <= b.range + 1e-6)
})
test('swept collision: a fast arrow cannot tunnel through a thin target', () => {
  const path = p.trajectory({ speed: 3, pitch: 0, maxTicks: 40 })
  const box = { min: { x: -0.3, y: -0.5, z: 10.0 }, max: { x: 0.3, y: 0.5, z: 10.1 } } // thinner than one tick's movement
  const c = p.collision(path, box)
  assert.ok(c.hit && c.point.z > 9.6 && c.point.z < 10.1, JSON.stringify(c))
  assert.ok(!p.collision(path, { min: { x: 5, y: 0, z: 10 }, max: { x: 6, y: 1, z: 11 } }).hit, 'misses to the side')
  assert.ok(c.speed > 2)
})
test('collision accepts simulate options and reports where in the tick it hit', () => {
  const c = p.collision({ speed: 3, pitch: 0, gravity: 0, drag: 1 }, { min: { x: -1, y: -1, z: 6 }, max: { x: 1, y: 1, z: 7 } }, { margin: 0 })
  assert.ok(c.hit)
  near(c.point.z, 6, 1e-9); near(c.tick, 2, 1e-9)
})
test('simulateMany: seeded, repeatable, spread grows with inaccuracy, hit rate with a box', () => {
  const o = { projectile: 'snowball', pitch: 5, targetY: -1, height: 0 }
  const a = p.simulateMany(o, { count: 100, seed: 7 })
  const b = p.simulateMany(o, { count: 100, seed: 7 })
  assert.deepStrictEqual(a.runs, b.runs)
  const wide = p.simulateMany({ ...o, inaccuracy: 6 }, { count: 100, seed: 7 })
  assert.ok(wide.stdDev.x > a.stdDev.x * 3)
  const big = { min: { x: -50, y: -3, z: 0 }, max: { x: 50, y: 3, z: 200 } }
  assert.strictEqual(p.simulateMany(o, { count: 20, seed: 1, box: big }).hitRate, 1)
})

group('E. bow mechanics')
test('draw power curve and minimum', () => {
  assert.strictEqual(p.bowPower(1), 0)
  near(p.bowPower(10), (0.25 + 1) / 3, 1e-12)
  assert.strictEqual(p.bowPower(20), 1)
  assert.strictEqual(p.bowPower(40), 1)
  near(p.bowSpeed(20), 3, 1e-12)
  assert.strictEqual(p.drawTicksForSpeed(3), 20)
  assert.strictEqual(p.drawTicksForSpeed(3.5), null)
})
test('critical is an explicit property of a full draw, not of speed', () => {
  assert.strictEqual(p.bowCritical(20), true)
  assert.strictEqual(p.bowCritical(19), false)
  assert.strictEqual(p.arrowDamage(3).critical, false)
  assert.strictEqual(p.arrowDamage(3, { critical: true }).critical, true)
})
test('damage uses the speed it is given; critical adds the random range', () => {
  assert.deepStrictEqual(p.arrowDamage(3), { base: 2, powerBonus: 0, min: 6, max: 6, critical: false })
  assert.deepStrictEqual(p.arrowDamage(3, { critical: true }), { base: 2, powerBonus: 0, min: 6, max: 11, critical: true })
  assert.strictEqual(p.arrowDamage(1.5).min, 3)
  assert.ok(p.arrowDamage(p.simulate({ speed: 3, pitch: 45 }).impactSpeed).min < 6, 'drag slows the arrow, so impact damage is lower')
})
test('Power adds 0.5 * level + 0.5 to the base damage; the old call form still works', () => {
  near(p.arrowDamage(3, { power: 1 }).powerBonus, 1, 1e-12)
  assert.strictEqual(p.arrowDamage(3, { power: 1 }).min, 9)
  assert.strictEqual(p.arrowDamage(3, 2, 0).min, 6)
  assert.strictEqual(p.arrowDamage(3, 2, 1).min, 9)
})

group('F. calculator and command')
const { server, calculate, format } = require('../index')
let cmd
server({ commands: { add: c => { cmd = c } } })
test('API and exports are all present', () => {
  const serv = { commands: { add () {} } }
  server(serv)
  for (const k of ['simulate', 'heightAt', 'solvePitch', 'solveSpeed', 'bestAngle', 'bowPower', 'bowSpeed', 'drawTicksForSpeed', 'arrowDamage', 'calculate', 'format', 'PROJECTILES', 'launchVelocity', 'velocityFromAngles', 'resolve', 'step', 'collision', 'simulateMany', 'trajectory']) {
    assert.ok(serv.projectileMotion[k] !== undefined, k)
  }
  assert.deepStrictEqual(cmd.aliases, ['pm'])
})
test('launch height: default target plane is the ground, dy is relative to the launcher', () => {
  const low = calculate({ speed: 2, pitch: 20 }).sim.range
  const high = calculate({ speed: 2, pitch: 20, height: 10 }).sim
  assert.ok(high.range > low && high.flightTicks > calculate({ speed: 2, pitch: 20 }).sim.flightTicks)
  near(calculate({ speed: 2, pitch: 20, height: 10, dy: -10 }).sim.range, high.range, 1e-9)
})
test('vanilla mode uses the throwable launch speed and pitch offset', () => {
  const r = calculate({ projectile: 'splash_potion', pitch: 0, vanilla: true })
  near(r.launch.pitch, 20, 1e-9)
  near(r.launch.speed, 0.5, 1e-9)
  assert.ok(/not yet verified/.test(format(r).join('\n')))
})
test('a full-draw bow shot is critical and damage uses the impact speed', () => {
  const r = calculate({ draw: 20, pitch: 10 })
  assert.strictEqual(r.critical, true)
  assert.ok(r.damage.critical && r.damage.max > r.damage.min)
  assert.ok(r.damage.min <= Math.ceil(3 * 2))
})
test('/projectile: simulate, solve, min speed, water ranges, errors', () => {
  assert.ok(/range 1\d\d\.\d+ blocks/.test(cmd.action('speed=3 pitch=45')))
  const solve = cmd.action('draw=20 distance=40 dy=5')
  assert.ok(/low angle/.test(solve) && /high angle/.test(solve))
  assert.ok(/minimum speed/.test(cmd.action('projectile=snowball distance=25')))
  assert.ok(/partly in water/.test(cmd.action('speed=3 pitch=30 water=5-20')))
  assert.ok(/look .* deg/.test(cmd.action('projectile=splash_potion distance=3 vanilla')))
  assert.ok(/projectile:/.test(cmd.action('pitch=45')))
  assert.ok(/projectile:/.test(cmd.action('projectile=nope speed=1 pitch=1')))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
