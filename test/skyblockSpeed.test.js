/* eslint-env mocha */
'use strict'
const assert = require('assert')
const { attributeFor, blocksPerSecond, speedStat } = require('../src/plugins/skyblock-speed/lib/speed')
const { createDefaultEngine } = require('../src/plugins/skyblock-stats/lib/engine')

describe('skyblock-speed', () => {
  it('maps Speed to the movement_speed attribute (100 = vanilla 0.1)', () => {
    assert.ok(Math.abs(attributeFor(100) - 0.1) < 1e-12)
    assert.ok(Math.abs(attributeFor(250) - 0.25) < 1e-12)
    assert.strictEqual(attributeFor(-20), 0)
  })
  it('never exceeds 5x vanilla, whatever the stat says', () => {
    assert.ok(Math.abs(attributeFor(900) - 0.5) < 1e-12)
    assert.ok(Math.abs(blocksPerSecond(900) - 4.317 * 5) < 1e-9)
    assert.ok(Math.abs(blocksPerSecond(100, true) - 4.317 * 1.3) < 1e-9)
  })
  it('base player has 100 Speed; the default cap is 400 and effects can raise it', () => {
    const engine = createDefaultEngine({})
    const base = engine.compute({ profile: {} })
    assert.strictEqual(speedStat(base).total, 100)
    assert.strictEqual(speedStat(base).cap, 400)
    const mods = [{ id: 'helmet', label: 'Racing Helmet', stats: { speed: 450 }, caps: { speed: 100 } }]
    const r = engine.compute({ profile: {}, modifiers: mods })
    assert.strictEqual(speedStat(r).cap, 500)
    assert.strictEqual(speedStat(r).total, 500) // 550 raw, capped at 400 + 100
    assert.strictEqual(speedStat(engine.compute({ profile: {}, modifiers: [{ id: 'x', stats: { speed: 450 } }] })).total, 400)
  })
  it('cap bonuses do not leak into the value breakdown', () => {
    const r = createDefaultEngine({}).compute({ profile: {}, modifiers: [{ id: 'c', label: 'Cap', caps: { speed: 100 } }] })
    assert.strictEqual(r.byGroup.effects, undefined)
  })
  it('uses Rift Speed in the Rift', () => {
    const r = createDefaultEngine({}).compute({ profile: {}, context: { dimension: 'rift' } })
    assert.strictEqual(speedStat(r).id, 'rift_speed')
  })
})
