/**
 * SkyBlock Menu
 * -------------
 * Gives every player a Magical Map (or a nether star, see menuItem) in the last hotbar slot.
 * Right-clicking it (or running /sbmenu [menu]) opens a 6-row chest GUI whose slot
 * layout, item types, titles and navigation (Storage, Pets) were taken from a
 * packet capture of the real Hypixel SkyBlock menu. Menus: main, storage, pets, loadouts.
 * Shortcuts: /sbmenu, /storage, /pets, /loadouts.
 *
 * Needs MC 1.20.5+ (item components). Item names / lore / titles are sent as NBT
 * text components with `italic: false` on the root, the same way Hypixel does
 * (see the `empty[style={!italic}, ...]` components in the packet capture).
 *
 * Optional settings (config/settings.json):
 *   "skyblockMenu": { "giveItem": true, "hotbarSlot": 8, "title": "SkyBlock Menu", "menuItem": "magical_map" }
 * (a top-level key: flying-squid treats every key under "plugins" as an external plugin to load)
 *
 * API (serv.skyblockMenu):
 *   register(id, def)       add / replace a menu (see DEFAULT_MENUS below for the shape)
 *   setPets(player, pets)   fill the Pets menu: [{ name, rarity, level, active?, texture? }]
 *   open(player, id='main') open a menu for a player
 *   close(player)           close the player's menu window
 *   giveItem(player)        (re)place the menu star in the player's hotbar
 *   setStats(player, obj)   update the numbers shown on the profile button
 *
 * Events (serv):
 *   'skyblockMenu:click' (player, { menu, slot, button, id, click })
 *       fired for buttons whose action is { event: '<name>' }; hook your own
 *       skills / collections / warp / etc. here.
 *
 * Button actions:
 *   { open: 'menuId', page?: n } | { close: true } | { command: 'tp 0 80 0' } |
 *   { message: '&aHello' } | { event: 'name' } | (player, ctx) => {}
 */
const nbt = require('prismarine-nbt')

// ---------------------------------------------------------------------------
// Text helpers (legacy § / & codes -> NBT text components)
// ---------------------------------------------------------------------------
const COLOR_CODES = {
  0: 'black',
  1: 'dark_blue',
  2: 'dark_green',
  3: 'dark_aqua',
  4: 'dark_red',
  5: 'dark_purple',
  6: 'gold',
  7: 'gray',
  8: 'dark_gray',
  9: 'blue',
  a: 'green',
  b: 'aqua',
  c: 'red',
  d: 'light_purple',
  e: 'yellow',
  f: 'white'
}
const FORMAT_CODES = { l: 'bold', o: 'italic', n: 'underlined', m: 'strikethrough', k: 'obfuscated' }

function parseLegacy (str) {
  const out = []
  let style = {}
  let text = ''
  const flush = () => {
    if (text) out.push({ text, ...style })
    text = ''
  }
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if ((c === '§' || c === '&') && i + 1 < str.length) {
      const code = str[i + 1].toLowerCase()
      if (COLOR_CODES[code] || FORMAT_CODES[code] || code === 'r') {
        flush()
        if (COLOR_CODES[code]) style = { color: COLOR_CODES[code] } // colour resets formatting, like vanilla
        else if (code === 'r') style = {}
        else style = { ...style, [FORMAT_CODES[code]]: true }
        i++
        continue
      }
    }
    text += c
  }
  flush()
  return out
}

/** "&aHello &lWorld" -> NBT component, root italic=false so tooltips aren't italic */
function textComponent (str) {
  const parts = parseLegacy(String(str))
  const root = { text: nbt.string(''), italic: nbt.byte(0) }
  if (parts.length) {
    root.extra = nbt.list(nbt.comp(parts.map(p => {
      const o = { text: nbt.string(p.text) }
      if (p.color) o.color = nbt.string(p.color)
      for (const f of Object.values(FORMAT_CODES)) if (p[f]) o[f] = nbt.byte(1)
      return o
    })))
  }
  return nbt.comp(root)
}

const fmt = n => Number(n).toLocaleString('en-US')

// Server world time (ticks, 0 = 06:00) as HH:MM; falls back to the machine clock
let worldTime = () => undefined
function worldClock () {
  const ticks = worldTime()
  if (typeof ticks !== 'number') return new Date().toTimeString().slice(0, 5)
  const hours = ((ticks / 1000) + 6) % 24
  const h = Math.floor(hours)
  const m = Math.floor((hours - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Default menus
//
// Slot numbers, item types, titles, counts and click targets come from a PacketSpy
// capture of the real menu. PacketSpy only prints "1 minecraft:clock" for a stack, so
// item NAMES / LORE / HEAD TEXTURES are not in the capture. Wherever a name is marked
// "(unverified)" it is a guess; everything else about the layout is exact.
// ---------------------------------------------------------------------------
const emit = (event, extra) => (player, ctx) => player.skyblockEmit(event, ctx, extra)
const stub = (event) => emit(event)

const RARITY_COLORS = { COMMON: 'f', UNCOMMON: 'a', RARE: '9', EPIC: '5', LEGENDARY: '6', MYTHIC: 'd', DIVINE: 'b' }

const DEFAULT_MENUS = {
  // Captured: title "SkyBlock Menu", 54 slots, every non-button slot is a black glass pane
  main: {
    title: 'SkyBlock Menu',
    buttons: {
      13: {
        id: 'profile',
        item: 'player_head',
        head: true,
        name: '&aYour SkyBlock Profile',
        lore: (p) => [
          '&7View your equipment, stats, and more!',
          '',
          `&c❤ Health &f${fmt(p.skyblockStats.health)}`,
          `&a❈ Defense &f${fmt(p.skyblockStats.defense)}`,
          `&b✎ Mana &f${fmt(p.skyblockStats.mana)}`,
          '',
          '&eClick to view!'
        ],
        action: stub('profile')
      },
      19: { id: 'skills', item: 'diamond_sword', name: '&aYour Skills', lore: ['&7View your Skill progression and', '&7rewards.', '', '&eClick to view!'], action: stub('skills') },
      20: { id: 'collections', item: 'painting', name: '&aCollections', lore: ['&7View all of the items available', '&7in SkyBlock. Collect more of an', '&7item to unlock rewards.', '', '&eClick to view!'], action: stub('collections') },
      21: { id: 'recipes', item: 'book', name: '&aRecipe Book', lore: ['&7Through your adventure, you will', '&7unlock recipes for all kinds of', '&7special items!', '', '&eClick to view!'], action: stub('recipes') },
      22: { id: 'trades', item: 'player_head', name: '&aTrades (unverified)', lore: ['&7View your available trades.', '', '&eClick to view!'], action: stub('trades') },
      23: { id: 'quests', item: 'writable_book', name: '&aQuest Log', lore: ['&7View your active quests,', '&7progress, and rewards.', '', '&eClick to view!'], action: stub('quests') },
      // Captured: this stack is re-sent roughly once a second while the menu is open
      24: {
        id: 'calendar',
        item: 'clock',
        name: '&aCalendar and Events',
        live: true,
        lore: () => ['&7View the SkyBlock calendar and', '&7upcoming events.', '', `&7Time: &e${worldClock()}`, '', '&eClick to view!'],
        action: stub('calendar')
      },
      25: { id: 'storage', item: 'chest', name: '&aStorage', lore: ['&7Store items in your Backpacks', '&7and Ender Chest.', '', '&eClick to open!'], action: { open: 'storage' } }, // confirmed by click capture
      29: { id: 'fast_travel', item: 'player_head', name: '&bFast Travel (unverified)', lore: ['&7Teleport to islands and areas', '&7you have already visited.', '', '&eClick to pick a destination!'], action: stub('fast_travel') },
      30: { id: 'pets', item: 'bone', name: '&aPets', lore: ['&7View and manage all of your', '&7Pets.', '', '&eClick to view!'], action: { open: 'pets' } }, // confirmed by click capture
      31: { id: 'crafting', item: 'crafting_table', name: '&aCraft Item (unverified)', lore: ['&7Opens the crafting grid.', '', '&eClick to open!'], action: stub('crafting') },
      32: { id: 'sacks', item: 'barrel', name: '&aSack of Sacks (unverified)', lore: ['&7Bulk storage for materials.', '', '&eClick to open!'], action: stub('sacks') },
      33: { id: 'wardrobe', item: 'player_head', name: '&aWardrobe (unverified)', lore: ['&7Store armor sets and swap', '&7between them quickly.', '', '&eClick to open!'], action: stub('wardrobe') },
      47: { id: 'accessories', item: 'player_head', name: '&aAccessory Bag (unverified)', lore: ['&7Your accessories live here.', '', '&eClick to open!'], action: stub('accessories') },
      48: { id: 'profile_management', item: 'name_tag', name: '&aProfile Management (unverified)', lore: ['&7Manage your SkyBlock profiles.', '', '&eClick to view!'], action: stub('profile_management') },
      49: { id: 'close', item: 'barrier', name: '&cClose', action: { close: true } },
      50: { id: 'settings', item: 'redstone_torch', name: '&aSettings', lore: ['&7View and edit your SkyBlock', '&7settings.', '', '&eClick to view!'], action: stub('settings') },
      51: { id: 'booster_cookie', item: 'cookie', name: '&6Booster Cookie (unverified)', lore: ['&7Time remaining on your buff.', '', '&eClick to view!'], action: stub('booster_cookie') }
    }
  },

  // Captured: title "Storage". Counts on the chests (1-4) and heads (1-18) are slot numbers.
  // Slots 13-17 are red glass panes (locked ender chest pages 5-9).
  storage: {
    title: 'Storage',
    back: 'main', // arrow at 48, barrier at 49
    build () {
      const buttons = {
        4: { id: 'enderchest_header', item: 'ender_chest', name: '&aEnder Chest (unverified)', lore: ['&7Store items in your Ender Chest', '&7pages.'] },
        22: { id: 'backpack_header', item: 'chest', name: '&aBackpacks (unverified)', lore: ['&7Backpack slots are below.'] }
      }
      for (let i = 1; i <= 4; i++) {
        buttons[8 + i] = { id: `enderchest_${i}`, item: 'chest', count: i, name: `&aEnder Chest Page ${i}`, lore: ['&eClick to open!'], action: stub(`enderchest:${i}`) }
      }
      for (let i = 5; i <= 9; i++) {
        buttons[8 + i] = { id: `enderchest_${i}_locked`, item: 'red_stained_glass_pane', name: `&cLocked Ender Chest Page ${i}`, lore: ['&7Unlock this page to use it.'] }
      }
      for (let i = 1; i <= 18; i++) {
        buttons[26 + i] = { id: `backpack_${i}`, item: 'player_head', count: i, name: `&aBackpack Slot ${i} (unverified)`, lore: ['&eClick to open!'], action: stub(`backpack:${i}`) }
      }
      return { buttons }
    }
  },

  // Captured: title "(1/4) Pets". 28 pet slots (rows 2-5, columns 2-8), paged; arrow at 48 goes
  // back, 53 is "next page". Control items (4, 7, 8, 46, 47, 50, 51, 52) keep their captured positions.
  pets: {
    title: 'Pets',
    back: 'main',
    build (player, state) {
      const PER_PAGE = 28
      const pets = player.skyblockPets ?? []
      const pages = Math.max(1, Math.ceil(pets.length / PER_PAGE))
      const page = Math.min(Math.max(1, state.page ?? 1), pages)
      const buttons = {
        4: { id: 'pets_header', item: 'bone', name: '&aPets', lore: ['&7View and manage all of your', '&7Pets.'] },
        7: { id: 'pets_dye', item: 'yellow_dye', name: '&ePet Options (unverified)', action: stub('pets:options') },
        8: { id: 'pets_diamond', item: 'diamond', name: '&bPet Score (unverified)', action: stub('pets:score') },
        46: { id: 'pets_active', item: 'player_head', name: '&aActive Pet (unverified)', action: stub('pets:active') },
        47: { id: 'pets_diamond2', item: 'diamond', name: '&bPet Upgrades (unverified)', action: stub('pets:upgrades') },
        50: { id: 'pets_sign', item: 'oak_sign', name: '&aSearch (unverified)', action: stub('pets:search') },
        51: { id: 'pets_button', item: 'stone_button', name: '&aHide Pets (unverified)', action: stub('pets:hide') },
        52: { id: 'pets_hopper', item: 'hopper', name: '&aSort (unverified)', action: stub('pets:sort') }
      }
      if (page > 1) buttons[45] = { id: 'prev_page', item: 'arrow', name: '&aPrevious Page', lore: [`&ePage ${page - 1}`], action: { open: 'pets', page: page - 1 } }
      if (page < pages) buttons[53] = { id: 'next_page', item: 'arrow', name: '&aNext Page', lore: [`&ePage ${page + 1}`], action: { open: 'pets', page: page + 1 } }
      const petSlots = []
      for (const base of [10, 19, 28, 37]) for (let col = 0; col < 7; col++) petSlots.push(base + col)
      const slice = pets.slice((page - 1) * PER_PAGE, page * PER_PAGE)
      slice.forEach((pet, i) => {
        const c = RARITY_COLORS[String(pet.rarity ?? 'COMMON').toUpperCase()] ?? 'f'
        buttons[petSlots[i]] = {
          id: `pet_${(page - 1) * PER_PAGE + i}`,
          item: 'player_head',
          texture: pet.texture,
          glow: !!pet.active,
          name: `&7[Lvl ${pet.level ?? 1}] &${c}${pet.name}`,
          lore: [`&${c}&l${String(pet.rarity ?? 'COMMON').toUpperCase()}`, '', pet.active ? '&cClick to despawn!' : '&eClick to summon!'],
          action: emit('pet:select', { pet, index: (page - 1) * PER_PAGE + i })
        }
      })
      return { title: `(${page}/${pages}) Pets`, buttons }
    }
  },

  // Captured: title "(1/3) Loadouts". Layout only: positions and item types are exact, but the
  // capture has no names, so these are placeholders. Not reachable from the main menu (the capture
  // doesn't show which button opens it); use /loadouts, /sbmenu loadouts or serv.skyblockMenu.open(player, 'loadouts').
  loadouts: {
    title: '(1/3) Loadouts',
    buttons: Object.fromEntries(Object.entries({
      9: 'player_head',
      10: 'paper',
      11: 'player_head',
      14: 'player_head',
      15: 'player_head',
      16: 'player_head',
      18: 'player_head',
      19: 'paper',
      20: 'leather_chestplate',
      21: 'player_head',
      23: 'player_head',
      24: 'player_head',
      25: 'gray_dye',
      27: 'paper',
      28: 'paper',
      29: 'leather_leggings',
      32: 'gray_dye',
      33: 'gray_dye',
      34: 'gray_dye',
      36: 'comparator',
      37: 'paper',
      38: 'leather_boots',
      41: 'gray_dye',
      42: 'red_dye',
      43: 'red_dye',
      44: 'arrow',
      49: 'barrier'
    }).map(([slot, item]) => [slot, item === 'barrier'
      ? { id: 'close', item, name: '&cClose', action: { close: true } }
      : { id: `loadout_${slot}`, item, name: '&7Loadouts &8(layout only)', action: stub(`loadouts:${slot}`) }]))
  }
}

// ---------------------------------------------------------------------------
module.exports.server = function (serv, options) {
  const { registry } = serv
  const config = Object.assign({ giveItem: true, hotbarSlot: 8, title: 'SkyBlock Menu', menuItem: 'magical_map' }, options?.skyblockMenu)

  if (!registry.version['>=']('1.20.5')) {
    serv.warn?.('[skyblockMenu] needs Minecraft 1.20.5+ (item components); plugin disabled')
    return
  }

  const Item = require('prismarine-item')(registry)
  const componentTypes = Object.values(registry.protocol.types.SlotComponentType[1].mappings)
  const hasTooltipDisplay = componentTypes.includes('tooltip_display')
  const menus = new Map()

  // -- items ----------------------------------------------------------------
  worldTime = () => serv.time

  function buildItem (def, player) {
    const info = registry.itemsByName[def.item]
    if (!info) {
      serv.warn?.(`[skyblockMenu] unknown item '${def.item}' (menu button '${def.id ?? '?'}')`)
      return null
    }
    const item = new Item(info.id, def.count ?? 1)
    const lore = typeof def.lore === 'function' ? def.lore(player) : (def.lore ?? [])
    item.components = []
    if (def.hideTooltip && hasTooltipDisplay) {
      item.components.push({ type: 'tooltip_display', data: { hideTooltip: true, hiddenComponents: [] } })
    } else {
      item.components.push({ type: 'custom_name', data: textComponent(def.hideTooltip ? ' ' : def.name) })
      if (lore.length) item.components.push({ type: 'lore', data: lore.map(textComponent) })
    }
    if (def.glow) item.components.push({ type: 'enchantment_glint_override', data: true })
    if (def.head && player) {
      // the viewer's own head
      item.components.push({
        type: 'profile',
        data: {
          type: 'partial',
          name: player.username,
          uuid: player.uuid,
          properties: (player.profileProperties ?? []).map(p => ({ name: p.name, value: p.value, signature: p.signature })),
          skinPatch: {}
        }
      })
    } else if (def.texture) {
      // custom head: `texture` is the base64 "textures" property value
      item.components.push({
        type: 'profile',
        data: { type: 'partial', properties: [{ name: 'textures', value: def.texture }], skinPatch: {} }
      })
    }
    if (def.tag) item.components.push({ type: 'custom_data', data: nbt.comp({ skyblock_menu: nbt.string(def.tag) }) })
    return item
  }

  const isMenuItem = (item) => !!item?.components?.some(c => c.type === 'custom_data' && c.data?.value?.skyblock_menu)

  // The hotbar item that opens the menu. Default is the Magical Map (as seen in the dungeon
  // screenshot); set "menuItem": "nether_star" in the skyblockMenu settings for the classic star.
  const MENU_ITEMS = {
    magical_map: {
      item: 'filled_map',
      name: '&bMagical Map',
      lore: ['&7Shows the layout of the Dungeon as it', '&7is explored and completed.'],
      tag: 'magical_map'
    },
    nether_star: {
      item: 'nether_star',
      name: '&aSkyBlock Menu &7(Click)',
      lore: ['&7View all of your SkyBlock progress,', '&7including your Skills, Collections,', '&7and more!', '', '&eClick to open!'],
      tag: 'star'
    }
  }

  function makeMenuItem () {
    return buildItem(MENU_ITEMS[config.menuItem] ?? MENU_ITEMS.magical_map)
  }

  // -- windows --------------------------------------------------------------
  /** Static menus use `buttons`; dynamic ones add/override via build(player, state) */
  function resolveMenu (player, state) {
    const menu = menus.get(state.menuId)
    const built = menu.build ? menu.build(player, state) : {}
    const merged = { ...menu, ...built, buttons: { ...menu.buttons, ...built.buttons } }
    const size = merged.rows * 9
    if (merged.back) {
      merged.buttons[size - 6] = { id: 'back', item: 'arrow', name: '&aGo Back', lore: [`&7To ${menus.get(merged.back)?.title ?? merged.back}`], action: { open: merged.back } }
      merged.buttons[size - 5] = merged.buttons[size - 5] ?? { id: 'close', item: 'barrier', name: '&cClose', action: { close: true } }
    }
    return merged
  }

  function menuSlots (player, menu) {
    const size = menu.rows * 9
    const slots = new Array(size).fill(null)
    const filler = menu.filler === true ? { item: 'black_stained_glass_pane', hideTooltip: true } : menu.filler
    if (filler) {
      const f = buildItem(filler, player)
      for (let i = 0; i < size; i++) slots[i] = f
    }
    for (const [slot, def] of Object.entries(menu.buttons)) {
      if (Number(slot) < size) slots[slot] = buildItem(def, player)
    }
    return slots
  }

  const nextState = (state) => (state.stateId = (state.stateId + 1) & 0x7fffffff)

  function sendContents (player) {
    const state = player.skyblockMenu
    if (!state) return
    const slots = menuSlots(player, resolveMenu(player, state))
    // Chest section followed by the player's inventory (main 9-35 then hotbar 36-44),
    // so the client's own inventory slots aren't blanked.
    const items = slots.map(i => Item.toNotch(i))
    for (let s = 9; s <= 44; s++) items.push(Item.toNotch(player.inventory.slots[s]))
    player._client.write('window_items', {
      windowId: state.windowId,
      stateId: nextState(state),
      items,
      carriedItem: Item.toNotch(null) // also clears whatever the client thinks is on the cursor
    })
  }

  // The real menu re-sends the clock stack about once a second; do the same for `live` buttons
  function startLive (player) {
    const state = player.skyblockMenu
    if (!state || !Object.values(resolveMenu(player, state).buttons).some(b => b.live)) return
    state.timer = setInterval(() => {
      try {
        if (player.skyblockMenu !== state || player.disconnected) return stopLive(state)
        const menu = resolveMenu(player, state)
        for (const [slot, def] of Object.entries(menu.buttons)) {
          if (!def.live) continue
          player._client.write('set_slot', { windowId: state.windowId, stateId: nextState(state), slot: Number(slot), item: Item.toNotch(buildItem(def, player)) })
        }
      } catch (err) {
        stopLive(state)
      }
    }, 1000)
    state.timer.unref?.()
  }

  function stopLive (state) {
    if (state?.timer) clearInterval(state.timer)
    if (state) state.timer = undefined
  }

  function clearState (player) {
    stopLive(player.skyblockMenu)
    player.skyblockMenu = undefined
  }

  function open (player, menuId = 'main', page = 1) {
    if (!menus.has(menuId)) return false
    clearState(player) // opening another screen just replaces the old one, like the real menu
    // Same dynamic window id scheme chest.js uses, wrapped to stay in 1..100
    player.windowId = ((player.windowId ?? 0) % 100) + 1
    player.windowType = 'skyblock_menu'
    const state = player.skyblockMenu = { menuId, page, windowId: player.windowId, stateId: 0 }
    const menu = resolveMenu(player, state)
    player._client.write('open_window', {
      windowId: state.windowId,
      inventoryType: menu.rows - 1, // generic_9x1 .. generic_9x6
      windowTitle: textComponent(menu.title)
    })
    sendContents(player)
    startLive(player)
    return true
  }

  function close (player) {
    const state = player.skyblockMenu
    if (!state) return
    clearState(player)
    player.windowType = ''
    player._client.write('close_window', { windowId: state.windowId })
  }

  function tell (player, message) {
    player._client.write('system_chat', { content: textComponent(message), isActionBar: false })
  }

  function runAction (player, menuId, slot, def, click) {
    const a = def.action
    if (!a) return
    const ctx = { menu: menuId, slot: Number(slot), button: def, id: def.id, click }
    if (typeof a === 'function') return a(player, ctx)
    if (a.open) return open(player, a.open, a.page)
    if (a.close) return close(player)
    if (a.command) {
      close(player)
      return player.handleCommand(a.command.replace(/^\//, ''))
    }
    if (a.message) return tell(player, a.message)
    if (a.event) return player.skyblockEmit(a.event, ctx)
  }

  function handleClick (player, packet) {
    const state = player.skyblockMenu
    const menu = resolveMenu(player, state)
    const def = menu.buttons[packet.slot]
    // mode 0 = normal click, 1 = shift-click, 3 = middle, 4 = drop (also click-outside), ...
    // only 0/1 on a button count as presses
    if (def?.action && packet.slot >= 0 && (packet.mode === 0 || packet.mode === 1)) {
      const click = { type: packet.mode === 1 ? 'shift' : (packet.mouseButton === 1 ? 'right' : 'left'), mode: packet.mode }
      try {
        runAction(player, state.menuId, packet.slot, def, click)
      } catch (err) {
        setTimeout(() => { throw err }, 0)
      }
    }
    // Unless the click opened/closed a window, the client already moved things around
    // locally; put the real contents back
    if (player.skyblockMenu === state) sendContents(player)
  }

  function giveItem (player) {
    const slot = 36 + config.hotbarSlot
    const existing = player.inventory.slots[slot]
    if (existing && !isMenuItem(existing)) return false // never delete someone's item
    player.inventory.updateSlot(slot, makeMenuItem())
    return true
  }

  // -- player data ----------------------------------------------------------
  const defaultStats = () => ({ health: 11342, defense: 4038, mana: 2002 }) // placeholders, from the capture
  function setStats (player, stats) {
    player.skyblockStats = Object.assign(player.skyblockStats ?? defaultStats(), stats)
  }
  /** pets: [{ name, rarity: 'LEGENDARY', level: 100, active?: bool, texture?: base64 }] */
  function setPets (player, pets) {
    player.skyblockPets = pets
  }

  // -- registry / API -------------------------------------------------------
  function register (id, def) {
    menus.set(id, { rows: 6, filler: true, buttons: {}, ...def, title: def.title ?? config.title })
  }
  for (const [id, def] of Object.entries(DEFAULT_MENUS)) register(id, id === 'main' ? { ...def, title: config.title } : def)

  serv.skyblockMenu = { register, open, close, giveItem, setStats, setPets, isMenuItem, menus, handleClick, clearState, config }

  serv.commands.add({
    base: 'sbmenu',
    aliases: ['skyblockmenu', 'sbm'],
    info: 'Open the SkyBlock menu',
    usage: '/sbmenu [menu]',
    onlyPlayer: true,
    action (arg, ctx) {
      // flying-squid hands plain commands their raw argument string
      const id = String(arg ?? '').trim().split(/\s+/)[0] || 'main'
      if (!open(ctx.player, id)) tell(ctx.player, `&cUnknown menu '${id}'. Available: ${[...menus.keys()].join(', ')}`)
    }
  })

  // Direct shortcuts to the sub-menus, same as pressing the button in the main menu
  for (const [base, menuId, info] of [
    ['storage', 'storage', 'Open your Storage'],
    ['pets', 'pets', 'Open your Pets menu'],
    ['loadouts', 'loadouts', 'Open your Loadouts']
  ]) {
    serv.commands.add({
      base,
      info,
      usage: `/${base}`,
      onlyPlayer: true,
      action (arg, ctx) {
        open(ctx.player, menuId)
      }
    })
  }
}

module.exports.player = function (player, serv) {
  const api = serv.skyblockMenu
  if (!api) return // disabled (unsupported version)

  player.skyblockStats = { health: 11342, defense: 4038, mana: 2002 }
  player.skyblockPets = []
  player.skyblockMenu = undefined

  /** fires 'skyblockMenu:click'; tells the player if nothing handles it */
  player.skyblockEmit = (event, ctx, extra) => {
    if (serv.listenerCount('skyblockMenu:click') === 0) {
      player._client.write('system_chat', { content: textComponent(`&c${ctx.id ?? event} isn't set up on this server yet.`), isActionBar: false })
      return
    }
    serv.emit('skyblockMenu:click', player, { ...ctx, ...extra, event })
  }

  // Right-click with the menu star (1.9+ sends use_item; 1.8 style block_place with direction -1 isn't handled)
  let lastOpen = 0
  player._client.on('use_item', () => {
    const held = player.inventory.slots[36 + player.heldItemSlot]
    if (!api.isMenuItem(held)) return
    const now = Date.now()
    if (now - lastOpen < 250) return // block_place + use_item can both arrive for one click
    lastOpen = now
    api.open(player, 'main')
  })

  player._client.on('window_click', (packet) => {
    const state = player.skyblockMenu
    if (!state || packet.windowId !== state.windowId) return
    api.handleClick(player, packet)
  })

  player._client.on('close_window', (packet) => {
    if (player.skyblockMenu && packet.windowId === player.skyblockMenu.windowId) api.clearState(player)
  })

  player.on('disconnected', () => api.clearState(player))

  if (api.config.giveItem) player.on('spawned', () => api.giveItem(player))
}
