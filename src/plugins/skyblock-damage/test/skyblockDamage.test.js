/* eslint-env mocha */
'use strict'
// Tests for the pure parts of skyblock-damage: the damage formula, reading stats, and the indicator text.
const assert = require('assert')
const { calculate, statsOf } = require('../lib/damage')
const { damageComponent, componentToNbt, plain } = require('../lib/indicator')

const never = () => 0.999 // never crits at 30 %
const always = () => 0 // always crits

describe('skyblock-damage formula', () => {
  it('no stats: the base 5', () => {
    assert.strictEqual(calculate({}, { rng: never }).damage, 5)
  })
  it('(5 + weapon + floor(strength / 5)) * (1 + strength / 100)', () => {
    // (5 + 100 + 20) * 2 = 250
    assert.strictEqual(calculate({ strength: 100, weaponDamage: 100, critChance: 30 }, { rng: never }).damage, 250)
  })
  it('crit multiplies by 1 + crit damage / 100', () => {
    const r = calculate({ strength: 100, weaponDamage: 100, critChance: 30, critDamage: 50 }, { rng: always })
    assert.strictEqual(r.critical, true)
    assert.strictEqual(r.damage, 375)
  })
  it('crit chance 0 never crits, 100 always does', () => {
    assert.strictEqual(calculate({ critChance: 0 }, { rng: always }).critical, false)
    assert.strictEqual(calculate({ critChance: 100 }, { rng: () => 0.999 }).critical, true)
  })
  it('never below the minimum', () => {
    assert.strictEqual(calculate({ additive: -100 }, { rng: never, min: 1 }).damage, 1)
  })
  it('reads stats from skyblock-stats and the held weapon', () => {
    const values = { strength: 100, crit_chance: 40, crit_damage: 80 }
    const player = { skyblock: { stats: { get: id => values[id], result: { held: { counts: true, damage: 100 } } } } }
    assert.deepStrictEqual(statsOf(player), { strength: 100, critChance: 40, critDamage: 80, weaponDamage: 100, additive: 0 })
  })
  it('a held item that does not count adds no damage; no profile means base stats', () => {
    const player = { skyblock: { stats: { get: () => 0, result: { held: { counts: false, damage: 999 } } } } }
    assert.strictEqual(statsOf(player).weaponDamage, 0)
    assert.deepStrictEqual(statsOf({}), { strength: 0, critChance: 0, critDamage: 0, weaponDamage: 0, additive: 0 })
  })
})

describe('skyblock-damage indicator text', () => {
  it('normal hit: gray number with thousands separators', () => {
    const c = damageComponent(1234.4, false)
    assert.strictEqual(plain(c), '1,234')
    assert.strictEqual(c.extra[0].color, 'gray')
  })
  it('crit: wrapped in ✧ with cycling colours', () => {
    const c = damageComponent(375, true)
    assert.strictEqual(plain(c), '✧375✧')
    assert.deepStrictEqual(c.extra.slice(1, 4).map(e => e.color), ['white', 'yellow', 'gold'])
  })
  it('component converts to typed NBT', () => {
    const nbt = componentToNbt(damageComponent(7, false))
    assert.strictEqual(nbt.type, 'compound')
    assert.strictEqual(nbt.value.extra.type, 'list')
    assert.strictEqual(nbt.value.extra.value.value[0].text.value, '7')
  })
})
