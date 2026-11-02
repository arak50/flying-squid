'use strict'
// Unit tests with a fake server (no flying-squid, no network):  node src/plugins/dungeon-mobs/test/dungeon-mobs.test.js
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const plugin = require('..')
const { mobs } = require('../lib/catalog')
const { nametagComponent, componentToNbt, plain } = require('../lib/nametag')
const skins = require('../lib/skins')

class FakeItem {
  constructor (type, count) { this.type = type; this.count = count; this.components = []; this.componentMap = new Map() }
  static toNotch (i) { return i ? { present: true, itemId: i.type, count: i.count, components: i.components } : { present: false } }
}

function fakeServ (extra = {}) {
  const serv = new EventEmitter()
  const keys = ['shared_flags', 'air', 'custom_name', 'custom_name_visible']
  const standKeys = [...keys, ...Array(11).fill('x'), 'armor_stand_flags']
  const playerKeys = [...keys, ...Array(13).fill('y'), 'player_mode_customisation']
  const defs = { zombie: keys, skeleton: keys, wither_skeleton: keys, spider: keys, enderman: keys, silverfish: keys, blaze: keys, bat: keys, allay: keys, player: playerKeys, armor_stand: standKeys }
  const entitiesByName = {}
  const entities = []
  Object.keys(defs).forEach((name, i) => { entitiesByName[name] = { id: i + 1, name, metadataKeys: defs[name] }; entities[i + 1] = entitiesByName[name] })
  serv.registry = {
    entitiesByName,
    entities,
    mobs: {},
    itemsByName: new Proxy({}, { get: (_, n) => typeof n === 'string' ? { id: n, name: n } : undefined }),
    version: { '>=': () => true },
    protocol: { types: { entityMetadataEntry: [0, [0, { type: [0, { mappings: { 0: 'byte', 6: 'optional_component', 8: 'boolean' } }] }]] } }
  }
  serv.entities = {}
  serv.overworld = { name: 'overworld' }
  serv.commands = { add () {} }
  serv.supportFeature = f => ['playerInfoActionIsBitfield', 'allEntityEquipmentInOne'].includes(f)
  serv.players = []
  serv.wire = [] // everything written to the (single) fake client, in order
  serv.all = [] // _writeAll
  serv._writeAll = (n, p) => serv.all.push([n, p])
  serv.sent = [] // sendMetadata calls: [entityId, entries]
  serv.nearbyWrites = []
  let id = 0
  serv.spawnMob = (type, world, position) => {
    if (!serv.registry.mobs[type]) throw new Error('not in registry.mobs')
    const mob = {
      id: ++id, type: 'mob', entityType: type, world, position, health: 20, metadata: [], equipment: [], uuid: 'uuid-' + id,
      sendMetadata (e) { serv.sent.push([this.id, e]) },
      getNearby: () => serv.players,
      _writeOthersNearby (n, p) { serv.nearbyWrites.push([n, p]) }
    }
    serv.entities[mob.id] = mob
    for (const p of serv.players) p.spawnEntity(mob)
    return mob
  }
  serv.destroyEntity = e => { serv.wire.push(['destroyEntity', e.id]); delete serv.entities[e.id] }
  serv.info = () => {}
  serv.err = e => { throw new Error(e) }
  const player = {
    type: 'player',
    _client: { write: (n, p) => serv.wire.push([n, p]) },
    spawnEntity (e) { serv.wire.push(['spawn', e.id, e.entityType]) },
    despawnEntities (es) { serv.wire.push(['despawn', es.map(e => e.id)]) }
  }
  plugin.server.call({ settings: { randomHealth: false, Item: FakeItem, profileRemoveDelay: 5, ...extra } }, serv, {})
  serv.players.push(player)
  serv.emit('newPlayer', player)
  serv.player = player
  return serv
}

const serv = fakeServ()
const dm = serv.dungeonMobs
const at = new Vec3(10, 70, 20)

// star flag, nametag and metadata
const star = dm.spawn('zombie_grunt', at, { star: true, floor: 1, roomId: 3, modifier: null })
assert.strictEqual(star.dungeon.star, true)
assert.strictEqual(star.dungeon.roomId, 3)
assert.ok(star.dungeon.tag.startsWith('✯ Zombie Grunt '), star.dungeon.tag)
assert.ok(star.dungeon.tag.endsWith('❤'))
const nameEntry = star.metadata.find(e => e.key === 2)
assert.strictEqual(nameEntry.type, 6)
assert.strictEqual(nameEntry.value.type, 'compound')
assert.strictEqual(star.metadata.find(e => e.key === 3).value, true)
assert.strictEqual(serv.sent.filter(([id]) => id === star.id).length, 1)

// non star has no ✯
const plainMob = dm.spawn('zombie_grunt', at, { modifier: null })
assert.ok(!plainMob.dungeon.tag.includes('✯'))
assert.strictEqual(plainMob.dungeon.star, false)

// position is where it was asked
assert.ok(star.position.equals ? star.position.equals(at) : (star.position.x === 10 && star.position.z === 20))

// health scales with floor and master, bonus and override
const lo = dm.spawn('skeleton_soldier', at, { floor: 1, modifier: null })
const hi = dm.spawn('skeleton_soldier', at, { floor: 7, master: true, modifier: null })
assert.strictEqual(lo.dungeon.maxHealth, 22400)
assert.strictEqual(hi.dungeon.maxHealth, 28e6)
assert.ok(dm.spawn('skeleton_soldier', at, { floor: 3, modifier: null }).health > 22400)
const bonus = dm.spawn('skeleton_soldier', at, { floor: 1, modifier: null, roomsExplored: 5 })
assert.strictEqual(bonus.dungeon.maxHealth, Math.round(22400 * 1.2))
assert.strictEqual(dm.spawn('zombie_lord', at, { health: 123 }).health, 123)

// modifiers
const fort = dm.spawn('zombie_grunt', at, { star: true, modifier: 'fortified' })
assert.ok(fort.dungeon.tag.startsWith('✯ Fortified Zombie Grunt '))
const healthy = dm.spawn('zombie_grunt', at, { modifier: 'healthy' })
assert.strictEqual(healthy.dungeon.maxHealth, Math.round(7000 * 1.3))
assert.throws(() => dm.spawn('zombie_grunt', at, { modifier: 'nope' }), /Unknown modifier/)
assert.throws(() => dm.spawn('not_a_mob', at), /Unknown dungeon mob/)

// every catalogue entry spawns, accepts plain {x,y,z}, and has sane data
for (const key of Object.keys(mobs)) {
  const m = dm.spawn(key, { x: 1, y: 2, z: 3 }, { floor: 4, star: mobs[key].star })
  assert.ok(m.health >= 1, key)
  assert.ok(m.dungeon.level >= 1, key)
}

// grouping and listing
dm.spawnGroup([{ mob: 'crypt_lurker', position: at, star: true }, { mob: 'sniper', position: at }, { mob: 'tank_zombie', position: at, star: true }], { roomId: 9, modifier: null })
assert.strictEqual(dm.list({ roomId: 9 }).length, 3)
assert.strictEqual(dm.list({ roomId: 9, star: true }).length, 2)
assert.strictEqual(dm.list({ roomId: 9, alive: false }).length, 0)

// event
let seen = 0
serv.on('dungeonMobSpawned', () => seen++)
dm.spawn('sniper', at)
assert.strictEqual(seen, 1)

// nametag helpers
assert.strictEqual(plain(nametagComponent({ name: 'Crypt Lurker', star: true, health: 9000 })), '✯ Crypt Lurker 9,000❤')
assert.deepStrictEqual(componentToNbt({ text: 'a', extra: [{ text: 'b', color: 'red' }] }), {
  type: 'compound',
  name: '',
  value: { text: { type: 'string', value: 'a' }, extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'b' }, color: { type: 'string', value: 'red' } }] } } }
})


// ---- health bar follows mob.health ----
{
  const m = dm.spawn('zombie_grunt', at, { star: true, modifier: null, health: 7000 })
  const before = serv.sent.length
  m.health -= 1500
  serv.emit('tick')
  assert.strictEqual(serv.sent.length, before + 1)
  assert.ok(m.dungeon.tag.endsWith('5,500❤'), m.dungeon.tag)
  serv.emit('tick')
  assert.strictEqual(serv.sent.length, before + 1, 'no resend while health is unchanged')
  m.health = 0
  serv.emit('tick')
  assert.ok(m.dungeon.tag.endsWith('0❤'))
}

// ---- player mobs: skin profile first, then the body, then the tag stand riding it ----
{
  serv.wire.length = 0
  const fa = dm.spawn('frozen_adventurer', at, { star: true, modifier: null, health: 285000 })
  assert.strictEqual(fa.dungeon.body, 'player')
  assert.strictEqual(fa.dungeon.skin, 'frozen_adventurer')
  const names = serv.wire.map(w => w[0])
  assert.deepStrictEqual(names.slice(0, 2), ['player_info', 'spawn'])
  const info = serv.wire[0][1]
  assert.strictEqual(info.data[0].listed, false)
  assert.strictEqual(info.data[0].uuid, fa.uuid)
  const prop = info.data[0].player.properties[0]
  const tex = JSON.parse(Buffer.from(prop.value, 'base64').toString())
  assert.strictEqual(tex.textures.SKIN.url, 'http://textures.minecraft.net/texture/3dee50181dbc336d0d9035f622448c43daa7fdb5d7caaa91f67b3bc6486c3210')
  assert.ok(!('signature' in prop) || prop.signature === undefined)
  // tag stand: spawned exactly once, after its owner, then mounted
  const stand = fa.dungeon.tagEntity
  assert.ok(stand && stand.tagOf === fa)
  assert.strictEqual(serv.wire.filter(w => w[0] === 'spawn' && w[1] === stand.id).length, 1)
  const mount = serv.wire.find(w => w[0] === 'set_passengers')
  assert.deepStrictEqual(mount[1], { entityId: fa.id, passengers: [stand.id] })
  assert.ok(names.indexOf('set_passengers') > names.indexOf('spawn'))
  // the stand is invisible + marker, and carries the star tag; the player body has no custom name
  const standMeta = Object.fromEntries(stand.metadata.map(e => [e.key, e.value]))
  assert.strictEqual(standMeta[0], 0x20)
  assert.strictEqual(standMeta[15], 0x18)
  assert.ok(fa.dungeon.tag.startsWith('✯ Frozen Adventurer 285,000'))
  assert.ok(!fa.metadata.some(e => e.key === 2), 'the player body carries no name')
  assert.ok(fa.metadata.some(e => e.key === 17 && e.value === 0x7f), 'skin layers on')
  // health bar goes to the stand
  const n = serv.sent.length
  fa.health -= 100000
  serv.emit('tick')
  assert.strictEqual(serv.sent[n][0], stand.id)
  assert.ok(fa.dungeon.tag.endsWith('185,000❤'))
  // despawn for a player takes the stand with it
  serv.wire.length = 0
  serv.player.despawnEntities([fa])
  assert.deepStrictEqual(serv.wire.map(w => w[0]), ['despawn', 'entity_destroy'])
  assert.deepStrictEqual(serv.wire[1][1].entityIds, [stand.id])
  // a player who arrives later gets profile + body + tag too
  serv.wire.length = 0
  serv.player.spawnEntity(fa)
  assert.deepStrictEqual(serv.wire.map(w => w[0]), ['player_info', 'spawn', 'spawn', 'set_passengers'])
  // death: core deletes the entity; the stand goes at once, the profile a moment later
  serv.wire.length = 0
  serv.all.length = 0
  delete serv.entities[fa.id]
  serv.emit('tick')
  assert.deepStrictEqual(serv.wire[0], ['destroyEntity', stand.id])
  assert.strictEqual(serv.all.length, 0)
  require('child_process').execSync('sleep 0.05')
  setTimeout(() => {
    assert.strictEqual(serv.all[0][0], 'player_remove')
    assert.deepStrictEqual(serv.all[0][1], { players: [fa.uuid] })
    console.log('dungeon-mobs: async checks passed')
  }, 30)
}

// every skin key the catalogue names exists, with a hash
{
  const have = new Set(skins.known())
  for (const [k, d] of Object.entries(mobs)) if (d.skin) for (const sk of [].concat(d.skin)) assert.ok(have.has(sk), `${k}: missing skin ${sk}`)
  assert.strictEqual(skins.skinProfile('nope'), null)
  const p = skins.skinProfile(['lost_adventurer', 'lost_adventurer_1'], 'x', () => 0.99)
  assert.strictEqual(p.key, 'lost_adventurer_1')
}

// players: false falls back to the vanilla body, with the tag on the mob itself
{
  const s2 = fakeServ({ players: false })
  const z = s2.dungeonMobs.spawn('frozen_adventurer', at, { modifier: null })
  assert.strictEqual(z.dungeon.body, 'zombie')
  assert.strictEqual(z.dungeon.tagEntity, null)
  assert.ok(z.metadata.some(e => e.key === 2))
}

// ---- armour ----
{
  const z = dm.spawn('zombie_knight', at, { modifier: null, armor: 'diamond' })
  const w = serv.nearbyWrites.filter(([n]) => n === 'entity_equipment').pop()
  assert.strictEqual(w[1].entityId, z.id)
  assert.deepStrictEqual(w[1].equipments.map(e => e.slot).sort(), [2, 3, 4, 5])
  assert.deepStrictEqual(Object.values(z.equipment).map(i => i.type).sort(), ['diamond_boots', 'diamond_chestplate', 'diamond_helmet', 'diamond_leggings'])
  assert.strictEqual(z.dungeon.armor.helmet.item, 'diamond_helmet')

  dm.setArmor(z, { material: 'leather', color: 0x66ccff })
  assert.strictEqual(z.equipment[5].type, 'leather_helmet')
  assert.deepStrictEqual(z.equipment[5].components[0], { type: 'dyed_color', data: 0x66ccff })

  dm.equip(z, 'helmet', { item: 'player_head', skin: 'a'.repeat(64) })
  const prof = z.equipment[5].components.find(c => c.type === 'profile')
  assert.ok(JSON.parse(Buffer.from(prof.data.properties[0].value, 'base64')).textures.SKIN.url.endsWith('a'.repeat(64)))

  dm.equip(z, 'mainhand', 'iron_sword')
  dm.equip(z, 'helmet', null)
  assert.strictEqual(z.equipment[5], undefined)
  assert.strictEqual(z.equipment[0].type, 'iron_sword')

  assert.throws(() => dm.setArmor(z, 'wood'), /Unknown armour material/)
  assert.throws(() => dm.setArmor(z, { hat: 'iron_helmet' }), /Unknown equipment slot/)

  // armour on a player mob is broadcast too, and a catalogue default applies when no option is given
  const ff = dm.spawn('shadow_assassin', at, { modifier: null, armor: { chestplate: 'netherite_chestplate' } })
  assert.strictEqual(ff.equipment[4].type, 'netherite_chestplate')
}

// ---- melee damage from stats ----
{
  const m = dm.spawn('zombie_grunt', at, { modifier: null })
  const mk = stats => ({ skyblock: { stats: { get: id => stats[id] || 0 } } })
  assert.strictEqual(dm.meleeDamage(mk({}), m), 5)
  assert.strictEqual(dm.meleeDamage(mk({ strength: 100 }), m), 50) // (5 + 20) * 2
  assert.strictEqual(dm.meleeDamage(mk({ strength: 100, crit_chance: 100, crit_damage: 50 }), m), 75)
  const on = {}
  const pl = { on: (n, f) => { on[n] = f } }
  plugin.player(pl, serv)
  const hit = { attackedEntity: m }
  on.attack(hit, false)
  assert.strictEqual(hit.damage, 5)
  const cow = { attackedEntity: { id: 1 } }
  on.attack(cow, false)
  assert.strictEqual(cow.damage, undefined)
}

console.log('dungeon-mobs: all tests passed')
