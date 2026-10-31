'use strict'
const EventEmitter = require('events')

// Rules (Hypixel SkyBlock wiki, checked 2026-10-31; see docs/skyblock/ARCHITECTURE.md §3.5):
//  Health regen  every 2 s (wiki.hypixel.net/Stats, in-game text "Regen interval: Every 2 seconds"):
//                  heal = (MaxHealth / 100 + 1.5) x HealthRegen / 100     (base Health Regen 100 -> ~1.25 HP/s at 100 HP)
//  Vitality      "increases your incoming healing, including health regen": heals are x Vitality / 100 (base 100 = x1)
//  Mana          max = 100 + Intelligence (the engine's derived.mana); regenerates every 1 s by 2% of max
//                  (+ percentage bonuses: Mana Flux orb +50 %, Wisp pet, Mana Regeneration attribute ... via addRegenBonus)
//                When max falls below current, the excess is removed. A higher max does not refill.
//  Overflow      separate pool (max 780), never regenerates, used instead of Mana when Mana alone cannot pay the cost
//  Damage        reduced by Defense / (Defense + 100) (True Defense for true damage) - recorded, ARCHITECTURE §3.3
// UNVERIFIED (no recording): whether Overflow pays the whole cost or only the shortfall; rounding of displayed numbers.
const HEALTH_INTERVAL_MS = 2000
const MANA_INTERVAL_MS = 1000
const MANA_REGEN_FRACTION = 0.02
const MAX_OVERFLOW = 780

class Vitals extends EventEmitter {
  /** @param {{get(stat:string):number, maxMana:number}} stats  PlayerStats-like (player.skyblock.stats) */
  constructor (stats) {
    super()
    this.stats = stats
    this.health = this.maxHealth
    this.mana = this.maxMana
    this.overflow = 0
    this.dead = false
    this.regenBonuses = new Map() // id -> percent of base mana regen
    this._hAcc = 0
    this._mAcc = 0
    this.flash = null // { text, ms } shown in place of the mana segment (ability cost)
  }

  get maxHealth () { return Math.max(1, this.stats.get('health')) }
  get maxMana () { return Math.max(0, this.stats.maxMana) }
  get defense () { return this.stats.get('defense') }

  /** HP per natural regen tick, before Vitality */
  get regenPerTick () { return (this.maxHealth / 100 + 1.5) * this.stats.get('health_regen') / 100 }
  get vitalityMultiplier () { return this.stats.get('vitality') / 100 }
  get manaPerSecond () { return this.maxMana * MANA_REGEN_FRACTION * (1 + [...this.regenBonuses.values()].reduce((a, b) => a + b, 0) / 100) }

  addRegenBonus (id, percent) { this.regenBonuses.set(id, percent); this.emit('change') }
  removeRegenBonus (id) { if (this.regenBonuses.delete(id)) this.emit('change') }

  /** Call whenever stats changed: pools are clamped to the new maxima, never raised. */
  sync () {
    let changed = false
    if (this.health > this.maxHealth) { this.health = this.maxHealth; changed = true }
    if (this.mana > this.maxMana) { this.mana = this.maxMana; changed = true }
    if (changed) this.emit('change')
    return changed
  }

  fill () { this.health = this.maxHealth; this.mana = this.maxMana; this.dead = false; this.emit('change') }

  /** Advance simulated time. Deterministic: the caller supplies the elapsed milliseconds. */
  advance (ms) {
    let changed = false
    if (this.flash && (this.flash.ms -= ms) <= 0) { this.flash = null; changed = true }
    this._mAcc += ms
    while (this._mAcc >= MANA_INTERVAL_MS) {
      this._mAcc -= MANA_INTERVAL_MS
      if (!this.dead && this.mana < this.maxMana) { this.mana = Math.min(this.maxMana, this.mana + this.manaPerSecond); changed = true }
    }
    this._hAcc += ms
    while (this._hAcc >= HEALTH_INTERVAL_MS) {
      this._hAcc -= HEALTH_INTERVAL_MS
      if (!this.dead && this.health < this.maxHealth) { this.health = Math.min(this.maxHealth, this.health + this.regenPerTick * this.vitalityMultiplier); changed = true }
    }
    if (changed) this.emit('change')
    return changed
  }

  /** Heal from any source. Vitality scales it unless `raw`. Returns the HP actually added. */
  heal (amount, { raw = false } = {}) {
    if (this.dead || amount <= 0) return 0
    const before = this.health
    this.health = Math.min(this.maxHealth, this.health + amount * (raw ? 1 : this.vitalityMultiplier))
    if (this.health !== before) this.emit('change')
    return this.health - before
  }

  /** @returns {number} HP removed after defense. Emits 'death' when health reaches 0. */
  damage (amount, { trueDamage = false } = {}) {
    if (this.dead || amount <= 0) return 0
    const d = trueDamage ? this.stats.get('true_defense') : this.defense
    const taken = amount * (1 - d / (d + 100))
    this.health = Math.max(0, this.health - taken)
    this.emit('change')
    if (this.health <= 0) { this.dead = true; this.emit('death') }
    return taken
  }

  /** Set health from a vanilla 0..20 value (what core code like /kill and respawn use). */
  setFromVanilla (v) {
    if (v <= 0) { this.health = 0; if (!this.dead) { this.dead = true; this.emit('change'); this.emit('death'); return } } else {
      this.dead = false
      this.health = v ? this.maxHealth : this.maxHealth
    }
    this.emit('change')
  }

  /** Spend mana for an ability. Overflow pays instead when Mana alone is not enough. */
  spendMana (cost, { label } = {}) {
    if (this.dead || cost < 0) return false
    if (this.mana >= cost) this.mana -= cost
    else if (this.overflow >= cost) this.overflow -= cost
    else return false
    if (label) this.flash = { text: `-${Math.round(cost)} Mana (${label})`, ms: 2000 }
    this.emit('change')
    return true
  }

  addMana (n) { this.mana = Math.min(this.maxMana, this.mana + n); this.emit('change') }
  setOverflow (n) { this.overflow = Math.max(0, Math.min(MAX_OVERFLOW, n)); this.emit('change') } // conversions overwrite, per the wiki

  /** What the vanilla heart bar shows: the same fraction of 20, never 0 while alive. */
  get vanillaHealth () { return this.health <= 0 ? 0 : Math.max(1, (this.health / this.maxHealth) * 20) }

  snapshot () {
    return { health: this.health, maxHealth: this.maxHealth, defense: this.defense, mana: this.mana, maxMana: this.maxMana, overflow: this.overflow, flash: this.flash && this.flash.text, dead: this.dead }
  }
}

module.exports = { Vitals, HEALTH_INTERVAL_MS, MANA_INTERVAL_MS, MANA_REGEN_FRACTION, MAX_OVERFLOW }
