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
 *   armor           armour / held items (default: the catalogue's, see ARMOR in lib/catalog.js), see lib/armor.js: 'diamond' | { material:'leather', color } | { helmet, chestplate, leggings, boots, mainhand, offhand }
 *   variant         armour variant for mobs that have them (Lost Adventurer: young | unstable | holy | superior) [random]
 *   skin            skin key from skins/skins.json for the mobs drawn as players (default: the catalogue's)
 *
 * Also:  serv.dungeonMobs.spawnGroup([{ mob, position, star, ... }, ...], sharedOptions)
 *        serv.dungeonMobs.setArmor(mob, spec)   serv.dungeonMobs.equip(mob, 'helmet', 'iron_helmet')   (live, nearby players see it)
 *        serv.dungeonMobs.list({ roomId, star, alive })     serv.dungeonMobs.catalog
 * Event: serv.emit('dungeonMobSpawned', entity)
 * Command (op): /dmob <mob> [star] [floor=N] [master] [modifier=<name>] [armor=<material>] [skin=<key>] [variant=<name>]
 *
 * Plugin settings: { glyphs: [{ text, color }], randomHealth: true, modifierChance: <overrides the per-mob chance>, players: true }
 *
 * Melee: players hitting a dungeon mob deal stat-based damage (see meleeDamage); set `meleeDamage: false` to keep core's 1 hp.
 * Death: player bodies get their death animation from a health metadata update (clients ignore entity_status 3 for players); the corpse is removed after `deathAnimationMs` [1000].
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
const look = require('./lib/look')

const MASTER_TIERS = 7 // M1-M7 sit after F7 on the stat scale

const lerpGeo = (lo, hi, p) => (lo <= 0 || hi <= 0 || lo === hi) ? lo + (hi - lo) * p : lo * Math.pow(hi / lo, p)
const pick = a => a[Math.floor(Math.random() * a.length)]

module.exports.server = function (serv, options) {
  const config = Object.assign({ glyphs: [], randomHealth: true, modifierChance: undefined, players: true, profileRemoveDelay: 3000, deathAnimationMs: 1000, tagLift: 0.15, npcLookRange: 10, npcLookEvery: 4 }, (this && this.settings) || {})
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

  // Mobs with armour variants (Lost Adventurer: young / unstable / holy / superior) get a random one unless asked for
  function resolveVariant (def, variant) {
    if (!def.armorVariants) return null
    const keys = Object.keys(def.armorVariants)
    if (variant === undefined || variant === null) return pick(keys)
    const key = normalise(variant)
    if (!def.armorVariants[key]) throw new Error(`Unknown variant: ${variant} (${keys.join(', ')})`)
    return key
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
  const TYPE_FLOAT = typeIds?.float ?? 3
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
    if (d.npc) return // NPC names are the line stands, made once
    const target = d.tagEntity || mob
    const health = Math.max(0, Math.ceil(mob.health))
    const component = d.npc ? { text: '', extra: [{ text: d.name, color: d.nameColor }] } : nametagComponent({ name: d.name, star: d.star, health, modifier: d.modifier ? MODIFIERS[d.modifier].prefix : null, glyphs: config.glyphs, nameColor: d.nameColor })
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

  // A player entity shows its profile name (the random "dm1a2b3c4d") above its head. The tag stand carries the real text, so the profile names
  // go into a scoreboard team whose name tags are never shown (the old rider stand hid the plate by being a passenger). Packet fields
  // differ by version: 26.1 names the modes and visibility values, 1.21.x numbers them.
  const TEAM = 'dm_hidden'
  const teamsNamed = () => { try { return Array.isArray(registry.protocol.play.toClient.types.packet_teams[1][1].type) } catch (e) { return true } }
  function teamPacket (mode, players) {
    const named = teamsNamed(); const empty = componentToNbt({ text: '' })
    if (mode === 'join' || mode === 'leave') return { team: TEAM, mode: named ? mode : (mode === 'join' ? 3 : 4), players }
    return named
      ? { team: TEAM, mode: 'add', name: empty, flags: { friendly_fire: false, see_friendly_invisible: false }, nameTagVisibility: 'never', collisionRule: 'never', formatting: 21, prefix: empty, suffix: empty, players }
      : { team: TEAM, mode: 0, name: empty, friendlyFire: 0, nameTagVisibility: 'never', collisionRule: 'never', formatting: 21, prefix: empty, suffix: empty, players }
  }
  function hideProfileName (player, name) {
    try {
      if (!player._dmTeam) { player._dmTeam = true; player._client.write('teams', teamPacket('add', [name])) } else player._client.write('teams', teamPacket('join', [name]))
    } catch (e) { serv.err?.(`[dungeon-mobs] team failed: ${e.message}`) }
  }

  function removeProfile (fp) {
    try {
      for (const pl of serv.players) if (pl._dmTeam) pl._client.write('teams', teamPacket('leave', [fp.name]))
    } catch (e) { /* client gone */ }
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
        if (entity.fakePlayer) {
          try { player._client.write('player_info', infoPacket(entity.fakePlayer)) } catch (e) { serv.err?.(`[dungeon-mobs] player_info failed: ${e.message}`) }
          hideProfileName(player, entity.fakePlayer.name)
        }
      }
      spawnOriginal(entity)
      if (entity.dungeon && standsOf(entity).length) sendTag(player, entity)
      if (entity.dungeon && entity.dungeon.scale) sendScale(entity, [player])
    }
    player.despawnEntities = entities => {
      // a player body that is playing its death animation stays until playDeath removes it (core would drop it as soon as a player moves)
      const now = Date.now()
      entities = entities.filter(e => !(e._dmobDyingUntil > now))
      if (!entities.length) return
      despawnOriginal(entities)
      const ids = entities.flatMap(e => (e.dungeon ? standsOf(e) : []).map(st => st.id))
      if (ids.length) { try { player._client.write('entity_destroy', { entityIds: ids }) } catch (e) { /* client gone */ } }
    }
  }
  {
    const bad = skins.unsigned()
    if (bad.length) serv.info?.(`[dungeon-mobs] ${bad.length} skin(s) have no signed textures property and will show as the default skin in vanilla clients: ${bad.join(', ')} (see lib/skins.js)`)
  }
  serv.on('newPlayer', install)
  for (const p of serv.players || []) install(p)

  // [capture] Hypixel's tags are free invisible armour stands at generic.scale 0.1, not riders. Dungeon mobs: marker stands (flags 0x10),
  // 2.09-2.19 above a zombie / skeleton's feet (= its height + ~0.15), kept on the mob by position packets. NPCs (Mort, lobby NPCs): stacks of
  // ordinary stands (flags 0), "Mort" at the NPC's feet height and "CLICK" 0.25 below. The client puts the text 0.5 above a marker stand and
  // 1.975 + 0.5 above an ordinary one (armour stands ignore generic.scale for their size), so both land a little over the head.
  const TAG_SCALE = 0.1
  const BODY_HEIGHT = 1.8 // player model
  // [capture] the Watcher's guardians (generic.scale 0.28) carry their tag stand 2.13-2.16 above their feet, whatever their scale (`tagDy` in the catalogue);
  // other mobs: the body height plus a lift that does not shrink with the body
  const tagDy = mob => mob.dungeon.tagDy !== undefined ? mob.dungeon.tagDy : BODY_HEIGHT * (mob.dungeon.scale || 1) + config.tagLift
  function makeStand (mob, world, pos, { marker, component }) {
    const def = registry.entitiesByName.armor_stand
    if (!def) return null
    ensureSpawnable(def)
    creatingTag = true
    let stand
    try { stand = serv.spawnMob(def.id, world, pos) } finally { creatingTag = false }
    stand.tagOf = mob
    stand.size = null // core's physics loop skips entities without a size: stock gravity/collision made the stands hop up 0.9 and fall ("jumping" lines)
    if (stand.gravity) stand.gravity.set(0, 0, 0)
    const flags = keyIndex(def.id, ['armor_stand_flags', 'armor_stand_data', 'client_flags'], 15)
    const noGravity = keyIndex(def.id, ['no_gravity'], 5)
    const silent = keyIndex(def.id, ['silent'], 4)
    const entries = [{ key: 0, type: TYPE_BYTE, value: 0x20 }] // invisible
    if (flags !== undefined) entries.push({ key: flags, type: TYPE_BYTE, value: marker ? 0x10 : 0 })
    if (noGravity !== undefined) entries.push({ key: noGravity, type: TYPE_BOOLEAN, value: true }) // else the client drops it to the floor and the server snaps it back: the line "jumps"
    if (silent !== undefined) entries.push({ key: silent, type: TYPE_BOOLEAN, value: true })
    if (component) {
      const k = metaKeys(def.id)
      entries.push({ key: k.name, type: TYPE_OPTIONAL_COMPONENT, value: componentToNbt(component) }, { key: k.visible, type: TYPE_BOOLEAN, value: true })
    }
    merge(stand, entries)
    return stand
  }
  function createTag (mob) {
    const p = mob.position
    const stand = makeStand(mob, mob.world, new Vec3(p.x, p.y + tagDy(mob), p.z), { marker: true })
    if (stand) stand.followDy = true
    return stand
  }
  // NPC name lines: [{ text, color, bold, dy }] from the top; static stands
  function createNpcLines (mob, def, world, pos) {
    return (def.lines || []).map(line => {
      const { dy, ...part } = line
      return makeStand(mob, world, new Vec3(pos.x, pos.y + dy, pos.z), { marker: false, component: { text: '', extra: [part] } })
    }).filter(Boolean)
  }
  const standsOf = mob => [mob.dungeon.tagEntity, ...(mob.dungeon.lineStands || [])].filter(Boolean)
  function sendStand (player, stand) {
    player._dmobSpawnStand(stand)
    player._client.write('entity_update_attributes', { entityId: stand.id, properties: [{ key: 'generic.scale', value: TAG_SCALE, modifiers: [] }] })
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
    const variant = resolveVariant(def, opts.variant)
    const modifier = resolveModifier(opts.modifier, def)
    const mod = modifier ? MODIFIERS[modifier] : {}

    // health: scale by floor, room-entering bonus, per-mob randomisation (-2000..+6000), modifier
    let maxHealth
    if (opts.health !== undefined) {
      maxHealth = opts.health
    } else {
      maxHealth = scale(def.health, def, floor, master)
      if (opts.roomsExplored > 0) maxHealth *= 1 + 0.05 * (opts.roomsExplored - 1)
      if (config.randomHealth && def.kind !== 'special' && def.kind !== 'npc') maxHealth = Math.max(maxHealth * 0.25, maxHealth + 1000 * (-2 + Math.random() * 8))
      maxHealth *= mod.healthMul || 1
      maxHealth = Math.max(1, Math.round(maxHealth))
    }

    const pos = position instanceof Vec3 ? position : new Vec3(position.x, position.y, position.z)
    const world = opts.world || position.world || serv.overworld
    pendingProfile = profile ? { name: 'dm' + Math.random().toString(16).slice(2, 10), properties: profile.properties } : null
    let mob
    try {
      mob = serv.spawnMob(entity.id, world, pos, { yaw: opts.yaw || 0, pitch: opts.pitch || 0, headPitch: opts.yaw || 0 }) // yaw / headPitch (= head yaw) are protocol angle bytes
    } finally { pendingProfile = null }

    let defense = scale(def.defense, def, floor, master)
    defense *= mod.defenseMul || 1
    mob.health = maxHealth
    mob.maxHealth = maxHealth
    mob.dungeon = {
      key,
      name: def.name,
      kind: def.kind,
      npc: !!def.npc,
      body: bodyName,
      skin: profile ? profile.key : null,
      star: !!opts.star,
      canBeStar: def.star,
      nameColor: def.nameColor ?? 'red',
      floor,
      master,
      variant,
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
      tagEntity: null,
      lineStands: [],
      homeYaw: 0
    }

    // the mob AI (if installed) just gave it a 20 hp vanilla profile: keep its idea of max health in step
    const ai = serv.mobAI?.get?.(mob)
    if (ai) { ai.attributes.maxHealth = maxHealth; if (ai.lastHealth !== undefined) ai.lastHealth = maxHealth }

    if (profile) {
      // skin layers (hat, jacket, sleeves, pants) are off unless the client is told
      const layers = keyIndex(entity.id, ['player_mode_customisation', 'player_model_customisation', 'skin_parts'], undefined)
      if (layers !== undefined) { const e = [{ key: layers, type: TYPE_BYTE, value: 0x7f }]; merge(mob, e); send(mob, e) }
      const early = opts.scale !== undefined ? opts.scale : def.scale
      if (early) mob.dungeon.scale = early // the tag height depends on it (sent to the clients below)
      if (def.tagDy !== undefined) mob.dungeon.tagDy = def.tagDy
      if (opts.nametag !== false && !def.npc) mob.dungeon.tagEntity = createTag(mob)
      if (def.npc) mob.dungeon.lineStands = createNpcLines(mob, def, world, pos)
      // players that already see the mob were sent it before the tag existed: add the tag for them now
      if (standsOf(mob).length) for (const p of mob.getNearby().filter(e => e.type === 'player')) { if (p._dmobInstalled) sendTag(p, mob) }
    }

    if (def.npc) { mob.dungeon.homeYaw = (opts.yaw || 0) * 360 / 256; makeNpc(mob) }
    applyNametag(mob)
    tracked.add(mob)
    let armor = opts.armor !== undefined ? opts.armor : (variant && def.armorVariants ? def.armorVariants[variant] : def.armor)
    if (typeof armor === 'function') armor = armor({ floor, master, variant, star: !!opts.star })
    if (armor) setArmor(mob, armor)
    const bodyScale = opts.scale !== undefined ? opts.scale : def.scale
    if (bodyScale) { mob.dungeon.scale = bodyScale; sendScale(mob) }
    serv.emit('dungeonMobSpawned', mob)
    return mob
  }
  // ---- NPCs (Mort): no AI, cannot be hurt, optional second tag line under the name --------------------------------------
  function makeNpc (mob) {
    const ai = serv.mobAI && serv.mobAI.get && serv.mobAI.get(mob)
    if (ai) { // the 'player' AI profile is a zombie: swap its goals for none, so it stands where it was put
      ai.selector.stopAll()
      ai.selector = new ai.selector.constructor({ startInterval: 2 })
      ai.attributes.knockbackResistance = 1
    }
    mob.invulnerable = true
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
    try { for (const stand of standsOf(mob)) sendStand(player, stand) } catch (e) { serv.err?.(`[dungeon-mobs] tag failed: ${e.message}`) }
  }
  // the tag stands are not passengers any more: put each one back over its mob when the mob has moved
  // NPCs face the nearest player in range (entity_look + entity_head_rotation, only when the angle changed), and turn back to where they were put
  function npcLook (mob) {
    const d = mob.dungeon
    const players = serv.players.filter(p => p.world === mob.world && p.gameMode !== 3 && p.position)
    const target = look.nearest(mob.position, players, config.npcLookRange)
    let yawDeg; let pitchDeg
    if (target) {
      const a = look.lookAngles(mob.position, target.position)
      if (a.yaw === null) return // standing right on top of it
      yawDeg = a.yaw; pitchDeg = a.pitch
    } else { yawDeg = d.homeYaw; pitchDeg = 0 }
    const yaw = look.angleByte(yawDeg); const pitch = look.angleByte(pitchDeg)
    if (yaw === mob.yaw && pitch === mob.pitch) return
    mob.yaw = yaw; mob.pitch = pitch; mob.headPitch = yaw // headPitch is the head yaw byte in spawn packets
    try {
      mob._writeOthersNearby('entity_look', { entityId: mob.id, yaw, pitch, onGround: true })
      mob._writeOthersNearby('entity_head_rotation', { entityId: mob.id, headYaw: yaw })
    } catch (e) { serv.err?.(`[dungeon-mobs] npc look failed: ${e.message}`) }
  }
  function followTags (mob) {
    const st = mob.dungeon.tagEntity
    if (!st || !st.followDy) return
    const t = mob.position; const dy = tagDy(mob)
    if (st.position.x === t.x && st.position.y === t.y + dy && st.position.z === t.z) return
    const to = new Vec3(t.x, t.y + dy, t.z)
    try { Promise.resolve(st.sendPosition(to, false, to.distanceTo(st.position) > 7)).catch(() => {}) } catch (e) { /* stand gone */ }
  }

  // ---- death animation for player bodies ------------------------------------------------------------------------------------
  // Core sends `entity_status 3` when a mob dies and then forgets the entity. Clients ignore that status for player-type entities
  // (their death is driven by the health metadata dropping to 0), so a player body would just stand there and then be despawned.
  // Send the health metadata, keep the body for the length of the animation, then remove it.
  function playDeath (mob) {
    const key = keyIndex(mob.entityType, ['health', 'living_entity_health'], 9)
    if (key === undefined) return // unknown layout: nothing better to do than the core behaviour
    mob._dmobDyingUntil = Date.now() + config.deathAnimationMs
    const entries = [{ key, type: TYPE_FLOAT, value: 0 }]
    merge(mob, entries)
    send(mob, entries)
    setTimeout(() => {
      mob._dmobDyingUntil = 0
      try { serv.destroyEntity(mob) } catch (e) { /* already gone */ }
    }, config.deathAnimationMs).unref?.()
  }

  // ---- upkeep: health bar follows mob.health, tags and fake profiles are removed with their mob ------------------------
  let ticks = 0
  serv.on('tick', () => {
    ticks++
    for (const mob of tracked) {
      const d = mob.dungeon
      if (!serv.entities[mob.id]) { // killed (core deletes the entity) or removed
        tracked.delete(mob)
        for (const st of standsOf(mob)) { try { serv.destroyEntity(st) } catch (e) { /* already gone */ } }
        d.tagEntity = null; d.lineStands = []
        if (mob.fakePlayer) {
          const killed = mob.health <= 0 // else it was just removed: no animation
          if (killed) playDeath(mob)
          const fp = mob.fakePlayer
          setTimeout(() => removeProfile(fp), killed ? Math.max(config.profileRemoveDelay, config.deathAnimationMs + 250) : config.profileRemoveDelay).unref?.() // after the corpse is gone
        }
        continue
      }
      followTags(mob)
      if (d.npc && ticks % config.npcLookEvery === 0) npcLook(mob)
      if (d.nametag && !d.npc && Math.max(0, Math.ceil(mob.health)) !== d.shownHealth) applyNametag(mob)
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
    usage: '/dmob <mob> [star] [floor=N] [master] [modifier=<name>] [armor=<material>] [skin=<key>] [variant=<name>]   (/dmob list)',
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
        else if (k === 'variant') opts.variant = v
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
  // NPCs cannot be hurt: cancel the attack before core's takeDamage (without running its cancel callback)
  player.on('attack_cancel', (data, cancel) => { if (data && data.attackedEntity && data.attackedEntity.dungeon && data.attackedEntity.dungeon.npc) cancel(false) })
  player.on('attack', (data, cancelled) => {
    const mob = data && data.attackedEntity
    const dm = serv.dungeonMobs
    if (cancelled || !mob || !mob.dungeon || !dm || !dm.config.meleeDamage) return
    data.damage = dm.meleeDamage(player, mob)
  })
}
