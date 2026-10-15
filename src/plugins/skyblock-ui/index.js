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
const Windows = require('./lib/windows')
const specs = require('./data/ui-specs.json')
const skyblockMenu = require('./lib/menus/skyblockMenu')
const statsEquipment = require('./lib/menus/statsEquipment')

module.exports.server = function (serv) {
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
      return {
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
  player._client.on('use_item', useStar)
  player._client.on('block_place', useStar)
}
