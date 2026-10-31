/* eslint-env mocha */
'use strict'
const assert = require('assert')
const { Vitals } = require('../src/plugins/skyblock-vitals/lib/vitals')
const { renderActionBar } = require('../src/plugins/skyblock-vitals/lib/actionBar')

const fakeStats = (o = {}) => {
  const v = Object.assign({ health: 100, defense: 0, true_defense: 0, health_regen: 100, vitality: 100 }, o)
  return { get: (k) => v[k] || 0, maxMana: o.maxMana !== undefined ? o.maxMana : 100, v }
}

describe('skyblock-vitals', () => {
  it('regenerates health every 2 s with (max/100+1.5) x regen/100', () => {
    const s = fakeStats(); const v = new Vitals(s)
    v.health = 50
    v.advance(1999); assert.strictEqual(v.health, 50)
    v.advance(1); assert.strictEqual(v.health, 52.5) // wiki: 1% of 100 + 1.5 = 2.5
  })
  it('Vitality scales healing, Health Regen scales natural regen', () => {
    const s = fakeStats({ health_regen: 200, vitality: 150 }); const v = new Vitals(s)
    v.health = 10; v.advance(2000)
    assert.strictEqual(v.health, 10 + 2.5 * 2 * 1.5)
    assert.strictEqual(v.heal(10, { raw: true }), 10)
  })
  it('regenerates 2% of max mana per second and stops at max', () => {
    const s = fakeStats({ maxMana: 500 }); const v = new Vitals(s)
    v.mana = 0; v.advance(1000); assert.strictEqual(v.mana, 10)
    v.mana = 495; v.advance(5000); assert.strictEqual(v.mana, 500)
  })
  it('regen bonuses stack as percent of the base rate', () => {
    const v = new Vitals(fakeStats({ maxMana: 1000 })); v.mana = 0
    v.addRegenBonus('flux', 50); v.advance(1000); assert.strictEqual(v.mana, 30)
  })
  it('a lower max removes the excess, a higher max does not refill', () => {
    const s = fakeStats({ maxMana: 300, health: 1000 }); const v = new Vitals(s)
    assert.strictEqual(v.mana, 300)
    s.maxMana = 100; s.v.health = 500; v.sync()
    assert.strictEqual(v.mana, 100); assert.strictEqual(v.health, 500)
    s.maxMana = 400; s.v.health = 2000; v.sync()
    assert.strictEqual(v.mana, 100); assert.strictEqual(v.health, 500)
  })
  it('spending: pays from mana, falls back to overflow, refuses otherwise', () => {
    const v = new Vitals(fakeStats({ maxMana: 100 }))
    assert.ok(v.spendMana(40)); assert.strictEqual(v.mana, 60)
    assert.ok(!v.spendMana(70))
    v.setOverflow(5000); assert.strictEqual(v.overflow, 780)
    assert.ok(v.spendMana(70)); assert.strictEqual(v.overflow, 710); assert.strictEqual(v.mana, 60)
  })
  it('damage is reduced by Defense/(Defense+100) and kills at 0', () => {
    const v = new Vitals(fakeStats({ health: 1000, defense: 100 }))
    let died = 0; v.on('death', () => died++)
    assert.strictEqual(v.damage(200), 100)
    assert.strictEqual(v.health, 900)
    v.damage(1e9, { trueDamage: true }); assert.ok(v.dead); assert.strictEqual(died, 1)
    v.advance(10000); assert.strictEqual(v.health, 0) // dead players do not regenerate
  })
  it('vanilla hearts keep the fraction of 20 and never show 0 while alive', () => {
    const v = new Vitals(fakeStats({ health: 2000 }))
    assert.strictEqual(v.vanillaHealth, 20)
    v.health = 1000; assert.strictEqual(v.vanillaHealth, 10)
    v.health = 1; assert.strictEqual(v.vanillaHealth, 1)
    v.setFromVanilla(0); assert.strictEqual(v.vanillaHealth, 0)
    v.setFromVanilla(20); assert.strictEqual(v.health, 2000); assert.ok(!v.dead)
  })
  it('renders the action bar', () => {
    const v = new Vitals(fakeStats({ health: 2000, defense: 321, maxMana: 285 }))
    assert.strictEqual(renderActionBar(v.snapshot(), { legacy: true }), '§c2,000/2,000❤     §a321❈ Defense     §b285/285✎ Mana')
    v.setOverflow(600); v.spendMana(50, { label: 'Ability' })
    const bar = renderActionBar(v.snapshot(), { legacy: true })
    assert.ok(bar.includes('§b-50 Mana (Ability)') && bar.endsWith('§3600ʬ'))
  })
})
