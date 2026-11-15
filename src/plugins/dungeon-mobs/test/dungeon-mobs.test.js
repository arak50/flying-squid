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
  const standKeys = [...keys, 'silent', 'no_gravity', ...Array(9).fill('x'), 'armor_stand_flags']
  const playerKeys = [...keys, ...Array(13).fill('y'), 'player_mode_customisation']
  playerKeys[9] = 'health'
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
    protocol: { types: { entityMetadataEntry: [0, [0, { type: [0, { mappings: { 0: 'byte', 3: 'float', 6: 'optional_component', 8: 'boolean' } }] }]] } }
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
  serv.spawnMob = (type, world, position, o = {}) => {
    if (!serv.registry.mobs[type]) throw new Error('not in registry.mobs')
    const mob = {
      id: ++id,
      type: 'mob',
      entityType: type,
      world,
      position,
      yaw: o.yaw || 0,
      pitch: o.pitch || 0,
      health: 20,
      metadata: [],
      equipment: [],
      uuid: 'uuid-' + id,
      sendMetadata (e) { serv.sent.push([this.id, e]) },
      moves: [],
      sendPosition (p) { this.moves.push(p); this.position = p; return Promise.resolve() },
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
  assert.deepStrictEqual(names.slice(0, 3), ['player_info', 'teams', 'spawn'], 'profile, then its name goes into the hidden-name team, then the body')
  const info = serv.wire[0][1]
  const team = serv.wire[1][1]
  assert.ok((team.mode === 'join' || (team.nameTagVisibility === 'never' && team.collisionRule === 'never')) && team.players[0] === (info.data[0].player || info.data[0]).name, 'the random profile name is never shown')
  assert.ok(/^dm[0-9a-f]+$/.test(team.players[0]))
  assert.strictEqual(info.data[0].listed, false)
  assert.strictEqual(info.data[0].uuid, fa.uuid)
  const prop = info.data[0].player.properties[0]
  const tex = JSON.parse(Buffer.from(prop.value, 'base64').toString())
  assert.strictEqual(tex.textures.SKIN.url, 'http://textures.minecraft.net/texture/3dee50181dbc336d0d9035f622448c43daa7fdb5d7caaa91f67b3bc6486c3210')
  assert.ok(!('signature' in prop) || prop.signature === undefined)
  // tag stand [capture]: a free stand (not a passenger), spawned exactly once after its owner, scale 0.1, 1.95 above the feet
  const stand = fa.dungeon.tagEntity
  assert.ok(stand && stand.tagOf === fa)
  assert.strictEqual(serv.wire.filter(w => w[0] === 'spawn' && w[1] === stand.id).length, 1)
  assert.ok(!serv.wire.some(w => w[0] === 'set_passengers'), 'no longer mounted')
  assert.ok(names.indexOf('entity_update_attributes') > names.indexOf('spawn'), 'the stand is scaled after it spawns')
  assert.ok(Math.abs(stand.position.y - (fa.position.y + 1.95)) < 1e-9 && stand.position.x === fa.position.x)
  // the stand is invisible + marker, does not fall, and carries the star tag; the player body has no custom name
  const standMeta = Object.fromEntries(stand.metadata.map(e => [e.key, e.value]))
  assert.strictEqual(standMeta[0], 0x20)
  assert.strictEqual(standMeta[15], 0x10)
  assert.strictEqual(standMeta[5], true, 'no gravity')
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
  assert.deepStrictEqual(serv.wire.map(w => w[0]), ['player_info', 'teams', 'spawn', 'spawn', 'entity_update_attributes'])
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

// ---- death animation of player bodies ----
{
  const s = fakeServ({ deathAnimationMs: 20 })
  const healthMeta = id => s.sent.filter(([eid, e]) => eid === id && e.some(x => x.key === 9 && x.type === 3 && x.value === 0))
  const m = s.dungeonMobs.spawn('crypt_dreadlord', at, { modifier: null }) // drawn as a player
  assert.ok(m.fakePlayer)

  // removed without dying: no animation
  const gone = s.dungeonMobs.spawn('crypt_dreadlord', at, { modifier: null })
  delete s.entities[gone.id]
  s.emit('tick')
  assert.strictEqual(healthMeta(gone.id).length, 0)

  // killed: core sends entity_status 3 (ignored by clients for players) and deletes the entity
  m.health = 0
  delete s.entities[m.id]
  s.wire.length = 0
  s.emit('tick')
  assert.strictEqual(healthMeta(m.id).length, 1, 'health metadata 0 is sent so the client plays the death animation')
  // core despawning the body because a player moved must not cut the animation short
  s.wire.length = 0
  s.player.despawnEntities([m])
  assert.ok(!s.wire.some(w => w[0] === 'despawn'))
  setTimeout(() => {
    assert.ok(s.wire.some(w => w[0] === 'destroyEntity' && w[1] === m.id), 'the corpse is removed after the animation')
    s.wire.length = 0
    s.player.despawnEntities([m])
    assert.ok(s.wire.some(w => w[0] === 'despawn'), 'despawns work again once it is gone')
    console.log('dungeon-mobs: death animation checks passed')
  }, 80)
}

// every skin key the catalogue names exists, with a hash
{
  const have = new Set(skins.known())
  for (const [k, d] of Object.entries(mobs)) if (d.skin) for (const sk of [].concat(d.skin)) assert.ok(have.has(sk), `${k}: missing skin ${sk}`)
  assert.strictEqual(skins.skinProfile('nope'), null)
  const p = skins.skinProfile(['lost_adventurer', 'lost_adventurer_1'], 'x', () => 0.99)
  assert.strictEqual(p.key, 'lost_adventurer_1')
}

// the Watcher's guardians: own skin, scale and gear from the capture
{
  const { mobs } = require('../lib/catalog')
  const hp = { parasite: 12000, putrid: 20000, psycho: 20000, reaper: 20000, flamer: 16000, ooze: 14000, freak: 16000, mute: 12000 }
  for (const [k, h] of Object.entries(hp)) {
    const m = mobs['watcher_' + k]
    assert.strictEqual(m.entity, 'player', k); assert.strictEqual(m.skin, 'watcher_' + k, k)
    assert.strictEqual(m.health[0], h, k); assert.ok(m.scale > 0.27 && m.scale < 0.29, k); assert.ok(m.armor && Object.keys(m.armor).length >= 3 - (k === 'mute' ? 1 : 0), k)
    assert.ok(skins.known().includes('watcher_' + k), k)
  }
}

// signed textures: a vanilla client drops unsigned ones, so every captured skin carries Hypixel's value + signature
{
  const data = JSON.parse(require('fs').readFileSync(require('path').join(skins.DIR, 'skins.json'), 'utf8'))
  for (const k of ['crypt_dreadlord', 'angry_archeologist', 'primal_fear', 'lost_adventurer_1', 'watcher_undead', 'watcher_parasite', 'watcher_putrid', 'watcher_psycho', 'watcher_reaper', 'watcher_flamer', 'watcher_ooze', 'watcher_freak', 'watcher_mute', 'crypt_undead']) {
    const p = skins.skinProfile(k).properties[0]
    assert.ok(p.signature && p.signature.length > 300, `${k} is signed`)
    if (k !== 'crypt_undead') assert.ok(JSON.parse(Buffer.from(p.value, 'base64').toString()).textures.SKIN.url.endsWith(data[k].hash), `${k} value matches its hash`)
  }
  assert.ok(!skins.unsigned().includes('watcher_mute') && skins.unsigned().includes('shadow_assassin'))
  // a random pick between skins never lands on an unsigned one while a signed one exists
  for (let i = 0; i < 50; i++) assert.ok(skins.skinProfile(['lost_adventurer', 'lost_adventurer_1', 'lost_adventurer_2'], 'x', Math.random).signed)
}

// later player mobs join the existing hidden-name team
{
  serv.wire.length = 0
  const fa2 = dm.spawn('frozen_adventurer', at, { modifier: null, health: 10 })
  const join = serv.wire.filter(w => w[0] === 'teams').pop()[1]
  assert.ok((join.mode === 'join' || join.mode === 3) && join.players[0] === fa2.fakePlayer.name, 'later mobs join the existing team')
}

// tags follow their mob (free stands, not riders), a scaled body gets a lower tag, and NPC names are static line stacks (Mort)
{
  const { Vec3 } = require('vec3')
  serv.wire.length = 0
  const fa = dm.spawn('frozen_adventurer', new Vec3(10, 70, 20), { star: true, modifier: null, health: 1000 })
  const st = fa.dungeon.tagEntity
  fa.position = new Vec3(12, 70, 21)
  serv.emit('tick')
  assert.ok(Math.abs(st.position.y - 71.95) < 1e-9 && st.position.x === 12 && st.position.z === 21, 'the tag moved with the mob')
  const n = st.moves.length
  serv.emit('tick')
  assert.strictEqual(st.moves.length, n, 'no packet while the mob stands still')
  const w = dm.spawn('watcher_parasite', new Vec3(0, 70, 0), { modifier: null })
  assert.ok(Math.abs(w.dungeon.tagEntity.position.y - (70 + 2.16)) < 1e-9, 'a blood room guardian: the capture puts the tag 2.16 above its feet, whatever its scale')
  w.position = new Vec3(3, 66, 4); serv.emit('tick')
  assert.ok(Math.abs(w.dungeon.tagEntity.position.y - (66 + 2.16)) < 1e-9 && w.dungeon.tagEntity.position.x === 3, 'and follows it down')

  serv.wire.length = 0
  const mort = dm.spawn('mort', new Vec3(5.5, 69, 5.5), { yaw: -64 })
  const lines = mort.dungeon.lineStands
  assert.strictEqual(lines.length, 2)
  assert.deepStrictEqual(lines.map(l => l.position.y), [69, 68.75], 'name at the feet height, CLICK 0.25 below (as the capture)')
  for (const l of lines) {
    const md = Object.fromEntries(l.metadata.map(e => [e.key, e.value]))
    assert.strictEqual(md[0], 0x20); assert.strictEqual(md[15], 0, 'ordinary (not marker) stand'); assert.strictEqual(md[5], true, 'no gravity: it must not drop and snap back')
    assert.ok(md[3] === true && md[2])
  }
  assert.strictEqual(mort.dungeon.tagEntity, null)
  assert.ok(!mort.metadata.some(e => e.key === 2 && e.value), 'the NPC body carries no name itself')
  assert.strictEqual(serv.wire.filter(x => x[0] === 'entity_update_attributes').length, 2, 'both lines are scaled 0.1')
  serv.emit('tick')
  assert.deepStrictEqual(lines.map(l => l.position.y), [69, 68.75], 'static')
  delete serv.entities[mort.id]
  serv.emit('tick')
  assert.ok(!serv.entities[lines[0].id] && !serv.entities[lines[1].id], 'the lines go with Mort')
}

// NPCs turn to the nearest player (entity_look + entity_head_rotation every 4 ticks, only on change) and back when nobody is near
{
  const look = require('../lib/look')
  const { Vec3 } = require('vec3')
  assert.strictEqual(look.angleByte(90), 64); assert.strictEqual(look.angleByte(-90), -64); assert.strictEqual(look.angleByte(180), -128); assert.strictEqual(look.angleByte(-180), -128); assert.strictEqual(look.angleByte(360), 0)
  const a = look.lookAngles({ x: 0, y: 69, z: 0 }, { x: 0, y: 69, z: 10 }); assert.ok(Math.abs(a.yaw) < 1e-9 && Math.abs(a.pitch) < 1e-9) // +z: yaw 0
  assert.ok(Math.abs(look.lookAngles({ x: 0, y: 69, z: 0 }, { x: -5, y: 69, z: 0 }).yaw - 90) < 1e-9) // -x: yaw 90
  assert.ok(Math.abs(look.lookAngles({ x: 0, y: 69, z: 0 }, { x: 5, y: 69, z: 0 }).yaw + 90) < 1e-9) // +x: yaw -90
  assert.ok(look.lookAngles({ x: 0, y: 69, z: 0 }, { x: 4, y: 76, z: 0 }).pitch < -40, 'a player on the platform above: look up (negative pitch)')
  assert.strictEqual(look.lookAngles({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }).yaw, null)
  assert.strictEqual(look.nearest({ x: 0, y: 0, z: 0 }, [{ position: { x: 30, y: 0, z: 0 } }], 10), null)

  const mort = dm.spawn('mort', new Vec3(0.5, 69, 0.5), { yaw: -64 })
  serv.nearbyWrites.length = 0
  for (let i = 0; i < 8; i++) serv.emit('tick')
  assert.strictEqual(serv.nearbyWrites.filter(w => w[0] === 'entity_look').length, 0, 'nobody near, already at its home angle: nothing is sent')
  const visitor = { type: 'player', world: mort.world, gameMode: 0, position: new Vec3(-7.5, 69, 0.5) } // 8 blocks to -x
  serv.players.push(visitor)
  for (let i = 0; i < 4; i++) serv.emit('tick')
  const l = serv.nearbyWrites.filter(w => w[0] === 'entity_look' && w[1].entityId === mort.id)
  const h = serv.nearbyWrites.filter(w => w[0] === 'entity_head_rotation' && w[1].entityId === mort.id)
  assert.strictEqual(l.length, 1); assert.strictEqual(h.length, 1)
  assert.strictEqual(l[0][1].yaw, 64, 'turns to -x (yaw 90)'); assert.strictEqual(h[0][1].headYaw, 64); assert.strictEqual(l[0][1].onGround, true)
  visitor.position = new Vec3(0.5, 69, 8.5) // now +z: yaw 0
  serv.nearbyWrites.length = 0
  for (let i = 0; i < 4; i++) serv.emit('tick')
  assert.strictEqual(serv.nearbyWrites.find(w => w[0] === 'entity_look')[1].yaw, 0)
  for (let i = 0; i < 8; i++) serv.emit('tick')
  assert.strictEqual(serv.nearbyWrites.filter(w => w[0] === 'entity_look').length, 1, 'no repeat while the angle is the same')
  visitor.position = new Vec3(80, 69, 8.5) // out of range: back to the home yaw
  serv.nearbyWrites.length = 0
  for (let i = 0; i < 4; i++) serv.emit('tick')
  assert.strictEqual(serv.nearbyWrites.find(w => w[0] === 'entity_look')[1].yaw, -64)
  serv.players.splice(serv.players.indexOf(visitor), 1)
  delete serv.entities[mort.id]; serv.emit('tick')
}

// Mort: a friendly NPC drawn as a signed player (slim), never a random-health mob, with a "CLICK" line under his name
{
  const m = require('../lib/catalog').mobs.mort
  assert.ok(m.npc && m.kind === 'npc' && m.nameColor === 'aqua' && m.lines[1].text === 'CLICK' && m.lines[1].bold && m.lines[0].dy === 0 && m.lines[1].dy === -0.25)
  assert.deepStrictEqual(m.damage, [0, 0])
  const sp = skins.skinProfile('mort', 'mort')
  assert.ok(sp.signed && sp.properties[0].signature.length > 300)
  assert.ok(JSON.parse(Buffer.from(sp.properties[0].value, 'base64').toString()).textures.SKIN.metadata.model === 'slim')
}

// skins/hashes.json: every skin key has its hash listed, hashes are unique, other hashes are kept apart
{
  const h = skins.hashes()
  const hex = /^[0-9a-f]{1,64}$/
  const seen = new Set()
  for (const m of h.mobSkins) { assert.ok(hex.test(m.hash), m.hash); assert.ok(!seen.has(m.hash), 'duplicate ' + m.hash); seen.add(m.hash) }
  for (const k of skins.known()) {
    const m = h.mobSkins.find(x => x.key === k)
    assert.ok(m, `${k} missing from hashes.json`)
    assert.strictEqual(m.hash, JSON.parse(require('fs').readFileSync(require('path').join(skins.DIR, 'skins.json'), 'utf8'))[k].hash.replace(/^0+/, ''))
  }
  assert.ok(h.mobSkins.filter(m => !m.file && m.captureNames.length).length >= 9, 'capture-only mob profiles are listed')
  assert.ok(h.otherHashes.length > 100)
  for (const o of h.otherHashes) { assert.ok(hex.test(o.hash) && !seen.has(o.hash), 'other hash overlaps a mob skin: ' + o.hash); assert.ok(['player', 'head'].includes(o.kind)) }
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

// ---- default catalogue armour (lib/armorSets.js, from the items endpoint) ----
{
  const worn = m => Object.fromEntries(Object.entries({ helmet: 5, chestplate: 4, leggings: 3, boots: 2 }).map(([n, i]) => [n, m.equipment[i]]))
  const types = m => Object.values(worn(m)).map(i => i && i.type)
  const dye = i => { const c = i.components.find(c => c.type === 'dyed_color'); return c && c.data }
  const rgb = (r, g, b) => (r << 16) | (g << 8) | b
  const spawn = (k, o = {}) => dm.spawn(k, at, { modifier: null, ...o })

  // full leather sets: dyed with the items endpoint colour, head piece is a skull with the endpoint's texture
  const sets = {
    tank_zombie: [[255, 255, 255], [130, 130, 130]], // heavy
    super_tank_zombie: [[230, 230, 230], [90, 100, 100]],
    zombie_soldier: [[208, 127, 0]],
    zombie_commander: [[213, 18, 48]],
    skeleton_grunt: [[225, 235, 52]],
    skeleton_soldier: [[255, 188, 11]],
    skeleton_master: [[255, 107, 11]],
    shadow_assassin: [[0, 0, 0]],
    frozen_adventurer: [[160, 218, 239]]
  }
  for (const [k, colours] of Object.entries(sets)) {
    const m = spawn(k)
    const w = worn(m)
    assert.ok(w.helmet && w.chestplate && w.leggings && w.boots, `${k} wears four pieces`)
    assert.ok(colours.some(c => dye(w.chestplate) === rgb(...c)), `${k} chestplate colour`)
  }
  assert.strictEqual(dye(worn(spawn('shadow_assassin')).boots), 0) // black is colour 0, not "no colour"
  assert.strictEqual(worn(spawn('shadow_assassin')).helmet.type, 'player_head')
  assert.strictEqual(worn(spawn('frozen_adventurer')).helmet.type, 'player_head')
  assert.ok(worn(spawn('frozen_adventurer')).helmet.components.some(c => c.type === 'profile'))
  assert.strictEqual(spawn('tank_zombie').dungeon.armor.chestplate.id, 'HEAVY_CHESTPLATE')
  assert.strictEqual(spawn('super_tank_zombie').dungeon.armor.chestplate.id, 'SUPER_HEAVY_CHESTPLATE')

  // vanilla-material sets
  assert.deepStrictEqual(types(spawn('king_midas')), ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots'])
  assert.deepStrictEqual(types(spawn('angry_archaeologist')), ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'])
  assert.deepStrictEqual(types(spawn('zombie_knight')), ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots'])
  assert.deepStrictEqual(types(spawn('skeletor')), ['player_head', 'chainmail_chestplate', 'chainmail_leggings', 'chainmail_boots'])
  assert.deepStrictEqual(types(spawn('skeleton_lord')), ['golden_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots'])
  assert.deepStrictEqual(types(spawn('zombie_lord')), ['golden_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots'])

  // Sniper only has a helmet
  const sn = spawn('sniper')
  assert.deepStrictEqual(types(sn), ['player_head', undefined, undefined, undefined])

  // Lost Adventurer: a dragon set per variant, random when not given
  const v = { young: [221, 228, 240], unstable: [178, 18, 227], holy: [71, 209, 71], superior: [242, 223, 17] }
  for (const [name, c] of Object.entries(v)) {
    const m = spawn('lost_adventurer', { variant: name })
    assert.strictEqual(m.dungeon.variant, name)
    assert.strictEqual(m.dungeon.armor.helmet.id, `${name.toUpperCase()}_DRAGON_HELMET`)
    assert.strictEqual(worn(m).helmet.type, 'player_head')
    assert.strictEqual(dye(worn(m).chestplate), rgb(...c), name)
  }
  assert.ok(Object.keys(v).includes(spawn('lost_adventurer').dungeon.variant))
  assert.strictEqual(spawn('zombie_knight').dungeon.variant, null)
  assert.throws(() => spawn('lost_adventurer', { variant: 'old' }), /Unknown variant/)

  // Super Archer: Bouncy armour on F4 only
  assert.deepStrictEqual(types(spawn('super_archer', { floor: 4 })).map(t => t && t.split('_')[0]), ['leather', 'leather', 'leather', 'leather'])
  assert.strictEqual(spawn('super_archer', { floor: 4 }).dungeon.armor.helmet.id, 'BOUNCY_HELMET')
  for (const floor of [3, 5, 7]) assert.deepStrictEqual(types(spawn('super_archer', { floor })), [undefined, undefined, undefined, undefined])

  // no armour / no confirmed armour (and the two sets the endpoint does not have)
  for (const k of ['crypt_lurker', 'crypt_undead', 'crypt_dreadlord', 'undead_skeleton', 'scared_skeleton', 'crypt_souleater', 'withermancer', 'redstone_warrior', 'zombie_grunt', 'skeletor_prime']) {
    assert.deepStrictEqual(types(spawn(k)), [undefined, undefined, undefined, undefined], k)
  }

  // an explicit option still wins over the default
  assert.strictEqual(worn(spawn('king_midas', { armor: 'netherite' })).helmet.type, 'netherite_helmet')
  assert.deepStrictEqual(types(spawn('king_midas', { armor: null })), [undefined, undefined, undefined, undefined])

  // every piece in the generated sets is a real item name and no two mobs share spec objects
  const a = spawn('zombie_soldier').dungeon.armor
  const b = spawn('zombie_soldier').dungeon.armor
  assert.notStrictEqual(a.helmet, b.helmet)
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
