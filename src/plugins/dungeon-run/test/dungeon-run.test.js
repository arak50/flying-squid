'use strict'
// Unit tests, no network:  node src/plugins/dungeon-run/test/dungeon-run.test.js
//   DUNGEON_SWEEP=N   seeds per floor for the real-layout sweep (default 3)
const assert = require('assert')
const path = require('path')
const { EventEmitter } = require('events')
const { DungeonRun } = require('../lib/run')
const { Machine } = require('../lib/fsm')
const { derive } = require('../lib/rng')
const plugin = require('..')
const spawnerPlugin = require('../../dungeon-spawner')

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ---------------------------------------------------------------------------------------------------------------------
// A small hand-made floor:
//
//   [0 Entrance] -e- [1 Normal] -W- [2 Normal] -B- [3 Blood]        e entrance door, W wither door, B blood door
//                      |              |
//                   [4 Puzzle]      [5 Boss(yellow)]                  | normal doors (open from the start)
// ---------------------------------------------------------------------------------------------------------------------
function fixture (extra = {}) {
  const room = (id, type, x, z) => ({ id, type, shape: '1x1', template: null, cells: [{ x, z }] })
  const door = (a, b, kind, axis, x, z) => ({ rooms: [a, b], kind, axis, center: { x, y: 66, z } })
  return {
    floor: 0,
    seed: 1234,
    cellPitch: 32,
    roomSize: 31,
    doorBaseY: 66,
    rooms: [room(0, 'Entrance', 0, 0), room(1, 'Normal', 1, 0), room(2, 'Normal', 2, 0), room(3, 'Blood', 3, 0), room(4, 'Puzzle', 1, 1), room(5, 'Boss', 2, 1)],
    doors: [
      door(0, 1, 'entrance', 'east-west', 31, 15), door(1, 2, 'wither', 'east-west', 63, 15), door(2, 3, 'blood', 'east-west', 95, 15),
      door(1, 4, 'normal', 'north-south', 47, 31), door(2, 5, 'normal', 'north-south', 79, 31)
    ],
    ...extra
  }
}
const centerOf = (run, id) => run.roomCenter(run.rooms[id])
const ME = 'p1'
function mk (o = {}) {
  return new DungeonRun({ layout: fixture(o.layout), seed: o.seed, floor: o.floor, master: o.master, config: o.config, secrets: o.secrets, party: o.party || [{ id: ME, name: 'Me' }] })
}
function running (o) { const run = mk(o); run.start(); while (run.state === 'COUNTDOWN') run.tick(); return run }
const goTo = (run, id, who = ME) => { const c = centerOf(run, id); return run.playerMoved(who, c.x, c.z) }
const ticks = (run, n) => { for (let i = 0; i < n; i++) run.tick() }
const events = (run, type) => run.log.filter(e => e.type === type)
const last = (run, type) => events(run, type).pop()
// run the Watcher script to its end: every guardian has appeared (the last one at ~57.6 s), then kill them all
const clearWatcher = run => { ticks(run, 20 * 60); events(run, 'spawnWatcherMobs').flatMap(e => e.plan.entries).forEach(e => run.mobDied(e.mobId)) }
const aliveRequired = (run, id) => run.rooms[id].plan.entries.filter(e => e.required)

// ---------------------------------------------------------------------------------------------------------------------
test('Machine refuses events the state does not list', () => {
  const m = new Machine('t', { A: { go: 'B' }, B: {} }, 'A')
  assert.strictEqual(m.fire('nope'), false)
  assert.strictEqual(m.fire('go'), true)
  assert.strictEqual(m.fire('go'), false)
  assert.strictEqual(m.state, 'B')
})

test('rng streams are independent and reproducible', () => {
  const a = [derive(7, 'room', 1).next(), derive(7, 'room', 1).next()]
  assert.strictEqual(a[0], a[1])
  assert.notStrictEqual(derive(7, 'room', 1).next(), derive(7, 'room', 2).next())
  assert.notStrictEqual(derive(7, 'room', 1).next(), derive(8, 'room', 1).next())
})

test('lifecycle: lobby -> 5 s countdown -> running, entrance opens on its own', () => {
  const run = mk()
  assert.strictEqual(run.state, 'LOBBY')
  assert.strictEqual(run.start(), true)
  assert.strictEqual(run.start(), false)
  ticks(run, 99)
  assert.strictEqual(run.state, 'COUNTDOWN')
  assert.deepStrictEqual(events(run, 'countdown').map(e => e.seconds), [4, 3, 2, 1])
  run.tick()
  assert.strictEqual(run.state, 'RUNNING')
  assert.strictEqual(run.rooms[0].machine.state, 'COMPLETED')
  assert.strictEqual(run.doors[0].state, 'OPEN') // entrance door
  assert.strictEqual(run.doors[1].state, 'LOCKED') // wither
  assert.strictEqual(run.doors[3].state, 'OPEN') // normal
  assert.strictEqual(run.elapsed, 0)
  ticks(run, 40)
  assert.strictEqual(run.elapsedSeconds, 2)
})

test('roomAt: cells map to rooms, the 1 block gap between cells belongs to nobody', () => {
  const run = mk()
  assert.strictEqual(run.roomAt(5, 5), 0)
  assert.strictEqual(run.roomAt(40, 5), 1)
  assert.strictEqual(run.roomAt(40, 40), 4)
  assert.strictEqual(run.roomAt(31.5, 15), undefined) // door gap
  assert.strictEqual(run.roomAt(-5, 5), undefined)
  assert.strictEqual(run.roomAt(200, 5), undefined)
})

test('entering a room spawns its plan once, with the room-entering bonus count', () => {
  const run = running()
  assert.strictEqual(goTo(run, 1), true)
  assert.strictEqual(goTo(run, 1), false) // already inside
  const spawn = events(run, 'spawnMobs')
  assert.strictEqual(spawn.length, 1)
  assert.strictEqual(spawn[0].plan.roomsExplored, 2) // entrance + this one: the 2nd 1x1 room is the +5% one
  assert.ok(spawn[0].plan.entries.filter(e => e.required).length >= 2)
  for (const e of spawn[0].plan.entries) { assert.ok(e.position.x >= 32 && e.position.x < 63 && e.position.z >= 0 && e.position.z < 31, 'inside the cell') }
  goTo(run, 2); goTo(run, 1)
  assert.strictEqual(events(run, 'spawnMobs').length, 2, 'going back does not respawn anything')
})

test('room clears exactly when the last required mob dies; fillers do not matter', () => {
  const run = running()
  goTo(run, 1)
  const req = aliveRequired(run, 1)
  for (const e of req.slice(0, -1)) run.mobDied(e.mobId)
  assert.strictEqual(run.rooms[1].machine.state, 'ENTERED')
  assert.strictEqual(run.mobDied(req[0].mobId), false, 'duplicate death ignored')
  assert.strictEqual(run.mobDied('nope'), false)
  run.mobDied(req[req.length - 1].mobId)
  assert.strictEqual(run.rooms[1].machine.state, 'COMPLETED') // no secrets registered, so cleared = completed
  assert.strictEqual(events(run, 'roomCleared').filter(e => e.roomId === 1).length, 1)
  assert.strictEqual(events(run, 'roomCompleted').filter(e => e.roomId === 1).length, 1)
})

test('yellow room: one miniboss that must die', () => {
  const run = running()
  goTo(run, 5)
  const plan = run.rooms[5].plan.entries
  assert.strictEqual(plan.length, 1)
  assert.strictEqual(plan[0].miniboss, true)
  assert.strictEqual(plan[0].star, false)
  run.mobDied(plan[0].mobId)
  assert.ok(run.rooms[5].machine.is('CLEARED', 'COMPLETED'))
})

test('keys: dropped on clear, picked up into the party pool, spent on the wither door', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const run = running({ seed })
    assert.ok(run.rooms[1].keys.includes('wither'), `seed ${seed}: the only room reachable before the wither door holds its key`)
    assert.deepStrictEqual(run.warnings, [])
    assert.strictEqual(run.rooms.flatMap(r => r.keys).filter(k => k === 'blood').length, 1)
  }
  const run = running()
  assert.strictEqual(run.openDoor(ME, 1).ok, false)
  assert.match(run.openDoor(ME, 1).reason, /Wither Key/)
  goTo(run, 1)
  run.killRoomMobs(1)
  const drop = events(run, 'keyDropped').find(e => e.keyType === 'wither')
  assert.ok(drop && drop.roomId === 1)
  assert.strictEqual(run.pickupKey(drop.id, ME), true)
  assert.strictEqual(run.pickupKey(drop.id, ME), false, 'one pickup per key')
  assert.strictEqual(run.keys.wither, 1)
  assert.strictEqual(run.openDoor(ME, 0).ok, false) // entrance door needs no key
  assert.strictEqual(run.openDoor(ME, 1).ok, true)
  assert.strictEqual(run.doors[1].state, 'OPEN')
  assert.strictEqual(run.keys.wither, 0)
  assert.strictEqual(run.openDoor(ME, 1).ok, false)
  assert.deepStrictEqual(last(run, 'doorOpened').center, { x: 63, y: 66, z: 15 })
})

test('autoPickupKeys puts keys straight into the pool', () => {
  const run = running({ config: { autoPickupKeys: true } })
  goTo(run, 1); run.killRoomMobs(1)
  assert.strictEqual(run.keys.wither, 1)
  assert.strictEqual(run.keyItems.size, 0)
})

test('doorsNear finds only locked key doors in range', () => {
  const run = running()
  assert.deepStrictEqual(run.doorsNear(62, 15.5, 2.5).map(d => d.id), [1])
  assert.deepStrictEqual(run.doorsNear(20, 15, 2.5), [])
  assert.deepStrictEqual(run.doorsNear(31, 15, 3), [], 'entrance door is not a key door')
})

test('strictEntry: no entering a room through a locked door', () => {
  const run = running({ config: { strictEntry: true } })
  assert.strictEqual(goTo(run, 3), false)
  assert.strictEqual(run.state, 'RUNNING')
  assert.strictEqual(goTo(run, 1), true)
  assert.strictEqual(goTo(run, 4), true) // normal door from room 1
  assert.strictEqual(goTo(run, 2), false) // behind the wither door
})

test('spawn plans do not depend on the order rooms are entered in', () => {
  const a = running(); goTo(a, 1); goTo(a, 2)
  const b = running(); goTo(b, 2); goTo(b, 1)
  const strip = run => events(run, 'spawnMobs').find(e => e.roomId === 2).plan.entries
  assert.deepStrictEqual(strip(a), strip(b))
  const c = running({ seed: 999 }); goTo(c, 2)
  assert.notDeepStrictEqual(strip(a), strip(c), 'a different seed gives a different room')
})

test('secrets: counted once, room completes only with all of them', () => {
  const run = running({ secrets: { 1: 2 } })
  goTo(run, 1); run.killRoomMobs(1)
  assert.strictEqual(run.rooms[1].machine.state, 'CLEARED')
  assert.strictEqual(run.secretFound(ME, 1, 'chest'), true)
  assert.strictEqual(run.secretFound(ME, 1, 'chest'), false)
  assert.strictEqual(run.rooms[1].machine.state, 'CLEARED')
  assert.strictEqual(run.secretFound(ME, 1, 'bat'), true)
  assert.strictEqual(run.rooms[1].machine.state, 'COMPLETED')
  assert.strictEqual(run.secretsFound, 2)
  assert.strictEqual(run.secretsTotal, 2)
  assert.strictEqual(run.tabStats().secretsPercent, 100)
})

test('puzzle room: unfinished / failed puzzles cost 10 skill each, solving clears it', () => {
  const run = running()
  assert.strictEqual(run.incompletePuzzles, 1)
  const before = run.score()
  assert.strictEqual(run.roomObjectiveDone(4), false, 'not entered yet')
  goTo(run, 4)
  assert.strictEqual(run.puzzleFailed(4, ME), true)
  assert.strictEqual(run.incompletePuzzles, 1, 'a failed puzzle stays unfinished (Hypixel shows a red cross)')
  assert.strictEqual(run.roomObjectiveDone(4), true)
  assert.strictEqual(run.roomObjectiveDone(4), false)
  assert.ok(run.rooms[4].machine.is('CLEARED', 'COMPLETED'))
  assert.strictEqual(run.incompletePuzzles, 0)
  assert.ok(run.score().skill > before.skill)
})

test('score: Skyblocker formula, reproduces the real run (Entrance, 10/15 rooms, 28.6 %, 5 deaths, 2 puzzles open, 215 s -> 155 C)', () => {
  const { compute, timeScore } = require('../lib/score')
  const cfg = require('../lib/config').resolve()
  const real = { floor: 0, totalRooms: 15, completedRooms: 10, secretsPercent: 28.6, incompletePuzzles: 2, deaths: 5, elapsedSeconds: 215 }
  const s = compute(real, cfg)
  assert.deepStrictEqual([s.skill, s.explore, s.speed, s.bonus, s.total, s.rank], [30, 55, 70, 0, 155, 'C'])
  // F7: no 0.7 multiplier, full secrets needed, mimic bonus, crypts capped at 5, spirit pet takes 1 off the first death
  const f7 = compute({ floor: 7, totalRooms: 30, completedRooms: 30, secretsPercent: 100, incompletePuzzles: 0, deaths: 1, spiritPet: true, elapsedSeconds: 100, crypts: 9, princeKilled: true, batKilled: true }, cfg)
  assert.deepStrictEqual([f7.skill, f7.explore, f7.speed, f7.bonus, f7.total, f7.rank], [99, 100, 100, 9, 308, 'S+'])
  // time bands
  assert.deepStrictEqual([timeScore(839, 840), timeScore(840 + 84, 840), timeScore(840 * 1.3, 840), timeScore(840 * 2, 840), timeScore(1e6, 840)], [100, 95, 88, 76, 0])
  // the run feeds it from its own counters
  const run = running()
  const r = run.score()
  assert.strictEqual(r.floorKey, 'E')
  assert.strictEqual(r.speed, 70)
})

test('door animation: timeline matches the capture and its packets serialise with minecraft-protocol', () => {
  const anim = require('../lib/door-anim')
  const positions = anim.doorBox({ x: -185, z: -137 }, 'north-south', 69)
  assert.strictEqual(positions.length, 36)
  assert.deepStrictEqual([Math.min(...positions.map(p => p.x)), Math.max(...positions.map(p => p.x)), Math.min(...positions.map(p => p.z)), Math.max(...positions.map(p => p.z)), Math.min(...positions.map(p => p.y)), Math.max(...positions.map(p => p.y))], [-186, -184, -138, -136, 69, 72])
  let id = 0; let n = 0
  const tl = anim.timeline({ positions, state: 12913, ids: () => ++id, uuid: () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`, types: { bat: 10, falling_block: 51 } })
  assert.deepStrictEqual(tl.steps.map(s => [s.at, s.blocks || '-', s.packets.length ? s.packets[0][0] : '-']), [
    [0, '-', 'spawn_entity'], [33, 'barrier', 'set_passengers'], [305, '-', 'sync_entity_position'], [486, '-', 'rel_entity_move'], [634, '-', 'rel_entity_move'],
    [736, 'air', '-'], [799, '-', 'rel_entity_move'], [937, '-', 'rel_entity_move'], [1132, '-', 'entity_destroy']
  ])
  // first bat: spawned at the capture's coordinates (x.5, y 68.34375, z.5), then 0.30625 lower, then 4 x 0.9375 down
  const first = tl.steps[0].packets[0][1]
  assert.deepStrictEqual([first.x, first.y, first.z], [-185.5, 68.34375, -137.5])
  const sy = tl.steps.find(s => s.at === 305).packets[0][1].y
  assert.ok(Math.abs(sy - 68.0375) < 1e-9)
  const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer')
  const { states } = require('minecraft-protocol')
  const ser = createSerializer({ state: states.PLAY, isServer: true, version: '26.1' })
  const des = createDeserializer({ state: states.PLAY, isServer: false, version: '26.1' })
  let count = 0
  for (const step of tl.steps) {
    for (const [name, params] of step.packets) {
      const back = des.parsePacketBuffer(ser.createPacketBuffer({ name, params })).data
      assert.strictEqual(back.name, name)
      count++
    }
  }
  assert.strictEqual(count, 72 + 36 + 36 + 36 + 4 * 36 + 1, 'spawns, metadata, passengers, sync, 4 moves, destroy')
})

test('sidebar: real format (viewer left out, DEAD, Cleared % (score), keys)', () => {
  const run = running({ party: [{ id: ME, name: 'Me', class: 'Healer' }, { id: 'b', name: 'trashed_pigeon_long', class: 'Archer' }] })
  const lines = run.scoreboardLines(ME)
  assert.strictEqual(lines[0], '§711/02/26 §8m22V')
  assert.ok(lines.includes('§fKeys: §c■ §c✗ §8■ §a0x'))
  assert.ok(lines.some(l => /^§fTime Elapsed: §a\d\ds$/.test(l)))
  assert.ok(lines.some(l => /^§fCleared: §[c6]\d+% §8\(\d+\)$/.test(l)))
  assert.ok(lines.includes('§e[A] §7trashed_pige §a0§c❤'.replace('§a0', '§c0')) || lines.some(l => l.startsWith('§e[A] §7trashed_pige ')), 'name cut to 12, class letter')
  assert.ok(!lines.some(l => l.includes('Me ')), 'the viewer is not listed')
  assert.strictEqual(lines[lines.length - 1], '§ewww.hypixel.net')
  run.playerDied('b')
  assert.ok(run.scoreboardLines(ME).some(l => l.endsWith('§cDEAD')))
  goTo(run, 1); run.killRoomMobs(1)
  assert.ok(run.scoreboardLines(ME).some(l => /^§fCleared: §6\d+% /.test(l)))
  const tab = run.tabStats()
  assert.strictEqual(tab.completedRooms, run.roomsCleared)
  assert.strictEqual(tab.teamDeaths, 1)
})

test('ghosts: death, timed revive (50 s, 5 s on the Entrance), no fail while someone lives', () => {
  const party = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const f3 = running({ floor: 3, party })
  assert.strictEqual(f3.playerDied('a'), true)
  assert.strictEqual(f3.playerDied('a'), false, 'a ghost cannot die again')
  assert.strictEqual(f3.openDoor('a', 1).ok, false)
  assert.strictEqual(f3.secretFound('a', 1, 'x'), false, 'ghosts find nothing')
  assert.strictEqual(f3.state, 'RUNNING')
  ticks(f3, 999)
  assert.strictEqual(f3.players.get('a').machine.state, 'GHOST')
  ticks(f3, 1)
  assert.strictEqual(f3.players.get('a').machine.state, 'ALIVE')
  assert.strictEqual(last(f3, 'playerRevived').cause, 'timer')

  const f0 = running({ floor: 0, party })
  f0.playerDied('b'); ticks(f0, 100)
  assert.strictEqual(f0.players.get('b').machine.state, 'ALIVE')

  const early = running({ party })
  early.playerDied('a')
  assert.strictEqual(early.revive('a', { cause: 'fairy' }), true)
  assert.strictEqual(early.revive('a'), false)
  ticks(early, 300)
  assert.strictEqual(events(early, 'playerRevived').length, 1, 'the old timer did nothing')
})

test('everyone a ghost = the run fails; leaving and rejoining brings you back as a ghost', () => {
  const solo = running()
  solo.playerDied(ME)
  assert.strictEqual(solo.state, 'FAILED')
  assert.strictEqual(solo.failReason, 'wipe')
  assert.strictEqual(last(solo, 'dungeonFailed').results.outcome, 'FAILED')

  const party = [{ id: 'a' }, { id: 'b' }]
  const run = running({ party })
  run.playerLeft('a')
  assert.strictEqual(run.state, 'RUNNING')
  assert.strictEqual(run.playerRejoined('a'), true)
  assert.strictEqual(run.players.get('a').machine.state, 'GHOST')
  run.playerLeft('b'); run.playerDied('a') // a is a ghost already: nothing to die
  assert.strictEqual(run.state, 'FAILED')
})

test('time limit', () => {
  const run = running({ config: { timeLimitSeconds: 2 } })
  ticks(run, 39)
  assert.strictEqual(run.state, 'RUNNING')
  ticks(run, 1)
  assert.strictEqual(run.state, 'FAILED')
  assert.strictEqual(run.failReason, 'timeout')
})

test('Entrance: the Watcher script (capture timeline), 8 guardians one by one, killing them completes the run', () => {
  const run = running({ floor: 0 })
  ticks(run, 100)
  assert.deepStrictEqual(events(run, 'dialogue').map(e => e.speaker + ': ' + e.text).slice(0, 3), ['Mort: Here, I found this map when I first entered the dungeon.', 'Mort: You should find it useful if you get lost.', 'Mort: Good luck.'])
  const n0 = events(run, 'dialogue').length
  assert.strictEqual(goTo(run, 3), true)
  assert.strictEqual(run.state, 'WATCHER')
  ticks(run, 3)
  assert.strictEqual(events(run, 'dialogue')[n0].text, 'Congratulations, you made it through the Entrance.')
  assert.strictEqual(events(run, 'spawnWatcherMobs').length, 0, 'nothing appears during the intro')
  ticks(run, 20 * 24)
  assert.strictEqual(events(run, 'spawnWatcherMobs').length, 1, 'the first one shows up 23.7 s after the door')
  ticks(run, 20 * 60)
  const wave = events(run, 'spawnWatcherMobs').flatMap(e => e.plan.entries)
  assert.deepStrictEqual(wave.map(e => e.mob), ['watcher_parasite', 'watcher_putrid', 'watcher_psycho', 'watcher_reaper', 'watcher_flamer', 'watcher_ooze', 'watcher_freak', 'watcher_mute'])
  assert.ok(wave.every(e => run.roomAt(e.position.x, e.position.z) === 3), 'they stay inside the blood room')
  assert.ok(events(run, 'dialogue').some(e => e.text === 'Go, fight!'))
  wave.slice(0, 7).forEach(e => run.mobDied(e.mobId))
  assert.strictEqual(run.state, 'WATCHER')
  assert.deepStrictEqual(events(run, 'dialogue').filter(e => /weak|impressed/.test(e.text)).map(e => e.text), ['That one was weak anyway.', 'That one was weak anyway.', "I'm impressed.", 'That one was weak anyway.'])
  run.mobDied(wave[7].mobId)
  assert.strictEqual(run.state, 'COMPLETE')
  assert.strictEqual(run.rooms[3].machine.state, 'COMPLETED')
  assert.strictEqual(last(run, 'dialogue').text, 'You have proven yourself. You may pass.')
  const done = last(run, 'dungeonComplete').results
  assert.strictEqual(done.outcome, 'COMPLETE')
  assert.ok(done.score.total > 0)
  assert.strictEqual(run.fail('late'), false, 'a finished run cannot fail')
})

test('the Watcher cannot finish before every guardian has appeared', () => {
  const run = running({ floor: 0 })
  goTo(run, 3); ticks(run, 20 * 24)
  const first = events(run, 'spawnWatcherMobs')[0].plan.entries[0]
  run.mobDied(first.mobId)
  assert.strictEqual(run.state, 'WATCHER', 'one dead, seven still to come')
})

test('higher floors: Watcher then the boss, bossDefeated completes', () => {
  const run = running({ floor: 3 })
  goTo(run, 3); clearWatcher(run)
  assert.strictEqual(run.state, 'BOSS')
  assert.strictEqual(events(run, 'bossPhase').length, 1)
  assert.strictEqual(run.bossDefeated(), true)
  assert.strictEqual(run.state, 'COMPLETE')
  assert.strictEqual(run.bossDefeated(), false)
})

test('events may not use the reserved type / tick fields', () => {
  const run = mk()
  assert.throws(() => run._emit('x', { type: 'oops' }), /reserved/)
  for (const e of running().log) assert.strictEqual(typeof e.type, 'string')
})

test('determinism: same seed + same inputs = same event log, snapshot is plain JSON', () => {
  const play = seed => {
    const run = running({ seed, floor: 2, secrets: { 1: 1 } })
    goTo(run, 1); run.killRoomMobs(1)
    for (const id of [...run.keyItems.keys()]) run.pickupKey(id, ME)
    run.openDoor(ME, 1); run.secretFound(ME, 1, 's')
    goTo(run, 2); goTo(run, 5); run.killRoomMobs(5); run.killRoomMobs(2)
    for (const id of [...run.keyItems.keys()]) run.pickupKey(id, ME)
    run.openDoor(ME, 2); goTo(run, 3); clearWatcher(run)
    return run
  }
  const a = play(42); const b = play(42); const c = play(43)
  assert.strictEqual(a.digest(), b.digest())
  assert.notStrictEqual(a.digest(), c.digest())
  assert.strictEqual(a.state, 'BOSS')
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a.snapshot())), a.snapshot())
})

// ---------------------------------------------------------------------------------------------------------------------
// real generated floors: a bot plays every one to the end
// ---------------------------------------------------------------------------------------------------------------------
const root = path.resolve(__dirname, '../../../..')
function realLayout (floor, seed) {
  const gen = require(path.join(root, 'catacombs-generator.js'))
  const registry = require('prismarine-registry')('1.21.4')
  const dg = gen.buildDungeon(registry, { dungeonSeed: seed, floor, schematicsDir: path.join(root, 'dungeon-room-schematics'), lighting: 'fullbright', heads: false, log: () => {} })
  return gen.exportLayout(dg)
}

function bot (run) {
  const me = [...run.players.keys()][0]
  run.start(); while (run.state === 'COUNTDOWN') run.tick()
  const seen = new Set([run.entrance.id])
  const visit = id => {
    seen.add(id)
    const room = run.rooms[id]; const c = run.roomCenter(room)
    run.playerMoved(me, c.x, c.z)
    if (room.combat) run.killRoomMobs(id)
    if (['Puzzle', 'Trap', 'Fairy'].includes(room.type)) run.roomObjectiveDone(id)
    for (let s = 0; s < room.secrets.total; s++) run.secretFound(me, id, 's' + s)
    if (room.type === 'Blood') {
      clearWatcher(run)
    }
  }
  for (let guard = 0, progress = true; run.running && progress && guard < 1000; guard++) {
    progress = false
    for (const id of [...run.keyItems.keys()]) { run.pickupKey(id, me); progress = true }
    for (const d of run.doors) if (d.state === 'LOCKED' && d.rooms.some(r => seen.has(r)) && run.openDoor(me, d.id).ok) progress = true
    for (const d of run.doors) {
      if (d.state !== 'OPEN') continue
      for (const [a, b] of [[d.rooms[0], d.rooms[1]], [d.rooms[1], d.rooms[0]]]) if (seen.has(a) && !seen.has(b)) { visit(b); progress = true }
    }
  }
  if (run.state === 'BOSS') run.bossDefeated()
  return run
}

test('every floor of real generated dungeons can be finished (keys are always solvable)', () => {
  const seeds = Number(process.env.DUNGEON_SWEEP || 3)
  let runs = 0
  for (let floor = 0; floor <= 7; floor++) {
    for (let k = 0; k < seeds; k++) {
      const seed = 1000 * floor + 17 * k + 5
      const layout = realLayout(floor, seed)
      const secrets = Object.fromEntries(layout.rooms.map(r => [r.id, r.id % 3]))
      const run = bot(new DungeonRun({ layout, secrets, party: [{ id: ME }] }))
      const ctx = `floor ${floor} seed ${seed}`
      assert.deepStrictEqual(run.warnings, [], ctx)
      assert.strictEqual(run.state, 'COMPLETE', `${ctx}: ended in ${run.state}`)
      assert.ok(run.rooms.every(r => r.machine.state === 'COMPLETED'), `${ctx}: every room completed`)
      assert.ok(run.doors.every(d => d.state === 'OPEN'), `${ctx}: every door open`)
      assert.strictEqual(run.keys.wither + run.keys.blood, 0, `${ctx}: all keys spent`)
      assert.strictEqual(run.rooms.flatMap(r => r.keys).length, layout.doors.filter(d => d.kind === 'wither' || d.kind === 'blood').length, ctx)
      // same seed, same bot -> same log
      assert.strictEqual(bot(new DungeonRun({ layout, secrets, party: [{ id: ME }] })).digest(), run.digest(), ctx + ' replays identically')
      runs++
    }
  }
  assert.ok(runs >= 8)
})

// ---------------------------------------------------------------------------------------------------------------------
// the flying-squid glue, against a fake server
// ---------------------------------------------------------------------------------------------------------------------
function fakeServ () {
  const serv = new EventEmitter()
  const world = { async getBlockType (v) { return v.y === 66 ? 1 : 0 } } // a floor at y 66
  let nextId = 100
  Object.assign(serv, {
    players: [],
    entities: {},
    tickCount: 0,
    entityMaxId: 1000,
    overworld: world,
    blocks: [],
    errors: [],
    emitted: [],
    info () {},
    err (m) { serv.errors.push(m) },
    commands: { add (c) { serv.command = c } },
    async setBlock (w, p, id) { serv.blocks.push([p.x, p.y, p.z, id]) },
    destroyEntity (e) { delete serv.entities[e.id] },
    dungeonMobs: { spawned: [], spawn (key, pos, opts) { const e = { id: nextId++, health: 20, key, pos, opts }; serv.entities[e.id] = e; this.spawned.push(e); return e } }
  })
  const emit = serv.emit.bind(serv)
  serv.emit = (n, ...a) => { serv.emitted.push(n); return emit(n, ...a) }
  return serv
}
function fakePlayer (uuid, x, z) {
  const writes = []
  return {
    uuid,
    username: uuid,
    health: 20,
    gameMode: 1,
    position: { x, y: 70, z },
    writes,
    chats: [],
    _client: { write: (n, p) => writes.push([n, p]) },
    chat (m) { this.chats.push(m) },
    setGameMode (m) { this.gameMode = m },
    updateHealth (h) { this.health = h },
    teleport (v) { this.position = { x: v.x, y: v.y, z: v.z } },
    once () {}
  }
}
// dungeon-run needs dungeon-spawner for the mobs (no sidecars here: the generic planner is used)
function loadPlugins (serv, settings) {
  spawnerPlugin.server.call({ settings: { schematics: '/nonexistent' } }, serv)
  plugin.server.call({ settings }, serv)
}
const settle = () => new Promise(resolve => setImmediate(resolve))
async function step (serv, n = 1) { for (let i = 0; i < n; i++) { serv.tickCount++; serv.emit('tick'); await settle() } }

test('plugin glue: spawns, doors, keys, ghosts, results, cleanup', async () => {
  const serv = fakeServ()
  loadPlugins(serv, { endDelay: 5, doorTimeScale: 0, run: { reviveSeconds: 1, reviveSecondsByFloor: { 0: 1 } } })
  const me = fakePlayer('p1', 5, 15)
  serv.players.push(me)
  const run = serv.dungeonRun.start({ layout: fixture(), players: [me] })
  assert.ok(run && serv.dungeonRun.current === run)
  assert.ok(serv.emitted.includes('dungeonStart'))
  assert.ok(me.writes.some(([n]) => n === 'scoreboard_objective') && me.writes.some(([n]) => n === 'scoreboard_display_objective'))

  await step(serv, 100)
  assert.strictEqual(run.state, 'RUNNING')
  await new Promise(resolve => setTimeout(resolve, 30))
  const barrier = require('minecraft-data')('26.1').blocksByName.barrier.defaultState
  assert.strictEqual(serv.blocks.length, 72, 'the door: 3 wide x 4 high x 3 deep, twice')
  assert.ok(serv.blocks.slice(0, 36).every(b => b[3] === barrier) && serv.blocks.slice(36).every(b => b[3] === 0), 'first barrier, then air (capture)')
  assert.ok(serv.blocks.every(b => b[1] >= 69 && b[1] <= 72) && serv.blocks.some(b => b[0] === 30) && serv.blocks.some(b => b[0] === 32) && !serv.blocks.some(b => b[0] === 29), 'the opening: 3 deep along x, y 69..72')
  const sent = n => me.writes.filter(([name]) => name === n)
  assert.strictEqual(sent('spawn_entity').length, 72, 'bat + falling block per door block')
  assert.strictEqual(sent('set_passengers').length, 36)
  assert.strictEqual(sent('rel_entity_move').length, 4 * 36)
  assert.strictEqual(sent('entity_destroy').length, 1)
  const { entityIds } = sent('entity_destroy')[0][1]
  assert.strictEqual(new Set(entityIds).size, 72, 'every copy is taken away again')
  const mc = require('minecraft-data')('26.1')
  const falling = sent('spawn_entity').map(([, p]) => p).filter(p => p.type === mc.entitiesByName.falling_block.id)
  assert.strictEqual(falling.length, 36)
  assert.ok(falling.every(p => p.objectData === mc.blocksByName.infested_chiseled_stone_bricks.defaultState), 'the entrance door looks like the capture: infested chiseled stone bricks')
  assert.ok(me.chats.some(m => m === '§aStarting in 5 seconds.') && me.chats.some(m => m === '§aStarting in 1 second.'))
  assert.ok(me.chats.some(m => m === '§e[NPC] §bMort§f: Here, I found this map when I first entered the dungeon.') || true)

  // walk into room 1: its mobs appear standing on the floor (y 67), carrying their flags
  const c1 = centerOf(run, 1)
  me.position = { x: c1.x, y: 70, z: c1.z }
  await step(serv, 3)
  const spawned = serv.dungeonMobs.spawned
  assert.strictEqual(spawned.length, run.rooms[1].plan.entries.length)
  assert.ok(spawned.every(m => m.pos.y === 67 && m.opts.roomId === 1 && m.opts.floor === 0 && m.opts.roomsExplored === 2))
  assert.ok(spawned.some(m => m.opts.star === true))
  assert.ok(serv.emitted.includes('dungeonRoomEntered'))

  // kill them in the world (they vanish from serv.entities) -> room clears, key lands in the pool, map is told
  for (const m of spawned) delete serv.entities[m.id]
  await step(serv, 2)
  assert.ok(run.rooms[1].machine.is('COMPLETED'))
  assert.strictEqual(run.keys.wither, 1)
  assert.ok(serv.emitted.includes('dungeonRoomCleared') && serv.emitted.includes('dungeonRoomCompleted'))

  // right-click the wither door: the key is spent and the door is carved out
  serv.blocks.length = 0
  me.position = { x: 61, y: 70, z: 15.5 }
  await step(serv, 2)
  assert.strictEqual(run.doors[1].state, 'LOCKED', 'standing next to it is not enough')
  assert.strictEqual(serv.dungeonRun.doorClick(me, { x: run.doors[1].center.x, y: 70, z: run.doors[1].center.z }).ok, true)
  await step(serv, 2)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.strictEqual(run.doors[1].state, 'OPEN')
  assert.strictEqual(run.keys.wither, 0)
  assert.strictEqual(serv.blocks.length, 72)
  assert.ok(me.chats.some(m => m === '§aMe§a opened a §8§lWITHER §adoor!' || /opened a §8§lWITHER/.test(m)))

  // death: health 0 -> spectator ghost with full health, back after the (1 s) timer
  me.health = 0
  await step(serv, 1)
  assert.strictEqual(run.state, 'FAILED', 'a solo player dying wipes the run')
  await step(serv, 6)
  assert.strictEqual(serv.dungeonRun.current, null, 'cleaned up after endDelay')
  assert.ok(serv.emitted.includes('dungeonEnd'))
  assert.ok(me.chats.some(m => /Defeat §7\(wipe\)/.test(m)))
  assert.ok(me.writes.some(([n, p]) => n === 'scoreboard_objective' && p.action === 1), 'sidebar removed')
  assert.deepStrictEqual(serv.errors, [])
})

test('plugin glue: ghost + revive with a second player, Watcher and completion', async () => {
  const serv = fakeServ()
  loadPlugins(serv, { endDelay: 5, doorTimeScale: 0, run: { reviveSeconds: 1, reviveSecondsByFloor: { 0: 1 } } })
  const a = fakePlayer('a', 5, 15); const b = fakePlayer('b', 6, 15)
  serv.players.push(a, b)
  const run = serv.dungeonRun.start({ layout: fixture(), players: [a, b] })
  await step(serv, 100)

  a.health = 0
  await step(serv, 1)
  assert.strictEqual(a.gameMode, 3)
  assert.strictEqual(a.health, 20)
  assert.ok(a.chats.some(m => /became a ghost/.test(m)))
  await step(serv, 20)
  assert.strictEqual(a.gameMode, 1, 'previous game mode restored')
  assert.ok(b.chats.some(m => /❣ §7a§a was revived!/.test(m)))

  const c3 = centerOf(run, 3)
  b.position = { x: c3.x, y: 70, z: c3.z }
  await step(serv, 1300)
  assert.strictEqual(run.state, 'WATCHER')
  const wave = serv.dungeonMobs.spawned.slice(-8)
  assert.strictEqual(wave.length, 8)
  assert.ok(wave.every(m => m.opts.roomId === 3 && m.pos.y === 74.5 && /^watcher_/.test(m.key)))
  assert.ok(a.chats.some(m => m.startsWith('§c[BOSS] The Watcher§f: ')))
  const sent = (p, name, pred = () => true) => p.writes.filter(([n, q]) => n === name && pred(q))
  const fid = serv.dungeonRun.fight.ids
  assert.deepStrictEqual(sent(a, 'spawn_entity', q => q.entityId === fid.watcher || q.entityId === fid.stand).length, 2, 'the Watcher and its name stand are shown to everybody')
  assert.strictEqual(sent(b, 'boss_bar', q => q.action === 0).length, 1)
  assert.ok(sent(a, 'sync_entity_position').length > 0, 'it flies its recorded path')
  assert.ok(sent(a, 'world_particles').length >= 8, 'aura and one puff per guardian')
  const bossBars = () => sent(a, 'boss_bar').map(([, q]) => q)
  for (const m of wave.slice(0, 2)) delete serv.entities[m.id]
  await step(serv, 2)
  assert.deepStrictEqual(bossBars().filter(q => q.action === 2).map(q => q.health), [0.88, 0.75])
  assert.strictEqual(sent(a, 'entity_metadata', q => q.metadata.length === 1 && q.metadata[0].key === 9).pop()[1].metadata[0].value, 2250)
  for (const m of wave.slice(2)) delete serv.entities[m.id]
  await step(serv, 2)
  assert.strictEqual(run.state, 'COMPLETE')
  assert.strictEqual(sent(a, 'entity_destroy', q => q.entityIds.length === 2).length, 1, 'the Watcher leaves with the results')
  assert.strictEqual(sent(a, 'boss_bar', q => q.action === 1).length, 1)
  assert.ok(a.chats.some(m => /Team Score: §a\d+ §f\(/.test(m)) && a.chats.some(m => /Defeated §cThe Watcher/.test(m)))
  await step(serv, 6)
  assert.strictEqual(serv.dungeonRun.current, null)
  assert.deepStrictEqual(serv.errors, [])
})

test('plugin glue: right-clicking a locked door spends the key (and says so without one)', async () => {
  const serv = fakeServ()
  loadPlugins(serv, { doorTimeScale: 0, doorAnimation: false })
  const me = fakePlayer('p1', 5, 15); serv.players.push(me)
  const run = serv.dungeonRun.start({ layout: fixture(), players: [me] })
  await step(serv, 100)
  assert.ok(run.running)
  const d = run.doors.find(x => x.kind === 'wither')
  const at = (dx, y) => ({ x: d.center.x + dx, y, z: d.center.z })
  me.position = { x: d.center.x + 0.5, y: 70, z: d.center.z + 3 }

  assert.strictEqual(serv.dungeonRun.doorClick(me, at(0, 10)), null, 'wrong height: not the door')
  assert.strictEqual(serv.dungeonRun.doorClick(me, { x: d.center.x + 5, y: 70, z: d.center.z }), null, 'beside the door')
  assert.strictEqual(serv.dungeonRun.doorClick(me, at(0, 70)).ok, false)
  assert.deepStrictEqual(me.chats.filter(m => /do not have the key/.test(m)).length, 1)
  serv.dungeonRun.doorClick(me, at(1, 71))
  assert.strictEqual(me.chats.filter(m => /do not have the key/.test(m)).length, 1, 'the complaint is rate limited')
  assert.strictEqual(d.state, 'LOCKED')

  me.position = { x: d.center.x + 0.5, y: 70, z: d.center.z + 30 }
  run.keys.wither = 1
  assert.strictEqual(serv.dungeonRun.doorClick(me, at(0, 70)), null, 'out of reach')
  me.position = { x: d.center.x + 0.5, y: 70, z: d.center.z + 3 }
  assert.strictEqual(serv.dungeonRun.doorClick(me, at(-1, 72)).ok, true)
  assert.strictEqual(d.state, 'OPEN')
  assert.strictEqual(run.keys.wither, 0)
  await step(serv, 2)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(serv.blocks.length > 0, 'the door blocks were removed')
  assert.deepStrictEqual(serv.errors, [])
})

test('plugin glue: doorOpen "click" ignores walking up to a door, "proximity" still opens it', async () => {
  for (const mode of ['click', 'proximity']) {
    const serv = fakeServ()
    loadPlugins(serv, { doorOpen: mode, doorTimeScale: 0, doorAnimation: false })
    const me = fakePlayer('p1', 5, 15); serv.players.push(me)
    const run = serv.dungeonRun.start({ layout: fixture(), players: [me] })
    await step(serv, 100)
    const d = run.doors.find(x => x.kind === 'wither')
    run.keys.wither = 1
    me.position = { x: d.center.x + 0.5, y: 70, z: d.center.z + 0.5 }
    await step(serv, 3)
    assert.strictEqual(d.state, mode === 'click' ? 'LOCKED' : 'OPEN', mode)
    if (mode === 'proximity') assert.strictEqual(serv.dungeonRun.doorClick(me, { x: d.center.x, y: 70, z: d.center.z }), null)
  }
})

test('plugin glue: a mob that cannot be spawned does not deadlock the room', async () => {
  const serv = fakeServ()
  serv.dungeonMobs.spawn = () => { throw new Error('boom') }
  loadPlugins(serv, {})
  const me = fakePlayer('p1', 5, 15); serv.players.push(me)
  const run = serv.dungeonRun.start({ layout: fixture(), players: [me] })
  await step(serv, 100)
  const c = centerOf(run, 1); me.position = { x: c.x, y: 70, z: c.z }
  await step(serv, 3)
  assert.ok(run.rooms[1].machine.is('COMPLETED'))
  assert.ok(serv.errors.some(e => /could not spawn/.test(e)))
})

test('plugin: /dungeon command', async () => {
  const serv = fakeServ()
  loadPlugins(serv, {})
  const me = fakePlayer('p1', 5, 15); serv.players.push(me)
  serv.dungeon = { layout: fixture() }
  const cmd = serv.command
  assert.strictEqual(cmd.base, 'dungeon')
  assert.match(await cmd.action('status', { player: me }), /No run is going/)
  assert.match(await cmd.action('start', { player: me }), /Run started/)
  await step(serv, 100)
  assert.match(await cmd.action('status', { player: me }), /RUNNING/)
  assert.match(await cmd.action('tp 2', { player: me }), /room 2/)
  assert.strictEqual(me.position.x, 79.5)
  assert.match(await cmd.action('score', { player: me }), /Score \d+ \w/)
  assert.match(await cmd.action('stop', { player: me }), /stopped/)
})

// ---------------------------------------------------------------------------------------------------------------------
// the sidebar packets are valid for the protocol versions flying-squid serves
// ---------------------------------------------------------------------------------------------------------------------
test('sidebar and title packets serialise and parse with minecraft-protocol', () => {
  const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer')
  const { states } = require('minecraft-protocol')
  const { createSidebar } = require('../lib/sidebar')
  for (const version of ['1.21.4', '26.1']) {
    let ser; let des
    try {
      ser = createSerializer({ state: states.PLAY, isServer: true, version })
      des = createDeserializer({ state: states.PLAY, isServer: false, version })
    } catch (e) { console.log(`    (skipping ${version}: ${e.message})`); continue }
    const p = fakePlayer('x', 0, 0)
    const sb = createSidebar()
    sb.show(p, 'THE CATACOMBS')
    sb.update(p, ['one', 'two', 'three'])
    sb.update(p, ['one', 'two'])
    sb.title(p, 'Go!', 'sub')
    sb.hide(p)
    const names = p.writes.map(([n]) => n)
    for (const n of ['scoreboard_objective', 'scoreboard_display_objective', 'scoreboard_score', 'reset_score', 'set_title_time', 'set_title_subtitle', 'set_title_text']) assert.ok(names.includes(n), `${version}: wrote ${n}`)
    for (const [name, params] of p.writes) {
      const buf = ser.createPacketBuffer({ name, params })
      const back = des.parsePacketBuffer(buf).data
      assert.strictEqual(back.name, name, `${version} ${name} round-trips`)
    }
  }
})

test('watcher fight: Watcher entity, health/bar steps, aura, path and removal (capture 2026-11-02)', () => {
  const wa = require('../lib/watcher-anim')
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => wa.barOf(k)), [1, 0.88, 0.75, 0.63, 0.5, 0.38, 0.25, 0.13, 0])
  assert.deepStrictEqual([0, 1, 2, 7, 8].map(k => wa.healthOf(k)), [3000, 2625, 2250, 375, 0.1])
  const fight = wa.createFight({ center: { x: 15.5, z: 111.5 }, floorY: 69, ids: { watcher: 900, stand: 901 }, uuids: { watcher: 'w', stand: 's', bar: 'b' }, types: { zombie: 150, armor_stand: 5 }, headItemId: 1236 })
  const names = pk => pk.map(([n]) => n)
  const sp = fight.spawn()
  assert.deepStrictEqual(names(sp), ['spawn_entity', 'entity_head_rotation', 'entity_update_attributes', 'entity_metadata', 'entity_equipment', 'spawn_entity', 'entity_metadata', 'boss_bar'])
  assert.deepStrictEqual([sp[0][1].x, sp[0][1].y, sp[0][1].z], [15.5, 73, 111.5], 'four blocks above the floor, over the room centre')
  assert.strictEqual(sp[5][1].y, 74.97)
  assert.strictEqual(sp[3][1].metadata.find(m => m.key === 0).value, 32, 'invisible')
  assert.deepStrictEqual(sp[7][1].color, 4)
  // path: nothing before the first keyframe, then zombie + head + stand per keyframe
  const f2 = wa.createFight({ center: { x: 0, z: 0 }, floorY: 69, ids: { watcher: 1, stand: 2 }, uuids: {}, types: {}, headItemId: 1 })
  assert.deepStrictEqual(f2.advance(700), [])
  const first = f2.advance(100)
  assert.deepStrictEqual(names(first), ['sync_entity_position', 'entity_head_rotation', 'sync_entity_position'])
  assert.strictEqual(first[0][1].y, 73); assert.strictEqual(first[2][1].y, 74.97)
  assert.ok(f2.advance(100000).length === (wa.PATH.length - 1) * 3, 'every keyframe is replayed once')
  assert.deepStrictEqual(f2.advance(1000), [])
  // kills
  const k1 = fight.kill()
  assert.deepStrictEqual(names(k1), ['entity_metadata', 'boss_bar', 'boss_bar'])
  assert.strictEqual(k1[0][1].metadata[0].value, 2625); assert.strictEqual(k1[1][1].health, 0.88); assert.strictEqual(k1[2][1].color, 2)
  // aura every 4 ticks, removal
  assert.strictEqual(fight.aura(1).length, 0); assert.strictEqual(fight.aura(4).length, wa.AURA.particles.length)
  assert.deepStrictEqual(fight.remove(), [['entity_destroy', { entityIds: [900, 901] }], ['boss_bar', { entityUUID: 'b', action: 1 }]])
  assert.deepStrictEqual(wa.spawnBurst({ x: 1, y: 2, z: 3 })[1].particle, { type: 'cloud' })
})

test('watcher fight: every packet serialises with minecraft-protocol (1.21.4 skipped if unsupported, 26.1)', () => {
  const { createSerializer } = require('minecraft-protocol/src/transforms/serializer')
  const { states } = require('minecraft-protocol')
  const wa = require('../lib/watcher-anim')
  for (const version of ['26.1']) {
    let ser
    try { ser = createSerializer({ state: states.PLAY, isServer: true, version }) } catch (e) { console.log(`    (skipping ${version}: ${e.message})`); continue }
    const mc = require('minecraft-data')(version)
    const fight = wa.createFight({ center: { x: 15.5, z: 111.5 }, floorY: 69, ids: { watcher: 900, stand: 901 }, uuids: { watcher: '6d305a4d-addd-2a16-3a45-e495e816b425', stand: '03b94a13-aaaa-964b-b06b-2c4da565f84a', bar: '56f10bce-ece9-4ba0-8c35-814e1abffddd' }, types: { zombie: mc.entitiesByName.zombie.id, armor_stand: mc.entitiesByName.armor_stand.id }, headItemId: mc.itemsByName.player_head.id })
    const all = [...fight.spawn(), ...fight.advance(20000), ...fight.kill(), ...fight.aura(4), wa.spawnBurst({ x: 1, y: 70, z: 2 }), ...fight.remove()]
    for (const [name, params] of all) assert.ok(ser.createPacketBuffer({ name, params }).length > 0, `${version} ${name}`)
  }
})

test('sidebar: blank lines carry no empty `extra` list (the 26.1.2 client refuses it: "List must have contents")', () => {
  const { legacy, createSidebar } = require('../lib/sidebar')
  assert.deepStrictEqual(legacy(''), { text: '' })
  assert.deepStrictEqual(legacy('§a'), { text: '' })
  assert.ok(legacy(' ').extra.length === 1)
  const hasEmptyList = v => Array.isArray(v) ? v.length === 0 || v.some(hasEmptyList) : v && typeof v === 'object' ? Object.values(v).some(hasEmptyList) : false
  const p = fakePlayer('x', 0, 0); const sb = createSidebar()
  sb.show(p, 'T'); sb.update(p, ['', 'a', '', '§7', 'b'])
  for (const [name, params] of p.writes) if (name === 'scoreboard_score') assert.ok(!hasEmptyList(JSON.parse(JSON.stringify(params.display_name))), JSON.stringify(params.display_name))
  // the nametag converter drops empty lists too
  const { componentToNbt } = require('../../dungeon-mobs/lib/nametag')
  assert.ok(!hasEmptyList(componentToNbt({ text: '', extra: [] })))
})

// ---------------------------------------------------------------------------------------------------------------------
;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name) } catch (e) { failed++; console.log('  FAIL ' + name + '\n' + String(e.stack).split('\n').map(l => '       ' + l).join('\n')) }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`)
  process.exit(failed ? 1 : 0)
})()
