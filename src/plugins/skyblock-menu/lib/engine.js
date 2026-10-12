const path = require('path')
const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer')
const { varint, clientboundIds, EMPTY_SLOT } = require('./raw')
const nbt = require('./nbt')

const TOP_ROWS_TO_SLOTS = (rows) => rows * 9

/** A mutable view over one screen's top-inventory slots, handed to render hooks. */
class View {
  constructor (engine, id, screen, slots, player) {
    this.engine = engine; this.id = id; this.screen = screen; this.player = player
    this.slots = slots // Buffer[] raw Slot bytes (replaced when edited)
    this.topCount = slots.length
    this._dirty = new Map() // slot -> decoded object
  }

  /** decoded copy (read-only use; use edit() to change) */
  item (i) { return this._dirty.get(i) || this.engine.decode(this.slots[i]) }
  /** decode, mutate with fn(item), re-encode on finalize. fn may return false to skip */
  edit (i, fn) {
    const it = this._dirty.get(i) || this.engine.decode(this.slots[i])
    if (!it || !it.itemCount) return false
    if (fn(it) === false) return false
    this._dirty.set(i, it)
    return true
  }

  set (i, item) { this._dirty.set(i, item) }
  name (i) { return this.engine.nameOf(this.slots[i]) }
  /** slots whose item name (plain text) matches */
  find (re) { const out = []; for (let i = 0; i < this.topCount; i++) if (re.test(this.name(i))) out.push(i); return out }

  finalize () {
    for (const [i, it] of this._dirty) this.slots[i] = this.engine.encode(it)
    this._dirty.clear()
    return this.slots
  }
}

class MenuEngine {
  constructor (serv, options = {}) {
    this.serv = serv
    this.opts = Object.assign({ dataFile: path.join(__dirname, '../data/screens.json'), starSlot: 8, giveStar: true }, options)
    this.data = require(this.opts.dataFile)
    const version = serv.registry.version.minecraftVersion
    this.ser = createSerializer({ state: 'play', isServer: true, version, customPackets: {} })
    this.de = createDeserializer({ state: 'play', isServer: false, version, customPackets: {} })
    this.ids = clientboundIds(serv.registry)
    this.hooks = []
    this._pool = new Map()
    this._names = new Map()
    this.screens = this.data.screens
    this.star = this._findStar()
  }

  // ---- slot codec ----
  decode (buf) { return this.de.proto.parsePacketBuffer('Slot', buf, 0).data }
  encode (item) { return this.ser.proto.createPacketBuffer('Slot', item) }
  raw (hash) {
    let b = this._pool.get(hash)
    if (!b) { b = Buffer.from(this.data.pool[hash], 'base64'); this._pool.set(hash, b) }
    return b
  }

  nameOf (buf) {
    if (buf.length <= 1) return ''
    const k = buf.toString('base64')
    let n = this._names.get(k)
    if (n === undefined) { try { n = nbt.nameText(this.decode(buf)).trim() } catch (e) { n = '' } this._names.set(k, n) }
    return n
  }

  _findStar () {
    for (const s of Object.values(this.screens)) {
      for (const h of Object.values(s.slots)) {
        const b = this.raw(h)
        if (/^SkyBlock Menu \(Click\)$/.test(this.nameOf(b))) return b
      }
    }
    return null
  }

  has (id) { return !!this.screens[id] }
  addHook (fn) { this.hooks.push(fn); return this }

  // ---- building ----
  async build (player, id) {
    const screen = this.screens[id]
    const n = TOP_ROWS_TO_SLOTS(screen.rows)
    const slots = []
    for (let i = 0; i < n; i++) slots.push(screen.slots[i] ? this.raw(screen.slots[i]) : EMPTY_SLOT)
    const view = new View(this, id, screen, slots, player)
    for (const h of this.hooks) {
      try { await h(view, { player, engine: this, screenId: id }) } catch (e) { this.serv.err?.(`[skyblock-menu] hook failed on ${id}: ${e.stack || e.message}`) }
    }
    view.finalize()
    return view
  }

  // 27 main + 9 hotbar slots of the player's real inventory (+ the SkyBlock star in the hotbar)
  _playerSlots (player) {
    const Item = require('prismarine-item')(this.serv.registry)
    const out = []
    for (let i = 9; i <= 44; i++) {
      let buf = EMPTY_SLOT
      if (this.opts.giveStar && this.star && i === 36 + this.opts.starSlot) buf = this.star
      else {
        try { const it = player.inventory?.slots[i]; if (it) buf = this.encode(Item.toNotch(it)) } catch (e) { buf = EMPTY_SLOT }
      }
      out.push(buf)
    }
    return out
  }

  _windowItems (st, player) {
    const all = [...st.slots, ...this._playerSlots(player)]
    return Buffer.concat([varint(this.ids.window_items), varint(st.windowId), varint(st.stateId), varint(all.length), ...all, EMPTY_SLOT])
  }

  _nextWindowId (player) { player.windowId = player.windowId === undefined ? 1 : (player.windowId % 100) + 1; return player.windowId }

  // ---- public actions ----
  async open (player, id, { push = true } = {}) {
    if (!this.has(id)) throw new Error(`unknown SkyBlock screen '${id}'`)
    if (player.skyblock?.ready) await Promise.race([player.skyblock.ready, new Promise(resolve => setTimeout(resolve, 3000))])
    const view = await this.build(player, id)
    const screen = view.screen
    const prev = player.sbMenu
    const st = { screenId: id, windowId: this._nextWindowId(player), stateId: 1, slots: view.slots, names: view.slots.map(b => this.nameOf(b)), topCount: view.topCount, history: prev ? prev.history.slice() : [] }
    if (prev && push && prev.screenId !== id) st.history.push(prev.screenId)
    player.sbMenu = st
    player.windowType = 'skyblock_menu'
    const c = player._client
    c.writeRaw(Buffer.concat([varint(this.ids.open_window), varint(st.windowId), varint(screen.type), Buffer.from(screen.titleRaw, 'base64')]))
    c.writeRaw(this._windowItems(st, player))
    this.serv.emit?.('skyblockMenuOpened', player, id)
    return st
  }

  close (player, { notifyClient = true } = {}) {
    const st = player.sbMenu
    if (!st) return
    if (notifyClient) player._client.writeRaw(Buffer.concat([varint(this.ids.close_window), varint(st.windowId)]))
    player.sbMenu = null
    player.windowType = ''
  }

  resync (player) {
    const st = player.sbMenu
    if (!st) return
    st.stateId = (st.stateId + 1) % 32768
    const c = player._client
    c.writeRaw(Buffer.concat([varint(this.ids.set_cursor_item), EMPTY_SLOT]))
    c.writeRaw(this._windowItems(st, player))
  }

  /** put the SkyBlock Menu star into the player's hotbar (window 0) */
  giveStar (player) {
    if (!this.star || !this.opts.giveStar) return
    const slot = 36 + this.opts.starSlot
    const head = Buffer.alloc(2); head.writeInt16BE(slot)
    player._client.writeRaw(Buffer.concat([varint(this.ids.set_slot), varint(0), varint(0), head, this.star]))
  }

  async click (player, pkt) {
    const st = player.sbMenu
    if (!st || pkt.windowId !== st.windowId) return false
    const slot = pkt.slot
    let target
    if (slot >= 0 && slot < st.topCount && (pkt.mode === 0 || pkt.mode === 1)) {
      const screen = this.screens[st.screenId]
      target = screen.edges[slot + ':' + pkt.mouseButton] ?? screen.edges[slot]
      const name = st.names[slot]
      if (!target && name === 'Close') target = 'CLOSE'
      if (name === 'Go Back' && st.history.length) target = 'BACK'
      if (name === 'Close') target = 'CLOSE'
    }
    if (target === 'CLOSE') this.close(player)
    else if (target === 'BACK') { const back = st.history.pop(); await this.open(player, back, { push: false }).then(ns => { ns.history = st.history }) } else if (target && this.has(target)) await this.open(player, target)
    else this.resync(player)
    return true
  }
}

module.exports = { MenuEngine, View }
