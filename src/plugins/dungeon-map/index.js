'use strict'
/**
 * dungeon-map — the Magical Map.
 *
 * When a dungeon starts, every participant's SkyBlock Menu star (nether_star) is swapped for the "Magical Map": a filled map
 * showing the generated floor. It keeps the star's custom_data id (SKYBLOCK_MENU), so skyblock-ui opens the SkyBlock Menu
 * from it exactly as before. The star comes back when the dungeon ends, the player leaves, or the profile is reloaded.
 *
 * The map draws what Hypixel draws (all measured from a protocol capture, see lib/renderer.js):
 *   - rooms you have entered, in their type colour; the neighbours of those are single grey "?" rooms
 *   - a white tick when every mob in the room is dead, a green tick when the room is complete
 *   - arrow icons: green = the player holding the map, blue = the other players (map decorations, rotation = facing)
 *
 * Game state lives in another plugin. This one only listens (all names can be changed in settings.events):
 *
 *   serv.emit('dungeonStart', { layout?, players?, origin? })   layout = catacombs-generator.exportLayout(); default serv.dungeon.layout
 *   serv.emit('dungeonRoomEntered',   { roomId })               room becomes visible/coloured (also detected from positions, see autoEnter)
 *   serv.emit('dungeonRoomCleared',   { roomId })               all mobs killed  -> white tick
 *   serv.emit('dungeonRoomCompleted', { roomId })               room complete    -> green tick
 *   serv.emit('dungeonEnd')
 *
 * Same thing from code:  serv.dungeonMap.start(opts) / enterRoom(id) / clearRoom(id) / completeRoom(id) / end()
 *
 * settings: { mapId: 1024, scale: 2, itemName: '§aMagical Map', markerMs: 250, autoEnter: true, origin: {x:0,z:0}, events: {...} }
 */
const crypto = require('crypto')
const { render, MapGeometry, State, MAP } = require('./lib/renderer')

const EVENTS = { start: 'dungeonStart', end: 'dungeonEnd', entered: 'dungeonRoomEntered', cleared: 'dungeonRoomCleared', completed: 'dungeonRoomCompleted' }
const ICON_SELF = 1 // green arrow ("frame")
const ICON_OTHER = 3 // blue arrow

module.exports.server = function (serv) {
  const cfg = Object.assign({ mapId: 1024, scale: 2, itemName: '§b§oMagical Map', markerMs: 250, autoEnter: true, origin: null }, this.settings || {})
  const ev = Object.assign({}, EVENTS, cfg.events || {})
  const run = { active: false, geo: null, rooms: new Map(), players: new Set(), tick: 0, timer: null, dirty: false, flush: null }
  const sent = new WeakMap() // player -> { pixels: hash, icons: json }

  const log = (m) => serv.info?.(`[dungeon-map] ${m}`)
  const ui = () => serv.skyblock && serv.skyblock.ui

  // ------------------------------------------------------------------ item swap (star <-> Magical Map)
  const isStar = it => { const cd = it && (it.components || []).find(c => c.type === 'custom_data'); return !!(cd && require('prismarine-nbt').simplify(cd.data).id === 'SKYBLOCK_MENU') }
  const mapType = () => serv.registry.itemsByName.filled_map.id

  function buildMap () {
    const u = ui(); if (!u || !u.conv) return null
    const n = { ...u.specs.items.skyblockStar, type: 'filled_map', name: cfg.itemName }
    const item = u.conv.build(n)
    const c = { type: 'map_id', data: cfg.mapId }
    item.components.push(c); if (item.componentMap) item.componentMap.set(c.type, c)
    return item
  }
  const buildStar = () => { const u = ui(); return u && u.conv ? u.conv.build(u.specs.items.skyblockStar) : null }

  function swapTo (player, kind) {
    const profile = player.skyblock && player.skyblock.profile
    if (!profile) return false
    const inv = profile.container('inventory')
    const want = kind === 'map'
    for (let i = 0; i < inv.size; i++) {
      const it = inv.get(i)
      if (!isStar(it)) continue
      const isMap = it.type === mapType()
      if (isMap === want) return true // already right
      const next = want ? buildMap() : buildStar()
      if (!next) return false
      inv.set(i, next, want ? 'magical_map' : 'star')
      return true
    }
    return false
  }

  // ------------------------------------------------------------------ packets
  const iconsFor = (player) => {
    const out = []
    const add = (pl, type) => {
      if (!pl.position) return
      const ic = run.geo.worldToIcon(pl.position.x, pl.position.z); if (!ic) return
      const deg = (((pl.yaw || 0) * 360 / 256) % 360 + 360) % 360
      out.push({ type, x: ic.x, z: ic.y, direction: Math.floor(deg / 22.5 + 0.5) & 15, displayName: undefined })
    }
    for (const pl of run.players) if (pl !== player) add(pl, ICON_OTHER)
    add(player, ICON_SELF) // last = drawn on top
    return out
  }

  function send (player, { pixels, force }) {
    const last = sent.get(player) || {}
    const icons = iconsFor(player)
    const iconsKey = JSON.stringify(icons)
    const hash = pixels ? crypto.createHash('md5').update(pixels).digest('hex') : last.pixels
    const base = { itemDamage: cfg.mapId, scale: cfg.scale, locked: false, icons }
    const c = player._client
    try {
      if (pixels && (force || hash !== last.pixels)) c.write('map', { ...base, columns: MAP, rows: MAP, x: 0, y: 0, data: Buffer.from(pixels) })
      else if (iconsKey !== last.icons) c.write('map', { ...base, columns: 0 }) // marker-only update, as in the capture
      else return
    } catch (e) { serv.err?.(`[dungeon-map] ${e.message}`); return }
    sent.set(player, { pixels: hash, icons: iconsKey })
  }

  const pixelsNow = () => render(run.geo, run.rooms)
  function pushAll ({ pixels = true, force = false } = {}) {
    if (!run.active) return
    const px = pixels ? pixelsNow() : null
    for (const p of run.players) send(p, { pixels: px, force })
  }
  function scheduleFull () { // many events in one tick -> one 16 KB packet per player
    if (run.flush) return
    run.flush = setTimeout(() => { run.flush = null; pushAll() }, 40)
  }

  // ------------------------------------------------------------------ state
  function setState (roomId, state) {
    if (!run.active || !run.geo.rooms.has(roomId)) return false
    const cur = run.rooms.get(roomId) || { state: State.HIDDEN, enteredAt: 0 }
    if (state <= cur.state) return false
    if (cur.state < State.ENTERED && state >= State.ENTERED) cur.enteredAt = ++run.tick
    cur.state = state
    run.rooms.set(roomId, cur)
    scheduleFull()
    return true
  }
  const enterRoom = id => setState(id, State.ENTERED)
  const clearRoom = id => { enterRoom(id); return setState(id, State.CLEARED) } // a room whose mobs are dead has been entered
  const completeRoom = id => { enterRoom(id); return setState(id, State.COMPLETED) }

  function start (opts = {}) {
    if (run.active) end()
    const layout = opts.layout || (serv.dungeon && serv.dungeon.layout)
    if (!layout) { serv.err?.('[dungeon-map] dungeonStart without a layout (pass { layout } or set serv.dungeon.layout)'); return false }
    run.geo = new MapGeometry(layout, { origin: opts.origin || cfg.origin || undefined })
    run.rooms = new Map(); run.tick = 0; run.active = true
    run.players = new Set(opts.players || serv.players)
    // the entrance is where you start
    for (const r of layout.rooms) if (r.type === 'Entrance') enterRoom(r.id)
    for (const p of run.players) attach(p)
    run.timer = setInterval(onMarkerTick, cfg.markerMs); run.timer.unref?.()
    log(`started: ${layout.rooms.length} rooms, ${run.players.size} player(s)`)
    return true
  }

  function attach (p) {
    sent.delete(p)
    const give = () => { swapTo(p, 'map'); pushAll({ force: true }) }
    if (p.skyblock && p.skyblock.profile && ui() && ui().conv) give()
    else p.once('skyblockProfileReady', () => setTimeout(() => { if (run.active && run.players.has(p)) give() }, 50)) // profile still loading
  }

  function end () {
    if (!run.active) return
    run.active = false
    clearInterval(run.timer); clearTimeout(run.flush); run.flush = null
    for (const p of run.players) swapTo(p, 'star')
    run.players.clear()
    log('ended')
  }

  function onMarkerTick () {
    if (!run.active) return
    if (cfg.autoEnter) for (const p of run.players) if (p.position) { const id = run.geo.roomAt(p.position.x, p.position.z); if (id !== undefined) enterRoom(id) }
    for (const p of run.players) send(p, { pixels: null })
  }

  serv.dungeonMap = { start, end, enterRoom, clearRoom, completeRoom, get active () { return run.active }, get geometry () { return run.geo }, state: () => run.rooms, render: pixelsNow }

  const on = (name, fn) => serv.on(name, (arg) => { try { fn(arg || {}) } catch (e) { serv.err?.(`[dungeon-map] ${name}: ${e.stack}`) } })
  on(ev.start, o => start(o))
  on(ev.end, () => end())
  on(ev.entered, o => enterRoom(o.roomId))
  on(ev.cleared, o => clearRoom(o.roomId))
  on(ev.completed, o => completeRoom(o.roomId))

  // manual testing without the state plugin:  /dungeonmap start | end | enter <room> | clear <room> | complete <room> | rooms
  serv.commands?.add({
    base: 'dungeonmap',
    info: 'control the Magical Map by hand (testing)',
    usage: '/dungeonmap <start|end|enter|clear|complete|rooms> [roomId]',
    onlyPlayer: true,
    parse: s => s || '',
    action (arg, ctx) {
      const [cmd, id] = String(arg).trim().split(/\s+/); const say = m => ctx.player.chat(m)
      if (cmd === 'start') { say(start({ players: [ctx.player] }) ? 'Magical Map on.' : 'No layout available (serv.dungeon.layout).'); return }
      if (cmd === 'end') { end(); say('Magical Map off.'); return }
      if (cmd === 'rooms') { if (run.geo) say(run.geo.layout.rooms.map(r => `${r.id}:${r.type}`).join('  ')); return }
      const fn = { enter: enterRoom, clear: clearRoom, complete: completeRoom }[cmd]
      if (!fn) return say('Usage: /dungeonmap <start|end|enter|clear|complete|rooms> [roomId]')
      say(fn(parseInt(id, 10)) ? 'ok' : 'nothing changed (unknown room, not running, or already that state)')
    }
  })

  // players who join / leave while a dungeon is running
  serv.dungeonMap._join = p => { if (run.active) { run.players.add(p); attach(p) } }
  serv.dungeonMap._leave = p => { if (run.active) run.players.delete(p); swapTo(p, 'star') }
  serv.dungeonMap._heal = p => swapTo(p, 'star')
}

module.exports.player = function (player, serv) {
  const dm = () => serv.dungeonMap
  // a Magical Map left in a saved profile (crash, kill) is turned back into the star once the profile loads and no dungeon runs
  player.on('skyblockProfileReady', () => { const d = dm(); if (d && !d.active) setTimeout(() => d._heal && d._heal(player), 0) })
  player.on('spawned', () => dm() && dm()._join(player))
  // restore BEFORE the profile is saved on logout, otherwise the map item (no map_id in the saved neutral form) would be persisted
  player.on('disconnected', () => dm() && dm()._leave(player))
}
