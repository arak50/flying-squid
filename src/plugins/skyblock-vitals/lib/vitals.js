'use strict'
const EventEmitter = require('events')

// Rules (Hypixel SkyBlock wiki, checked 2026-10-31; see docs/skyblock/ARCHITECTURE.md §3.5):
//  Health regen  every 2 s (wiki.hypixel.net/Stats, in-game text "Regen interval: Every 2 seconds"):
//                  heal = (MaxHealth / 100 + 1.5) x HealthRegen / 100     (base Health Regen 100 -> ~1.25 HP/s at 100 HP)
//  Vitality      "increases your incoming healing, including health regen": heals are x Vitality / 100 (base 100 = x1)
//  Mana          max = 100 + Intelligence (the engine's derived.mana); regenerates every 1 s by 2% of max
//                  (+ percentage bonuses: Mana Flux orb +50 %, Wisp pet, Mana Regeneration attribute ... via addRegenBonus)
//                RECORDED (Hypixel, 26.1): the STORED mana is never cut when max falls - only the display is `min(mana, max)`
//                  (529/953 -> 529/610; 550/610 -> 460/460 for 1.5 s -> 550/610 again, not 481), and regen pauses while stored >= max.
//  Absorption    RECORDED: extra HP on top of max, shown in gold as `health + absorption` (4,499/4,124); damage eats it first.
//  Not enough    RECORDED: a failed ability replaces only the mana segment with "NOT ENOUGH MANA" until ~1.5 s after the last failure.
//  Ability cost  UNVERIFIED and NOT in the recording: no "-N Mana (...)" text ever appeared across ~25 mana spends (opt-in: manaFlash).
//  Overflow      separate pool (max 780), never regenerates, used instead of Mana when Mana alone cannot pay the cost
//  Damage        reduced by Defense / (Defense + 100) (True Defense for true damage) - recorded, ARCHITECTURE §3.3
// UNVERIFIED (no recording): whether Overflow pays the whole cost or only the shortfall; rounding of displayed numbers;
// regen amounts (recorded +28 mana/s at max 953 and +21/s at 610, +141 HP/s at max 4,124 - far above the base formulas, the buff sources are unknown).
const HEALTH_INTERVAL_MS = 2000
const MANA_INTERVAL_MS = 1000
const MANA_REGEN_FRACTION = 0.02
const MAX_OVERFLOW = 780
const NOT_ENOUGH_MANA_MS = 1500 // recorded: bursts ended 1.25-1.42 s after the last failed attempt (bars are 0.5 s apart)
const ZONE_MS = 2000 // recorded: the zone name replaces Defense for ~2-2.5 s

class Vitals extends EventEmitter {
  /**
   * @param {{get(stat:string):number, maxMana:number}} stats  PlayerStats-like (player.skyblock.stats)
   * @param {{manaFlash?:boolean}} [opts]  manaFlash: show "-N Mana (label)" after a paid ability (never seen in the recording)
   */
  constructor (stats, opts = {}) {
    super()
    this.stats = stats
    this.manaFlash = !!opts.manaFlash
    this.health = this.maxHealth
    this.mana = this.maxMana
    this.overflow = 0
    this.absorption = 0 // extra HP above max, damaged first, shown in gold
    this.dead = false
    this.notEnough = 0 // ms left of the NOT ENOUGH MANA message
    this.zone = null // { name, color, ms } shown in place of Defense
    this.regenBonuses = new Map() // id -> percent of base mana regen
    this._hAcc = 0
    this._mAcc = 0
    this.flash = null // { text, ms } shown in place of the mana segment (ability cost)
  }

  get maxHealth () { return Math.max(1, this.stats.get('health')) }
  get maxMana () { return Math.max(0, this.stats.maxMana) }
  get defense () { return this.stats.get('defense') }
  /** What the client sees: stored mana is kept when max falls (recorded), only the display is capped. */
  get shownMana () { return Math.min(this.mana, this.maxMana) }

  /** HP per natural regen tick, before Vitality */
  get regenPerTick () { return (this.maxHealth / 100 + 1.5) * this.stats.get('health_regen') / 100 }
  get vitalityMultiplier () { return this.stats.get('vitality') / 100 }
  get manaPerSecond () { return this.maxMana * MANA_REGEN_FRACTION * (1 + [...this.regenBonuses.values()].reduce((a, b) => a + b, 0) / 100) }

  addRegenBonus (id, percent) { this.regenBonuses.set(id, percent); this.emit('change') }
  removeRegenBonus (id) { if (this.regenBonuses.delete(id)) this.emit('change') }

  /**
   * Call whenever stats changed. Health is clamped to the new max (recorded: 3,676/4,124 -> 3,458/3,458), never raised.
   * Mana is NOT cut: the stored value survives a lower max and shows again when max rises (recorded 550/610 -> 460/460 -> 550/610).
   */
  sync () {
    let changed = false
    if (this.health > this.maxHealth) { this.health = this.maxHealth; changed = true }
    const shown = this.shownMana
    if (shown !== this._lastShownMana) { this._lastShownMana = shown; changed = true }
    if (changed) this.emit('change')
    return changed
  }

  fill () { this.health = this.maxHealth; this.mana = this.maxMana; this.absorption = 0; this.dead = false; this.emit('change') }

  /** The mana segment shows NOT ENOUGH MANA; call on every failed attempt (it renews the timer). */
  failMana () { this.notEnough = NOT_ENOUGH_MANA_MS; this.emit('change') }

  /** Show a zone name in place of Defense for a moment, e.g. showZone('Colosseum') or showZone('Wilderness', { color: '2' }). */
  showZone (name, { color = 'b', ms = ZONE_MS } = {}) { this.zone = { name, color, ms }; this.emit('change') }

  addAbsorption (n) { this.absorption = Math.max(0, this.absorption + n); this.emit('change') }
  setAbsorption (n) { this.absorption = Math.max(0, n); this.emit('change') }

  /** Advance simulated time. Deterministic: the caller supplies the elapsed milliseconds. */
  advance (ms) {
    let changed = false
    if (this.flash && (this.flash.ms -= ms) <= 0) { this.flash = null; changed = true }
    if (this.notEnough > 0 && (this.notEnough -= ms) <= 0) { this.notEnough = 0; changed = true }
    if (this.zone && (this.zone.ms -= ms) <= 0) { this.zone = null; changed = true }
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
    const soaked = Math.min(this.absorption, taken) // absorption goes first
    this.absorption -= soaked
    this.health = Math.max(0, this.health - (taken - soaked))
    this.emit('change')
    if (this.health <= 0) { this.dead = true; this.emit('death') }
    return taken
  }

  /** Set health from a vanilla 0..20 value (what core code like /kill and respawn use). */
  setFromVanilla (v) {
    if (v <= 0) { this.health = 0; if (!this.dead) { this.dead = true; this.emit('change'); this.emit('death'); return } } else {
      this.dead = false
      this.health = this.maxHealth // core only ever sends 20 (respawn/join): any positive value refills
    }
    this.emit('change')
  }

  /** Spend mana for an ability (from what is shown). Overflow pays instead when Mana alone is not enough. */
  spendMana (cost, { label } = {}) {
    if (this.dead || cost < 0) return false
    const shown = this.shownMana
    if (shown >= cost) this.mana = shown - cost
    else if (this.overflow >= cost) this.overflow -= cost
    else return false
    if (label && this.manaFlash) this.flash = { text: `-${Math.round(cost)} Mana (${label})`, ms: 2000 }
    this.emit('change')
    return true
  }

  addMana (n) { this.mana = Math.min(this.maxMana, this.shownMana + n); this.emit('change') }
  setOverflow (n) { this.overflow = Math.max(0, Math.min(MAX_OVERFLOW, n)); this.emit('change') } // conversions overwrite, per the wiki

  /** What the vanilla heart bar shows: the same fraction of 20, never 0 while alive. */
  get vanillaHealth () { return this.health <= 0 ? 0 : Math.max(1, (this.health / this.maxHealth) * 20) }

  /**
   * The value for the update_health packet. Recorded from Hypixel (26.1): full health is 40.0 on the wire, not 20.
   * Same fraction as Health / Max Health, never 0 while alive. `full` = value at 100 %.
   */
  heartsHealth (full = 40) { return this.health <= 0 ? 0 : Math.min(full, Math.max(1, (this.health / this.maxHealth) * full)) }

  snapshot () {
    return {
      health: this.health,
      absorption: this.absorption,
      maxHealth: this.maxHealth,
      defense: this.defense,
      mana: this.shownMana,
      maxMana: this.maxMana,
      overflow: this.overflow,
      flash: this.flash && this.flash.text,
      notEnough: this.notEnough > 0,
      zone: this.zone && { name: this.zone.name, color: this.zone.color },
      dead: this.dead
    }
  }
}

module.exports = { Vitals, HEALTH_INTERVAL_MS, MANA_INTERVAL_MS, MANA_REGEN_FRACTION, MAX_OVERFLOW, NOT_ENOUGH_MANA_MS, ZONE_MS }
