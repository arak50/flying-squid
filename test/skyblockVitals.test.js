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
  it('a lower max clamps health and only HIDES the excess mana; a higher max does not refill', () => {
    const s = fakeStats({ maxMana: 300, health: 1000 }); const v = new Vitals(s)
    assert.strictEqual(v.mana, 300)
    s.maxMana = 100; s.v.health = 500; v.sync()
    assert.strictEqual(v.shownMana, 100); assert.strictEqual(v.mana, 300) // recorded: stored mana survives
    assert.strictEqual(v.health, 500)
    s.maxMana = 400; s.v.health = 2000; v.sync()
    assert.strictEqual(v.shownMana, 300) // back up to what was stored, not refilled to 400
    assert.strictEqual(v.health, 500)
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
    assert.strictEqual(renderActionBar(v.snapshot(), { legacy: true }), '§c2,000/2,000❤     §a321§a❈ Defense     §b285/285✎ Mana     ')
    // the "-N Mana (label)" flash is opt-in: it never appeared in the recording
    v.setOverflow(600); v.spendMana(50, { label: 'Ability' })
    assert.ok(!renderActionBar(v.snapshot(), { legacy: true }).includes('Ability'))
    const f = new Vitals(fakeStats({ health: 2000, maxMana: 285 }), { manaFlash: true })
    f.setOverflow(600); f.spendMana(50, { label: 'Ability' })
    const bar = renderActionBar(f.snapshot(), { legacy: true })
    assert.ok(bar.includes('§b-50 Mana (Ability)') && bar.endsWith('§3600ʬ     '))
  })
})

describe('skyblock-vitals: update_health vs the Hypixel recording (protocol 26.1)', () => {
  const EventEmitter = require('events')
  const mc = require('minecraft-protocol')
  const plugin = require('../src/plugins/skyblock-vitals')

  // Raw payloads copied from the recording (packet id 0x68, then f32 health, varint food, f32 saturation)
  const RECORDED_LOBBY = Buffer.from('68 41 A0 00 00 14 40 A0 00 00'.replace(/ /g, ''), 'hex') // 20.0 / 20 / 5.0   (before joining SkyBlock)
  const RECORDED_SKYBLOCK = Buffer.from('68 42 20 00 00 14 41 A0 00 00'.replace(/ /g, ''), 'hex') // 40.0 / 20 / 20.0 (repeated every ~300 ms)

  const serialize = (params) => {
    const ser = mc.createSerializer({ state: mc.states.PLAY, isServer: true, version: '26.1' })
    return ser.createPacketBuffer({ name: 'update_health', params })
  }

  it('the serializer reproduces both recorded packets byte for byte', () => {
    assert.deepStrictEqual(serialize({ health: 20, food: 20, foodSaturation: 5 }), RECORDED_LOBBY)
    assert.deepStrictEqual(serialize({ health: 40, food: 20, foodSaturation: 20 }), RECORDED_SKYBLOCK)
  })

  it('heartsHealth: full = the recorded 40, same fraction, never 0 while alive', () => {
    const v = new Vitals(fakeStats({ health: 2000 }))
    assert.strictEqual(v.heartsHealth(), 40)
    v.health = 1000; assert.strictEqual(v.heartsHealth(), 20)
    v.health = 1; assert.strictEqual(v.heartsHealth(40), 1)
    v.health = 0; assert.strictEqual(v.heartsHealth(), 0)
  })

  // minimal player/serv doubles: just what the plugin touches
  const boot = (settings) => {
    const writes = []
    const client = new EventEmitter()
    client.write = (name, params) => writes.push({ name, params })
    const player = new EventEmitter()
    player._client = client
    const stats = new EventEmitter()
    Object.assign(stats, { result: {}, maxMana: 100, get: (k) => ({ health: 2000, defense: 0, true_defense: 0, health_regen: 100, vitality: 100 })[k] || 0 })
    player.skyblock = { stats }
    const serv = { supportFeature: () => true, _createChatComponent: (t) => ({ toNetworkFormat: () => t }) }
    plugin.player.call({ settings }, player, serv)
    player.emit('skyblockProfileReady')
    const hearts = () => writes.filter(w => w.name === 'update_health').map(w => w.params)
    const stop = () => client.emit('end')
    return { player, writes, hearts, stop }
  }
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  it('sends 40 / 20 / 20.0 at full health, like the recording', async () => {
    const t = boot({ actionBar: false })
    await wait(30)
    assert.deepStrictEqual(t.hearts()[0], { health: 40, food: 20, foodSaturation: 20 })
    assert.strictEqual(t.player.health, 20) // core keeps its 0..20 scale
    assert.strictEqual(t.player.foodSaturation, 20)
    t.stop()
  })

  it('re-sends unchanged values on a timer (recorded: every ~300 ms)', async () => {
    const t = boot({ actionBar: false, healthRefreshMs: 20 })
    await wait(150)
    const sent = t.hearts()
    t.stop()
    assert.ok(sent.length >= 4, `expected periodic resends, got ${sent.length}`)
    assert.ok(sent.every(p => p.health === 40 && p.food === 20 && p.foodSaturation === 20))
  })

  it('healthRefreshMs: 0 only sends when the heart value changes', async () => {
    const t = boot({ actionBar: false, healthRefreshMs: 0 })
    await wait(150)
    assert.strictEqual(t.hearts().length, 1)
    t.player.skyblock.vitals.damage(1000) // half health
    await wait(30)
    const sent = t.hearts()
    t.stop()
    assert.strictEqual(sent.length, 2)
    assert.strictEqual(sent[1].health, 20)
  })

  it('a dead player gets one 0 and is then left alone', async () => {
    const t = boot({ actionBar: false, healthRefreshMs: 20 })
    await wait(30)
    t.player.skyblock.vitals.damage(1e9)
    await wait(30)
    const n = t.hearts().length
    await wait(100)
    const sent = t.hearts()
    t.stop()
    assert.strictEqual(sent.length, n)
    assert.strictEqual(sent[sent.length - 1].health, 0)
  })

  it('stops its timers when the client disconnects', async () => {
    const t = boot({ actionBar: false, healthRefreshMs: 20 })
    await wait(50)
    t.stop()
    const n = t.hearts().length
    await wait(100)
    assert.strictEqual(t.hearts().length, n)
  })

  it('the action bar goes out as system_chat with isActionBar (schema-checked for 1.19.2 .. 26.1)', async () => {
    const t = boot({ healthRefreshMs: 0, refreshMs: 0 })
    await wait(30)
    const bar = t.writes.find(w => w.name === 'system_chat')
    t.stop()
    assert.ok(bar && bar.params.isActionBar === true)
    assert.ok(bar.params.content.includes('2,000/2,000'))
  })
})

describe('skyblock-vitals: action bar vs the Hypixel recording (protocol 26.1)', () => {
  const EventEmitter = require('events')
  const plugin = require('../src/plugins/skyblock-vitals')
  const { NOT_ENOUGH_MANA_MS } = require('../src/plugins/skyblock-vitals/lib/vitals')
  const recorded = require('./fixtures/actionbar-recorded.json').bars
  const num = (t) => Number(t.replace(/,/g, ''))

  // text -> snapshot, using only what the string itself says
  const RE = /^(§[6c])([\d,]+)\/([\d,]+)\uE010 {5}(?:§a([\d,]+)§a\uE008 Defense|§7\uE067 §(\w)(.+?)) {5}(?:§b([\d,]+)\/([\d,]+)\uE003 Mana {5}|(§c§lNOT ENOUGH MANA))$/
  const toSnapshot = (text) => {
    const m = RE.exec(text)
    assert.ok(m, `unparseable recorded bar: ${JSON.stringify(text)}`)
    const gold = m[1] === '§6'
    return {
      health: num(m[2]) - (gold ? 1 : 0),
      absorption: gold ? 1 : 0,
      maxHealth: num(m[3]),
      defense: m[4] ? num(m[4]) : 0,
      zone: m[5] ? { color: m[5], name: m[6] } : null,
      mana: m[7] ? num(m[7]) : 0,
      maxMana: m[8] ? num(m[8]) : 0,
      notEnough: !!m[9],
      overflow: 0,
      dead: false
    }
  }

  it('renders all 87 distinct recorded bars byte for byte', () => {
    assert.ok(recorded.length >= 80)
    for (const text of recorded) assert.strictEqual(renderActionBar(toSnapshot(text)), text)
  })

  it('the recording covers every layout: gold/red health, Defense, zone, NOT ENOUGH MANA', () => {
    assert.ok(recorded.some(t => t.startsWith('§6')) && recorded.some(t => t.startsWith('§c')))
    assert.ok(recorded.some(t => t.includes(' Defense')) && recorded.some(t => t.includes('\uE067')))
    assert.ok(recorded.some(t => t.endsWith('NOT ENOUGH MANA')))
  })

  it('replays the gear change at 71 s: shown mana is min(stored, max), regen waits, nothing is lost', () => {
    const s = fakeStats({ maxMana: 953, health: 4124 }); const v = new Vitals(s)
    v.mana = 529
    s.maxMana = 610; v.sync(); assert.strictEqual(v.snapshot().mana, 529) // 529/953 -> 529/610
    v.mana = 550
    s.maxMana = 460; v.sync(); assert.strictEqual(v.snapshot().mana, 460) // 550/610 -> 460/460
    v.advance(5000); assert.strictEqual(v.mana, 550) // stored >= max: no regen
    s.maxMana = 610; v.sync(); assert.strictEqual(v.snapshot().mana, 550) // -> 550/610, not 481
    v.advance(1000); assert.ok(v.mana > 550 && v.mana < 575) // regen resumes
  })

  it('health is clamped when max falls (recorded 3,676/4,124 -> 3,458/3,458)', () => {
    const s = fakeStats({ health: 4124 }); const v = new Vitals(s)
    v.health = 3676
    s.v.health = 3458; v.sync()
    assert.strictEqual(v.health, 3458)
  })

  it('absorption is shown in gold on top of max and soaks damage first', () => {
    const v = new Vitals(fakeStats({ health: 4124, defense: 0 }))
    v.setAbsorption(375)
    assert.strictEqual(renderActionBar(v.snapshot()), '§64,499/4,124\uE010     §a0§a\uE008 Defense     §b100/100\uE003 Mana     ')
    assert.strictEqual(v.heartsHealth(), 40) // recorded: the wire stays at 40.0 while above max
    v.damage(269) // recorded 4,499 -> 4,230
    assert.strictEqual(v.absorption, 106); assert.strictEqual(v.health, 4124)
    v.damage(206)
    assert.strictEqual(v.absorption, 0); assert.ok(Math.abs(v.health - 4024) < 1e-9)
    assert.ok(renderActionBar(v.snapshot()).startsWith('§c')) // red again once the gold is gone
  })

  it('NOT ENOUGH MANA replaces only the mana segment, renews on each failure, lasts ~1.5 s', () => {
    const v = new Vitals(fakeStats({ health: 4124, defense: 1008, maxMana: 953 }))
    v.mana = 25
    assert.strictEqual(v.spendMana(57), false)
    v.failMana()
    assert.strictEqual(renderActionBar(v.snapshot()), '§c4,124/4,124\uE010     §a1,008§a\uE008 Defense     §c§lNOT ENOUGH MANA')
    v.advance(NOT_ENOUGH_MANA_MS - 100); assert.ok(v.snapshot().notEnough)
    v.failMana(); v.advance(NOT_ENOUGH_MANA_MS - 100); assert.ok(v.snapshot().notEnough) // renewed
    v.advance(200); assert.ok(!v.snapshot().notEnough)
    assert.ok(renderActionBar(v.snapshot()).endsWith('Mana     '))
  })

  it('a zone name replaces Defense for ~2 s, then Defense returns', () => {
    const v = new Vitals(fakeStats({ health: 4124, defense: 1008, maxMana: 953 }))
    v.showZone('Wilderness', { color: '2' })
    assert.ok(renderActionBar(v.snapshot()).includes('     §7\uE067 §2Wilderness     '))
    v.advance(2100)
    assert.ok(renderActionBar(v.snapshot()).includes('§a1,008§a\uE008 Defense'))
  })

  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const boot = (settings) => {
    const writes = []
    const client = new EventEmitter()
    client.write = (name, params) => writes.push({ name, params })
    const player = new EventEmitter()
    player.id = 7
    player._client = client
    const stats = new EventEmitter()
    Object.assign(stats, { result: {}, maxMana: 100, get: (k) => ({ health: 2000, defense: 0, true_defense: 0, health_regen: 100, vitality: 100 })[k] || 0 })
    player.skyblock = { stats }
    const serv = { supportFeature: () => true, _createChatComponent: (t) => ({ toNetworkFormat: () => t }) }
    plugin.player.call({ settings }, player, serv)
    player.emit('skyblockProfileReady')
    return { player, writes, bars: () => writes.filter(w => w.name === 'system_chat').map(w => w.params.content), stop: () => client.emit('end') }
  }

  it('the bar follows its own clock: a change does not trigger an extra bar unless barOnChange is set', async () => {
    const quiet = boot({ healthRefreshMs: 0, refreshMs: 0 })
    await wait(30)
    quiet.player.skyblock.vitals.damage(1000); await wait(30)
    assert.strictEqual(quiet.bars().length, 1) // only the initial one
    quiet.stop()
    const eager = boot({ healthRefreshMs: 0, refreshMs: 0, barOnChange: true })
    await wait(30)
    const before = eager.bars().length
    eager.player.skyblock.vitals.damage(1000); await wait(30)
    assert.strictEqual(eager.bars().length, before + 1) // one extra bar for the change
    eager.stop()
  })

  it('periodic bars are sent every refreshMs (recorded: ~0.5 s)', async () => {
    const t = boot({ healthRefreshMs: 0, refreshMs: 20 })
    await wait(130)
    const n = t.bars().length
    t.stop()
    assert.ok(n >= 4, `expected periodic bars, got ${n}`)
  })

  it('useMana failure shows NOT ENOUGH MANA inside the normal bar, not instead of it', async () => {
    const t = boot({ healthRefreshMs: 0, refreshMs: 20 })
    await wait(30)
    assert.strictEqual(t.player.skyblock.useMana(1e9), false)
    await wait(60)
    const last = t.bars().pop()
    t.stop()
    assert.ok(last.includes('2,000/2,000') && last.includes('Defense') && last.endsWith('§c§lNOT ENOUGH MANA'))
  })

  it('sends generic.max_health = 40 (recorded: it arrives with the first update_health of 40.0) on start and spawn', async () => {
    const t = boot({ actionBar: false, healthRefreshMs: 0 })
    await wait(30)
    const attr = () => t.writes.filter(w => w.name === 'entity_update_attributes')
    assert.strictEqual(attr().length, 1)
    assert.strictEqual(attr()[0].params.entityId, 7)
    const prop = attr()[0].params.properties[0]
    assert.strictEqual(prop.value, 40); assert.ok(Object.values(prop).includes('generic.max_health'))
    t.player.emit('spawned')
    assert.strictEqual(attr().length, 2)
    t.stop()
    const off = boot({ actionBar: false, healthRefreshMs: 0, maxHealthAttribute: 0 })
    await wait(30)
    assert.strictEqual(off.writes.filter(w => w.name === 'entity_update_attributes').length, 0)
    off.stop()
  })
})
