'use strict'
const { liveToRaw } = require('./convert')
const { parseLore, parseFooter, strip } = require('./lore')

// Footer type -> role. Anything not listed is 'other'.
const ROLE = {
  HELMET: 'armor',
  CHESTPLATE: 'armor',
  LEGGINGS: 'armor',
  BOOTS: 'armor',
  ACCESSORY: 'accessory',
  HATCESSORY: 'accessory',
  HATCCESSORY: 'accessory',
  NECKLACE: 'equipment',
  CLOAK: 'equipment',
  BELT: 'equipment',
  GLOVES: 'equipment',
  BRACELET: 'equipment',
  PET: 'pet',
  'PET ITEM': 'pet_item',
  SWORD: 'weapon',
  LONGSWORD: 'weapon',
  BOW: 'weapon',
  AXE: 'weapon',
  WAND: 'weapon',
  GAUNTLET: 'weapon',
  'FISHING WEAPON': 'weapon',
  DEPLOYABLE: 'other',
  TOOL: 'tool',
  PICKAXE: 'tool',
  DRILL: 'tool',
  SHOVEL: 'tool',
  HOE: 'tool',
  'FISHING ROD': 'tool',
  'FISHING NET': 'tool',
  SHEARS: 'tool'
}
const HELD_ROLES = new Set(['weapon', 'tool'])

class SbItem {
  /** @param {{id,count,damage,nbt,tag}} raw  entry produced by nbt.decodeInventory */
  constructor (raw) {
    this.raw = raw
    this.mcId = raw.id
    this.count = raw.count
    this.damage = raw.damage
    this.nbt = raw.nbt
    const tag = raw.tag || {}
    this.extra = tag.ExtraAttributes || {}
    this.display = tag.display || {}
    this.id = this.extra.id || null // SkyBlock item id e.g. "HYPERION"
    this.displayName = this.display.Name || ''
    this.name = strip(this.displayName)
    this.lore = this.display.Lore || []
    this._parsed = null
    this._footer = undefined
  }

  /** Build from a prismarine-item (live inventory) without touching the API data. */
  static fromPrismarine (item) {
    if (!item) return null
    if (item._sb) return item._sb
    const live = liveToRaw(item)
    const tag = { ExtraAttributes: live.extra, display: { Name: live.name || '', Lore: live.lore } }
    const s = new SbItem({ id: item.type, count: item.count, damage: 0, nbt: undefined, tag })
    Object.defineProperty(s, 'live', { value: item, enumerable: false }) // the prismarine item this was read from (icons)
    try { Object.defineProperty(item, '_sb', { value: s, enumerable: false, configurable: true }) } catch (e) { /* frozen */ }
    return s
  }

  static fromRaw (raw) { return raw ? new SbItem(raw) : null }

  get parsed () { return this._parsed || (this._parsed = parseLore(this.lore)) }
  get footer () { return this._footer === undefined ? (this._footer = parseFooter(this.lore)) : this._footer }
  get rarity () { return this.footer ? this.footer.rarity : null }
  get role () { return this.footer ? (ROLE[this.footer.type.split(' ').slice(-1)[0]] || ROLE[this.footer.type] || 'other') : 'unknown' }
  get hasStats () { return Object.keys(this.parsed.stats).length > 0 }

  /** Does this item contribute stats while held in the hotbar? */
  get countsWhenHeld () {
    const r = this.role
    return HELD_ROLES.has(r) || (r === 'unknown' && this.hasStats)
  }

  toJSON () { return { id: this.id, name: this.name, rarity: this.rarity, role: this.role, count: this.count } }
}

module.exports = { SbItem }
