'use strict'
/**
 * dungeon-mobs — spawn Catacombs mobs at a position, with dungeon flags (✯ star, modifier, room, floor ...).
 *
 * This is only the spawning primitive. Room clearing, key / blessing drops and picking positions per room come later and
 * can all be built on top of what a spawned mob carries in `entity.dungeon`.
 *
 *   const mob = serv.dungeonMobs.spawn('zombie_grunt', new Vec3(x, y, z), { star: true, floor: 3, roomId: 4 })
 *   mob.dungeon  // { key, name, kind, star, floor, master, modifier, roomId, level, health, maxHealth, damage, defense, traits, ... }
 *
 * Options (all optional)
 *   world           world to spawn in                                        [position.world or serv.overworld]
 *   star            show the gold ✯ and mark it as a star mob                [false]
 *   floor           0 (Entrance) .. 7                                        [0]
 *   master          master mode, scales stats like M1-M7                     [false]
 *   modifier        'healthy'|'stormy'|'speedy'|'fortified'|'flaming', null/'none' for none, undefined = random by chance
 *   roomId          dungeon room this mob belongs to (matches exportLayout().rooms[].id)
 *   roomsExplored   rooms already explored: applies the "room entering bonus" 1 + 0.05 * (n - 1) to health
 *   health          force the max health (skips scaling, bonus and randomisation)
 *   level           force the level shown / stored
 *   yaw, pitch      facing
 *   nametag         show the name tag [true]
 *   armor           armour / held items, see lib/armor.js: 'diamond' | { material:'leather', color } | { helmet, chestplate, leggings, boots, mainhand, offhand }
 *   skin            skin key from skins/skins.json for the mobs drawn as players (default: the catalogue's)
 *
 * Also:  serv.dungeonMobs.spawnGroup([{ mob, position, star, ... }, ...], sharedOptions)
 *        serv.dungeonMobs.setArmor(mob, spec)   serv.dungeonMobs.equip(mob, 'helmet', 'iron_helmet')   (live, nearby players see it)
 *        serv.dungeonMobs.list({ roomId, star, alive })     serv.dungeonMobs.catalog
 * Event: serv.emit('dungeonMobSpawned', entity)
 * Command (op): /dmob <mob> [star] [floor=N] [master] [modifier=<name>] [armor=<material>] [skin=<key>]
 *
 * Plugin settings: { glyphs: [{ text, color }], randomHealth: true, modifierChance: <overrides the per-mob chance>, players: true }
 *
 * Melee: players hitting a dungeon mob deal stat-based damage (see meleeDamage); set `meleeDamage: false` to keep core's 1 hp.
 * Health bar: the number in the name tag follows `mob.health` (checked every tick), so any damage path updates it.
 * Player mobs: Hypixel draws some mobs as players. They are spawned as player entities with a `textures` profile (lib/skins.js).
 * A player's own name plate cannot be edited or hidden by metadata, so the tag is an invisible armour stand riding the mob
 * (a mob with a passenger shows no name plate), and the fake profile is hidden from the tab list.
 */
const { Vec3 } = require('vec3')
const { mobs: CATALOG, modifiers: MODIFIERS, normalise } = require('./lib/catalog')
const { nametagComponent, componentToNbt, plain } = require('./lib/nametag')
const armorLib = require('./lib/armor')
const skins = require('./lib/skins')

const MASTER_TIERS = 7 // M1-M7 sit after F7 on the stat scale

const lerpGeo = (lo, hi, p) => (lo <= 0 || hi <= 0 || lo === hi) ? lo + (hi - lo) * p : lo * Math.pow(hi / lo, p)
const pick = a => a[Math.floor(Math.random() * a.length)]

module.exports.server = function (serv, options) {
  const config = Object.assign({ glyphs: [], randomHealth: true, modifierChance: undefined, players: true, profileRemoveDelay: 3000 }, (this && this.settings) || {})
  const registry = serv.registry
  const Item = config.Item || require('prismarine-item')(registry)
  const tracked = new Set() // spawned dungeon mobs: health bar refresh and tag clean-up
  let creatingTag = false // true while the tag stand is being created: core would announce it on its own
  let pendingProfile = null // set while serv.spawnMob runs for a player mob: the spawn packet needs the profile first

  // ---- entity metadata plumbing (indices and type ids come from the registry, with vanilla values as fallback) ----------
  let typeIds = null
  try {
    const mappings = registry.protocol.types.entityMetadataEntry[1][1].type[1].mappings // id -> name
    typeIds = {}
    for (const [id, name] of Object.entries(mappings)) typeIds[name] = Number(id)
  } catch { /* old protocol layout: keep the fallbacks below */ }
  const TYPE_OPTIONAL_COMPONENT = typeIds?.optional_component ?? 6
  const TYPE_BOOLEAN = typeIds?.boolean ?? 8

  function metaKeys (entityTypeId) {
    const keys = (registry.entities?.[entityTypeId]?.metadataKeys) || []
    const index = (name, fallback) => { const i = keys.indexOf(name); return i === -1 ? fallback : i }
    return { name: index('custom_name', 2), visible: index('custom_name_visible', 3) }
  }

  // registry.mobs only lists a handful of types on 26.1 (mob-ai patches the rest in); make sure ours are spawnable either way
  function ensureSpawnable (entity) {
    if (registry.mobs && !registry.mobs[entity.id]) registry.mobs[entity.id] = entity
  }

  // ---- stats ----------------------------------------------------------------------------------------------------------
  function scale (range, def, floor, master) {
    const tier = floor + (master ? MASTER_TIERS : 0)
    const first = def.floors[0]
    const last = def.floors[1] + MASTER_TIERS
    const p = last === first ? 0 : Math.max(0, Math.min(1, (tier - first) / (last - first)))
    return Array.isArray(range) ? lerpGeo(range[0], range[1], p) : range
  }

  function resolveDef (ref) {
    if (ref && typeof ref === 'object') return { key: normalise(ref.key || ref.name), def: ref }
    const key = normalise(ref)
    const def = CATALOG[key]
    if (!def) throw new Error(`Unknown dungeon mob: ${ref} (try ${Object.keys(CATALOG).slice(0, 5).join(', ')} ...)`)
    return { key, def }
  }

  function resolveModifier (mod, def) {
    if (mod === null || mod === 'none' || mod === false) return null
    if (typeof mod === 'string') {
      const m = MODIFIERS[normalise(mod)]
      if (!m) throw new Error(`Unknown modifier: ${mod} (${Object.keys(MODIFIERS).join(', ')})`)
      return normalise(mod)
    }
    const chance = config.modifierChance ?? def.modChance ?? 0
    return Math.random() < chance ? pick(Object.keys(MODIFIERS)) : null
  }

  // ---- metadata helpers -----------------------------------------------------------------------------------------------
  const TYPE_BYTE = typeIds?.byte ?? 0
  const keyIndex = (entityTypeId, names, fallback) => {
    const keys = (registry.entities?.[entityTypeId]?.metadataKeys) || []
    for (const n of names) { const i = keys.indexOf(n); if (i !== -1) return i }
    return keys.length ? undefined : fallback // no key list in this registry: vanilla index, else do not send (a wrong index disconnects the client)
  }
  const send = (entity, entries) => { try { entity.sendMetadata(entries) } catch (e) { serv.err?.(`[dungeon-mobs] metadata failed: ${e.message}`) } }
  const merge = (entity, entries) => { entity.metadata = (entity.metadata || []).filter(e => !entries.some(n => n.key === e.key)).concat(entries) }

  // ---- name tag (and health bar) --------------------------------------------------------------------------------------
  // Player mobs carry the tag on an invisible armour stand riding them; every other mob wears it as its own custom name.
  function applyNametag (mob) {
    const d = mob.dungeon
    const target = d.tagEntity || mob
    const health = Math.max(0, Math.ceil(mob.health))
    const component = nametagComponent({ name: d.name, star: d.star, health, modifier: d.modifier ? MODIFIERS[d.modifier].prefix : null, glyphs: config.glyphs, nameColor: d.nameColor })
    const k = metaKeys(target.entityType)
    const entries = [
      { key: k.name, type: TYPE_OPTIONAL_COMPONENT, value: componentToNbt(component) },
      { key: k.visible, type: TYPE_BOOLEAN, value: d.nametag }
    ]
    merge(target, entries)
    send(target, entries)
    d.tag = plain(component)
    d.shownHealth = health
  }

  // ---- fake players ----------------------------------------------------------------------------------------------------
  const playerDef = () => registry.entitiesByName.player
  const infoPacket = (fp) => serv.supportFeature('playerInfoActionIsBitfield')
    ? { action: { add_player: true, update_listed: true }, data: [{ uuid: fp.uuid, player: { name: fp.name, properties: fp.properties }, listed: false }] }
    : { action: 'add_player', data: [{ uuid: fp.uuid, name: fp.name, properties: fp.properties, gamemode: 0, ping: 0 }] }

  function removeProfile (fp) {
    try {
      if (serv.supportFeature('playerInfoActionIsBitfield')) serv._writeAll('player_remove', { players: [fp.uuid] })
      else serv._writeAll('player_info', { action: 'remove_player', data: [{ uuid: fp.uuid }] })
    } catch (e) { serv.err?.(`[dungeon-mobs] player_remove failed: ${e.message}`) }
  }

  // Spawn / despawn go through core's per-player spawnEntity / despawnEntities. For a player mob we must (1) tell the client
  // the profile before the spawn packet, (2) send the tag stand and the "stand rides mob" packet right after, (3) destroy the stand
  // together with the mob.
  function install (player) {
    if (player._dmobInstalled) return
    if (typeof player.spawnEntity !== 'function' || typeof player.despawnEntities !== 'function') return setImmediate(() => install(player))
    player._dmobInstalled = true
    player._dmobSpawnStand = player.spawnEntity
    const spawnOriginal = player.spawnEntity
    const despawnOriginal = player.despawnEntities
    player.spawnEntity = entity => {
      if (entity.tagOf || creatingTag) return // the tag goes out with its owner
      if (entity.type === 'mob' && playerDef() && entity.entityType === playerDef().id) {
        if (!entity.fakePlayer && pendingProfile) entity.fakePlayer = { ...pendingProfile, uuid: entity.uuid }
        if (entity.fakePlayer) { try { player._client.write('player_info', infoPacket(entity.fakePlayer)) } catch (e) { serv.err?.(`[dungeon-mobs] player_info failed: ${e.message}`) } }
      }
      spawnOriginal(entity)
      if (entity.dungeon && entity.dungeon.tagEntity) sendTag(player, entity)
      if (entity.dungeon && entity.dungeon.scale) sendScale(entity, [player])
    }
    player.despawnEntities = entities => {
      despawnOriginal(entities)
      const ids = entities.map(e => e.dungeon && e.dungeon.tagEntity && e.dungeon.tagEntity.id).filter(id => id !== undefined)
      if (ids.length) { try { player._client.write('entity_destroy', { entityIds: ids }) } catch (e) { /* client gone */ } }
    }
  }
  serv.on('newPlayer', install)
  for (const p of serv.players || []) install(p)

  function createTag (mob) {
    const def = registry.entitiesByName.armor_stand
    if (!def) return null
    ensureSpawnable(def)
    creatingTag = true
    let stand
    try { stand = serv.spawnMob(def.id, mob.world, mob.position.clone()) } finally { creatingTag = false }
    stand.tagOf = mob
    const flags = keyIndex(def.id, ['armor_stand_flags', 'armor_stand_data'], 15)
    const entries = [{ key: 0, type: TYPE_BYTE, value: 0x20 }] // invisible
    if (flags !== undefined) entries.push({ key: flags, type: TYPE_BYTE, value: 0x08 | 0x10 }) // no base plate, marker (no hit box)
    merge(stand, entries)
    return stand
  }

  // ---- equipment ------------------------------------------------------------------------------------------------------
  function applyEquipment (mob, normalised) {
    const ids = armorLib.slotIds(registry)
    const equipments = []
    mob.equipment = mob.equipment || []
    for (const [slot, spec] of Object.entries(normalised)) {
      const id = ids[slot]
      if (id === undefined) continue
      const item = spec ? armorLib.makeItem(registry, Item, spec) : null
      mob.equipment[id] = item || undefined
      equipments.push({ slot: id, item: Item.toNotch(item) })
    }
    if (!equipments.length) return
    try {
      if (serv.supportFeature('allEntityEquipmentInOne')) mob._writeOthersNearby('entity_equipment', { entityId: mob.id, equipments })
      else for (const e of equipments) mob._writeOthersNearby('entity_equipment', { entityId: mob.id, slot: e.slot, item: e.item })
    } catch (e) { serv.err?.(`[dungeon-mobs] equipment failed: ${e.message}`) }
    if (mob.dungeon) mob.dungeon.armor = { ...(mob.dungeon.armor || {}), ...normalised }
  }
  const setArmor = (mob, spec) => applyEquipment(mob, armorLib.normalise(spec))
  const equip = (mob, slot, spec) => applyEquipment(mob, armorLib.normalise({ [slot]: spec }))

  // ---- spawn ----------------------------------------------------------------------------------------------------------
  function spawn (mobRef, position, opts = {}) {
    const { key, def } = resolveDef(mobRef)

    // body: a player entity with a skin when we have one, else the vanilla fallback
    const asPlayer = !!(def.skin && config.players !== false && playerDef())
    const profile = asPlayer ? skins.skinProfile(opts.skin || def.skin, 'dm' + Math.random().toString(16).slice(2, 10)) : null
    const bodyName = profile ? 'player' : (def.fallback || (def.entity === 'player' ? 'zombie' : def.entity))
    const entity = registry.entitiesByName[bodyName]
    if (!entity) throw new Error(`Entity type ${bodyName} is not in this registry`)
    ensureSpawnable(entity)

    const floor = Math.max(0, Math.min(7, opts.floor ?? 0))
    const master = !!opts.master
    const modifier = resolveModifier(opts.modifier, def)
    const mod = modifier ? MODIFIERS[modifier] : {}

    // health: scale by floor, room-entering bonus, per-mob randomisation (-2000..+6000), modifier
    let maxHealth
    if (opts.health !== undefined) {
      maxHealth = opts.health
    } else {
      maxHealth = scale(def.health, def, floor, master)
      if (opts.roomsExplored > 0) maxHealth *= 1 + 0.05 * (opts.roomsExplored - 1)
      if (config.randomHealth && def.kind !== 'special') maxHealth = Math.max(maxHealth * 0.25, maxHealth + 1000 * (-2 + Math.random() * 8))
      maxHealth *= mod.healthMul || 1
      maxHealth = Math.max(1, Math.round(maxHealth))
    }

    const pos = position instanceof Vec3 ? position : new Vec3(position.x, position.y, position.z)
    const world = opts.world || position.world || serv.overworld
    pendingProfile = profile ? { name: 'dm' + Math.random().toString(16).slice(2, 10), properties: profile.properties } : null
    let mob
    try {
      mob = serv.spawnMob(entity.id, world, pos, { yaw: opts.yaw || 0, pitch: opts.pitch || 0 })
    } finally { pendingProfile = null }

    let defense = scale(def.defense, def, floor, master)
    defense *= mod.defenseMul || 1
    mob.health = maxHealth
    mob.maxHealth = maxHealth
    mob.dungeon = {
      key,
      name: def.name,
      kind: def.kind,
      body: bodyName,
      skin: profile ? profile.key : null,
      star: !!opts.star,
      canBeStar: def.star,
      nameColor: def.nameColor ?? 'red',
      floor,
      master,
      modifier,
      roomId: opts.roomId ?? null,
      level: opts.level ?? Math.round(scale(def.level, def, floor, master)),
      maxHealth,
      damage: Math.round(scale(def.damage, def, floor, master)),
      defense: Math.round(defense),
      magicResist: def.magicResist ?? 0.1,
      traits: def.traits.slice(),
      nametag: opts.nametag !== false,
      spawnedAt: Date.now(),
      armor: {},
      tagEntity: null
    }

    // the mob AI (if installed) just gave it a 20 hp vanilla profile: keep its idea of max health in step
    const ai = serv.mobAI?.get?.(mob)
    if (ai) { ai.attributes.maxHealth = maxHealth; if (ai.lastHealth !== undefined) ai.lastHealth = maxHealth }

    if (profile) {
      // skin layers (hat, jacket, sleeves, pants) are off unless the client is told
      const layers = keyIndex(entity.id, ['player_mode_customisation', 'player_model_customisation', 'skin_parts'], undefined)
      if (layers !== undefined) { const e = [{ key: layers, type: TYPE_BYTE, value: 0x7f }]; merge(mob, e); send(mob, e) }
      if (opts.nametag !== false) mob.dungeon.tagEntity = createTag(mob)
      // players that already see the mob were sent it before the tag existed: add the tag for them now
      if (mob.dungeon.tagEntity) for (const p of mob.getNearby().filter(e => e.type === 'player')) { if (p._dmobInstalled) sendTag(p, mob) }
    }

    applyNametag(mob)
    tracked.add(mob)
    const armor = opts.armor !== undefined ? opts.armor : def.armor
    if (armor) setArmor(mob, armor)
    const bodyScale = opts.scale !== undefined ? opts.scale : def.scale
    if (bodyScale) { mob.dungeon.scale = bodyScale; sendScale(mob) }
    serv.emit('dungeonMobSpawned', mob)
    return mob
  }
  // [capture] The Watcher's guardians are 0.28 scale players: generic.scale attribute (sent to everybody nearby, and again for late arrivals)
  function sendScale (mob, players) {
    const packet = { entityId: mob.id, properties: [{ key: 'generic.scale', value: mob.dungeon.scale, modifiers: [] }] }
    try {
      if (players) for (const p of players) p._client.write('entity_update_attributes', packet)
      else mob._writeOthersNearby('entity_update_attributes', packet)
    } catch (e) { serv.err?.(`[dungeon-mobs] scale failed: ${e.message}`) }
  }
  function sendTag (player, mob) {
    const stand = mob.dungeon.tagEntity
    try {
      player._dmobSpawnStand(stand)
      player._client.write('set_passengers', { entityId: mob.id, passengers: [stand.id] })
    } catch (e) { serv.err?.(`[dungeon-mobs] tag failed: ${e.message}`) }
  }

  // ---- upkeep: health bar follows mob.health, tags and fake profiles are removed with their mob ------------------------
  serv.on('tick', () => {
    for (const mob of tracked) {
      const d = mob.dungeon
      if (!serv.entities[mob.id]) { // killed (core deletes the entity) or removed
        tracked.delete(mob)
        if (d.tagEntity) { try { serv.destroyEntity(d.tagEntity) } catch (e) { /* already gone */ } d.tagEntity = null }
        if (mob.fakePlayer) { const fp = mob.fakePlayer; setTimeout(() => removeProfile(fp), config.profileRemoveDelay).unref?.() } // let the death animation play
        continue
      }
      if (d.nametag && Math.max(0, Math.ceil(mob.health)) !== d.shownHealth) applyNametag(mob)
    }
  })

  // mob AI profile for player bodies: melee like a zombie (the mob AI only drives `mob` entities, never real players)
  function registerPlayerProfile () {
    const ai = serv.mobAI
    if (!ai || !ai.registerProfile) return
    const g = ai.goals
    ai.registerProfile('player', {
      type: 'hostile',
      height: 1.8,
      reach: 1.7,
      attributes: { maxHealth: 20, movementSpeed: 3.6, attackDamage: 3, followRange: 35, knockbackResistance: 0 },
      goals: [[1, a => new g.SwimGoal(a)], [1, a => new g.NearestAttackableTargetGoal(a)], [2, a => new g.MeleeAttackGoal(a, 1)], [3, a => new g.WanderAroundGoal(a, 0.8)], [4, a => new g.LookAtEntityGoal(a)]]
    })
  }
  if (serv.pluginsReady) registerPlayerProfile()
  else serv.once('pluginsReady', registerPlayerProfile)

  // ---- melee damage ---------------------------------------------------------------------------------------------------
  // Core's attack handler calls takeDamage with no damage, which is 1 hp. For dungeon mobs, replace that with the SkyBlock formula
  //   (5 + floor(strength / 5)) * (1 + strength / 100) * (1 + crit_damage / 100 on a crit)
  // from the player's skyblock-stats (weapon damage and enchantments are not read yet). Override with config.damageFn(player, mob, base).
  function meleeDamage (player, mob) {
    const stat = id => { try { return Number(player.skyblock.stats.get(id)) || 0 } catch { return 0 } }
    const strength = stat('strength')
    const crit = Math.random() * 100 < stat('crit_chance')
    let damage = (5 + Math.floor(strength / 5)) * (1 + strength / 100)
    if (crit) damage *= 1 + stat('crit_damage') / 100
    damage = Math.max(1, Math.round(damage))
    return config.damageFn ? config.damageFn(player, mob, damage) : damage
  }

  function list ({ roomId, star, alive } = {}) {
    return Object.values(serv.entities).filter(e => e.dungeon &&
      (roomId === undefined || e.dungeon.roomId === roomId) &&
      (star === undefined || e.dungeon.star === star) &&
      (alive === undefined || (e.health > 0) === alive))
  }

  serv.dungeonMobs = { spawn, spawnGroup: (specs, shared = {}) => specs.map(({ mob, position, ...own }) => spawn(mob, position, { ...shared, ...own })), list, setArmor, equip, meleeDamage, refreshNametag: applyNametag, skins, catalog: CATALOG, modifiers: MODIFIERS, config }

  serv.commands.add({
    base: 'dmob',
    info: 'Spawn a Catacombs mob',
    usage: '/dmob <mob> [star] [floor=N] [master] [modifier=<name>] [armor=<material>] [skin=<key>]   (/dmob list)',
    op: true,
    action (params, ctx) {
      const [name, ...flags] = String(params || '').trim().split(/\s+/)
      if (!name || name === 'list') return 'Mobs: ' + Object.keys(CATALOG).join(', ')
      const player = ctx && ctx.player
      if (!player) return 'Only players can use /dmob'
      const opts = {}
      for (const f of flags) {
        const [k, v] = f.split('=')
        if (k === 'star') opts.star = true
        else if (k === 'master') opts.master = true
        else if (k === 'floor') opts.floor = parseInt(v, 10) || 0
        else if (k === 'modifier') opts.modifier = v
        else if (k === 'armor') opts.armor = v
        else if (k === 'skin') opts.skin = v
      }
      const yaw = player.yaw || 0
      const ahead = player.position.offset(-Math.sin(yaw) * 2, 0, Math.cos(yaw) * 2)
      try {
        const mob = spawn(name, ahead, { ...opts, world: player.world })
        return `Spawned ${mob.dungeon.tag} (${mob.dungeon.maxHealth.toLocaleString('en-US')} hp)`
      } catch (e) {
        return `Could not spawn: ${e.message}`
      }
    }
  })

  serv.dungeonMobs.config.meleeDamage ??= true

  serv.info?.(`[dungeon-mobs] ready; ${Object.keys(CATALOG).length} mobs in the catalogue`)
}

module.exports.player = function (player, serv) {
  player.on('attack', (data, cancelled) => {
    const mob = data && data.attackedEntity
    const dm = serv.dungeonMobs
    if (cancelled || !mob || !mob.dungeon || !dm || !dm.config.meleeDamage) return
    data.damage = dm.meleeDamage(player, mob)
  })
}
