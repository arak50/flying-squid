/**
 * skyblock-ui — locked, server-authoritative SkyBlock menus drawn from the backend (skyblock-core + skyblock-stats).
 * Replaces the byte-replay `skyblock-menu` / `skyblock-personalize` plugins: do not load them together with this one.
 *
 *   Menus: SkyBlock Menu (opened with the star), Stats & Equipment, Your Stats Breakdown, Stats ➜ <Stat>,
 *          <Stat> ➜ Flat Bonuses / Additive Buffs.   Commands: /stats, /sbmenu
 *   Equipment and armour are the profile's containers: clicking a worn piece moves it to your inventory, clicking an
 *   equippable piece in your inventory (menu open) wears it — exactly what statsmenupackets.txt shows.
 *
 *   serv.skyblock.ui.open(player, menuFactory)   menuFactory(ctx) -> { title, items:[54], click(info) }
 *
 * Static texts, icons and layouts come from data/ui-specs.json, generated from the recordings by tools/extract-ui-specs.js.
 */
const nbt = require('prismarine-nbt')
const Windows = require('./lib/windows')
const specs = require('./data/ui-specs.json')
const skyblockMenu = require('./lib/menus/skyblockMenu')
const statsEquipment = require('./lib/menus/statsEquipment')

module.exports.server = function (serv) {
  const cfg = Object.assign({ strikeFrom: null }, this.settings || {})
  const Item = require('prismarine-item')(serv.registry)
  const windows = new Windows.WindowManager(serv)
  const ui = {
    Item,
    specs,
    conv: null,
    windows,
    open: (player, factory) => windows.open(player, factory),
    close: player => windows.close(player),
    context (player) {
      const sb = player.skyblock || {}
      if (!sb.profile) throw new Error('your SkyBlock profile is still loading')
      if (!ui.conv) throw new Error('item converter not ready')
      if (sb.stats) sb.stats.flush()
      // Which stats are struck through differs between recordings (the first two strike the mining/farming/foraging fortune
      // stats, the last two none); the cause is not in the packets. "strikeFrom" picks a recorded set, default = the latest.
      const sets = specs.strikeSets || {}
      const keys = Object.keys(sets)
      const struck = new Set([].concat(...Object.values(sets[cfg.strikeFrom] || sets[keys[keys.length - 1]] || {})))
      return {
        isStruck: name => struck.has(name),
        player,
        serv,
        specs,
        conv: ui.conv,
        profile: sb.profile,
        stats: sb.stats,
        member: sb.member || {},
        core: serv.skyblock.core,
        build: n => ui.conv.build(n),
        ui: { open: f => windows.open(player, f), close: () => windows.close(player), say: m => player.chat(m) }
      }
    }
  }
  serv.skyblock = Object.assign(serv.skyblock || {}, { ui })
  if (serv.hypixel) serv.hypixel.getConverter().then(c => { ui.conv = c })

  const cmd = (base, info, factory) => serv.commands.add({
    base,
    info,
    usage: '/' + base,
    onlyPlayer: true,
    action (_, ctx) { try { windows.open(ctx.player, factory) } catch (e) { ctx.player.chat(serv.color.red + e.message) } } // returns nothing: commands print what they return
  })
  cmd('stats', 'Open Stats & Equipment', statsEquipment)
  cmd('sbmenu', 'Open the SkyBlock Menu', skyblockMenu)
  // the recorded lore advertises these: "Also accessible via /enderchest 2", "/backpack 3"
  const storageMenus = require('./lib/menus/storage')
  const withPage = (base, info, make) => serv.commands.add({
    base,
    info,
    usage: `/${base} [number]`,
    onlyPlayer: true,
    action (params, ctx) { try { windows.open(ctx.player, c => make(c, Math.max(1, parseInt(params, 10) || 1))) } catch (e) { ctx.player.chat(serv.color.red + e.message) } }
  })
  cmd('storage', 'Open Storage', storageMenus.storage)
  withPage('enderchest', 'Open an ender chest page', storageMenus.enderChest)
  withPage('backpack', 'Open a backpack', storageMenus.backpack)
}

module.exports.player = function (player, serv) {
  const ui = serv.skyblock.ui
  ui.windows.attach(player)
  const holdingStar = () => {
    const p = player.skyblock && player.skyblock.profile; if (!p || !ui.conv) return false
    const it = p.container('inventory').get(player.heldItemSlot || 0)
    const n = it && ui.conv.neutralFromItem(it)
    return !!(n && n.extra && n.extra.id === 'SKYBLOCK_MENU')
  }
  const useStar = () => {
    if (player.ui.win || !holdingStar()) return
    try { ui.windows.open(player, skyblockMenu) } catch (e) { serv.err?.(e.message) }
  }
  // Every SkyBlock player has the menu star. Some imported inventories lack it: put it in hotbar slot 9 (where the recorded
  // profile has it); if that slot is taken, the first free hotbar slot, then the first free slot. (What Hypixel does when the
  // slot is occupied was not recorded.)
  player.on('skyblockProfileReady', async (profile) => {
    const conv = await serv.hypixel.getConverter()
    const inv = profile.container('inventory')
    // earlier builds could turn the star into a plain nether star (a split dropped its data) and add a second one on the next
    // join; no imported SkyBlock item is a data-less nether star, so those are removed
    const netherStar = serv.registry.itemsByName.nether_star.id
    for (let i = 0; i < inv.size; i++) {
      const it = inv.get(i)
      if (it && it.type === netherStar && !(it.components || []).some(c => c.type === 'custom_data')) inv.set(i, null, 'repair')
    }
    if (inv.items().some(it => it && (conv.neutralFromItem(it).extra || {}).id === 'SKYBLOCK_MENU')) return
    const slot = !inv.get(8) ? 8 : inv.firstEmpty([...Array(36).keys()])
    if (slot < 0) return serv.info?.(`[skyblock-ui] ${player._client.username}: inventory full, no room for the SkyBlock Menu star`)
    inv.set(slot, conv.build(ui.specs.items.skyblockStar), 'star')
  })
  // Clicking the star in the inventory screen opens the SkyBlock Menu and never picks the star up (recorded: the server
  // answers with an empty cursor and open_window "SkyBlock Menu"). The star cannot be moved by any click mode.
  const isStar = item => {
    const cd = item && (item.components || []).find(c => c.type === 'custom_data')
    return !!(cd && nbt.simplify(cd.data).id === 'SKYBLOCK_MENU')
  }
  ;(player.inventoryClickFilters = player.inventoryClickFilters || []).push(click => {
    if (click.windowId !== 0 || click.slot < 0 || !isStar(player.inventory.slots[click.slot])) return false
    if (click.mode === 0) setImmediate(() => { try { ui.windows.open(player, skyblockMenu) } catch (e) { serv.err?.(e.message) } })
    return true
  })
  player._client.on('use_item', useStar)
  player._client.on('block_place', useStar)
}
