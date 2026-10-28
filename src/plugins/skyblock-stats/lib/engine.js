'use strict'
const { STATS } = require('../../hypixel-api/lib/statDefs')

const GROUP_ORDER = ['base', 'sb_level', 'skills', 'attributes', 'slayer', 'perks', 'armor', 'held', 'equipment', 'accessories', 'accessory_power', 'tuning', 'pets', 'effects']
const GROUP_LABEL = {
  base: 'Base',
  sb_level: 'SkyBlock Level',
  attributes: 'Attributes',
  skills: 'Skills',
  slayer: 'Slayers',
  perks: 'Perks',
  armor: 'Armor',
  held: 'Held Item',
  equipment: 'Equipment',
  accessories: 'Accessories',
  accessory_power: 'Accessory Power',
  tuning: 'Tuning',
  pets: 'Pet',
  effects: 'Effects'
}
const groupRank = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i }

/**
 * Pure stat calculator. No server/prismarine dependencies, so it is unit-testable
 * and usable by anything later (menus, damage calc, scoreboard, commands).
 *
 * A provider is { id, collect(ctx, push) } and pushes contributions:
 *   { stat, amount, group, label, kind: 'flat' | 'mult', parts?, itemId? }
 * Providers run in registration order and share `ctx.shared` (e.g. the
 * accessories provider publishes magical power for the power provider).
 */
class StatEngine {
  constructor ({ applyCaps = true } = {}) {
    this.providers = []
    this.applyCaps = applyCaps
  }

  use (provider) {
    if (this.providers.some(p => p.id === provider.id)) throw new Error('duplicate provider ' + provider.id)
    this.providers.push(provider)
    return this
  }

  remove (id) { this.providers = this.providers.filter(p => p.id !== id) }

  /**
   * @param {object} input
   * @param {{armor:Array,held:object|null,equipment:Array,accessories:Array}} input.sources  SbItem instances
   * @param {object} [input.state]      mutable player state (selectedPower, tuning, ...)
   * @param {Array}  [input.modifiers]  active effects
   * @param {object} [input.context]    { dungeon:boolean, dimension:'overworld'|'rift', location?:string }
   * @param {object} [input.profile]    raw API member object, for providers that need it
   */
  compute (input) {
    const ctx = {
      sources: Object.assign({ armor: [], held: null, equipment: [], accessories: [] }, input.sources),
      state: input.state || {},
      modifiers: input.modifiers || [],
      context: input.context || {},
      profile: input.profile || null,
      shared: {},
      warnings: []
    }
    const contributions = []
    const push = (c) => contributions.push(Object.assign({ kind: 'flat' }, c))
    for (const p of this.providers) {
      try { p.collect(ctx, push) } catch (e) { ctx.warnings.push(`provider ${p.id} failed: ${e.message}`) }
    }

    const dim = ctx.context.dimension || 'overworld'
    const stats = {}
    for (const def of Object.values(STATS)) {
      if (def.category === 'rift' && dim !== 'rift') continue
      stats[def.id] = {
        id: def.id,
        name: def.name,
        category: def.category,
        color: def.color,
        icon: def.icon,
        legacyIcon: def.legacyIcon,
        suffix: def.suffix,
        base: def.base,
        cap: def.cap,
        flat: def.base,
        multPct: 0,
        sources: def.base ? [{ group: 'base', label: 'Base', amount: def.base, kind: 'flat' }] : []
      }
    }
    for (const c of contributions) {
      const s = stats[c.stat]
      if (!s) continue
      if (c.kind === 'mult') s.multPct += c.amount
      else s.flat += c.amount
      s.sources.push(c)
    }

    const byGroup = {}
    for (const s of Object.values(stats)) {
      s.raw = s.flat * (1 + s.multPct / 100)
      s.total = (this.applyCaps && s.cap != null) ? Math.min(s.raw, s.cap) : s.raw
      s.capped = s.cap != null && s.raw > s.cap
      s.breakdown = mergeSources(s.sources)
      for (const b of s.breakdown) {
        const g = (byGroup[b.group] = byGroup[b.group] || {})
        g[s.id] = (g[s.id] || 0) + b.amount
      }
      delete s.sources
    }

    const t = (id) => (stats[id] ? stats[id].total : 0)
    return {
      stats,
      byGroup,
      derived: {
        effective_health: t('health') * (1 + t('defense') / 100), // wiki: Health x (Defense/100 + 1)
        mana: 100 + t('intelligence') // wiki: base 100 + Intelligence
      },
      held: ctx.shared.held || null,
      accessories: ctx.shared.accessories || null,
      magicalPower: ctx.shared.magicalPower || 0,
      power: ctx.shared.power || null,
      context: { dungeon: !!ctx.context.dungeon, dimension: dim },
      warnings: ctx.warnings,
      computedAt: Date.now()
    }
  }

  /** Stats whose total changed between two results: [{ stat, from, to }] */
  static diff (prev, next) {
    const out = []
    for (const id of Object.keys(next.stats)) {
      const a = prev && prev.stats[id] ? prev.stats[id].total : undefined
      const b = next.stats[id].total
      if (a === undefined ? b !== STATS[id].base : Math.abs(a - b) > 1e-9) out.push({ stat: id, from: a === undefined ? STATS[id].base : a, to: b })
    }
    return out
  }
}

function mergeSources (sources) {
  const m = new Map()
  for (const s of sources) {
    const key = s.group + '\u0000' + s.label + '\u0000' + s.kind
    const cur = m.get(key)
    if (cur) { cur.amount += s.amount; if (s.parts) cur.parts = (cur.parts || []).concat(s.parts) } else m.set(key, { group: s.group, label: s.label, kind: s.kind, amount: s.amount, itemId: s.itemId, parts: s.parts ? s.parts.slice() : undefined, dungeonBonus: s.dungeonBonus })
  }
  return [...m.values()].sort((a, b) => groupRank(a.group) - groupRank(b.group) || Math.abs(b.amount) - Math.abs(a.amount))
}

/** Engine pre-loaded with the built-in providers. */
function createDefaultEngine (opts) {
  return new StatEngine(opts)
    .use(require('./providers/skills'))
    .use(require('./providers/sbLevel'))
    .use(require('./providers/attributes'))
    .use(require('./providers/items'))
    .use(require('./providers/accessories'))
    .use(require('./providers/power')) // must follow accessories (needs magical power)
    .use(require('./providers/tuning'))
    .use(require('./providers/effects'))
}

module.exports = { StatEngine, createDefaultEngine, GROUP_ORDER, GROUP_LABEL }
