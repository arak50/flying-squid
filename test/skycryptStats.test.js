/* eslint-env mocha */
'use strict'
const assert = require('assert')
const { createDefaultEngine } = require('../src/plugins/skyblock-stats/lib/engine')
const { stepBonus } = require('../src/plugins/skyblock-stats/lib/providers/slayer')
const catacombs = require('../src/plugins/skyblock-stats/lib/providers/catacombs')
const misc = require('../src/plugins/skyblock-stats/lib/providers/misc')
const bonuses = require('../src/plugins/skyblock-stats/data/skycrypt/bonuses.json')

describe('skyblock-stats: SkyCrypt sources', () => {
  it('slayer steps follow SkyCrypt getBonusStat', () => {
    assert.deepStrictEqual(stepBonus(bonuses.slayer_zombie, 3, 9), { health: 7 })
    assert.strictEqual(stepBonus(bonuses.slayer_zombie, 8, 9).health_regen, 50)
  })
  it('catacombs level from xp (+2 Health per level)', () => {
    assert.strictEqual(catacombs.level(0), 0)
    assert.strictEqual(catacombs.level(50), 1)
    assert.strictEqual(catacombs.level(125), 2)
  })
  it('pet score thresholds', () => {
    assert.strictEqual(misc.petScoreMagicFind(9), 0)
    assert.strictEqual(misc.petScoreMagicFind(10), 1)
    assert.strictEqual(misc.petScoreMagicFind(338), 10)
  })
  it('engine adds essence shop, slayer and potion sources from a member', () => {
    const member = {
      player_data: { perks: { permanent_health: 2, unbreaking: 2 }, active_effects: [{ effect: 'strength', level: 2 }] },
      slayer: { slayer_bosses: { zombie: { claimed_levels: { level_1: true }, boss_kills_tier_0: 1 } } }
    }
    const r = createDefaultEngine({}).compute({ profile: member })
    assert.strictEqual(r.byGroup.essence_shop.health, 4)
    assert.strictEqual(r.byGroup.essence_shop.vitality, 4)
    assert.strictEqual(r.byGroup.slayer.health, 2)
    assert.strictEqual(r.byGroup.potions.strength, 12.5)
  })
})
