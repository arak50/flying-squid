'use strict'
/**
 * DungeonRun: the rules of one Catacombs run. Pure logic, no flying-squid, no clock, no Math.random.
 *
 * The caller (the plugin, a test, a replay tool) feeds it INPUTS, advances time with tick() (20 per second), and reads
 * EFFECTS back as events. The same layout + seed + the same sequence of inputs always produces the same event log,
 * which is what `digest()` hashes.
 *
 *   inputs   start() tick() playerMoved() mobDied() pickupKey() openDoor() secretFound() roomObjectiveDone() puzzleFailed()
 *            playerDied() revive() playerLeft() playerRejoined() bossDefeated() fail()
 *   effects  countdown go roomEntered spawnMobs mobDied roomCleared roomCompleted keyDropped keyPickedUp doorOpened
 *            secretFound watcherStarted dialogue spawnWatcherMobs bossPhase playerDied playerRevived
 *            dungeonComplete dungeonFailed            (listen to one with run.on(type, fn), to all with run.on('*', fn))
 *
 * State machines (lib/fsm.js):
 *   dungeon  LOBBY -> COUNTDOWN -> RUNNING -> WATCHER -> (BOSS ->) COMPLETE        FAILED from any live state
 *   room     UNENTERED -> ENTERED -> CLEARED -> COMPLETED      (cleared = objective done, completed = cleared + all secrets)
 *   player   ALIVE <-> GHOST,  LEFT -> GHOST on rejoin
 *   watcher  INACTIVE -> INTRO -> FIGHT -> DONE
 *
 * `layout` is catacombs-generator.exportLayout(): rooms[{id,type,cells,template}], doors[{rooms,kind,axis,center}],
 * cellPitch, roomSize, spawn, seed, floor.
 */
const { EventEmitter } = require('events')
const crypto = require('crypto')
const { Machine } = require('./fsm')
const { derive } = require('./rng')
const { resolve } = require('./config')
const scoring = require('./score')
const { planRoom } = require('../../dungeon-spawner/lib/plan')

const DUNGEON = {
  LOBBY: { start: 'COUNTDOWN', fail: 'FAILED' },
  COUNTDOWN: { go: 'RUNNING', fail: 'FAILED' },
  RUNNING: { watcherStart: 'WATCHER', fail: 'FAILED' },
  WATCHER: { bossStart: 'BOSS', complete: 'COMPLETE', fail: 'FAILED' },
  BOSS: { complete: 'COMPLETE', fail: 'FAILED' },
  COMPLETE: {},
  FAILED: {}
}
const ROOM = { UNENTERED: { enter: 'ENTERED' }, ENTERED: { clear: 'CLEARED' }, CLEARED: { complete: 'COMPLETED' }, COMPLETED: {} }
const PLAYER = { ALIVE: { die: 'GHOST', leave: 'LEFT' }, GHOST: { revive: 'ALIVE', leave: 'LEFT' }, LEFT: { rejoin: 'GHOST' } }
const WATCHER = { INACTIVE: { start: 'INTRO' }, INTRO: { spawn: 'FIGHT' }, FIGHT: { done: 'DONE' }, DONE: {} }

const COMBAT = new Set(['Normal', 'Boss']) // rooms with a mob plan ("Boss" is the yellow miniboss room)
const OBJECTIVE = new Set(['Puzzle', 'Trap', 'Fairy']) // rooms cleared by roomObjectiveDone()
const round2 = v => Math.round(v * 100) / 100

class DungeonRun extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.layout   exportLayout() result
   * @param {number} [o.seed]   run seed (default layout.seed)
   * @param {number} [o.floor]  0 = Entrance .. 7 (default layout.floor)
   * @param {boolean} [o.master]
   * @param {Array<{id:string,name?:string,class?:string}>} o.party
   * @param {object} [o.config] overrides for lib/config.js
   * @param {object} [o.secrets] { roomId: totalSecrets }
   */
  constructor (o) {
    super()
    if (!o || !o.layout) throw new Error('DungeonRun needs a layout (catacombs-generator.exportLayout())')
    this.layout = o.layout
    this.mobPlanner = o.mobPlanner || planRoom // ctx -> plan; dungeon-spawner's plannerFor(layout) adds the room sidecars
    this.seed = (o.seed ?? o.layout.seed ?? 0) | 0
    this.floor = o.floor ?? o.layout.floor ?? 0
    this.master = !!o.master
    this.cfg = resolve(o.config)
    this.P = o.layout.cellPitch || 32
    this.S = o.layout.roomSize || 31
    this.warnings = []
    this.log = []
    this.now = 0 // ticks since creation
    this.elapsed = 0 // ticks the run has actually been going (RUNNING onwards)
    this.countdownLeft = 0
    this._seq = 0
    this._due = []

    this.dungeon = new Machine('dungeon', DUNGEON, 'LOBBY', (from, event, to) => this._emit('state', { machine: 'dungeon', from, event, to }))
    this.watcher = { machine: new Machine('watcher', WATCHER, 'INACTIVE', (from, event, to) => this._emit('state', { machine: 'watcher', from, event, to })), mobs: new Map() }
    this.failReason = null

    // rooms
    this.rooms = o.layout.rooms.map(r => ({
      id: r.id,
      type: r.type,
      shape: r.shape,
      template: r.template,
      cells: r.cells,
      combat: COMBAT.has(r.type),
      machine: new Machine(`room ${r.id}`, ROOM, 'UNENTERED', (from, event, to) => this._emit('state', { machine: `room ${r.id}`, from, event, to })),
      mobs: new Map(), // mobId -> { mob, required, alive, ... }
      plan: null,
      secrets: { total: (o.secrets && o.secrets[r.id]) || 0, found: new Set() },
      keys: [] // 'wither' | 'blood' dropped when this room is cleared
    }))
    this.cellIndex = new Map()
    for (const r of this.rooms) for (const c of r.cells) this.cellIndex.set(`${c.x},${c.z}`, r.id)
    this.entrance = this.rooms.find(r => r.type === 'Entrance')
    this.bloodRoom = this.rooms.find(r => r.type === 'Blood')
    if (!this.entrance || !this.bloodRoom) throw new Error('layout has no Entrance or Blood room')

    // doors: normal doors are open from the start, entrance doors open at "go", wither / blood doors need a key
    this.doors = o.layout.doors.map((d, id) => ({
      id, rooms: d.rooms, kind: d.kind, axis: d.axis, center: d.center, state: d.kind === 'normal' ? 'OPEN' : 'LOCKED'
    }))

    // keys
    this.keys = { wither: 0, blood: 0 } // the party's pool
    this.keyItems = new Map() // dropped, not picked up yet: itemId -> { id, type, roomId }
    this._keyId = 0
    this._assignKeys()

    // players
    this.players = new Map()
    for (const p of o.party || []) {
      this.players.set(String(p.id), {
        id: String(p.id),
        name: p.name || String(p.id),
        class: p.class || null,
        rank: p.rank || '', // '', 'VIP', 'VIP+', 'MVP', 'MVP+' : the colour of the name in the sidebar
        level: p.level ?? 0, // class level, shown in the pre-start sidebar
        spiritPet: !!p.spiritPet, // legendary Spirit pet: the first death costs 1 point less
        health: 0, // current / max, pushed by the plugin (setHealth) for the sidebar
        maxHealth: 0,
        machine: new Machine(`player ${p.id}`, PLAYER, 'ALIVE', (from, event, to) => this._emit('state', { machine: `player ${p.id}`, from, event, to })),
        room: null,
        reviveAt: null,
        deaths: 0
      })
    }
    if (!this.players.size) throw new Error('DungeonRun needs at least one party member')

    // counters
    this.exploredCells = 0
    this.secretsFound = 0
    this.puzzlesFailed = 0
    this.cryptsCleared = 0
    this.mimicsKilled = 0
    this.perks = { ezpz: !!(o.perks && o.perks.ezpz), prince: !!(o.perks && o.perks.prince), bat: !!(o.perks && (o.perks.bat || o.perks.murkbat)) }
    this.firstDeath = null // id of the first player to die (Spirit pet rule)
    this.mobIndex = new Map() // mobId -> room or 'watcher'
  }

  // ====================================================================================================
  // events
  // ====================================================================================================
  _emit (type, data = {}) {
    if ('type' in data || 'tick' in data) throw new Error(`event ${type}: payload may not use the reserved fields type / tick`)
    const entry = { tick: this.now, type, ...data }
    this.log.push(entry)
    super.emit(type, entry)
    super.emit('*', entry)
    return entry
  }

  /** Hash of the whole event log: two runs with equal digests behaved identically. */
  digest () { return crypto.createHash('sha1').update(JSON.stringify(this.log)).digest('hex') }

  _schedule (afterTicks, fn) { this._due.push({ at: this.now + Math.max(0, afterTicks), seq: this._seq++, fn }) }

  // ====================================================================================================
  // geometry helpers
  // ====================================================================================================
  /** Room id at a world position, or undefined (outside the dungeon or in the gap where the doors are). */
  roomAt (x, z) {
    const cx = Math.floor(x / this.P); const cz = Math.floor(z / this.P)
    if (x - cx * this.P >= this.S || z - cz * this.P >= this.S) return undefined
    return this.cellIndex.get(`${cx},${cz}`)
  }

  roomCenter (room) {
    const c = room.cells[0]; const mid = (this.S - 1) / 2
    return { x: c.x * this.P + mid + 0.5, z: c.z * this.P + mid + 0.5 }
  }

  /** Locked doors that need a key, within `dist` blocks (x/z only) of a point. */
  doorsNear (x, z, dist = 3) {
    return this.doors.filter(d => d.state === 'LOCKED' && (d.kind === 'wither' || d.kind === 'blood') &&
      Math.hypot(d.center.x + 0.5 - x, d.center.z + 0.5 - z) <= dist)
  }

  /** The locked wither / blood door whose 3x3 footprint contains the block column (bx, bz), or null (used for right-clicks). */
  doorAt (bx, bz) {
    return this.doors.find(d => d.state === 'LOCKED' && (d.kind === 'wither' || d.kind === 'blood') &&
      Math.abs(d.center.x - bx) <= 1 && Math.abs(d.center.z - bz) <= 1) || null
  }

  // ====================================================================================================
  // key rooms: which cleared rooms hold the Wither Keys and the Blood Key
  // ====================================================================================================
  // The layout export has no key information, so it is decided per seed. A random assignment is only accepted if the
  // floor can actually be finished with it (simulated below); otherwise the next attempt is drawn.
  _assignKeys () {
    const wanted = [
      ...this.doors.filter(d => d.kind === 'wither').map(() => 'wither'),
      ...this.doors.filter(d => d.kind === 'blood').map(() => 'blood')
    ]
    const eligible = this.rooms.filter(r => r.combat).map(r => r.id)
    const apply = assign => { for (const r of this.rooms) r.keys = assign.get(r.id) || [] }

    if (this.cfg.keyRooms) { // pinned by the caller
      const assign = new Map(Object.entries(this.cfg.keyRooms).map(([id, list]) => [Number(id), list.slice()]))
      apply(assign)
      if (!this._solvable(assign)) this.warnings.push('keyRooms: the pinned key placement cannot finish the floor')
      return
    }
    if (!wanted.length) return
    if (!eligible.length) { this.warnings.push('keys: no combat room can hold a key'); return }

    const built = this._placeKeys(derive(this.seed, 'keys'))
    if (built && this._solvable(built)) { apply(built); return }
    // last resort: everything in the combat room closest to the entrance
    const first = this._doorDistanceOrder().find(id => eligible.includes(id))
    this.warnings.push('keys: no placement could be built, all keys are in room ' + first)
    apply(new Map([[first, wanted.slice()]]))
  }

  // Walk the floor the way a party would. Whenever the next locked door needs a key the party does not hold yet, put that key in
  // a random room that is already reachable, so the floor can always be finished and the keys still end up spread out.
  // Rooms are preferred in this order: unused combat room, any combat room, unused puzzle / trap / fairy room, any of those.
  _placeKeys (rng) {
    const open = new Set(this.doors.filter(d => d.kind === 'normal' || d.kind === 'entrance').map(d => d.id))
    const reach = new Set([this.entrance.id])
    const assign = new Map(); const holding = { wither: 0, blood: 0 }
    const expand = () => {
      for (let grew = true; grew;) {
        grew = false
        for (const d of this.doors) {
          if (!open.has(d.id)) continue
          const [a, b] = d.rooms
          if (reach.has(a) !== reach.has(b)) { reach.add(a); reach.add(b); grew = true }
        }
      }
    }
    const tiers = [r => r.combat, r => OBJECTIVE.has(r.type)]
    expand()
    for (let guard = 0; guard < 10000 && this.rooms.some(r => !reach.has(r.id)); guard++) {
      const door = this.doors.find(d => !open.has(d.id) && (reach.has(d.rooms[0]) || reach.has(d.rooms[1])))
      if (!door || (door.kind !== 'wither' && door.kind !== 'blood')) return null
      if (holding[door.kind] > 0) { holding[door.kind]--; open.add(door.id); expand(); continue }
      let pick = null
      for (const isTier of tiers) {
        const rooms = [...reach].sort((a, b) => a - b).filter(id => isTier(this.rooms[id]))
        const unused = rooms.filter(id => !assign.has(id))
        const pool = unused.length ? unused : rooms
        if (pool.length) { pick = rng.pick(pool); break }
      }
      if (pick === null) return null
      assign.set(pick, [...(assign.get(pick) || []), door.kind])
      holding[door.kind]++
    }
    return assign
  }

  _doorDistanceOrder () { // rooms by number of doors from the entrance, every door treated as passable
    const seen = [this.entrance.id]
    for (let i = 0; i < seen.length; i++) {
      for (const d of this.doors) {
        const [a, b] = d.rooms
        const other = a === seen[i] ? b : b === seen[i] ? a : null
        if (other !== null && !seen.includes(other)) seen.push(other)
      }
    }
    return seen
  }

  _solvable (assign) {
    const open = new Set(this.doors.filter(d => d.kind === 'normal' || d.kind === 'entrance').map(d => d.id))
    const reach = new Set([this.entrance.id]); const taken = new Set()
    let wither = 0; let blood = 0; let changed = true
    while (changed) {
      changed = false
      for (let grew = true; grew;) {
        grew = false
        for (const d of this.doors) {
          if (!open.has(d.id)) continue
          const [a, b] = d.rooms
          if (reach.has(a) !== reach.has(b)) { reach.add(a); reach.add(b); grew = true }
        }
      }
      for (const id of reach) {
        if (taken.has(id)) continue
        taken.add(id); changed = true
        for (const t of assign.get(id) || []) { if (t === 'wither') wither++; else blood++ }
      }
      for (const d of this.doors) {
        if (open.has(d.id) || !(reach.has(d.rooms[0]) || reach.has(d.rooms[1]))) continue
        if (d.kind === 'wither' && wither > 0) { wither--; open.add(d.id); changed = true } else if (d.kind === 'blood' && blood > 0) { blood--; open.add(d.id); changed = true }
      }
    }
    return this.rooms.every(r => reach.has(r.id))
  }

  // ====================================================================================================
  // lifecycle
  // ====================================================================================================
  /** LOBBY -> COUNTDOWN. */
  start () {
    if (!this.dungeon.fire('start')) return false
    this.countdownLeft = this.cfg.countdownSeconds * this.cfg.tps
    this._emit('countdownStarted', { seconds: this.cfg.countdownSeconds })
    if (this.countdownLeft === 0) this._go()
    return true
  }

  _go () {
    if (!this.dungeon.fire('go')) return
    this._emit('go', {})
    for (const [at, text] of this.cfg.mort) this._schedule(Math.round(at * this.cfg.tps), () => this._emit('dialogue', { speaker: 'Mort', npc: true, text }))
    for (const d of this.doors) if (d.kind === 'entrance') this._unlock(d, null, 'start')
    // the entrance is where everybody stands: entered, cleared and complete from the first tick
    this._enter(this.entrance, null)
    this._clearRoom(this.entrance, 'start')
  }

  /** Advance one tick (1/20 s). */
  tick () {
    this.now++
    const { tps } = this.cfg
    if (this.dungeon.is('COUNTDOWN')) {
      this.countdownLeft--
      if (this.countdownLeft > 0 && this.countdownLeft % tps === 0) this._emit('countdown', { seconds: this.countdownLeft / tps })
      if (this.countdownLeft <= 0) this._go()
      return
    }
    if (!this.dungeon.is('RUNNING', 'WATCHER', 'BOSS')) return
    this.elapsed++

    for (const p of this.players.values()) {
      if (p.machine.is('GHOST') && p.reviveAt !== null && this.now >= p.reviveAt) this.revive(p.id, { cause: 'timer' })
    }
    this._due.sort((a, b) => a.at - b.at || a.seq - b.seq)
    while (this._due.length && this._due[0].at <= this.now) this._due.shift().fn()

    const limit = this.cfg.timeLimitSeconds
    if (limit && this.elapsed >= limit * tps) this.fail('timeout')
  }

  get elapsedSeconds () { return Math.floor(this.elapsed / this.cfg.tps) }
  get state () { return this.dungeon.state }
  get running () { return this.dungeon.is('RUNNING', 'WATCHER', 'BOSS') }

  fail (reason = 'failed') {
    if (!this.dungeon.fire('fail')) return false
    this.failReason = reason
    this._emit('dungeonFailed', { reason, results: this.results() })
    return true
  }

  _complete () {
    if (!this.dungeon.fire('complete')) return
    this._emit('dungeonComplete', { results: this.results() })
  }

  // ====================================================================================================
  // players
  // ====================================================================================================
  _player (id) { return this.players.get(String(id)) }
  _alive (id) { const p = this._player(id); return p && p.machine.is('ALIVE') ? p : null }

  /** A player moved: entering a new room starts it. */
  playerMoved (id, x, z) {
    const p = this._alive(id)
    if (!p || !this.running) return false
    const roomId = this.roomAt(x, z)
    if (roomId === undefined || roomId === p.room) return false
    p.room = roomId
    return this._enter(this.rooms[roomId], p.id)
  }

  playerDied (id, info = {}) {
    const p = this._alive(id)
    if (!p || !this.running) return false
    p.machine.fire('die')
    p.deaths++
    if (!this.firstDeath) this.firstDeath = p.id
    p.reviveAt = this.now + this._reviveTicks()
    this._emit('playerDied', { player: p.id, name: p.name, reviveInTicks: p.reviveAt - this.now, ...info })
    this._checkWipe()
    return true
  }

  _reviveTicks () {
    const s = this.cfg.reviveSecondsByFloor[this.floor] ?? this.cfg.reviveSeconds
    return s * this.cfg.tps
  }

  /** Bring a ghost back: cause 'timer' | 'soul' | 'fairy' | 'ability' | anything the caller wants to log. */
  revive (id, info = {}) {
    const p = this._player(id)
    if (!p || !p.machine.fire('revive')) return false
    p.reviveAt = null
    this._emit('playerRevived', { player: p.id, name: p.name, ...info })
    return true
  }

  playerLeft (id) {
    const p = this._player(id)
    if (!p || !p.machine.fire('leave')) return false
    p.reviveAt = null
    this._emit('playerLeft', { player: p.id })
    this._checkWipe()
    return true
  }

  /** A player who left comes back as a ghost (wiki: rejoining returns you as a ghost). */
  playerRejoined (id) {
    const p = this._player(id)
    if (!p || !p.machine.fire('rejoin')) return false
    p.reviveAt = this.now + this._reviveTicks()
    this._emit('playerRejoined', { player: p.id, reviveInTicks: p.reviveAt - this.now })
    return true
  }

  _checkWipe () {
    if (!this.running) return
    const present = [...this.players.values()].filter(p => !p.machine.is('LEFT'))
    if (![...this.players.values()].some(p => p.machine.is('ALIVE'))) this.fail(present.length ? 'wipe' : 'abandoned')
  }

  // ====================================================================================================
  // rooms
  // ====================================================================================================
  _enter (room, byId) {
    if (!room.machine.can('enter')) return false
    if (this.cfg.strictEntry && room !== this.entrance && !this._connectedToEntered(room)) return false
    room.machine.fire('enter')
    this.exploredCells += room.cells.length
    this._emit('roomEntered', { roomId: room.id, roomType: room.type, by: byId, exploredCells: this.exploredCells })
    if (room.type === 'Blood') this._startWatcher()
    else if (room.combat) this._spawnRoom(room)
    return true
  }

  _connectedToEntered (room) {
    return this.doors.some(d => d.state === 'OPEN' && d.rooms.includes(room.id) &&
      d.rooms.some(id => id !== room.id && !this.rooms[id].machine.is('UNENTERED')))
  }

  // ---- mobs --------------------------------------------------------------------------------------------
  _spawnRoom (room) {
    room.plan = this._planRoom(room)
    for (const e of room.plan.entries) { room.mobs.set(e.mobId, { ...e, alive: true }); this.mobIndex.set(e.mobId, room.id) }
    this._emit('spawnMobs', { roomId: room.id, plan: room.plan })
    if (!room.plan.entries.some(e => e.required)) this._clearRoom(room, 'empty')
  }

  _planRoom (room) {
    return this.mobPlanner({
      room,
      layoutRoom: this.layout.rooms[room.id],
      floor: this.floor,
      master: this.master,
      seed: this.seed,
      exploredCells: this.exploredCells,
      cfg: this.cfg,
      P: this.P,
      S: this.S,
      roomCenter: this.roomCenter(room)
    })
  }

  /** A dungeon mob died (mobId from the spawnMobs / spawnWatcherMobs plan). */
  mobDied (mobId, info = {}) {
    const where = this.mobIndex.get(mobId)
    if (where === undefined) return false
    if (where === 'watcher') return this._watcherMobDied(mobId, info)
    const room = this.rooms[where]
    const mob = room.mobs.get(mobId)
    if (!mob || !mob.alive) return false
    mob.alive = false
    this._emit('mobDied', { mobId, roomId: room.id, required: mob.required, ...info })
    this._checkCleared(room)
    return true
  }

  /** Admin / debug: kill everything alive in a room. */
  killRoomMobs (roomId) {
    const room = this.rooms[roomId]
    if (!room) return 0
    let n = 0
    for (const [id, mob] of room.mobs) if (mob.alive && this.mobDied(id, { cause: 'admin' })) n++
    return n
  }

  _checkCleared (room) {
    if (!room.machine.is('ENTERED') || !room.plan) return
    if ([...room.mobs.values()].some(m => m.required && m.alive)) return
    this._clearRoom(room, 'mobs')
  }

  /** Trap / puzzle / fairy room objective reached (puzzle solved, traps survived, fairy dealt with). */
  roomObjectiveDone (roomId) {
    const room = this.rooms[roomId]
    if (!room || !OBJECTIVE.has(room.type) || !this.running) return false
    if (room.machine.is('UNENTERED')) return false
    return this._clearRoom(room, room.type.toLowerCase())
  }

  puzzleFailed (roomId, byId) {
    const room = this.rooms[roomId]
    if (!room || room.type !== 'Puzzle' || !this.running) return false
    this.puzzlesFailed++
    this._emit('puzzleFailed', { roomId, by: byId ?? null, total: this.puzzlesFailed })
    return true
  }

  _clearRoom (room, cause) {
    if (!room.machine.fire('clear')) return false
    this._emit('roomCleared', { roomId: room.id, cause })
    for (const type of room.keys) this._dropKey(room, type)
    this._checkComplete(room)
    return true
  }

  _checkComplete (room) {
    if (!room.machine.is('CLEARED') || room.secrets.found.size < room.secrets.total) return
    room.machine.fire('complete')
    this._emit('roomCompleted', { roomId: room.id })
  }

  // ---- secrets -----------------------------------------------------------------------------------------
  setSecrets (roomId, total) {
    const room = this.rooms[roomId]
    if (!room) return false
    room.secrets.total = total
    this._checkComplete(room)
    return true
  }

  /** A player found secret `secretId` of a room (any stable string / number). Counted once. */
  secretFound (playerId, roomId, secretId) {
    const room = this.rooms[roomId]
    if (!room || !this._alive(playerId) || !this.running) return false
    const key = String(secretId)
    if (room.secrets.found.has(key)) return false
    room.secrets.found.add(key)
    this.secretsFound++
    this._emit('secretFound', { roomId, secretId: key, by: String(playerId), total: this.secretsFound })
    this._checkComplete(room)
    return true
  }

  // ====================================================================================================
  // keys and doors
  // ====================================================================================================
  _dropKey (room, type) {
    const item = { id: `key${this._keyId++}`, keyType: type, roomId: room.id }
    this.keyItems.set(item.id, item)
    const c = this.roomCenter(room)
    this._emit('keyDropped', { ...item, position: { x: round2(c.x), z: round2(c.z) } })
    if (this.cfg.autoPickupKeys) this.pickupKey(item.id, null)
  }

  /** A player picked up a dropped key: it goes into the party pool. */
  pickupKey (itemId, playerId) {
    const item = this.keyItems.get(itemId)
    if (!item) return false
    if (playerId !== null && playerId !== undefined && !this._alive(playerId)) return false
    this.keyItems.delete(itemId)
    this.keys[item.keyType]++
    this._emit('keyPickedUp', { id: item.id, keyType: item.keyType, by: playerId === null ? null : String(playerId), pool: { ...this.keys } })
    return true
  }

  /** Spend a key on a wither / blood door. Returns { ok, reason? }. */
  openDoor (playerId, doorId) {
    const door = this.doors[doorId]
    if (!door) return { ok: false, reason: 'no such door' }
    if (!this.running) return { ok: false, reason: 'the run is not going' }
    if (!this._alive(playerId)) return { ok: false, reason: 'ghosts cannot open doors' }
    if (door.state === 'OPEN') return { ok: false, reason: 'already open' }
    if (door.kind !== 'wither' && door.kind !== 'blood') return { ok: false, reason: 'this door needs no key' }
    if (this.keys[door.kind] < 1) return { ok: false, reason: `you need a ${door.kind === 'wither' ? 'Wither' : 'Blood'} Key` }
    this.keys[door.kind]--
    this._unlock(door, String(playerId), 'key')
    return { ok: true }
  }

  _unlock (door, by, cause) {
    door.state = 'OPEN'
    this._emit('doorOpened', { doorId: door.id, kind: door.kind, rooms: door.rooms, axis: door.axis, center: door.center, by, cause, pool: { ...this.keys } })
  }

  // ====================================================================================================
  // The Watcher and the boss
  // ====================================================================================================
  _startWatcher () {
    if (!this.dungeon.fire('watcherStart')) return
    this.watcher.machine.fire('start')
    this.watcher.spawned = 0
    this.watcher.kills = 0
    this._emit('watcherStarted', {})
    const w = this.cfg.watcher
    const tps = this.cfg.tps
    for (const [at, text] of w.script) this._schedule(Math.round(at * tps), () => this._say(text))
    const count = w.mobsByFloor[this.floor] ?? w.defaultMobs
    this.watcher.total = count
    const rng = derive(this.seed, 'watcher')
    const c = this.roomCenter(this.bloodRoom)
    for (let i = 0; i < count; i++) {
      const at = w.spawnAtSeconds[i] ?? w.spawnAtSeconds[w.spawnAtSeconds.length - 1] + 2 * (i - w.spawnAtSeconds.length + 1)
      const mob = w.pool[i % w.pool.length]
      const pos = { x: round2(c.x + (rng.next() * 2 - 1) * w.spread), z: round2(c.z + (rng.next() * 2 - 1) * w.spread) }
      this._schedule(Math.round(at * tps), () => this._spawnWatcherMob(i, mob, pos))
    }
  }

  _say (text) { this._emit('dialogue', { speaker: 'The Watcher', text }) }

  _spawnWatcherMob (i, mob, position) {
    if (!this.dungeon.is('WATCHER')) return
    this.watcher.machine.fire('spawn') // INTRO -> FIGHT on the first one
    const mobId = `w.${i}`
    this.watcher.mobs.set(mobId, { alive: true })
    this.mobIndex.set(mobId, 'watcher')
    this.watcher.spawned++
    const entries = [{ mobId, mob, required: true, star: false, modifier: null, position }]
    this._emit('spawnWatcherMobs', { roomId: this.bloodRoom.id, plan: { roomId: this.bloodRoom.id, floor: this.floor, master: this.master, roomsExplored: this.exploredCells, entries } })
  }

  _watcherMobDied (mobId, info) {
    const mob = this.watcher.mobs.get(mobId)
    if (!mob || !mob.alive) return false
    mob.alive = false
    this._emit('mobDied', { mobId, roomId: this.bloodRoom.id, required: true, watcher: true, ...info })
    const line = this.cfg.watcher.killLines[this.watcher.kills++]
    if (line) this._say(line)
    if (this.watcher.spawned < this.watcher.total || [...this.watcher.mobs.values()].some(m => m.alive)) return true
    if (!this.watcher.machine.fire('done')) return true
    this._say(this.cfg.watcher.doneLine)
    this._clearRoom(this.bloodRoom, 'watcher')
    if (this.floor === this.cfg.watcher.completesRunOnFloor) this._complete()
    else if (this.dungeon.fire('bossStart')) this._emit('bossPhase', { floor: this.floor, master: this.master })
    return true
  }

  /** The floor boss is dead (the boss fight itself lives outside this module). */
  bossDefeated () {
    if (!this.dungeon.is('BOSS')) return false
    this._complete()
    return true
  }

  // ====================================================================================================
  // score, sidebar, snapshot
  // ====================================================================================================
  get secretsTotal () { return this.rooms.reduce((n, r) => n + r.secrets.total, 0) }
  get roomsCleared () { return this.rooms.filter(r => r.machine.is('CLEARED', 'COMPLETED')).length }
  get roomsCompleted () { return this.rooms.filter(r => r.machine.is('COMPLETED')).length }
  get deaths () { return [...this.players.values()].reduce((n, p) => n + p.deaths, 0) }

  get incompletePuzzles () { return this.rooms.filter(r => r.type === 'Puzzle' && !r.machine.is('CLEARED', 'COMPLETED')).length }
  /** "Secrets Found: 28.6%" as the tab list shows it (one decimal, no trailing .0). */
  get secretsPercent () { return this.secretsTotal ? Math.round(1000 * this.secretsFound / this.secretsTotal) / 10 : 0 }

  /** Team Score (lib/score.js = Skyblocker's DungeonScore). The inputs are the ones Hypixel shows in the tab list / sidebar. */
  score () {
    const first = this.firstDeath && this.players.get(this.firstDeath)
    return scoring.compute({
      floor: this.floor,
      master: this.master,
      totalRooms: this.rooms.length,
      completedRooms: this.roomsCleared,
      secretsPercent: this.secretsPercent,
      incompletePuzzles: this.incompletePuzzles,
      deaths: this.deaths,
      spiritPet: !!(first && first.spiritPet),
      elapsedSeconds: this.elapsedSeconds,
      crypts: this.cryptsCleared,
      mimicKilled: this.mimicsKilled > 0,
      princeKilled: this.perks.prince,
      batKilled: this.perks.bat,
      ezpz: this.perks.ezpz
    }, this.cfg)
  }

  /** The prince / bat bonus kills (+1 each, once). */
  bonusKill (what, by) {
    if (!this.running || !(what in this.perks) || what === 'ezpz' || this.perks[what]) return false
    this.perks[what] = true
    this._emit('bonusKill', { what, by: by ?? null })
    return true
  }

  /** The plugin tells the run a player's health for the sidebar. */
  setHealth (id, health, max) {
    const p = this.players.get(String(id))
    if (!p) return
    p.health = health; p.maxHealth = max ?? p.maxHealth
  }

  /** A crypt was blown up (one call per crypt). */
  cryptCleared (by) {
    if (!this.running) return false
    this.cryptsCleared++
    this._emit('cryptCleared', { by: by ?? null, total: this.cryptsCleared })
    return true
  }

  /** A mimic was killed. */
  mimicDied (by) {
    if (!this.running) return false
    this.mimicsKilled++
    this._emit('mimicKilled', { by: by ?? null, total: this.mimicsKilled })
    return true
  }

  results () {
    return {
      outcome: this.dungeon.state,
      reason: this.failReason,
      floor: this.floor,
      master: this.master,
      elapsedSeconds: this.elapsedSeconds,
      score: this.score(),
      roomsCleared: this.roomsCleared,
      roomsCompleted: this.roomsCompleted,
      roomsTotal: this.rooms.length,
      secretsFound: this.secretsFound,
      secretsTotal: this.secretsTotal,
      deaths: this.deaths,
      puzzlesFailed: this.puzzlesFailed
    }
  }

  /**
   * Sidebar text for one viewer, top to bottom, in the format of the Hypixel capture (legacy § colour codes).
   * The viewer is left out of the party list, like Hypixel does. `ctx` = { date, skyDate, skyTime, server } (all optional).
   */
  scoreboardLines (viewerId, ctx = {}) {
    const L = this.cfg.lines
    const head = [`§7${ctx.date ?? L.date} §8${ctx.server ?? L.server}`, `§f ${ctx.skyDate ?? L.skyDate}`, ` §7${ctx.skyTime ?? L.skyTime}`, ` §7${L.locationGlyph} §cThe Catacombs §7(${scoring.floorKey(this.floor, this.master)})`, '']
    const others = [...this.players.values()].filter(p => p.id !== String(viewerId))
    const mmss = s => s >= 60 ? `${String(Math.floor(s / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s` : `${String(s).padStart(2, '0')}s`
    const rankColor = { '': '§7', VIP: '§a', 'VIP+': '§a', MVP: '§b', 'MVP+': '§b' }
    const letter = p => (p.class ? p.class[0] : 'M').toUpperCase()
    const name = p => (rankColor[p.rank] ?? '§7') + p.name.slice(0, 12)

    if (this.dungeon.is('LOBBY')) return [...head, ...others.map(p => `§a[${letter(p)}] ${name(p)} §7[Lv${p.level}]`), '', '§fWaiting for the party', '', `§e${L.website}`]
    if (this.dungeon.is('COUNTDOWN')) {
      const left = Math.ceil(this.countdownLeft / this.cfg.tps)
      return [...head, ...others.map(p => `§a[${letter(p)}] ${name(p)} §7[Lv${p.level}]`), '', `§fStarting in: §a0:${String(left).padStart(2, '0')}`, '', `§e${L.website}`]
    }
    const total = this.rooms.length
    const pct = total ? Math.round(100 * this.roomsCleared / total) : 0
    const pctColor = pct >= 100 ? '§a' : pct > 0 ? '§6' : '§c' // [capture] 0 % red, 40-67 % gold
    const hp = p => {
      if (!p.machine.is('ALIVE')) return '§cDEAD'
      const f = p.maxHealth ? p.health / p.maxHealth : 1
      return `${f > 0.5 ? '§a' : f > 0.25 ? '§e' : '§c'}${Math.round(p.health).toLocaleString('en-US')}§c❤`
    }
    const key = this.keys.blood > 0 ? '§c■ §a✓' : '§c■ §c✗'
    return [
      ...head,
      `§fKeys: ${key} §8■ §a${this.keys.wither}x`,
      `§fTime Elapsed: §a${mmss(this.elapsedSeconds)}`,
      `§fCleared: ${pctColor}${pct}% §8(${this.score().total})`,
      '',
      ...others.map(p => `§e[${letter(p)}] ${name(p)} ${hp(p)}`),
      '',
      `§e${L.website}`
    ]
  }

  /** Dungeon Stats as the tab list shows them (what Skyblocker reads). */
  tabStats () {
    const mmss = s => s >= 60 ? `${String(Math.floor(s / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s` : `${String(s).padStart(2, '0')}s`
    const opened = this.rooms.filter(r => !r.machine.is('UNENTERED')).length
    const puz = this.rooms.filter(r => r.type === 'Puzzle')
    const mark = r => r.machine.is('CLEARED', 'COMPLETED') ? '§a§l✔' : '§6§l✦'
    return {
      downed: [...this.players.values()].filter(p => !p.machine.is('ALIVE')).map(p => p.name),
      teamDeaths: this.deaths,
      discoveries: this.secretsFound,
      secretsFound: this.secretsFound,
      crypts: this.cryptsCleared,
      openedRooms: opened,
      completedRooms: this.roomsCleared,
      secretsPercent: this.secretsPercent,
      time: mmss(this.elapsedSeconds),
      puzzles: puz.map(r => ({ name: r.name || `Puzzle ${r.id}`, state: mark(r) }))
    }
  }

  snapshot () {
    return {
      state: this.dungeon.state,
      now: this.now,
      elapsed: this.elapsed,
      floor: this.floor,
      seed: this.seed,
      rooms: this.rooms.map(r => ({
        id: r.id,
        type: r.type,
        state: r.machine.state,
        secrets: { total: r.secrets.total, found: r.secrets.found.size },
        aliveRequired: [...r.mobs.values()].filter(m => m.required && m.alive).length,
        keys: r.keys
      })),
      doors: this.doors.map(d => ({ id: d.id, kind: d.kind, state: d.state })),
      keys: { ...this.keys },
      droppedKeys: [...this.keyItems.values()],
      players: [...this.players.values()].map(p => ({ id: p.id, state: p.machine.state, room: p.room, deaths: p.deaths, reviveAt: p.reviveAt })),
      watcher: { state: this.watcher.machine.state, alive: [...this.watcher.mobs.values()].filter(m => m.alive).length },
      score: this.score()
    }
  }
}

module.exports = { DungeonRun, DUNGEON, ROOM, PLAYER, WATCHER }
