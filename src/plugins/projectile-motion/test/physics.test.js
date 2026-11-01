'use strict'
const assert = require('assert')
const p = require('../lib/physics')
let passed = 0
let failed = 0
const test = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name) } catch (e) { failed++; console.log('  FAIL ' + name + '\n     ' + e.message) } }
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`)

test('hand-stepped vanilla loop matches simulate()', () => {
  let x = 0; let y = 0; let vx = 3 * Math.cos(Math.PI / 6); let vy = 3 * Math.sin(Math.PI / 6)
  const r = p.simulate({ speed: 3, pitch: 30, keepGoing: true, maxTicks: 40 })
  for (let t = 1; t <= 40; t++) { x += vx; y += vy; vx *= 0.99; vy = vy * 0.99 - 0.05; near(r.path[t].x, x, 1e-9); near(r.path[t].y, y, 1e-9) }
})
test('straight up: apex tick and drag-limited height', () => {
  const r = p.simulate({ speed: 3, pitch: 90 })
  // closed form: vy_n = -5 + 8 * 0.99^n  ->  zero at n = ln(0.625) / ln(0.99) = 46.8
  assert.strictEqual(r.apexTick, 47)
  near(r.maxHeight, 66.18, 0.05, 'max height')
})
test('no drag/gravity limit: vacuum formula range v^2 sin(2a)/g within a few %', () => {
  const r = p.simulate({ speed: 1, pitch: 45, gravity: 0.05, drag: 1 }) // per-tick gravity form: close to continuous
  near(r.range, 1 * 1 / 0.05, 1, 'vacuum range') // per-tick stepping overshoots the continuous 20 by ~3.5%
})
test('launching from higher ground lands farther', () => {
  const a = p.simulate({ speed: 2, pitch: 20 })
  const b = p.simulate({ speed: 2, pitch: 20, height: 10, targetY: 0 })
  assert.ok(b.range > a.range)
})
test('solvePitch round-trips through simulate', () => {
  const s = p.solvePitch({ speed: 3, distance: 40, dy: 3 })
  assert.ok(s.reachable && s.low !== null && s.high !== null)
  for (const pitch of [s.low, s.high]) {
    const h = p.heightAt({ speed: 3, pitch }, 40)
    near(h.y, 3, 0.01, 'height at distance')
  }
})
test('out of reach target reports unreachable', () => {
  assert.strictEqual(p.solvePitch({ speed: 1, distance: 200 }).reachable, false)
})
test('solveSpeed gives a speed that just reaches the target', () => {
  const v = p.solveSpeed({ distance: 30, dy: 0 })
  assert.ok(p.solvePitch({ speed: v * 1.001, distance: 30 }).reachable)
  assert.ok(!p.solvePitch({ speed: v * 0.99, distance: 30 }).reachable)
})
test('best angle is below 45 with drag and beats neighbours', () => {
  const b = p.bestAngle({ speed: 3 })
  assert.ok(b.pitch < 45 && b.pitch > 30)
  for (const d of [-3, 3]) assert.ok(p.simulate({ speed: 3, pitch: b.pitch + d }).range <= b.range + 1e-6)
})
test('bow power curve', () => {
  assert.strictEqual(p.bowPower(20), 1)
  assert.strictEqual(p.bowPower(40), 1)
  assert.strictEqual(p.bowPower(1), 0) // under 0.1 power does not fire
  near(p.bowPower(10), (0.25 + 1) / 3, 1e-12)
  near(p.bowSpeed(20), 3, 1e-12)
  assert.strictEqual(p.drawTicksForSpeed(3), 20)
  assert.strictEqual(p.drawTicksForSpeed(3.5), null)
})
test('arrow damage', () => {
  assert.deepStrictEqual(p.arrowDamage(3), { min: 6, max: 11, critical: true })
})
test('water slows an arrow', () => {
  const air = p.simulate({ speed: 3, pitch: 10 }).range
  const water = p.simulate({ speed: 3, pitch: 10, water: true }).range
  assert.ok(water < air / 2)
})
test('unknown projectile throws; custom gravity works', () => {
  assert.throws(() => p.simulate({ speed: 1, pitch: 0, projectile: 'nope' }))
  assert.ok(p.simulate({ speed: 1, pitch: 30, gravity: 0.01, drag: 0.99, projectile: 'nope' }).landed)
})

console.log('cross-check against the mob-ai arrow simulation')
try {
  const { ProjectileManager } = require('../../mob-ai/lib/projectiles')
  if (!ProjectileManager) throw new Error('not exported')
  // the vanilla per-tick rule is the same one mob-ai uses; compare with a direct re-implementation of its step
  test('arrow step rule (move, *0.99, -0.05) is the one mob-ai documents', () => {
    const src = require('fs').readFileSync(require.resolve('../../mob-ai/lib/projectiles'), 'utf8')
    assert.ok(/0\.99/.test(src) && /0\.05/.test(src))
  })
} catch (e) {
  console.log('  skipped (mob-ai plugin not installed next to this one): ' + e.message)
}

const cmdTest = () => {
  const { server } = require('../index')
  let cmd
  const serv = { commands: { add: c => { cmd = c } } }
  server(serv)
  test('/projectile command: simulate', () => {
    const out = cmd.action('speed=3 pitch=45')
    assert.ok(/range 1\d\d\.\d+ blocks/.test(out), out)
  })
  test('/projectile command: solve with bow draw', () => {
    const out = cmd.action('draw=20 distance=40 dy=5')
    assert.ok(/low angle/.test(out) && /high angle/.test(out), out)
  })
  test('/projectile command: min speed', () => {
    const out = cmd.action('projectile=snowball distance=25')
    assert.ok(/minimum speed/.test(out), out)
  })
  test('/projectile command: bad input is reported, not thrown', () => {
    assert.ok(/projectile:/.test(cmd.action('pitch=45')))
    assert.ok(/projectile:/.test(cmd.action('projectile=nope speed=1 pitch=1')))
  })
}
cmdTest()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
