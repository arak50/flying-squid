/**
 * skyblock-damage — SkyBlock melee damage for players hitting entities, plus the floating damage number above the target.
 * Needs `skyblock-stats` for the stats (without a loaded profile a hit does the base 5). Works with `dungeon-mobs` and plain core mobs.
 * Load order in settings does not matter.
 *
 * Core's pvp plugin still applies the hit (health, sound, hurt animation, death); this plugin only sets the damage:
 * on the player's `attack` event it writes `data.damage` (and `data.critical`), which core's takeDamage then uses.
 *
 *   damage = (5 + weapon damage + floor(strength / 5)) * (1 + strength / 100) * (1 + crit_damage / 100, on a crit)
 *   crit   = random roll under Crit Chance
 *   inputs come from player.skyblock.stats (strength, crit_chance, crit_damage) and the held item's Damage.
 *   Not covered yet: enchantments, ferocity, reforges, mob defense.
 *
 *   serv.skyblock.damage.calculate(player, target)       -> { damage, critical }
 *   serv.skyblock.damage.spawnIndicator(target, damage, { critical })    the floating number (an invisible armour stand with a custom name)
 *   serv.skyblock.damage.config                           live settings
 *   Event: player 'skyblock:damage' ({ target, damage, critical })
 *
 * Indicators cannot be hit; hitting a name-tag stand (`stand.tagOf`) hits its owner instead. Players are not touched unless `players: true`.
 * While this plugin is loaded it switches off dungeon-mobs' own `meleeDamage` (the two would overwrite each other); `takeOverDungeonMobs: false` keeps theirs.
 *
 * config/settings.json: "skyblock-damage": { "indicator": true, "indicatorMs": 1000, "minDamage": 1, "players": false, "takeOverDungeonMobs": true }
 *   indicator            show the damage number
 *   indicatorMs          how long it stays
 *   minDamage            every hit does at least this much
 *   players              also change the damage of player-vs-player hits
 *   damageFn             (player, target, { damage, critical }) => number | { damage, critical }   hook to add enchants etc. (code only, not JSON)
 */
const { Vec3 } = require('vec3')
const { calculate, statsOf } = require('./lib/damage')
const { damageComponent, componentToNbt } = require('./lib/indicator')

module.exports.server = function (serv) {
  const config = Object.assign({ indicator: true, indicatorMs: 1000, minDamage: 1, players: false, takeOverDungeonMobs: true, damageFn: undefined }, (this && this.settings) || {})
  const registry = serv.registry
  serv.skyblock = serv.skyblock || {}

  // ---- entity metadata plumbing (indices and type ids come from the registry, with vanilla values as fallback) ----------
  let typeIds = null
  try {
    const mappings = registry.protocol.types.entityMetadataEntry[1][1].type[1].mappings // id -> name
    typeIds = {}
    for (const [id, name] of Object.entries(mappings)) typeIds[name] = Number(id)
  } catch (e) { /* old protocol layout: keep the fallbacks below */ }
  const TYPE_BYTE = typeIds?.byte ?? 0
  const TYPE_OPTIONAL_COMPONENT = typeIds?.optional_component ?? 6
  const TYPE_BOOLEAN = typeIds?.boolean ?? 8
  const keyIndex = (entityTypeId, names, fallback) => {
    const keys = (registry.entities?.[entityTypeId]?.metadataKeys) || []
    for (const n of names) { const i = keys.indexOf(n); if (i !== -1) return i }
    return keys.length ? undefined : fallback // no key list in this registry: vanilla index, else do not send (a wrong index disconnects the client)
  }
  const merge = (entity, entries) => { entity.metadata = (entity.metadata || []).filter(e => !entries.some(n => n.key === e.key)).concat(entries) }

  // registry.mobs only lists a handful of types on 26.1 (mob-ai patches the rest in); make sure the stand is spawnable either way
  function ensureSpawnable (def) {
    if (registry.mobs && !registry.mobs[def.id]) registry.mobs[def.id] = def
  }

  // ---- damage ---------------------------------------------------------------------------------------------------------
  function calc (player, target) {
    let out = calculate(statsOf(player), { min: config.minDamage })
    if (typeof config.damageFn === 'function') {
      const r = config.damageFn(player, target, out)
      if (typeof r === 'number') out = { ...out, damage: Math.max(config.minDamage, r) }
      else if (r && typeof r.damage === 'number') out = { ...out, ...r, damage: Math.max(config.minDamage, r.damage) }
    }
    return out
  }

  // ---- indicator ------------------------------------------------------------------------------------------------------
  function spawnIndicator (target, damage, { critical = false } = {}) {
    const def = registry.entitiesByName.armor_stand
    if (!def || !target || !target.position) return null
    ensureSpawnable(def)
    const height = target.height || (target.dungeon && target.dungeon.scale ? 1.8 * target.dungeon.scale : 1.8)
    const p = target.position
    const pos = new Vec3(p.x + (Math.random() - 0.5) * 1.2, p.y + height * 0.6 + Math.random() * 0.6, p.z + (Math.random() - 0.5) * 1.2)
    let stand
    try { stand = serv.spawnMob(def.id, target.world, pos) } catch (e) { serv.err?.(`[skyblock-damage] spawn failed: ${e.message}`); return null }
    if (!stand) return null
    stand.isDamageIndicator = true
    stand.size = null // core's physics loop skips entities without a size: no gravity, no collision
    if (stand.gravity) stand.gravity.set(0, 0, 0)

    const flags = keyIndex(def.id, ['armor_stand_flags', 'armor_stand_data', 'client_flags'], 15)
    const noGravity = keyIndex(def.id, ['no_gravity'], 5)
    const silent = keyIndex(def.id, ['silent'], 4)
    const nameKey = keyIndex(def.id, ['custom_name'], 2)
    const visibleKey = keyIndex(def.id, ['custom_name_visible'], 3)
    const entries = [{ key: 0, type: TYPE_BYTE, value: 0x20 }] // invisible
    if (flags !== undefined) entries.push({ key: flags, type: TYPE_BYTE, value: 0x10 }) // marker: no hitbox
    if (noGravity !== undefined) entries.push({ key: noGravity, type: TYPE_BOOLEAN, value: true })
    if (silent !== undefined) entries.push({ key: silent, type: TYPE_BOOLEAN, value: true })
    if (nameKey !== undefined) entries.push({ key: nameKey, type: TYPE_OPTIONAL_COMPONENT, value: componentToNbt(damageComponent(damage, critical)) })
    if (visibleKey !== undefined) entries.push({ key: visibleKey, type: TYPE_BOOLEAN, value: true })
    merge(stand, entries) // players who walk into range later get the same metadata
    try { stand.sendMetadata(entries) } catch (e) { serv.err?.(`[skyblock-damage] metadata failed: ${e.message}`) }

    const timer = setTimeout(() => { if (serv.entities[stand.id]) serv.destroyEntity(stand) }, config.indicatorMs)
    if (timer.unref) timer.unref()
    return stand
  }

  serv.skyblock.damage = { calculate: calc, spawnIndicator, config }

  // dungeon-mobs applies its own (weapon-less) formula on the same event; this plugin replaces it
  const takeOver = () => {
    const dm = serv.dungeonMobs
    if (config.takeOverDungeonMobs && dm && dm.config) dm.config.meleeDamage = false
  }
  takeOver()
  setImmediate(takeOver) // dungeon-mobs may load after this plugin and set its default afterwards
  serv.info?.('[skyblock-damage] ready')
}

module.exports.player = function (player, serv) {
  // damage indicators cannot be hit: cancel before core's takeDamage, without running its cancel callback
  player.on('attack_cancel', (data, cancel) => {
    if (data && data.attackedEntity && data.attackedEntity.isDamageIndicator) cancel(false)
  })

  player.on('attack', (data, cancelled) => {
    const api = serv.skyblock && serv.skyblock.damage
    if (cancelled || !data || !data.attackedEntity || !api) return
    if (api.config.takeOverDungeonMobs && serv.dungeonMobs && serv.dungeonMobs.config) serv.dungeonMobs.config.meleeDamage = false

    let target = data.attackedEntity
    if (target.tagOf) target = data.attackedEntity = target.tagOf // a name-tag stand hits its owner
    if (target.type === 'player' && !api.config.players) return
    if (!(target.health > 0)) return // already dead

    const { damage, critical } = api.calculate(player, target)
    data.damage = damage
    data.critical = critical
    if (api.config.indicator) api.spawnIndicator(target, damage, { critical })
    player.emit('skyblock:damage', { target, damage, critical })
  })
}
