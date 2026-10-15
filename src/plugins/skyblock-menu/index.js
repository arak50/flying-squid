/**
 * skyblock-menu — replays the SkyBlock menu captured from a protocol sniff, byte for byte.
 *
 * Data: data/screens.json (made by tools/extract-skyblock-menus.js). Every item is the raw Slot bytes
 * the real server sent; navigation follows the clicks seen in the capture.
 *
 *   serv.skyblockMenu.open(player, 'your_skills')
 *   serv.skyblockMenu.addHook(async (view, { player, screenId }) => { view.edit(13, item => ...) })
 *
 * Opens with: right-click the hotbar star (slot 9), or /sbmenu [screen]  /skills  /pets  /stats  /storage ...
 * config: "skyblock-menu": { "starSlot": 8, "giveStar": true }
 */
const { MenuEngine } = require('./lib/engine')

const ALIASES = {
  sbmenu: 'skyblock_menu',
  skills: 'your_skills',
  collection: 'collections',
  recipes: 'recipe_book',
  stats: 'stats_equipment',
  pets: '1_4_pets',
  storage: 'storage',
  levels: 'skyblock_leveling',
  bank: 'bank',
  calendar: 'calendar_and_events',
  warp: 'fast_travel',
  loadouts: '1_3_loadouts',
  viewsettings: 'settings',
  boostercookie: 'booster_cookie'
}

module.exports.server = function (serv, options) {
  const engine = serv.skyblockMenu = new MenuEngine(serv, this.settings || {})
  serv.info?.(`[skyblock-menu] ${Object.keys(engine.screens).length} screens loaded from ${engine.data.source}`)

  // commands print whatever their action resolves to, so never let open()'s result (an object) escape
  const open = (ctx, id) => engine.open(ctx.player, id).then(() => undefined).catch(e => { ctx.player.chat(serv.color.red + e.message) })
  serv.commands.add({
    base: 'sbmenu',
    info: 'open the SkyBlock menu (or any captured screen by id)',
    usage: '/sbmenu [screen_id|list]',
    onlyPlayer: true,
    parse: (s) => s || '',
    action (arg, ctx) {
      if (arg === 'list') return ctx.player.chat(Object.keys(engine.screens).join(', '))
      return open(ctx, arg || 'skyblock_menu')
    }
  })
  for (const [cmd, id] of Object.entries(ALIASES)) {
    if (cmd === 'sbmenu') continue
    serv.commands.add({ base: cmd, info: `open the ${id} menu`, usage: '/' + cmd, onlyPlayer: true, action: (_, ctx) => open(ctx, id) })
  }
}

module.exports.player = function (player, serv) {
  const engine = () => serv.skyblockMenu
  // Never reach into engine internals from a packet handler: a stale lib/engine.js must not be able to kick players.
  const call = (name, ...args) => { const e = engine(); return e && typeof e[name] === 'function' ? e[name](...args) : undefined }
  const settings = this.settings || {}
  const starSlot = () => (settings.starSlot !== undefined ? settings.starSlot : ((engine() && engine().opts && engine().opts.starSlot) ?? 8))
  const c = player._client
  let last = 0
  const openMain = () => { const t = Date.now(); if (t - last < 250) return; last = t; Promise.resolve(call('open', player, 'skyblock_menu')).catch(e => serv.err?.(e.message)) }

  // 'asap' fires after every builtin plugin built player.inventory – guard it so menu clicks never touch real slots
  player.once('asap', () => {
    const inv = player.inventory
    const orig = inv.acceptClick.bind(inv)
    inv.acceptClick = (info) => { if (player.sbMenu) return; return orig(info) }
  })

  c.on('window_click', (pkt) => { Promise.resolve(call('click', player, pkt)).catch(e => serv.err?.(e.stack)) })
  c.on('close_window', (pkt) => { if (player.sbMenu && pkt.windowId === player.sbMenu.windowId) call('close', player, { notifyClient: false }) })
  c.on('use_item', () => { if (player.heldItemSlot === starSlot()) openMain() })
  c.on('block_place', () => { if (player.heldItemSlot === starSlot()) openMain() })
  // The star now arrives with the imported inventory (a real SkyBlock item in hotbar slot 9), so giveStar is only
  // called if the engine still has it.
  player.on('spawned', () => { if (typeof (engine() || {}).giveStar === 'function') { setTimeout(() => call('giveStar', player), 300); setTimeout(() => call('giveStar', player), 2000) } })
}
