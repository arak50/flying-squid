'use strict'
// node src/plugins/dungeon-items/test/dungeon-items.test.js
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { createItems, rollLevel } = require('../lib/items')
const { planDrops } = require('../lib/drops')
const { ITEMS, resolve, roman } = require('../lib/catalog')
const plugin = require('..')
const { createBob } = require('../lib/bob')
const mcData = require('minecraft-data')('26.1')

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('catalogue: names resolve, every item has a head and a pickup mode', () => {
  assert.strictEqual(resolve('Blessing of Life'), 'blessing_life')
  assert.strictEqual(resolve('life'), 'blessing_life')
  assert.strictEqual(resolve('blood'), 'blood_key')
  assert.strictEqual(resolve('wither key'), 'wither_key')
  assert.strictEqual(resolve('nope'), null)
  for (const [k, d] of Object.entries(ITEMS)) { assert.ok(d.head && d.name && d.pickup, k) }
  assert.deepStrictEqual(Object.keys(ITEMS).filter(k => k.startsWith('blessing_')).sort(), ['blessing_life', 'blessing_power', 'blessing_stone', 'blessing_time', 'blessing_wisdom'])
  assert.strictEqual(roman(9), 'IX')
})

test('blessings: level by floor, clamped, stacking and summed stats per player', () => {
  const lo = () => 0; const hi = () => 0.999
  assert.strictEqual(rollLevel(0, false, hi), 1)
  assert.strictEqual(rollLevel(7, false, lo), 6); assert.strictEqual(rollLevel(7, false, hi), 8)
  assert.strictEqual(rollLevel(7, true, hi), 13, 'never above XIII')
  const it = createItems({ rng: lo })
  const a = it.spawn('blessing_life', { x: 1, y: 2, z: 3 }, { level: 4 })
  const b = it.spawn('blessing_life', { x: 1, y: 2, z: 3 }, { level: 3 })
  const c = it.spawn('blessing_power', { x: 1, y: 2, z: 3 }, { level: 2 })
  assert.strictEqual(it.list().length, 3)
  assert.strictEqual(it.pickup(a.id, 'p1').total, 4)
  assert.strictEqual(it.pickup(b.id, 'p1').total, 7)
  assert.strictEqual(it.pickup(a.id, 'p2'), null, 'already taken')
  it.pickup(c.id, 'p2')
  assert.deepStrictEqual(it.levels('p1'), { blessing_life: 7 })
  assert.deepStrictEqual(it.bonuses('p1'), { health: { add: 0, mult: 1.2299 }, healthRegen: { add: 0, mult: 1.2299 } })
  assert.deepStrictEqual(it.bonuses('p2'), { strength: { add: 8.16, mult: 1.0404 } })
  assert.deepStrictEqual(it.bonuses('nobody'), {})
  assert.throws(() => it.spawn('unicorn', {}), /Unknown item/)
  assert.strictEqual(it.spawn('blessing_time', {}, { level: 99 }).level, 13)
})

test('grant text matches the capture ("Granted you ..." lines)', () => {
  const it = createItems()
  assert.strictEqual(it.grantText('blessing_power', 5), '§a+20.4§7 & §a+1.1x §cStrength')
  assert.strictEqual(it.grantText('blessing_power', 1), '§a+4.1§7 & §a+1.02x §cStrength')
  assert.strictEqual(it.grantText('blessing_power', 2), '§a+8.2§7 & §a+1.04x §cStrength')
  assert.strictEqual(it.grantText('blessing_stone', 5), '§a+20.4§7 & §a+1.1x §aDefense §7and §a+30 §cDamage')
  assert.strictEqual(it.grantText('blessing_stone', 1), '§a+4.1§7 & §a+1.02x §aDefense §7and §a+6 §cDamage')
  assert.strictEqual(it.grantText('blessing_life', 5), '§a+1.15x HP §7and §a+1.15x §cHealth Regen')
  assert.strictEqual(it.grantText('blessing_life', 2), '§a+1.06x HP §7and §a+1.06x §cHealth Regen')
})

test('a blessing is granted to every recipient (party-wide)', () => {
  const it = createItems({ rng: () => 0 })
  const b = it.spawn('blessing_life', {}, { level: 3 })
  const r = it.pickup(b.id, 'a', { recipients: ['a', 'b', 'c'] })
  assert.deepStrictEqual(r.recipients, ['a', 'b', 'c']); assert.deepStrictEqual(it.levels('c'), { blessing_life: 3 })
})

test('drops: last mob = key or blessing, plus TNT or Revive Stone; miniboss may drop a blessing', () => {
  const seq = vals => { let i = 0; return () => vals[i++ % vals.length] }
  const a = planDrops({ kind: 'lastMob', hasKey: false, floor: 3, rng: seq([0.1, 0.5, 0.2]) })
  assert.strictEqual(a.length, 2); assert.ok(a[0].type.startsWith('blessing_') && a[0].level >= 1); assert.strictEqual(a[1].type, 'superboom_tnt')
  const k = planDrops({ kind: 'lastMob', hasKey: true, rng: seq([0.99]) })
  assert.deepStrictEqual(k, [{ type: 'revive_stone' }], 'the key is dropped by dungeon-run; here only the second slot')
  assert.strictEqual(planDrops({ kind: 'miniboss', rng: () => 0.9 }).length, 0)
  assert.strictEqual(planDrops({ kind: 'miniboss', rng: () => 0.1 }).length, 1)
  let tnt = 0; for (let i = 0; i < 3000; i++) if (planDrops({ kind: 'lastMob', hasKey: true, rng: Math.random })[0].type === 'superboom_tnt') tnt++
  assert.ok(tnt > 1800 && tnt < 2200, 'about 2:1')
})

test('consumables are carried and used; keys have no level', () => {
  const it = createItems()
  const t = it.spawn('superboom_tnt', {}); assert.strictEqual(t.level, undefined)
  assert.strictEqual(it.pickup(t.id, 'p').count, 1)
  assert.deepStrictEqual(it.inventory('p'), { superboom: 1 })
  assert.strictEqual(it.use('p', 'superboom'), true); assert.strictEqual(it.use('p', 'superboom'), false)
  assert.strictEqual(it.spawn('wither_key', {}).level, undefined)
})

class FakeItem {
  constructor (type, count) { this.type = type; this.count = count; this.components = []; this.componentMap = new Map(); FakeItem.last = this }
  static toNotch (i) { return i ? { present: true, itemId: i.type, count: i.count } : { present: false } }
}
// ---- glue with a fake server ----
function mkServ () {
  const serv = new EventEmitter(); serv.errors = []; serv.err = m => serv.errors.push(m); serv.info = () => {}
  serv.players = []; serv.overworld = { name: 'w' }; serv.destroyed = []
  const keys = mcData.entitiesByName.armor_stand.metadataKeys
  const registry = { entitiesByName: { armor_stand: { id: 5 } }, entities: { 5: { metadataKeys: keys } }, mobs: {}, protocol: { types: { entityMetadataEntry: [0, [0, { type: [0, { mappings: mcData.protocol.types.entityMetadataEntry[1][1].type[1].mappings }] }]] } }, itemsByName: { wither_skeleton_skull: { id: 3 }, paper: { id: 4 }, player_head: { id: 7 } }, version: { '>=': () => true }, supportFeature: () => true }
  serv.registry = registry
  serv.supportFeature = () => true
  serv.spawned = []
  serv.spawnMob = (id, world, pos) => {
    const e = { id: 100 + serv.spawned.length, position: pos, world, gravity: new Vec3(0, -20, 0), metadata: [], sent: [], packets: [], sendMetadata (m) { this.sent.push(m) }, _writeOthersNearby (n, d) { this.packets.push([n, d]) } }
    serv.spawned.push(e); return e
  }
  serv.destroyEntity = e => serv.destroyed.push(e)
  serv.commands = { list: [], add (c) { this.list.push(c) } }
  plugin.server.call({ settings: { Item: FakeItem, rng: () => 0 } }, serv)
  return serv
}
const player = (name, x, z, extra = {}) => ({ uuid: name, username: name, position: { x, y: 69, z }, world: null, chat (m) { this.said = (this.said || []).concat(m) }, ...extra })

test('plugin: a drop is an item stand with the captured head plus a still name stand; walking over it collects it', () => {
  const serv = mkServ()
  const world = serv.overworld
  serv.dungeonItems.spawn('blessing_life', { x: 10.5, y: 69, z: 10.5 }, { world, level: 6 })
  assert.strictEqual(serv.spawned.length, 2)
  const [body, name] = serv.spawned
  assert.strictEqual(body.position.y, 69 - 0.71875); assert.strictEqual(name.position.y, 69 - 0.46875)
  const m = (e, k) => (e.metadata.find(x => x.key === k) || {}).value
  assert.strictEqual(m(body, 0), 0x20, 'invisible'); assert.strictEqual(m(body, 15), 0, 'ordinary stand, not marker'); assert.deepStrictEqual(m(body, 19), { pitch: -90, yaw: 0, roll: 0 })
  assert.ok(JSON.stringify(m(name, 2)).includes('Blessing of Life') && !JSON.stringify(m(name, 2)).includes(' VI'), 'name has no level, like the capture')
  assert.strictEqual(m(name, 3), true)
  const eq = body.packets.find(p => p[0] === 'entity_equipment')
  assert.ok(eq, 'head sent: ' + serv.errors.join('|'))
  assert.strictEqual(eq[1].equipments[0].slot, 5)
  const prof = FakeItem.last.components.find(c => c.type === 'profile').data.properties[0]
  assert.ok(prof.signature && Buffer.from(prof.value, 'base64').toString().includes('ab436edb7b805e133f7d3489d46ce0636f7e1cb37b67689faa12e698dbbd7c66'))
  assert.ok(name.packets.some(p => p[0] === 'update_attributes' && p[1].properties[0].value === 0.1), 'scale 0.1 on the name stand')
  const far = player('far', 30, 30, { world }); const near = player('near', 11, 10.5, { world })
  serv.players.push(far); serv.emit('tick'); serv.emit('tick')
  assert.strictEqual(serv.dungeonItems.list().length, 1, 'too far')
  serv.players.push(near); serv.emit('tick'); serv.emit('tick')
  assert.strictEqual(serv.dungeonItems.list().length, 0)
  assert.deepStrictEqual(serv.destroyed, [body, name])
  assert.ok(near.said.some(m => m.includes('DUNGEON BUFF') && m.includes('Blessing of Life VI')))
  assert.strictEqual(serv.dungeonItems.bonuses(near).health.mult, 1.1941)
  assert.deepStrictEqual(serv.errors, [])
})

test('plugin: superboom is a paper in the main hand with the resource-pack model, glint, raised arm', () => {
  const serv = mkServ()
  serv.dungeonItems.spawn('superboom_tnt', { x: 0.5, y: 69, z: 0.5 }, { world: serv.overworld })
  const [body] = serv.spawned
  assert.strictEqual(body.position.y, 68.5)
  assert.strictEqual(body.packets.find(p => p[0] === 'entity_equipment')[1].equipments[0].slot, 0)
  const c = FakeItem.last.components
  assert.strictEqual(c.find(x => x.type === 'item_model').data, 'hypixel_skyblock:item/uncategorized/superboom_tnt')
  assert.ok(c.find(x => x.type === 'enchantment_glint_override'))
  assert.deepStrictEqual(serv.errors, [])
})

test('plugin: the item stand bobs and spins every tick, and unclaimed items vanish after 30 s (keys never)', () => {
  const serv = mkServ(); const world = serv.overworld
  serv.dungeonItems.spawn('blessing_life', { x: 0.5, y: 69, z: 0.5 }, { world })
  serv.dungeonItems.spawn('wither_key', { x: 50.5, y: 69, z: 50.5 }, { world })
  const body = serv.spawned[0]; const base = body.position.y
  serv.emit('tick')
  const syncs = () => body.packets.filter(p => p[0] === 'sync_entity_position').map(p => p[1])
  assert.strictEqual(syncs().length, 1)
  assert.ok(Math.abs(syncs()[0].y - (base + 0.01)) < 1e-9)
  for (let i = 0; i < 20; i++) serv.emit('tick')
  const ys = syncs().map(s => s.y - base)
  assert.ok(Math.abs(Math.max(...ys) - 0.2) < 1e-9)
  for (let i = 0; i < 60; i++) serv.emit('tick')
  assert.ok(Math.abs(Math.min(...syncs().map(s => s.y - base)) + 0.2) < 1e-9)
  assert.ok(Math.abs(((syncs()[1].yaw - syncs()[0].yaw) + 360) % 360 - 2) < 1e-9, 'spins 2 degrees per tick')
  for (let i = 0; i < 1500; i++) serv.emit('tick')
  assert.deepStrictEqual(serv.dungeonItems.list().map(i => i.type), ['wither_key'])
})

test('bob: triangle wave of +-0.2 with a held tick at each end, 2 degrees per tick (as captured)', () => {
  const b = createBob(0); const ys = []; for (let i = 0; i < 100; i++) ys.push(b.step().dy)
  assert.deepStrictEqual(ys.slice(0, 3), [0.01, 0.02, 0.03]); assert.strictEqual(ys[19], 0.2); assert.strictEqual(ys[20], 0.2); assert.strictEqual(ys[21], 0.19)
  assert.strictEqual(ys[60], -0.2); assert.strictEqual(ys[61], -0.2); assert.strictEqual(ys[62], -0.19)
})

test('plugin: spawn and pickup effects, party chat (as captured)', () => {
  const serv = mkServ(); const world = serv.overworld
  const written = []
  const mk = (name, x, z) => { const p = player(name, x, z, { world }); p._client = { write: (n, d) => written.push([name, n, d]) }; return p }
  const me = mk('Me', 9.2, 10.5); const mate = mk('Mate', 90, 90)
  serv.players.push(me, mate); serv.getNearby = () => [me]
  serv.dungeonRun = { party: [me, mate], elapsedSeconds: 186 }
  serv.registry.soundsByName = { 'entity.item.break': { id: 909 } }
  serv.dungeonItems.spawnDrops([{ type: 'blessing_power', level: 5 }, { type: 'superboom_tnt' }], { x: 10.5, y: 69, z: 10.5 }, { world })
  const items = serv.dungeonItems.list()
  assert.deepStrictEqual(items.map(i => [i.position.x, i.position.z]), [[10.5, 10.5], [11, 11]], 'second drop 0.5 away')
  const puffs = written.filter(w => w[1] === 'world_particles').map(w => w[2].particle.type)
  assert.deepStrictEqual(puffs, ['explosion', 'explosion', 'explosion_emitter'], 'explosion for each drop, the emitter too for the consumable')
  serv.emit('tick'); serv.emit('tick')
  const sparks = written.filter(w => w[2].particle && w[2].particle.type === 'firework')
  assert.strictEqual(sparks.length, 0, 'the sparkle is every 10 ticks')
  for (let i = 0; i < 10; i++) serv.emit('tick')
  assert.ok(written.some(w => w[2].particle && w[2].particle.type === 'firework' && w[2].particle.amount !== 0 && w[2].amount === 6), 'TNT sparkles')
  // the blessing was picked up on the first ticks (player stands on it)
  assert.ok(written.some(w => w[1] === 'sound_effect' && w[2].sound.soundId === 909 && w[0] === 'Me'), 'item.break to the picker')
  assert.ok(written.some(w => w[1] === 'world_particles' && w[2].particle.type === 'lava'), 'lava at the stand')
  assert.ok(me.said.includes('§bMe §ehas obtained §dBlessing of Power§e!'))
  assert.ok(me.said.includes('§6§lDUNGEON BUFF! §fYou found a §dBlessing of Power V§f! §f(§a03m 06s§f)'))
  assert.ok(mate.said.includes('§6§lDUNGEON BUFF! §f§bMe §ffound a §dBlessing of Power V§f! §f(§a03m 06s§f)'))
  assert.ok(mate.said.includes('     §7Granted you §a+20.4§7 & §a+1.1x §cStrength§7.'))
  assert.ok(serv.dungeonItems.levels(mate).blessing_power === 5, 'the whole party gets it')
})

test('plugin: a claim hook can take the item (keys) or refuse it (ghosts)', () => {
  const serv = mkServ(); const world = serv.overworld
  let allow = false; const got = []
  serv.dungeonItems.spawn('wither_key', { x: 0, y: 69, z: 0 }, { world, claim: p => { got.push(p.username); return allow } })
  const p = player('p', 0.5, 0.5, { world }); serv.players.push(p)
  serv.emit('tick'); serv.emit('tick')
  assert.strictEqual(serv.dungeonItems.list().length, 1, 'refused: still lying there')
  allow = true; serv.emit('tick'); serv.emit('tick')
  assert.strictEqual(serv.dungeonItems.list().length, 0)
  assert.ok(got.length >= 2)
  assert.strictEqual(p.said, undefined, 'keys are announced by dungeon-run, not here')
})

test('plugin: /ditem drops an item at the player', () => {
  const serv = mkServ(); const world = serv.overworld
  const cmd = serv.commands.list.find(c => c.base === 'ditem')
  assert.deepStrictEqual(cmd.parse('blessing_stone 3'), { type: 'blessing_stone', level: 3 })
  const msg = cmd.action({ type: 'stone', level: 3 }, { player: { position: new Vec3(1, 2, 3), world } })
  assert.strictEqual(msg, 'Dropped blessing_stone III.')
  assert.match(cmd.action({ type: 'zzz' }, { player: { position: new Vec3(0, 0, 0), world } }), /Unknown item/)
})

let failed = 0
for (const [name, fn] of tests) { try { fn(); console.log('  ok  ', name) } catch (e) { failed++; console.log('  FAIL', name, '\n', e.stack) } }
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
