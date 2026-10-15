/**
 * skyblock-stats — live SkyBlock stat calculation + the data model behind the Stats & Equipment menu.
 * Needs `skyblock-core` (the profile whose containers it reads). Load order in settings does not matter.
 *
 * Recomputes on: inventory import, hotbar slot change, any inventory click / slot update (armour swaps,
 * picking up weapons), context changes (dungeon), effect add/expire, power/tuning changes.
 *
 *   serv.skyblock.engine                      StatEngine — engine.use({ id, collect(ctx, push) }) adds a stat source
 *   player.skyblock.stats                     PlayerStats:
 *       .get('strength')   .breakdown('strength')   .result   .menu({legacy, hideZero})
 *       .effectiveHealth / .maxMana
 *       .setContext({dungeon:true})  .addEffect({id,label,stats,multipliers}, durationMs)  .removeEffect(id)
 *       .setSelectedPower(id)  .setTuning(points)
 *       .on('change', ({result, changes, reason}))
 *   Events (player & serv): 'skyblock:stats' (result, changes, reason)
 *
 * config/settings.json: "skyblock-stats": { "applyCaps": true, "context": { "dungeon": false } }
 */
const { createDefaultEngine, StatEngine } = require('./lib/engine')
const { PlayerStats } = require('./lib/playerStats')

const hasPoints = t => !!t && typeof t === 'object' && t.purchase_ts === undefined

// power / tuning selection lives in the profile's accessory bag
function runtimeFromMember (member) {
  const abs = member.accessory_bag_storage || {}
  const tuning = abs.tuning || {}
  const slotKey = tuning.selected_slot != null ? 'slot_' + tuning.selected_slot : 'slot_0'
  return {
    selectedPower: abs.selected_power || null,
    unlockedPowers: abs.unlocked_powers || [],
    tuning: hasPoints(tuning[slotKey]) ? tuning[slotKey] : (hasPoints(tuning.slot_0) ? tuning.slot_0 : null),
    tuningSlot: slotKey
  }
}

module.exports.server = function (serv) {
  const cfg = this.settings || {}
  serv.skyblock = serv.skyblock || {}
  serv.skyblock.StatEngine = StatEngine
  serv.skyblock.engine = createDefaultEngine({ applyCaps: cfg.applyCaps !== false })

  // Debug/verification command. The real menu consumes player.skyblock.stats.menu().
  if (serv.commands && typeof serv.commands.add === 'function') {
    serv.commands.add({
      base: 'skystats',
      info: 'Show your calculated SkyBlock stats',
      usage: '/skystats [stat_id]',
      action (params, ctx) {
        const player = (ctx && ctx.player) || ctx
        const st = player && player.skyblock && player.skyblock.stats
        if (!st || !st.result) return 'No SkyBlock profile loaded yet.'
        const [id] = String(params || '').trim().split(/\s+/)
        const round = n => Math.round(n * 100) / 100
        if (id) {
          const s = st.result.stats[id]
          if (!s) return 'Unknown stat: ' + id
          return [`§e${s.name}: §f${round(s.total)}`, ...s.breakdown.map(b => `§7${b.group}: ${b.label} §f${b.amount >= 0 ? '+' : ''}${round(b.amount)}`)].join('\n')
        }
        const r = st.result
        const keys = ['health', 'defense', 'strength', 'crit_chance', 'crit_damage', 'attack_speed', 'ferocity', 'intelligence', 'speed', 'magic_find']
        return keys.map(k => `§7${r.stats[k].name}: §f${round(r.stats[k].total)}`).join('§8 | ') +
          `\n§7Effective Health: §f${Math.round(r.derived.effective_health)} §8| §7Magical Power: §f${r.magicalPower}`
      }
    })
  }
}

module.exports.player = function (player, serv) {
  const settings = this.settings || {}
  const sb = player.skyblock = player.skyblock || {}
  const stats = sb.stats = new PlayerStats(player, serv.skyblock.engine, { context: settings.context })
  sb.runtime = {}

  stats.on('change', ({ result, changes, reason }) => {
    player.emit('skyblock:stats', result, changes, reason)
    serv.emit('skyblock:stats', player, result, changes, reason)
  })

  player.on('skyblockProfileReady', (profile) => {
    sb.runtime = runtimeFromMember(sb.member)
    stats.heldSlot = player.heldItemSlot || 0
    profile.on('change', () => stats.schedule('inventory')) // any item movement, from any source
    stats.recompute('import')
  })
  player._client.on('held_item_slot', p => stats.setHeldSlot((p && p.slotId) || 0))

  player._client.once('end', () => stats.dispose())
}
