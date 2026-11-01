/* eslint-env mocha */
'use strict'
// Regression tests for skyblock-teleport. The expected packets are the bytes from a real Hypixel SkyBlock capture
// (2026-10-31 sclogs, 26.1 client); the sync tests drive the plugin with a fake player.
const assert = require('assert')
const { EventEmitter } = require('events')
const mc = require('minecraft-protocol')
const { Vec3 } = require('vec3')
const plugin = require('../src/plugins/skyblock-teleport')
const effects = require('../src/plugins/skyblock-teleport/lib/effects')

const registry = require('prismarine-registry')('26.1')
const serializer = mc.createSerializer({ state: mc.states.PLAY, isServer: true, version: '26.1' })
const hex = (s) => Buffer.from(s.replace(/0x|\s/g, ''), 'hex')
const encode = (name, params) => serializer.createPacketBuffer({ name, params })

describe('skyblock-teleport effects (match the real-server capture)', () => {
  it('instant teleport sound: entity.enderman.teleport, hostile, vol 1, pitch 1, at the destination', () => {
    const p = effects.soundParams(registry, effects.DEFAULT_SOUNDS.instant, new Vec3(116.5, 91, 115.5))
    const got = encode('sound_effect', p)
    const want = hex('75 d6 04 05 00 00 03 a4 00 00 02 d8 00 00 03 9c 3f 80 00 00 3f 80 00 00')
    assert.deepStrictEqual(got.subarray(0, want.length), want) // the 8 seed bytes are random
  })
  it('ether teleport sound: entity.ender_dragon.hurt at pitch 34/63', () => {
    const p = effects.soundParams(registry, effects.DEFAULT_SOUNDS.ether, new Vec3(83.5, 66, 146.5))
    const got = encode('sound_effect', p)
    const want = hex('75 cd 04 05 00 00 02 9c 00 00 02 10 00 00 04 94 3f 80 00 00 3f 0a 28 a3')
    assert.deepStrictEqual(got.subarray(0, want.length), want)
  })
  it('blocked message: red "There are blocks in the way!" as a chat line, not the action bar', () => {
    const got = encode('system_chat', { content: effects.messageComponent('There are blocks in the way!', 'red'), isActionBar: false })
    const want = hex('79 0a 09 00 05 65 78 74 72 61 0a 00 00 00 01 08 00 05 63 6f 6c 6f 72 00 03 72 65 64 08 00 04 74 65 78 74 00 1c ' +
      '54 68 65 72 65 20 61 72 65 20 62 6c 6f 63 6b 73 20 69 6e 20 74 68 65 20 77 61 79 21 00 01 00 06 69 74 61 6c 69 63 00 08 00 04 74 65 78 74 00 00 00 00')
    assert.deepStrictEqual(got, want)
  })
  it('unknown sound names are skipped instead of sending a bad packet', () => {
    assert.strictEqual(effects.soundParams(registry, { name: 'no.such.sound', category: 'hostile', volume: 1, pitch: 1 }, new Vec3(0, 0, 0)), null)
  })
})

// ---- a fake player/server around the real plugin ---------------------------------------------------------------------
function makeWorld (solid = []) {
  const stone = registry.blocksByName.stone
  const air = registry.blocksByName.air
  const mk = (b) => ({ name: b.name, shapes: b.name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], boundingBox: b.name === 'air' ? 'empty' : 'block' })
  const set = new Set(solid.map(v => v.join(',')))
  return { getBlock: async (v) => (set.has([v.x, v.y, v.z].join(',')) || v.y < 4) ? mk(stone) : mk(air) }
}

function makeRig ({ solid = [], settings = {}, crouching = false, held = null, mana = null } = {}) {
  const sent = []
  const served = []
  const warned = []
  const serv = Object.assign(new EventEmitter(), {
    registry,
    getNearby: () => [],
    err: (m) => served.push(m),
    warn: (m) => warned.push(m)
  })
  const client = Object.assign(new EventEmitter(), { write: (name, params) => sent.push({ name, params }) })
  const player = {
    id: 1,
    _client: client,
    world: makeWorld(solid),
    crouching,
    position: new Vec3(0.5, 5, 0.5),
    yaw: 0,
    pitch: 0,
    heldItemSlot: 0,
    inventory: { slots: [] },
    moves: [], // every position core would have broadcast
    _writeOthersNearby () {},
    // stands in for core's entity.sendPosition: applies the position and records it
    async sendPosition (position, onGround, teleport = false) {
      if (this.position.equals(position) && this.onGround === onGround) return undefined
      this.moves.push({ position: position.clone(), teleport })
      this.position = position
      this.onGround = onGround
      return true
    }
  }
  // client packet handlers core registers: movement from the client goes straight to sendPosition
  client.on('position', ({ x, y, z, onGround }) => player.sendPosition(new Vec3(x, y, z), onGround))
  plugin.server.call({ settings }, serv)
  plugin.player(player, serv)
  if (held) player.inventory.slots[36] = held // the real abilityFor reads the item (tooltip cost and all)
  else serv.skyblockTeleport.abilityFor = () => ({ kind: 'instant', range: 8, itemId: 'ASPECT_OF_THE_END' })
  // a stand-in for skyblock-vitals' player.skyblock: useMana behaves like the plugin's (spend, or flag NOT ENOUGH MANA)
  let pool = null
  if (mana !== null) {
    pool = { mana, failed: 0, spendMana (c) { if (this.mana >= c) { this.mana -= c; return true } return false }, addMana (n) { this.mana += n }, failMana () { this.failed++ } }
    player.skyblock = { vitals: pool, useMana: (cost, label) => { pool.label = label; return pool.spendMana(cost) || (pool.failMana(), false) } }
  }
  return { serv, player, client, sent, served, warned, pool, api: serv.skyblockTeleport }
}

const chatTexts = (sent) => sent.filter(p => p.name === 'system_chat').map(p => p.params.content.value.extra.value.value[0].text.value)

describe('skyblock-teleport sync with the client', () => {
  it('ignores stale client movement until teleport_confirm, then trusts it again', async () => {
    const { player, client, sent, api } = makeRig()
    const r = await api.use(player, { yaw: 0, pitch: 0 })
    assert.ok(r, 'teleport happened')
    const dest = player.position.clone()
    assert.ok(dest.z > 4)

    // the client had already sent movement from before it saw the teleport
    client.emit('position', { x: 0.5, y: 5, z: 0.5, onGround: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(player.position.equals(dest), 'stale packet must not move the player back')
    assert.strictEqual(player.moves.filter(m => !m.teleport).length, 0, 'no stale move was broadcast to other players')
    assert.ok(api.isAwaitingConfirm(player))

    const pos = sent.find(p => p.name === 'position')
    assert.strictEqual(pos.params.teleportId, 100)
    client.emit('teleport_confirm', { teleportId: pos.params.teleportId })
    assert.ok(!api.isAwaitingConfirm(player))
    client.emit('position', { x: dest.x + 1, y: 5, z: dest.z, onGround: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(player.position.x, dest.x + 1, 'movement is accepted again after the confirm')
  })

  it('a wrong teleport id does not release the guard', async () => {
    const { player, client, api } = makeRig()
    await api.use(player, { yaw: 0, pitch: 0 })
    client.emit('teleport_confirm', { teleportId: 1 })
    assert.ok(api.isAwaitingConfirm(player))
  })

  it('rapid uses chain from the previous destination and are applied in order', async () => {
    const { player, sent, api } = makeRig()
    const [a, b, c] = await Promise.all([0, 1, 2].map(() => api.use(player, { yaw: 0, pitch: 0 })))
    assert.strictEqual(a.to.z + 8, b.to.z)
    assert.strictEqual(b.to.z + 8, c.to.z)
    assert.deepStrictEqual(sent.filter(p => p.name === 'position').map(p => p.params.teleportId), [100, 101, 102])
  })

  it('gives up waiting after confirmTimeoutMs (client never answers)', async () => {
    const { player, api } = makeRig({ settings: { confirmTimeoutMs: 15 } })
    await api.use(player, { yaw: 0, pitch: 0 })
    assert.ok(api.isAwaitingConfirm(player))
    await new Promise(resolve => setTimeout(resolve, 80)) // one resend, then released
    assert.ok(!api.isAwaitingConfirm(player))
  })

  it('sends the destination sound to the teleporting player', async () => {
    const { player, sent, api } = makeRig()
    await api.use(player, { yaw: 0, pitch: 0 })
    const snd = sent.filter(p => p.name === 'sound_effect')
    assert.strictEqual(snd.length, 1)
    assert.strictEqual(snd[0].params.soundCategory, 'hostile')
    assert.strictEqual(snd[0].params.sound.soundId, registry.soundsByName['entity.enderman.teleport'].id - 1)
  })

  it('sends "There are blocks in the way!" (and no teleport) when the way is blocked', async () => {
    const wall = [[0, 6, 1], [0, 7, 1], [0, 5, 1]]
    const { player, sent, api } = makeRig({ solid: wall })
    const r = await api.use(player, { yaw: 0, pitch: 0 })
    assert.strictEqual(r, null)
    assert.deepStrictEqual(chatTexts(sent), ['There are blocks in the way!'])
    assert.strictEqual(sent.filter(p => p.name === 'position' || p.name === 'sound_effect').length, 0)
    assert.ok(player.position.equals(new Vec3(0.5, 5, 0.5)))
  })

  it('messages can be turned off in the config', async () => {
    const { player, sent, api } = makeRig({ solid: [[0, 6, 1], [0, 7, 1], [0, 5, 1]], settings: { messages: { blocked: null } } })
    await api.use(player, { yaw: 0, pitch: 0 })
    assert.strictEqual(chatTexts(sent).length, 0)
  })
})

// ---- mana ------------------------------------------------------------------------------------------------------------
// The tooltip lines are copied from the Warped Aspect of the Void in apiresponsesample.json (profile Raspberry, Ultimate Wise V).
const nbt = require('prismarine-nbt')
const { legacyToComponent } = require('../src/plugins/hypixel-api/lib/text')
const { parseAbilityCosts, abilityCostsOf } = require('../src/plugins/skyblock-teleport/lib/mana')

const AOTV_LORE = [
  '§7Damage: §c+315 §e(+30) §d(+165)', '§7Strength: §c+295 §e(+30) §d(+165)', '', '§9Ultimate Wise V§9, Critical VI',
  '', '§6Ability: Instant Transmission  §e§lRIGHT CLICK', '§7Teleport §a8 blocks§7 ahead of you and', '§7gain §a+50 §f Speed§7 for §a3 seconds§7.',
  '§8Mana Cost: §3§b19', '', '§6Ability: Ether Transmission  §e§lSNEAK RIGHT CLICK', '§7Teleport to your targeted block up', '§7to §a57 blocks §7away.',
  '§7§8Soulflow Cost: §31', '§8Mana Cost: §3§b74', '', '§6§l§ka§r §6§lLEGENDARY SWORD §6§l§ka'
]

// a live-shaped (26.1 components) item
const makeItem = (id, extra = {}, lore = null) => ({
  components: [
    { type: 'custom_data', data: nbt.comp(Object.assign({ id: nbt.string(id) }, ...Object.entries(extra).map(([k, v]) => ({ [k]: nbt.int(v) })))) },
    ...(lore ? [{ type: 'lore', data: lore.map(legacyToComponent) }] : [])
  ]
})
const AOTV = () => makeItem('ASPECT_OF_THE_VOID', { ethermerge: 1 }, AOTV_LORE)
const FWD = { yaw: 0, pitch: 0 }
const DOWN = { yaw: 0, pitch: 45 } // sneaking: etherwarp onto the floor ahead

describe('skyblock-teleport reads the cost from the item tooltip', () => {
  it('parses the sample item: Instant 19 mana, Ether 74 mana + 1 Soulflow', () => {
    assert.deepStrictEqual(parseAbilityCosts(AOTV_LORE), {
      'Instant Transmission': { mana: 19, soulflow: null },
      'Ether Transmission': { mana: 74, soulflow: 1 }
    })
  })

  it('works on the live 26.1 lore component, not just legacy strings', () => {
    assert.deepStrictEqual(abilityCostsOf(AOTV())['Ether Transmission'], { mana: 74, soulflow: 1 })
  })

  it('handles thousands separators, other click types and costs that belong to another ability', () => {
    const lore = ['§6Ability: Gravity Storm  §e§lLEFT CLICK', '§8Mana Cost: §3§b1,200', '', '§6Ability: Instant Transmission  §e§lRIGHT CLICK', '§7no cost line here']
    assert.deepStrictEqual(parseAbilityCosts(lore), { 'Gravity Storm': { mana: 1200, soulflow: null }, 'Instant Transmission': { mana: null, soulflow: null } })
    assert.deepStrictEqual(parseAbilityCosts(['§8Mana Cost: §3§b50']), {}) // no ability header above it
    assert.deepStrictEqual(abilityCostsOf(null), {})
    assert.deepStrictEqual(abilityCostsOf(makeItem('ASPECT_OF_THE_END')), {})
  })

  it('abilityFor puts the printed cost on the ability (instant standing, ether sneaking)', () => {
    const a = makeRig({ held: AOTV() }).api
    const standing = makeRig({ held: AOTV() })
    assert.strictEqual(a.abilityFor(standing.player).manaCost, 19)
    const sneaking = makeRig({ held: AOTV(), crouching: true })
    const ether = sneaking.api.abilityFor(sneaking.player)
    assert.strictEqual(ether.kind, 'ether')
    assert.strictEqual(ether.manaCost, 74)
    assert.strictEqual(ether.soulflow, 1)
  })
})

describe('skyblock-teleport charges mana', () => {
  it('Instant Transmission takes the printed 19 and reports it', async () => {
    const { player, pool, api, sent } = makeRig({ held: AOTV(), mana: 100 })
    const r = await api.use(player, FWD)
    assert.ok(r)
    assert.strictEqual(pool.mana, 81)
    assert.strictEqual(r.mana, 19)
    assert.strictEqual(pool.label, 'Instant Transmission')
    assert.strictEqual(sent.filter(p => p.name === 'position').length, 1)
  })

  it('Ether Transmission takes the printed 74 and reports the Soulflow it does not charge', async () => {
    const { player, pool, api } = makeRig({ held: AOTV(), crouching: true, mana: 100 })
    const r = await api.use(player, DOWN)
    assert.ok(r, 'ether teleport happened')
    assert.strictEqual(r.kind, 'ether')
    assert.strictEqual(pool.mana, 26)
    assert.strictEqual(r.mana, 74)
    assert.strictEqual(r.soulflow, 1)
  })

  it('not enough mana: no teleport, no sound, nothing spent, NOT ENOUGH MANA is flagged', async () => {
    const { player, pool, api, sent } = makeRig({ held: AOTV(), mana: 18 })
    const r = await api.use(player, FWD)
    assert.strictEqual(r, null)
    assert.strictEqual(pool.mana, 18)
    assert.strictEqual(pool.failed, 1)
    assert.ok(player.position.equals(new Vec3(0.5, 5, 0.5)))
    assert.strictEqual(sent.filter(p => p.name === 'position' || p.name === 'sound_effect').length, 0)
    assert.ok(!api.isAwaitingConfirm(player))
  })

  it('exactly enough mana is enough', async () => {
    const { player, pool, api } = makeRig({ held: AOTV(), mana: 19 })
    assert.ok(await api.use(player, FWD))
    assert.strictEqual(pool.mana, 0)
  })

  it('a blocked teleport costs nothing', async () => {
    const { player, pool, api, sent } = makeRig({ held: AOTV(), mana: 100, solid: [[0, 6, 1], [0, 7, 1], [0, 5, 1]] })
    assert.strictEqual(await api.use(player, FWD), null)
    assert.strictEqual(pool.mana, 100)
    assert.strictEqual(pool.failed, 0)
    assert.deepStrictEqual(chatTexts(sent), ['There are blocks in the way!'])
  })

  it('rapid right-clicks pay one after another: mana for two hops gives exactly two hops', async () => {
    const { player, pool, api } = makeRig({ held: AOTV(), mana: 40 })
    const results = await Promise.all([0, 1, 2].map(() => api.use(player, FWD)))
    assert.strictEqual(results.filter(Boolean).length, 2)
    assert.strictEqual(results[2], null)
    assert.strictEqual(pool.mana, 2)
    assert.strictEqual(pool.failed, 1)
  })

  it('refunds the mana when another plugin cancels the move', async () => {
    const { player, pool, api } = makeRig({ held: AOTV(), mana: 100 })
    player.sendPosition = async () => false // e.g. a region plugin vetoes the move
    assert.strictEqual(await api.use(player, FWD), null)
    assert.strictEqual(pool.mana, 100)
  })

  it('an item without a printed cost falls back to the table (AOTE 50, AOTV 45)', async () => {
    const aote = makeRig({ held: makeItem('ASPECT_OF_THE_END'), mana: 100 })
    await aote.api.use(aote.player, FWD)
    assert.strictEqual(aote.pool.mana, 50)
    const aotv = makeRig({ held: makeItem('ASPECT_OF_THE_VOID'), mana: 100 })
    await aotv.api.use(aotv.player, FWD)
    assert.strictEqual(aotv.pool.mana, 55)
  })

  it('mana can be switched off in the config', async () => {
    const { player, pool, api } = makeRig({ held: AOTV(), mana: 100, settings: { mana: { enabled: false } } })
    const r = await api.use(player, FWD)
    assert.ok(r); assert.strictEqual(r.mana, 0); assert.strictEqual(pool.mana, 100)
  })

  it('hooks.manaCost can change or waive the cost', async () => {
    const half = makeRig({ held: AOTV(), mana: 100 })
    half.api.hooks.manaCost = (player, ability, cost) => cost / 2
    await half.api.use(half.player, FWD)
    assert.strictEqual(half.pool.mana, 90.5)
    const free = makeRig({ held: AOTV(), mana: 100 })
    free.api.hooks.manaCost = () => 0
    assert.ok(await free.api.use(free.player, FWD))
    assert.strictEqual(free.pool.mana, 100)
  })

  it('without skyblock-vitals teleports stay free, with a single warning', async () => {
    const { player, api, warned } = makeRig({ held: AOTV() }) // no player.skyblock
    assert.ok(await api.use(player, FWD))
    assert.ok(await api.use(player, FWD))
    assert.strictEqual(warned.length, 1)
    assert.ok(/skyblock-vitals/.test(warned[0]))
  })

  it('the skyblock:teleport event carries what was paid', async () => {
    const { player, serv, api } = makeRig({ held: AOTV(), mana: 100 })
    const seen = []
    serv.on('skyblock:teleport', (p, result) => seen.push(result.mana))
    await api.use(player, FWD)
    assert.deepStrictEqual(seen, [19])
  })
})
