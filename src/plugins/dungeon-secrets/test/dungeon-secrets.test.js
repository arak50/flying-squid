'use strict'
// node src/plugins/dungeon-secrets/test/dungeon-secrets.test.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { loadLocations, validateLocations, roomSecrets, parseName } = require('../lib/locations')
const plugin = require('..')

const tests = []
const test = (name, fn) => tests.push([name, fn])
const size = { x: 31, y: 40, z: 31 }
const E = (secretName, category, x, y, z) => ({ secretName, category, x, y, z })
const fixture = () => ({
  copyright: 'c',
  license: 'l',
  'Test-1': [E('1 - Chest', 'chest', 3, 70, 3), E('2 - Bat', 'bat', 9, 72, 3), E('3 - Wither Essence', 'wither', 9, 67, 9), E('3 - Entrance', 'entrance', 1, 68, 1), E('2/3 - Superboom', 'superboom', 5, 68, 5), E('4 - Item', 'item', 7, 68, 7)],
  'Bad-1': [E('1 - Chest', 'unicorn', 1, 2, 3)]
})
const mkServ = (dir, locFile) => {
  const serv = new EventEmitter(); serv.errors = []; serv.err = m => serv.errors.push(m); serv.info = () => {}
  plugin.server.call({ settings: { schematics: dir, locations: locFile } }, serv)
  return serv
}

test('locations: name parsing and category split (chest/item/bat/wither count, the rest are hints)', () => {
  assert.deepStrictEqual(parseName('2/3 - Redstone Skull'), { numbers: [2, 3], label: 'Redstone Skull' })
  assert.deepStrictEqual(parseName('Whatever'), { numbers: [], label: 'Whatever' })
  const { secrets, hints } = roomSecrets(fixture()['Test-1'], 66)
  assert.deepStrictEqual(secrets.map(s => [s.id, s.type]), [['chest-1', 'chest'], ['bat-2', 'bat'], ['essence-3', 'essence'], ['item-4', 'item']])
  assert.deepStrictEqual(secrets[0].pos, { x: 3.5, y: 4, z: 3.5 }, 'block centre, y relative to the floor')
  assert.deepStrictEqual(hints.map(h => [h.category, h.numbers]), [['entrance', [3]], ['superboom', [2, 3]]])
})

test('plugin: totals / list / hints from the file, spawnRoom only announces (stub)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'))
  fs.mkdirSync(path.join(dir, '1x1'))
  fs.writeFileSync(path.join(dir, '1x1', 'Test-1.json'), JSON.stringify({ name: 'Test-1', category: '1x1', size, floorYWorld: 66, secrets: { ignored: 'the sidecar block is not the source any more' } }))
  fs.writeFileSync(path.join(dir, '1x1', 'Bad-1.json'), JSON.stringify({ name: 'Bad-1', category: '1x1', size, floorYWorld: 66 }))
  const file = path.join(dir, 'loc.json'); fs.writeFileSync(file, JSON.stringify(fixture()))
  const serv = mkServ(dir, file)
  const room = (id, template, x, rot = 0) => ({ id, template, rotationQuarterTurns: rot, blockMin: { x: x * 32, z: 0 }, cells: [{ x, z: 0 }] })
  const layout = { rooms: [room(0, null, 0), room(1, 'Test-1', 1), room(2, 'Bad-1', 2), room(3, 'Test-1', 3, 1), room(4, 'Nope-9', 4)] }
  assert.deepStrictEqual(serv.dungeonSecrets.totals(layout), { 1: 4, 3: 4 })
  assert.ok(serv.errors.some(e => /Bad-1\[0\].*unknown category/.test(e)), serv.errors.join('|'))
  const l = serv.dungeonSecrets.list(layout, 1)
  assert.deepStrictEqual(l.map(s => [s.id, s.type, s.counts]), [['chest-1', 'chest', true], ['bat-2', 'bat', true], ['essence-3', 'essence', true], ['item-4', 'item', true]])
  assert.deepStrictEqual(l[0].position, { x: 32 + 3.5, y: 70, z: 3.5 })
  assert.deepStrictEqual(serv.dungeonSecrets.list(layout, 3)[0].position, { x: 96 + 31 - 3.5, y: 70, z: 3.5 }, 'rotated like the room')
  assert.deepStrictEqual(serv.dungeonSecrets.hints(layout, 1).map(h => h.category), ['entrance', 'superboom'])
  for (const id of [0, 2, 4]) assert.deepStrictEqual(serv.dungeonSecrets.list(layout, id), [])
  const seen = []
  serv.on('dungeonSecretsSpawn', e => seen.push(e))
  assert.deepStrictEqual(serv.dungeonSecrets.spawnRoom({ layout, roomId: 1 }), [], 'nothing is spawned yet')
  serv.emit('dungeonRoomEntered', { roomId: 3, layout })
  serv.emit('dungeonRoomEntered', { roomId: 0, layout })
  assert.deepStrictEqual(seen.map(e => e.roomId), [1, 3])
  assert.strictEqual(seen[0].hints.length, 2)
})

test('shipped data: valid, keeps its licence header, and every secret of our sidecars lies inside its room', () => {
  const loc = loadLocations()
  assert.deepStrictEqual(validateLocations(loc), [])
  assert.match(loc.meta.license, /GPL-3.0/)
  assert.ok(loc.rooms.size > 100)
  const dir = path.resolve(__dirname, '../../../../dungeon-room-schematics')
  if (!fs.existsSync(dir)) return
  const { loadSidecars } = require('../../dungeon-spawner/lib/sidecars')
  const { byName } = loadSidecars(dir, { skipMobs: true })
  let matched = 0; let secrets = 0
  for (const [name, sc] of byName) {
    const entries = loc.rooms.get(name); if (!entries) continue
    matched++
    const r = roomSecrets(entries, sc.floorYWorld)
    for (const s of [...r.secrets, ...r.hints]) {
      assert.ok(s.pos.x > 0 && s.pos.x < sc.size.x && s.pos.z > 0 && s.pos.z < sc.size.z && s.pos.y >= 0 && s.pos.y < sc.size.y, `${name} ${s.name} outside the room: ${JSON.stringify(s.pos)}`)
    }
    secrets += r.secrets.length
  }
  assert.ok(matched >= 20 && secrets > 40, `matched ${matched} rooms, ${secrets} secrets`)
})

;(async () => {
  let ok = 0
  for (const [name, fn] of tests) {
    try { await fn(); ok++; console.log('  ok  ', name) } catch (e) { console.log('  FAIL', name); console.log('      ' + String(e.stack || e).split('\n').join('\n      ')) }
  }
  console.log(`\n${ok}/${tests.length} passed`)
  process.exit(ok === tests.length ? 0 : 1)
})()
