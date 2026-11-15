'use strict'
/**
 * dungeon-items — items that lie in the dungeon and are picked up by walking over them: Wither / Blood Keys, Blessings
 * (Power, Life, Wisdom, Stone, Time), Superboom TNT and Revive Stones. See lib/catalog.js.
 *
 *   serv.dungeonItems.spawn('blessing_life', position, { world, level, floor, master, roomId })  -> item
 *   serv.dungeonItems.spawn('wither_key', position, { world, claim: (player, item) => true })   claim: the spawner takes the item itself when touched (return false to leave it)
 *   serv.dungeonItems.bonuses(player) / levels(player) / inventory(player) / use(player, 'superboom')
 *   serv.dungeonItems.list()   serv.dungeonItems.clear()   serv.dungeonItems.catalog
 * Events:  serv.emit('dungeonItemSpawned', item)   serv.emit('dungeonItemPickedUp', { player, ...result })
 * Command (op): /ditem <type> [level]   types: wither_key blood_key blessing_power blessing_life blessing_wisdom blessing_stone blessing_time superboom_tnt revive_stone
 *
 * dungeon-run drops its keys through this plugin when it is loaded (the key is spent from the party pool once somebody walks over it).
 * Blessing stats are only recorded (bonuses()); applying them to damage / health is for the combat layer.
 *
 * Settings: { pickupRadius: 1.5, announce: true }  (Item / rng: test hooks)
 * Each drop is two armour stands as captured: an item stand (helmet or main hand, bobbing +-0.2 and spinning 2 deg per tick, synced every tick) and a still name stand at scale 0.1; unclaimed items vanish after their lifetime (30 s; keys never).
 */
const { Vec3 } = require('vec3')
const { createItems } = require('./lib/items')
const { ITEMS, roman, resolve } = require('./lib/catalog')
const { createBob, OFFSET } = require('./lib/bob')
const { planDrops } = require('./lib/drops')
const { componentToNbt } = require('../dungeon-mobs/lib/nametag')

module.exports.server = function (serv, options) {
  const config = Object.assign({ pickupRadius: 1.5, announce: true, Item: null, rng: null, drops: {} }, (this && this.settings) || {})
  const registry = serv.registry
  const err = m => serv.err?.(`[dungeon-items] ${m}`)
  const core = createItems()
  const rng = config.rng || Math.random
  const stands = new Map() // item id -> { entity, world }
  let ticks = 0

  let typeIds = null
  try { typeIds = {}; for (const [id, name] of Object.entries(registry.protocol.types.entityMetadataEntry[1][1].type[1].mappings)) typeIds[name] = Number(id) } catch { typeIds = null }
  const T = { byte: typeIds?.byte ?? 0, component: typeIds?.optional_component ?? 6, bool: typeIds?.boolean ?? 8, rotations: typeIds?.rotations }
  const keyOf = (def, names, fallback) => { const keys = registry.entities?.[def.id]?.metadataKeys || []; for (const n of names) { const i = keys.indexOf(n); if (i !== -1) return i } return keys.length ? undefined : fallback }

  const label = item => {
    const def = ITEMS[item.type]
    return { text: '', extra: [{ text: def.name, color: def.color }] }
  }

  // One drop = an item stand (helmet or main hand, invisible, bobbing and spinning) + a still name stand at scale 0.1, as captured.
  function makeStand (world, x, y, z, yawByte, entries) {
    const def = registry.entitiesByName.armor_stand
    if (registry.mobs && !registry.mobs[def.id]) registry.mobs[def.id] = def
    const e = serv.spawnMob(def.id, world, new Vec3(x, y, z))
    e.size = null; if (e.gravity) e.gravity.set(0, 0, 0)
    const flags = keyOf(def, ['client_flags', 'armor_stand_flags', 'armor_stand_data'], 15)
    const noGravity = keyOf(def, ['no_gravity'], 5)
    const arm = keyOf(def, ['right_arm_pose'], 19)
    const all = [{ key: 0, type: T.byte, value: 0x20 }, { key: flags, type: T.byte, value: 0 }, ...(noGravity !== undefined ? [{ key: noGravity, type: T.bool, value: true }] : []),
      ...(arm !== undefined && T.rotations !== undefined ? [{ key: arm, type: T.rotations, value: { pitch: -90, yaw: 0, roll: 0 } }] : []), ...entries]
    const sendable = all.filter(m => m.key !== undefined)
    e.metadata = (e.metadata || []).filter(m => !sendable.some(n => n.key === m.key)).concat(sendable)
    e.yaw = yawByte
    try { e.sendMetadata(sendable) } catch (er) { err(`metadata: ${er.message}`) }
    return e
  }

  function equip (entity, slot, spec) {
    try {
      const Item = config.Item || require('prismarine-item')(registry)
      const armor = require('../dungeon-mobs/lib/armor')
      const it = armor.makeItem(registry, Item, spec)
      const ids = armor.slotIds(registry)
      const id = ids[slot]
      if (serv.supportFeature('allEntityEquipmentInOne')) entity._writeOthersNearby('entity_equipment', { entityId: entity.id, equipments: [{ slot: id, item: Item.toNotch(it) }] })
      else entity._writeOthersNearby('entity_equipment', { entityId: entity.id, slot: id, item: Item.toNotch(it) })
      entity.equipment = entity.equipment || []; entity.equipment[id] = it
    } catch (e) { err(`${slot} item: ${e.message}`) }
  }

  // ---- effects (all from the capture) ----
  const particle = (world, pos, type, { amount = 1, spread = 0, speed = 0 } = {}) => {
    let listeners = []
    try { listeners = serv.getNearby({ world, position: new Vec3(pos.x, pos.y, pos.z), radius: 32 }) } catch (e) { listeners = serv.players || [] }
    for (const p of listeners) {
      try { p._client.write('world_particles', { longDistance: true, alwaysShow: true, x: pos.x, y: pos.y, z: pos.z, offsetX: spread, offsetY: spread, offsetZ: spread, velocityOffset: speed, amount, particle: { type } }) } catch (e) { /* left */ }
    }
  }
  const sound = (player, name, volume = 1, pitch = 1) => {
    const entry = registry.soundsByName && registry.soundsByName[name]
    if (!entry) return
    const pos = player.position
    try { player._client.write('sound_effect', { sound: { soundId: entry.id }, soundCategory: 'player', x: Math.round(pos.x * 8), y: Math.round(pos.y * 8), z: Math.round(pos.z * 8), volume, pitch, seed: [Math.floor(rng() * 2 ** 31), Math.floor(rng() * 2 ** 31)] }) } catch (e) { /* left */ }
  }
  /** A drop appears: explosion puff (3 particles, speed 8) at the floor; consumables also get the emitter. */
  function spawnEffect (item, world) {
    const at = { x: item.position.x, y: item.position.y, z: item.position.z }
    particle(world, at, 'explosion', { amount: 3, speed: 8 })
    if (ITEMS[item.type].kind === 'consumable') particle(world, at, 'explosion_emitter')
  }

  function draw (item, world) {
    if (!registry.entitiesByName.armor_stand) return null
    const d = ITEMS[item.type]
    const p = item.position
    const [dyItem, dyName] = OFFSET[d.style || 'head']
    const yawByte = Math.floor(rng() * 4)
    const body = makeStand(world, p.x, p.y + dyItem, p.z, yawByte, [])
    equip(body, d.style === 'held' ? 'mainhand' : 'helmet', { item: d.head, skin: d.skin, model: d.model, glint: d.glint })
    const nameStand = makeStand(world, p.x + (d.style === 'held' ? 0 : 0), p.y + dyName, p.z, 0, [
      { key: keyOf(registry.entitiesByName.armor_stand, ['custom_name'], 2), type: T.component, value: componentToNbt(label(item)) },
      { key: keyOf(registry.entitiesByName.armor_stand, ['custom_name_visible'], 3), type: T.bool, value: true }
    ])
    try { nameStand._writeOthersNearby('update_attributes', { entityId: nameStand.id, properties: [{ key: 'generic.scale', value: 0.1, modifiers: [] }] }) } catch (e) { err(`scale: ${e.message}`) }
    return { entity: body, nameStand, baseY: body.position.y, bob: createBob(yawByte * 360 / 256) }
  }

  function spawn (ref, position, opts = {}) {
    const item = core.spawn(ref, position, opts)
    const world = opts.world || serv.overworld
    const drawn = draw(item, world) || {}
    stands.set(item.id, { ...drawn, world, item, claim: opts.claim, expires: (opts.lifetime ?? ITEMS[item.type].lifetime) ? ticks + Math.round((opts.lifetime ?? ITEMS[item.type].lifetime) / 50) : 0 })
    spawnEffect(item, world)
    serv.emit('dungeonItemSpawned', item)
    return item
  }

  /** Spawn a list of drops [{ type, level? }] side by side (the capture puts the second item 0.5 away in x and z). */
  function spawnDrops (drops, position, opts = {}) {
    return drops.map((d, i) => spawn(d.type, { x: position.x + 0.5 * i, y: position.y, z: position.z + 0.5 * i }, { ...opts, level: d.level }))
  }

  function remove (id) {
    const s = stands.get(id)
    stands.delete(id); core.remove(id)
    for (const e of s ? [s.entity, s.nameStand] : []) if (e) { try { serv.destroyEntity(e) } catch (er) { /* gone */ } }
  }
  const clear = () => { for (const id of [...stands.keys()]) remove(id) }

  const CODES = { dark_gray: '8', red: 'c', green: 'a', aqua: 'b', gray: '7', light_purple: 'd', blue: '9', gold: '6' }
  const colorCode = c => CODES[c] || 'f'
  const mmss = sec => sec >= 60 ? `${String(Math.floor(sec / 60)).padStart(2, '0')}m ${String(sec % 60).padStart(2, '0')}s` : `${String(sec).padStart(2, '0')}s`
  const partyOf = player => { const p = serv.dungeonRun && serv.dungeonRun.party; const list = typeof p === 'function' ? p() : p; return list && list.length ? list : [player] }

  /** Chat for a pickup, as captured: "<name> has obtained <item>!" to the party, then for blessings the DUNGEON BUFF line and "Granted you ..." */
  function announce (r) {
    const d = ITEMS[r.type]; const picker = r.player
    if (!config.announce || r.kind === 'key') return // dungeon-run announces keys itself
    const party = partyOf(picker)
    const item = `§${colorCode(d.color)}${d.name}`
    for (const p of party) p.chat(`§b${picker.username} §ehas obtained ${item}§e!`)
    if (r.kind !== 'blessing') return
    const secs = serv.dungeonRun && serv.dungeonRun.elapsedSeconds
    const stamp = r.item.level >= 5 && secs !== undefined ? ` §f(§a${mmss(secs)}§f)` : '' // the capture only stamps level V (the run clock)
    for (const p of party) {
      p.chat(`§6§lDUNGEON BUFF! §f${p === picker ? 'You found a ' : '§b' + picker.username + ' §ffound a '}§d${d.name} ${roman(r.item.level)}§f!${stamp}`)
      p.chat(`     §7Granted you ${core.grantText(r.type, r.item.level)}§7.`)
    }
  }

  /** Give an item to a player: updates blessings (party-wide) / carried items, plays the pickup effects, removes the stands, announces. */
  function collect (itemId, player) {
    const s = stands.get(itemId)
    const party = partyOf(player)
    const r = core.pickup(itemId, player.uuid, { recipients: party.map(p => p.uuid) })
    if (!r) return null
    r.player = player
    if (s && s.entity) particle(s.world, { x: s.entity.position.x, y: s.entity.position.y, z: s.entity.position.z }, 'lava') // at the item stand
    sound(player, 'entity.item.break')
    remove(itemId)
    announce(r)
    serv.emit('dungeonItemPickedUp', r)
    return r
  }

  serv.on('tick', () => {
    ticks++
    if (!stands.size) return
    if (ticks % 2 === 0) {
      const r2 = config.pickupRadius ** 2
      for (const [id, s] of [...stands]) {
        const item = s.item
        for (const player of serv.players) {
          if (player.world !== s.world || player.gameMode === 3 || player.gamemode === 3) continue
          const dx = player.position.x - item.position.x; const dz = player.position.z - item.position.z; const dy = player.position.y - item.position.y
          if (dx * dx + dz * dz > r2 || dy < -1.5 || dy > 2.5) continue
          // `claim(player, item)` lets the spawner take the item itself (dungeon-run: keys go to the party pool); false = leave it lying
          const ok = s.claim ? s.claim(player, item) : true
          if (ok === false) continue
          if (s.claim) { if (s.entity) particle(s.world, { x: s.entity.position.x, y: s.entity.position.y, z: s.entity.position.z }, 'lava'); sound(player, 'entity.item.break'); remove(id); serv.emit('dungeonItemPickedUp', { player, item, type: item.type, kind: item.kind }) } else collect(id, player)
          break
        }
      }
    }
    for (const [id, s] of [...stands]) {
      if (ITEMS[s.item.type].kind === 'consumable' && ticks % 10 === 0) { const q = s.item.position; for (let k = 0; k < 2; k++) particle(s.world, { x: q.x, y: q.y + 0.7, z: q.z }, 'firework', { amount: 6, spread: 0.3 }) }
      if (s.expires && ticks >= s.expires) { remove(id); serv.emit('dungeonItemExpired', s.item); continue }
      if (!s.entity || !s.bob) continue
      const { dy, yaw } = s.bob.step()
      const e = s.entity
      e.position.y = s.baseY + dy; e.yaw = yaw
      try { e._writeOthersNearby('sync_entity_position', { entityId: e.id, x: e.position.x, y: e.position.y, z: e.position.z, dx: 0, dy: 0, dz: 0, yaw, pitch: 0, onGround: false }) } catch (er) { /* gone */ }
    }
  })

  serv.dungeonItems = { spawn, spawnDrops, planDrops: (kind, ctx = {}) => planDrops({ kind, rng, ...ctx, table: { ...(config.drops || {}), ...(ctx.table || {}) } }), remove, clear, collect, list: () => core.list(), bonuses: p => core.bonuses(p.uuid ?? p), levels: p => core.levels(p.uuid ?? p), inventory: p => core.inventory(p.uuid ?? p), use: (p, c) => core.use(p.uuid ?? p, c), core, catalog: ITEMS }

  serv.commands.add({
    base: 'ditem',
    info: 'Drop a dungeon item (key, blessing, ...) at your feet',
    usage: `/ditem <${Object.keys(ITEMS).join('|')}> [level]`,
    op: true,
    onlyPlayer: true,
    parse (str) { const [type, level] = str.trim().split(/\s+/); return type ? { type, level: level ? Number(level) : undefined } : false },
    action ({ type, level }, ctx) {
      if (!resolve(type)) return `Unknown item. Try: ${Object.keys(ITEMS).join(', ')}`
      const p = ctx.player.position
      const item = spawn(type, { x: p.x, y: p.y, z: p.z }, { world: ctx.player.world, level })
      return `Dropped ${item.type}${item.level ? ' ' + roman(item.level) : ''}.`
    }
  })
}
