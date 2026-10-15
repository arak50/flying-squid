'use strict'
const EventEmitter = require('events')
const { SbItem } = require('../../hypixel-api/lib/item')
const { buildModifiers } = require('./modifiers')
const { StatEngine } = require('./engine')
const { buildStatsMenu } = require('./menu')

/**
 * Per-player controller around the pure StatEngine. It owns the *live* inputs
 * (current armour, held item, context, effects), recomputes whenever they change,
 * and publishes `change` events. Everything a stats menu, damage system or
 * scoreboard needs later is a getter on this object.
 */
class PlayerStats extends EventEmitter {
  constructor (player, engine, options = {}) {
    super()
    this.player = player
    this.engine = engine
    this.options = options
    this.context = { dungeon: false, dimension: 'overworld', ...options.context }
    this.modifiers = []
    this.heldSlot = 0
    this.result = null
    this._sources = null
    this._timers = new Map()
    this._scheduled = null
  }

  get sb () { return this.player.skyblock }

  // ---- inputs --------------------------------------------------------------
  get profile () { return this.sb && this.sb.profile }

  /** Everything the item providers need, read live from the profile containers (the same ones menus edit). */
  sources () {
    const p = this.profile
    const it = (c, i) => SbItem.fromPrismarine(p.container(c).get(i))
    const list = c => p.container(c).items().map(SbItem.fromPrismarine)
    return {
      armor: [3, 2, 1, 0].map(i => it('armor', i)), // providers expect boots..helmet
      held: it('inventory', this.heldSlot),
      equipment: list('equipment'),
      accessories: list('accessoryBag')
    }
  }

  /** Modifier rows per stat (see modifiers.js), cached per computation. */
  statModifiers () { // not `modifiers`: that name is the list of active effects on this object
    if (!this.result) return {}
    if (this._modsFor !== this.result) { this._mods = buildModifiers(this.result, this.sources()); this._modsFor = this.result }
    return this._mods
  }

  // ---- compute -------------------------------------------------------------
  /** Coalesce bursts (a click can touch several slots) into one compute. */
  schedule (reason) {
    this._reason = reason
    if (this._scheduled) return
    this._scheduled = setImmediate(() => { this._scheduled = null; this.recompute(this._reason) })
  }

  recompute (reason = 'manual') {
    if (!this.profile) return this.result
    this._sources = this.sources()
    const next = this.engine.compute({
      sources: this._sources,
      state: this.sb.runtime,
      modifiers: this.modifiers,
      context: this.context,
      profile: this.sb.member
    })
    const changes = StatEngine.diff(this.result, next)
    this.result = next
    if (changes.length || reason === 'import' || reason === 'manual') this.emit('change', { result: next, changes, reason })
    return next
  }

  // ---- queries ---------------------------------------------------------------
  get (stat) { return this.result && this.result.stats[stat] ? this.result.stats[stat].total : 0 }
  breakdown (stat) { return this.result && this.result.stats[stat] ? this.result.stats[stat].breakdown : [] }
  get effectiveHealth () { return this.result ? this.result.derived.effective_health : 0 }
  get maxMana () { return this.result ? this.result.derived.mana : 100 }
  menu (opts) { return this.result ? buildStatsMenu(this.result, this._sources, opts) : null }

  // ---- mutations (all trigger a recompute) --------------------------------------
  setHeldSlot (i) { this.heldSlot = i; this.schedule('held') }
  setContext (partial) { Object.assign(this.context, partial); this.schedule('context') }
  setSelectedPower (id) { this.sb.runtime.selectedPower = id; this.schedule('power') }
  setTuning (points) { this.sb.runtime.tuning = points; this.schedule('tuning') }

  /** @param {{id,label,stats?,multipliers?,group?}} mod  @param {number} [durationMs] */
  addEffect (mod, durationMs) {
    this.removeEffect(mod.id, true)
    const m = { ...mod, expiresAt: durationMs ? Date.now() + durationMs : undefined }
    this.modifiers.push(m)
    if (durationMs) this._timers.set(mod.id, setTimeout(() => this.removeEffect(mod.id), durationMs))
    this.schedule('effect')
    return m
  }

  removeEffect (id, silent) {
    this.modifiers = this.modifiers.filter(m => m.id !== id)
    if (this._timers.has(id)) { clearTimeout(this._timers.get(id)); this._timers.delete(id) }
    if (!silent) this.schedule('effect')
  }

  dispose () {
    for (const t of this._timers.values()) clearTimeout(t)
    this._timers.clear()
    if (this._scheduled) clearImmediate(this._scheduled)
    this.removeAllListeners()
  }
}

module.exports = { PlayerStats }
