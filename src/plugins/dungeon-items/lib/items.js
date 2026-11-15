'use strict'
/**
 * DungeonItems: pure bookkeeping of the items lying in a run and what players have picked up. No flying-squid, no Math.random
 * (pass `rng`). The plugin draws them and calls pickup() when a player walks over one.
 *
 *   spawn(type, position, { level, roomId, floor, master }) -> item   emits 'spawned'
 *   pickup(itemId, playerId, { recipients })                -> result | null   emits 'pickedUp'   (a blessing is granted to every recipient, default: the picker)
 *   bonuses(playerId)  { stat: { add, mult } } from a player's blessings   levels(playerId) { blessing_life: 7, ... }
 *   grantText(type, level)  the stats one blessing grants, as a chat string
 *   inventory(playerId) consumables carried   use(playerId, type) -> bool
 */
const { EventEmitter } = require('events')
const { ITEMS, STAT_TEXT, resolve } = require('./catalog')

/** Blessing level for a floor: the deeper (and the harder), the higher; a little spread around it. */
function rollLevel (floor, master, rng) {
  const top = Math.min(13, 1 + Math.max(0, floor | 0) + (master ? 5 : 0))
  const low = Math.max(1, top - 2)
  return low + Math.floor(rng() * (top - low + 1))
}

function createItems ({ rng = Math.random } = {}) {
  const em = new EventEmitter()
  const lying = new Map()
  const owned = new Map() // playerId -> { levels: {}, carried: {} }
  let nextId = 1
  const of = id => { const k = String(id); if (!owned.has(k)) owned.set(k, { levels: {}, carried: {} }); return owned.get(k) }

  function spawn (ref, position, opts = {}) {
    const type = resolve(ref)
    if (!type) throw new Error(`Unknown item: ${ref} (${Object.keys(ITEMS).join(', ')})`)
    const def = ITEMS[type]
    const item = { id: `item${nextId++}`, type, kind: def.kind, position: { ...position }, roomId: opts.roomId ?? null, ...(opts.data || {}) }
    if (def.kind === 'blessing') item.level = Math.max(1, Math.min(def.maxLevel, opts.level ?? rollLevel(opts.floor || 0, !!opts.master, rng)))
    lying.set(item.id, item)
    em.emit('spawned', item)
    return item
  }

  function pickup (itemId, playerId, { recipients } = {}) {
    const item = lying.get(itemId)
    if (!item) return null
    lying.delete(itemId)
    const def = ITEMS[item.type]
    const result = { item, by: String(playerId), kind: def.kind, type: item.type }
    if (def.kind === 'blessing') {
      for (const id of new Set([String(playerId), ...(recipients || []).map(String)])) {
        const o = of(id)
        o.levels[item.type] = (o.levels[item.type] || 0) + item.level // blessings of one kind add up
        if (id === String(playerId)) result.total = o.levels[item.type]
      }
      result.recipients = [...new Set([String(playerId), ...(recipients || []).map(String)])]
    } else if (def.kind === 'consumable') {
      const o = of(playerId); o.carried[def.consumable] = (o.carried[def.consumable] || 0) + 1
      result.count = o.carried[def.consumable]
    }
    em.emit('pickedUp', result)
    return result
  }

  function bonuses (playerId) {
    const out = {}
    for (const [type, level] of Object.entries(of(playerId).levels)) {
      for (const [stat, v] of Object.entries(ITEMS[type].stats)) {
        const o = out[stat] || (out[stat] = { add: 0, mult: 1 })
        if (v.add) o.add += v.add * level
        if (v.mult) o.mult *= Math.pow(v.mult, level)
      }
    }
    for (const o of Object.values(out)) { o.add = Math.round(o.add * 100) / 100; o.mult = Math.round(o.mult * 10000) / 10000 }
    return out
  }
  const levels = playerId => ({ ...of(playerId).levels })
  const inventory = playerId => ({ ...of(playerId).carried })
  function use (playerId, consumable) {
    const o = of(playerId)
    if (!(o.carried[consumable] > 0)) return false
    o.carried[consumable]--
    return true
  }
  const flat = v => String(Math.round(v * 10) / 10)
  const mul = v => String(Math.floor(v * 100 + 1e-9) / 100) // the game truncates: 1.03^5 = 1.159 reads 1.15x
  /** "+20.4 & +1.1x §aDefense §7and §a+30 §cDamage" style text for one blessing level, e.g. the second line of DUNGEON BUFF. */
  function grantText (type, level) {
    const parts = []
    for (const [stat, v] of Object.entries(ITEMS[type].stats)) {
      const [label, code] = STAT_TEXT[stat] || [stat, 'a']
      if (stat === 'health') { parts.push(`§a+${mul(Math.pow(v.mult, level))}x HP`); continue }
      const bits = []
      if (v.add) bits.push(`§a+${flat(v.add * level)}`)
      if (v.add && v.mult) bits.push('§7 & ')
      if (v.mult) bits.push(`§a+${mul(Math.pow(v.mult, level))}x`)
      parts.push(`${bits.join('')} §${code}${label}`)
    }
    return parts.join(' §7and ')
  }
  const remove = id => lying.delete(id)
  const list = () => [...lying.values()]
  return Object.assign(em, { spawn, pickup, grantText, bonuses, levels, inventory, use, remove, list })
}

module.exports = { createItems, rollLevel }
