'use strict'
// Server-authoritative 9x6 menu windows. Behaviour taken from the recordings (docs/skyblock/ARCHITECTURE.md §3):
//   * every state-changing click re-opens the menu as a NEW window id (1, 2, 3 ... ), it does not patch slots
//   * the player's inventory is part of the window (slots 54-89: main 54-80, hotbar 81-89)
//   * titles are plain { text } components
// Nothing in a menu window can be moved by the client: clicks are routed to the menu, then the window is re-sent.

const nbt = require('prismarine-nbt')

const MENU_SIZE = 54
const invIndexOfSlot = slot => (slot >= 81 ? slot - 81 : slot - 54 + 9) // window slot (54-89) -> profile 'inventory' index
const slotOfInvIndex = i => (i < 9 ? 81 + i : 54 + (i - 9))

class WindowManager {
  constructor (serv) { this.serv = serv; this.Item = null }

  attach (player) {
    const ui = player.ui = { win: null, next: 1 }
    const c = player._client
    c.on('window_click', pkt => this._click(player, pkt))
    c.on('close_window', pkt => { if (ui.win && pkt.windowId === ui.win.id) this._closed(player) })
    player.once('asap', () => { // belt and braces next to the built-in plugin's own skyblockMenu guard
      const inv = player.inventory; const orig = inv.acceptClick.bind(inv)
      inv.acceptClick = info => (ui.win ? undefined : orig(info))
    })
    return ui
  }

  /** factory(ctx) -> { title, items:[54 Items|null], click(info) -> 'reopen'|'close'|undefined } */
  open (player, factory) {
    const ui = player.ui
    const ctx = this.serv.skyblock.ui.context(player)
    const menu = factory(ctx)
    const id = ui.next; ui.next = ui.next % 100 + 1
    ui.win = { id, menu, factory, stateId: 0 }
    player.skyblockMenu = player.sbMenu = { windowId: id } // built-in inventory plugin ignores window_click while this is set
    player._client.write('open_window', { windowId: id, inventoryType: 5, windowTitle: nbt.comp({ text: nbt.string(menu.title) }) })
    this._send(player)
  }

  reopen (player) { if (player.ui.win) this.open(player, player.ui.win.factory) }

  close (player) {
    const w = player.ui.win
    if (!w) return
    player._client.write('close_window', { windowId: w.id })
    this._closed(player)
  }

  _closed (player) { player.ui.win = null; delete player.skyblockMenu; delete player.sbMenu }

  _items (player, win) {
    const Item = this.serv.skyblock.ui.Item
    const out = win.menu.items.slice(0, MENU_SIZE)
    while (out.length < MENU_SIZE) out.push(null)
    const inv = player.skyblock && player.skyblock.profile ? player.skyblock.profile.container('inventory') : null
    for (let i = 0; i < 36; i++) out[slotOfInvIndex(i)] = inv ? inv.get(i) : null
    return out.map(it => Item.toNotch(it))
  }

  _send (player) {
    const w = player.ui.win
    w.stateId = (w.stateId + 1) & 0x7fff
    player._client.write('window_items', { windowId: w.id, stateId: w.stateId, items: this._items(player, w), carriedItem: this.serv.skyblock.ui.Item.toNotch(null) })
  }

  /** Cancel whatever the client predicted: re-send the contents and empty the cursor. */
  resync (player) {
    this._send(player)
    player._client.write('set_slot', { windowId: -1, stateId: 0, slot: -1, item: this.serv.skyblock.ui.Item.toNotch(null) })
  }

  _click (player, pkt) {
    const w = player.ui.win
    if (!w || pkt.windowId !== w.id) return
    let result
    try {
      // only plain left/right clicks are understood; shift-click, drags, number keys, drops were not recorded
      if (pkt.mode === 0 && (pkt.mouseButton === 0 || pkt.mouseButton === 1)) {
        result = pkt.slot >= 0 && pkt.slot < MENU_SIZE
          ? w.menu.click({ player, slot: pkt.slot, button: pkt.mouseButton, area: 'menu' })
          : (pkt.slot >= MENU_SIZE && pkt.slot < 90 ? w.menu.click({ player, slot: pkt.slot, button: pkt.mouseButton, area: 'inventory', index: invIndexOfSlot(pkt.slot) }) : undefined)
      }
    } catch (e) { this.serv.err?.(`[skyblock-ui] ${w.menu.title}: ${e.stack}`) }
    if (player.ui.win !== w) return // the click already opened another menu
    if (result === 'reopen') this.open(player, w.factory)
    else if (result === 'close') this.close(player)
    else this.resync(player)
  }
}

module.exports = { WindowManager, MENU_SIZE, invIndexOfSlot, slotOfInvIndex }
