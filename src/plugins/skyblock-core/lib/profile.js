'use strict'
const { EventEmitter } = require('events')
const { ArrayContainer, inventoryContainer, armorContainer } = require('./container')

const VERSION = 2 // 2: neutral items carry model/style/enchantments/signatures/typed custom_data

/**
 * The single source of truth for one player's SkyBlock profile (see docs/skyblock/ARCHITECTURE.md).
 * Containers hold items; `member` is the immutable-at-import API snapshot for everything not modelled as
 * state yet (skills xp, collections, bestiary, slayer, ...).  Changes are announced with 'change'.
 */
class ProfileState extends EventEmitter {
  constructor (meta = {}) {
    super()
    this.uuid = meta.uuid
    this.profileId = meta.profileId || null
    this.cuteName = meta.cuteName || null
    this.source = meta.source || 'unknown' // 'api' | 'sample' | 'store'
    this.importedAt = meta.importedAt || Date.now()
    this.member = meta.member || {}
    this.sets = meta.sets || { armor: {}, equipment: {} } // saved Armor Sets / Equipment Sets: id -> { SLOT: Item }
    this.loadouts = meta.loadouts || [] // [{id, name, armor_set_id, equipment_set_id, pet, ...}]
    this.settings = meta.settings || {}
    this.containers = new Map()
    this.window = null
  }

  addContainer (c) {
    c.onChange = evt => this.emit('change', evt)
    this.containers.set(c.name, c)
    return c
  }

  container (name) {
    const c = this.containers.get(name)
    if (!c) throw new Error('no container ' + name)
    return c
  }

  has (name) { return this.containers.has(name) }

  /** Make `inventory`/`armor` live views of the player's window, moving whatever was held in memory into it. */
  attachWindow (player) {
    const mem = { inventory: this.containers.get('inventory'), armor: this.containers.get('armor') }
    this.addContainer(inventoryContainer(player))
    this.addContainer(armorContainer(player))
    for (const name of ['inventory', 'armor']) {
      const live = this.container(name)
      for (let i = 0; i < live.size; i++) {
        const it = mem[name] ? mem[name].get(i) : null
        if (it || live.get(i)) live._set(i, it)
      }
    }
    this.window = player
    this._onSlot = (slot) => {
      for (const name of ['inventory', 'armor']) {
        const i = this.container(name).map.indexOf(slot)
        if (i >= 0) this.emit('change', { container: name, index: i, reason: 'window' })
      }
    }
    player.inventory.on('updateSlot', this._onSlot)
  }

  detachWindow () {
    if (this.window && this._onSlot) this.window.inventory.removeListener('updateSlot', this._onSlot)
    this.window = null
  }

  toJSON (neutralOf) {
    const out = {}
    for (const [name, c] of this.containers) out[name] = c.items().map(it => (it ? neutralOf(it) : null))
    const sets = { armor: {}, equipment: {} }
    for (const kind of ['armor', 'equipment']) for (const [id, set] of Object.entries(this.sets[kind])) sets[kind][id] = Object.fromEntries(Object.entries(set).map(([k, it]) => [k, it ? neutralOf(it) : null]))
    return { version: VERSION, uuid: this.uuid, profileId: this.profileId, cuteName: this.cuteName, source: this.source, importedAt: this.importedAt, savedAt: Date.now(), member: this.member, loadouts: this.loadouts, settings: this.settings, containers: out, sets }
  }

  static fromJSON (json, build) {
    if (json.version !== VERSION) throw new Error(`unsupported profile version ${json.version}`)
    const p = new ProfileState({ uuid: json.uuid, profileId: json.profileId, cuteName: json.cuteName, source: 'store', importedAt: json.importedAt, member: json.member, loadouts: json.loadouts, settings: json.settings })
    for (const [name, list] of Object.entries(json.containers)) p.addContainer(new ArrayContainer(name, list.length, list.map(n => (n ? build(n) : null))))
    for (const kind of ['armor', 'equipment']) for (const [id, set] of Object.entries(json.sets[kind] || {})) p.sets[kind][id] = Object.fromEntries(Object.entries(set).map(([k, n]) => [k, n ? build(n) : null]))
    return p
  }
}

module.exports = { ProfileState, VERSION }
