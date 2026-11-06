'use strict'
/**
 * dungeon-run — the backend logic of a Catacombs run, wired into flying-squid.
 *
 * The rules live in lib/run.js (DungeonRun: pure, deterministic, unit-tested). This file is the glue: it feeds the run
 * what happens in the world (players walking, mobs dying, health reaching 0) and turns the run's effect events into
 * entities, blocks, game modes, chat, titles, the sidebar and the Magical Map.
 *
 *   serv.dungeonRun.start({ layout?, seed?, floor?, master?, secrets?, players?, config? })   -> DungeonRun
 *   serv.dungeonRun.current      the running DungeonRun (or null)
 *   serv.dungeonRun.stop(reason)
 *
 * Needs `dungeon-spawner` (plans + spawns the room mobs; it uses `dungeon-mobs`) and optionally `dungeon-secrets` (secret totals
 * from the room sidecars, stub). Works with `dungeon-map` (Magical Map) when it is loaded: this plugin emits
 * dungeonStart / dungeonRoomEntered / dungeonRoomCleared / dungeonRoomCompleted / dungeonEnd for it.
 * Layout comes from `serv.dungeon.layout` (dungeon-server.js sets it) unless one is passed in.
 *
 * Plugin settings (all optional)
 *   autoStart        start as soon as the first player has joined                            [false]
 *   autoStartDelay   ticks to wait after that join (lets the client finish loading)           [60]
 *   sidebar          show the sidebar scoreboard                                              [true]
 *   watcherAnimation  draw the Watcher, its boss bar and the guardians' spawn puffs (lib/watcher-anim.js)   [true]
 *   doorOpen         how a key is spent: 'click' (right-click the door), 'proximity' (walk up to it) or 'both'   ['click']
 *   clickReach       furthest a right-click on a door still counts, in blocks                   [6]
 *   doorRange        blocks from a locked wither / blood door at which a key is spent (proximity)   [2.5]
 *   groundScan       [from, to] y range scanned (bottom up) to stand a spawned mob on the floor; passed to dungeon-spawner
 *   endDelay         ticks between the end of the run and cleaning up                         [100]
 *   doorAnimation    [true] bats + falling blocks sink while the door opens (capture, lib/door-anim.js)
 *   doorTimeScale    [1] 0 = play the whole animation at once
 *   run              overrides for lib/config.js (revive time, watcher size, score curve ...)
 *
 * Op command: /dungeon <start|stop|status|score|clear [room]|tp <room>|die|key [wither|blood]>
 */
const { Vec3 } = require('vec3')
const { DungeonRun } = require('./lib/run')
const { createSidebar } = require('./lib/sidebar')
const doorAnim = require('./lib/door-anim')
const watcherAnim = require('./lib/watcher-anim')
const crypto = require('crypto')

const SPECTATOR = 3

module.exports.server = function (serv, options) {
  const config = Object.assign({ autoStart: false, autoStartDelay: 60, sidebar: true, doorRange: 2.5, doorOpen: 'click', clickReach: 6, watcherAnimation: true, groundScan: null, endDelay: 100, doorAnimation: true, doorTimeScale: 1, run: {} }, (this && this.settings) || {})
  const sidebar = createSidebar()
  let current = null // { run, players: Map(uuid -> player), spawner (dungeon-spawner session), world, layout, endAt, prevMode: Map }

  const log = m => serv.info?.(`[dungeon-run] ${m}`)
  const warn = m => serv.err?.(`[dungeon-run] ${m}`)
  const say = (m, players) => { for (const p of players || current.players.values()) { try { p.chat(m) } catch (e) { /* client gone */ } } }

  const nameOf = (run, id) => { const p = id != null ? run.players.get(String(id)) : [...run.players.values()][0]; return p ? p.name : 'Someone' }

  // ---- start / stop ---------------------------------------------------------------------------------------------------
  function start (opts = {}) {
    if (current) stop('restarted')
    const layout = opts.layout || (serv.dungeon && serv.dungeon.layout)
    if (!layout) { warn('no layout: pass { layout } or set serv.dungeon.layout'); return null }
    const players = (opts.players || serv.players).filter(p => p._client)
    if (!players.length) { warn('no players to put in the run'); return null }
    if (!serv.dungeonSpawner) warn('the dungeon-spawner plugin is not loaded: rooms will have no mobs and clear at once')
    else if (!serv.dungeonMobs) warn('the dungeon-mobs plugin is not loaded: rooms will have no mobs and clear at once')

    const run = new DungeonRun({
      layout,
      seed: opts.seed,
      floor: opts.floor,
      master: opts.master,
      secrets: opts.secrets ?? (serv.dungeonSecrets && serv.dungeonSecrets.totals(layout)), // from the room sidecars (dungeon-secrets)
      mobPlanner: serv.dungeonSpawner && serv.dungeonSpawner.plannerFor(layout), // room sidecar mobs (dungeon-spawner)
      config: { autoPickupKeys: true, ...config.run, ...opts.config }, // keys are not physical items yet, see README
      party: players.map(p => ({ id: p.uuid, name: p.username, class: p.dungeonClass || (p.skyblock && p.skyblock.dungeonClass) || null }))
    })
    current = { run, layout, world: opts.world || serv.overworld, players: new Map(players.map(p => [p.uuid, p])), spawner: serv.dungeonSpawner ? serv.dungeonSpawner.session({ world: opts.world || serv.overworld, layout, groundScan: config.groundScan, warn }) : null, endAt: null, prevMode: new Map(), sidebarAt: 0 }
    run.on('*', e => { try { onEvent(e) } catch (err) { warn(`${e.type}: ${err.stack}`) } })
    for (const w of run.warnings) warn(w)

    serv.emit('dungeonStart', { layout, players }) // Magical Map
    if (config.sidebar) for (const p of players) sidebar.show(p, run.cfg.lines.title)
    run.start()
    refreshSidebar()
    log(`floor ${run.floor} seed ${run.seed}: ${run.rooms.length} rooms, ${players.length} player(s)`)
    serv.emit('dungeonRunStarted', run)
    return run
  }

  function stop (reason = 'stopped') {
    if (!current) return false
    const cur = current
    current = null
    endFight(cur)
    for (const p of cur.players.values()) { sidebar.hide(p); restoreMode(cur, p) }
    if (cur.spawner) cur.spawner.clear()
    serv.emit('dungeonEnd', { reason })
    log(`ended (${reason}, ${cur.run.state})`)
    return true
  }

  const restoreMode = (cur, p) => { const m = cur.prevMode.get(p.uuid); if (m !== undefined && p.gameMode === SPECTATOR) p.setGameMode(m); cur.prevMode.delete(p.uuid) }

  // ---- run events -> the world ----------------------------------------------------------------------------------------
  function onEvent (e) {
    const cur = current
    if (!cur) return
    const run = cur.run
    const players = [...cur.players.values()]
    const titleAll = (main, sub) => { if (config.sidebar) for (const p of players) sidebar.title(p, main, sub) }
    switch (e.type) {
      case 'countdownStarted': say(`§aStarting in ${e.seconds} seconds.`); break
      case 'countdown': say(`§aStarting in ${e.seconds} second${e.seconds === 1 ? '' : 's'}.`); break
      case 'go': break // [capture] no title; Mort speaks (dialogue events)

      case 'roomEntered': serv.emit('dungeonRoomEntered', { roomId: e.roomId, layout: cur.layout, world: cur.world }); break
      case 'roomCleared': serv.emit('dungeonRoomCleared', { roomId: e.roomId }); break
      case 'roomCompleted': serv.emit('dungeonRoomCompleted', { roomId: e.roomId }); break

      case 'spawnMobs': spawnPlan(cur, e.plan); break
      case 'spawnWatcherMobs': guardianEntrance(cur, e.plan); spawnPlan(cur, e.plan); break
      case 'mobDied':
        if (e.cause === 'admin' && cur.spawner) cur.spawner.despawn(e.mobId)
        if (e.watcher && cur.fight) toAll(cur, cur.fight.kill(run.watcher.total))
        break

      case 'keyPickedUp': {
        const who = nameOf(run, e.by)
        const blood = e.keyType === 'blood'
        say(`§b${who}§f §ehas obtained ${blood ? '§cBlood Key' : '§8Wither Key'}§e!`)
        say(`§e§lRIGHT CLICK §7on §7${blood ? 'the §cBLOOD DOOR' : 'a §8WITHER §7door'}§7 to ${blood ? 'open it' : 'open it'}. This key can only be used to open §a1§7 door!`)
        break
      }
      case 'doorOpened':
        if (e.kind === 'wither') say(`§a${nameOf(run, e.by)}§a opened a §8§lWITHER §adoor!`)
        else if (e.kind === 'blood') { say('§cThe §c§lBLOOD DOOR§c has been opened!'); say('§5A shiver runs down your spine...') }
        openDoorBlocks(cur, e)
        break

      case 'watcherStarted': startFight(cur); break
      case 'dialogue': say(e.npc ? `§e[NPC] §b${e.speaker}§f: ${e.text}` : `§c[BOSS] ${e.speaker}§f: ${e.text}`); break
      case 'bossPhase': endFight(cur); say('§cThe floor boss approaches.'); break
      case 'puzzleFailed': say(`§c§lPUZZLE FAIL! §a${nameOf(run, e.by)} §ewas fooled by §c${e.puzzle || 'a puzzle'}§e! §4Y§ci§6k§ee§as§2!`); break

      case 'playerDied': {
        const p = cur.players.get(e.player)
        if (!p) break
        cur.prevMode.set(p.uuid, p.gameMode)
        p.updateHealth(20) // no death screen: the ghost is a spectator
        p.setGameMode(SPECTATOR)
        say(`§c ☠ §b${e.name}§7 ${e.killer ? `was killed by ${e.killer}` : 'died'}§7 and became a ghost§7.`)
        // [capture] the dead player's titles: "You became a spectator!" then "BEING REVIVED" every second
        if (config.sidebar) {
          sidebar.title(p, '§eYou became a spectator!', '§7Hopefully your teammates will be able to revive you!', { fadeIn: 0, stay: 100, fadeOut: 5 })
          const secs = Math.round(e.reviveInTicks / run.cfg.tps)
          for (let i = secs; i >= 2; i--) setTimeout(() => { if (current === cur && run.players.get(e.player).machine.is('GHOST')) sidebar.title(p, '§e§lBEING REVIVED', `§aYou will be revived in ${i}s`, { fadeIn: 0, stay: 30, fadeOut: 0 }) }, (secs - i + 1.8) * 1000)
        }
        break
      }
      case 'playerRevived': {
        const p = cur.players.get(e.player)
        if (!p) break
        restoreMode(cur, p)
        p.updateHealth(20)
        say(`§a ❣ §7${e.name}§a was revived${e.cause && e.cause !== 'timer' && nameOf(run, e.by) ? ` by §a${nameOf(run, e.by)}§a` : ''}!`)
        break
      }

      case 'dungeonComplete': case 'dungeonFailed': {
        endFight(cur)
        const r = e.results
        const L = run.cfg.lines
        const bar = '§a§l' + '▬'.repeat(64)
        const mmss = secs => `${String(Math.floor(secs / 60)).padStart(2, '0')}m ${String(secs % 60).padStart(2, '0')}s`
        const floorName = r.floor === 0 ? 'Entrance' : `${r.master ? 'Master Mode ' : ''}Floor ${['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][r.floor]}`
        const rc = run.cfg.score.rankColors[r.score.rank] || '§f'
        const lines = [bar, `§f                        §cThe Catacombs §8- §e${floorName}`, `Team Score: §a${r.score.total} §f(${rc}${r.score.rank}§f)`]
        lines.push(e.type === 'dungeonComplete'
          ? `§f                  §c☠ §eDefeated §c${L.bossByFloor[r.floor] || 'the boss'} §ein §a${mmss(r.elapsedSeconds)}`
          : `§f                  §c☠ §cDefeat §7(${r.reason}) §ein §a${mmss(r.elapsedSeconds)}`)
        lines.push(bar)
        for (const l of lines) say(l)
        if (config.sidebar) titleAll(e.type === 'dungeonComplete' ? '§aDUNGEON COMPLETE' : '§cDUNGEON FAILED', `§7Score ${r.score.total} ${r.score.rank}`)
        cur.endAt = serv.tickCount + config.endDelay
        refreshSidebar()
        break
      }
    }
  }

  // ---- the Watcher and the blood room fight (lib/watcher-anim.js) -------------------------------------------------------
  const toAll = (cur, packets) => { for (const p of cur.players.values()) for (const [name, params] of packets) safeWrite(p, name, params) }
  const feetY = cur => (cur.layout.doorBaseY ?? 66) + 3
  function startFight (cur) {
    if (!config.watcherAnimation || cur.fight) return
    try {
      const mcData = require('minecraft-data')((options && options.version) || serv.version || '26.1')
      const run = cur.run
      cur.fight = watcherAnim.createFight({
        center: run.roomCenter(run.bloodRoom),
        floorY: feetY(cur),
        ids: { watcher: ++serv.entityMaxId, stand: ++serv.entityMaxId },
        uuids: { watcher: crypto.randomUUID(), stand: crypto.randomUUID(), bar: crypto.randomUUID() },
        types: { zombie: mcData.entitiesByName.zombie.id, armor_stand: mcData.entitiesByName.armor_stand.id },
        headItemId: mcData.itemsByName.player_head.id
      })
      toAll(cur, cur.fight.spawn())
    } catch (err) { warn(`watcher: ${err.stack}`); cur.fight = null }
  }
  function endFight (cur) {
    if (!cur.fight) return
    toAll(cur, cur.fight.remove())
    cur.fight = null
  }
  /** Each guardian appears 5-6 blocks above the floor, under the Watcher, with a cloud puff. */
  function guardianEntrance (cur, plan) {
    for (const entry of plan.entries) {
      entry.position = { ...entry.position, y: round2(feetY(cur) + watcherAnim.GUARDIAN_SPAWN_DY) }
      if (config.watcherAnimation) toAll(cur, [watcherAnim.spawnBurst(entry.position)])
    }
  }
  const round2 = n => Math.round(n * 100) / 100

  // ---- mobs: planned by the run, spawned by dungeon-spawner -------------------------------------------------------------
  function spawnPlan (cur, plan) {
    const failed = id => { if (current === cur) cur.run.mobDied(id, { cause: 'spawnFailed' }) } // never leave a room waiting for a mob that does not exist
    if (!cur.spawner) { for (const e of plan.entries) failed(e.mobId); return }
    cur.spawner.spawn(plan, failed).catch(err => warn(`spawn: ${err.stack}`))
  }

  // ---- doors ----------------------------------------------------------------------------------------------------------
  // [capture] The door animation: bats carrying falling blocks of the door material sink 3.75 blocks while the real blocks go
  // barrier -> air (lib/door-anim.js). `doorTimeScale` 0 plays it instantly (tests), `doorAnimation: false` only swaps the blocks.
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function openDoorBlocks (cur, e) {
    const mcData = require('minecraft-data')((options && options.version) || serv.version || '26.1')
    const stateOf = name => mcData.blocksByName[name].defaultState
    const positions = doorAnim.doorBox(e.center, e.axis, (cur.layout.doorBaseY ?? 66) + 3)
    const material = stateOf((config.doorBlocks || doorAnim.DOOR_BLOCKS)[e.kind] || doorAnim.DOOR_BLOCKS.normal)
    const tl = doorAnim.timeline({
      positions,
      state: material,
      ids: () => ++serv.entityMaxId,
      uuid: () => crypto.randomUUID(),
      types: { bat: mcData.entitiesByName.bat.id, falling_block: mcData.entitiesByName.falling_block.id }
    })
    if (!config.doorAnimation) tl.steps = tl.steps.filter(st => st.blocks).map(st => ({ ...st, packets: [] }))
    const fill = async state => { for (const p of positions) { if (current !== cur) return; try { await serv.setBlock(cur.world, new Vec3(p.x, p.y, p.z), state) } catch (err) { warn(`door block: ${err.message}`) } } }
    let at = 0
    for (const step of tl.steps) {
      await sleep((step.at - at) * config.doorTimeScale)
      at = step.at
      if (current !== cur) { // the run ended mid-animation: still take the copies away
        for (const p of cur.players.values()) safeWrite(p, 'entity_destroy', { entityIds: tl.entityIds })
        return
      }
      for (const [name, params] of step.packets) for (const p of cur.players.values()) safeWrite(p, name, params)
      if (step.blocks === 'barrier') await fill(stateOf('barrier'))
      else if (step.blocks === 'air') await fill(0)
    }
  }
  const safeWrite = (p, name, params) => { try { p._client.write(name, params) } catch (err) { /* client gone */ } }

  // ---- per tick: world -> run -----------------------------------------------------------------------------------------
  function refreshSidebar () {
    if (!current || !config.sidebar) return
    for (const p of current.players.values()) sidebar.update(p, current.run.scoreboardLines(p.uuid))
  }

  serv.on('tick', () => {
    const cur = current
    if (!cur) return
    const run = cur.run

    for (const [id, p] of cur.players) {
      const here = serv.players.includes(p)
      const st = run.players.get(id).machine.state
      if (!here && st !== 'LEFT') { run.playerLeft(id); continue }
      if (here && st === 'LEFT') { run.playerRejoined(id); continue }
      if (!here || !run.running || !p.position) continue
      run.playerMoved(id, p.position.x, p.position.z)
      if (p.health <= 0) run.playerDied(id)
      if (config.doorOpen !== 'click') {
        for (const d of run.doorsNear(p.position.x, p.position.z, config.doorRange)) {
          if (run.keys[d.kind] > 0) run.openDoor(id, d.id)
        }
      }
    }

    if (cur.spawner) for (const mobId of cur.spawner.gone()) run.mobDied(mobId, { cause: 'killed' }) // gone from the world or at 0 hp = dead

    if (cur.fight) { toAll(cur, cur.fight.advance(1000 / run.cfg.tps)); toAll(cur, cur.fight.aura(serv.tickCount)) }
    run.tick()
    if (!cur.sidebarAt || serv.tickCount - cur.sidebarAt >= 10 || run.state === 'COMPLETE' || run.state === 'FAILED') { cur.sidebarAt = serv.tickCount; refreshSidebar() }
    if (cur.endAt !== null && serv.tickCount >= cur.endAt) stop('finished')
  })

  if (config.autoStart) {
    serv.on('newPlayer', player => {
      player.once('spawned', () => setTimeout(() => { if (!current) start({ players: [player] }) }, config.autoStartDelay * 50))
    })
  }

  // ---- right-click a locked door ---------------------------------------------------------------------------------------
  // [capture] Hypixel answers a click without the key with "You do not have the key for this door!". The key itself is spent
  // on the first valid click; a ghost's or a distant click is ignored.
  const NO_KEY = '§cYou do not have the key for this door!'
  function doorClick (player, location) {
    const cur = current
    if (!cur || !location || config.doorOpen === 'proximity' || !cur.run.running) return null
    const id = String(player.uuid)
    if (![...cur.players.values()].includes(player)) return null
    const baseY = (cur.layout.doorBaseY ?? 66) + 3
    if (location.y < baseY || location.y >= baseY + 4) return null
    const door = cur.run.doorAt(location.x, location.z)
    if (!door) return null
    const p = player.position
    if (p && Math.hypot(door.center.x + 0.5 - p.x, door.center.z + 0.5 - p.z) > config.clickReach) return null
    const res = cur.run.openDoor(id, door.id)
    if (!res.ok && /key/i.test(res.reason)) {
      const now = Date.now()
      if (!player._doorMsgAt || now - player._doorMsgAt > 1000) { player._doorMsgAt = now; try { player.chat(NO_KEY) } catch (e) { /* client gone */ } }
    }
    return res
  }
  serv.on('newPlayer', player => { player._client.on('block_place', ({ location } = {}) => { try { doorClick(player, location) } catch (e) { warn(`door click: ${e.stack}`) } }) })

  serv.dungeonRun = { start, stop, doorClick, get current () { return current && current.run }, get fight () { return current && current.fight }, config, sidebar }

  // ---- command --------------------------------------------------------------------------------------------------------
  serv.commands.add({
    base: 'dungeon',
    info: 'control the dungeon run',
    usage: '/dungeon <start|stop|status|score|clear [room]|tp <room>|die|key [wither|blood]>',
    op: true,
    onlyPlayer: true,
    parse: s => s || '',
    action (arg, ctx) {
      const [cmd, a] = String(arg).trim().split(/\s+/)
      const me = ctx.player
      const run = current && current.run
      if (cmd === 'start') return start({ players: [...serv.players] }) ? 'Run started.' : 'Could not start (see the server log).'
      if (cmd === 'stop') return stop('command') ? 'Run stopped.' : 'No run is going.'
      if (!run) return 'No run is going. /dungeon start'
      if (cmd === 'status') return `${run.state} | ` + run.scoreboardLines().join(' | ') + ' | rooms: ' + run.rooms.map(r => `${r.id}${r.type[0]}:${r.machine.state[0]}`).join(' ')
      if (cmd === 'score') { const s = run.score(); return `Score ${s.total} ${s.rank} (skill ${s.skill}, explore ${s.explore}, speed ${s.speed}, bonus ${s.bonus})` }
      if (cmd === 'clear') {
        const id = a !== undefined ? parseInt(a, 10) : run.roomAt(me.position.x, me.position.z)
        if (id === undefined || !run.rooms[id]) return 'Stand in a room or pass a room id.'
        return run.killRoomMobs(id) + ' mob(s) killed in room ' + id
      }
      if (cmd === 'tp') {
        const room = run.rooms[parseInt(a, 10)]
        if (!room) return 'Rooms: ' + run.rooms.map(r => `${r.id}=${r.type}`).join(' ')
        const c = run.roomCenter(room)
        me.teleport(new Vec3(c.x, (current.layout.doorBaseY ?? 66) + 4, c.z))
        return 'Teleported to room ' + room.id
      }
      if (cmd === 'die') { run.playerDied(me.uuid); return 'You died.' }
      if (cmd === 'key') {
        const type = a === 'blood' ? 'blood' : 'wither'
        run._dropKey(run.rooms[run.entrance.id], type)
        return `A ${type} key was dropped.`
      }
      return 'Usage: /dungeon <start|stop|status|score|clear [room]|tp <room>|die|key [wither|blood]>'
    }
  })
}
