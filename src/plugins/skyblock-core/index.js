/**
 * skyblock-core — the backend every SkyBlock feature reads from (see docs/skyblock/ARCHITECTURE.md).
 *
 * First join: the player's selected SkyBlock profile is fetched through `hypixel-api`, converted to a ProfileState
 * (inventory, armour, equipment, accessory bag, ender chest, backpacks, vault, bags, armour/equipment sets, API snapshot
 * for skills/collections/...) and saved.  Every later join loads the saved profile — the API is not asked again
 * until the player runs /sbreset.
 *
 *   player.skyblock.profile                 ProfileState   .container('inventory'|'armor'|'equipment'|'accessoryBag'|'enderChest'|...)
 *   player.skyblock.imported                true once the profile is attached
 *   player.on('skyblockProfileReady', profile)
 *   profile.on('change', { container, index, reason })     every item movement, from any source
 *   serv.skyblock.core.equip(player, {container:'inventory', index}) / .unequip(player, 'NECKLACE')
 *   serv.skyblock.core.save(player) / .reset(player)
 *
 * config: "skyblock-core": { "dir": "skyblock-data/profiles", "autosaveMs": 5000 }
 * Commands: /sbreset (re-import from the API, discarding saved state)   /sbsave
 */
const path = require('path')
const { FileStore } = require('./lib/store')
const { profileFromSnapshot } = require('./lib/snapshot')
const equipment = require('./lib/equipment')

module.exports.server = function (serv) {
  const cfg = Object.assign({ dir: path.join(process.cwd(), 'skyblock-data', 'profiles'), autosaveMs: 5000 }, this.settings || {})
  let store = null
  const timers = new Map()

  async function getStore () {
    if (store) return store
    if (!serv.hypixel) throw new Error('skyblock-core needs the hypixel-api plugin')
    store = new FileStore(cfg.dir, await serv.hypixel.getConverter())
    return store
  }

  async function load (player, { reimport = false } = {}) {
    const st = await getStore()
    const uuid = player._client.uuid
    let profile = reimport ? null : st.load(uuid)
    let first = false
    if (!profile) {
      const snap = await serv.hypixel.fetchSnapshot(player, { force: reimport })
      profile = profileFromSnapshot(uuid, snap, await serv.hypixel.getConverter())
      first = true
    }
    const sb = player.skyblock = player.skyblock || {}
    if (sb.profile) sb.profile.detachWindow()
    profile.attachWindow(player)
    sb.profile = profile
    sb.member = profile.member
    sb.imported = true
    profile.on('change', () => scheduleSave(player))
    if (first) st.save(profile)
    serv.info?.(`[skyblock-core] ${player._client.username}: ${first ? 'imported' : 'loaded'} profile "${profile.cuteName}" (${profile.source})`)
    player.emit('skyblockProfileReady', profile)
    return profile
  }

  function scheduleSave (player) {
    if (timers.has(player)) return
    timers.set(player, setTimeout(() => { timers.delete(player); save(player) }, cfg.autosaveMs))
  }

  function save (player) {
    const sb = player.skyblock
    if (!sb || !sb.profile || !store) return false
    store.save(sb.profile)
    return true
  }

  async function reset (player) {
    const st = await getStore()
    const sb = player.skyblock
    if (sb && sb.profile) for (const c of ['inventory', 'armor']) { const cont = sb.profile.container(c); for (let i = 0; i < cont.size; i++) if (cont.get(i)) cont._set(i, null) }
    st.delete(player._client.uuid)
    return load(player, { reimport: true })
  }

  const need = player => { const p = player.skyblock && player.skyblock.profile; if (!p) throw new Error('profile not loaded yet'); return p }
  serv.skyblock = Object.assign(serv.skyblock || {}, {
    core: {
      cfg,
      load,
      save,
      reset,
      profile: player => (player.skyblock && player.skyblock.profile) || null,
      equip: (player, from) => equipment.equip(need(player), from),
      unequip: (player, key) => equipment.unequip(need(player), key),
      slotFor: equipment.slotFor
    }
  })

  serv.commands.add({
    base: 'sbreset',
    info: 'Re-import your SkyBlock profile from the Hypixel API (discards saved state)',
    usage: '/sbreset',
    onlyPlayer: true,
    action (_, ctx) {
      reset(ctx.player).then(p => ctx.player.chat(`Imported profile "${p.cuteName}" from ${p.source}.`)).catch(e => ctx.player.chat(serv.color.red + 'Import failed: ' + e.message))
    }
  })
  serv.commands.add({ base: 'sbsave', info: 'Save your SkyBlock profile now', usage: '/sbsave', onlyPlayer: true, action: (_, ctx) => (save(ctx.player) ? 'Saved.' : 'Nothing to save.') })
}

module.exports.player = function (player, serv) {
  player.skyblock = player.skyblock || {}
  player.once('spawned', () => {
    serv.skyblock.core.load(player).catch(e => {
      player.skyblock.importError = e.message
      serv.info?.(`[skyblock-core] ${player._client.username}: profile not loaded: ${e.message}`)
    })
  })
  player._client.once('end', () => { clearTimeout(0); serv.skyblock.core.save(player) })
}
