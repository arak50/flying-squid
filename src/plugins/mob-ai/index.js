'use strict'
/**
 * mob-ai — Pumpkin-style goal based mob AI for flying-squid.
 *
 * Design follows https://docs.pumpkinmc.org/developer/entities/ai-and-mobs :
 * every mob gets a GoalSelector holding prioritised Goals (Swim, Panic, FleeSun, MeleeAttack,
 * RangedAttack, WanderAround, LookAtEntity ...), a grid A* navigator, and attributes.
 *
 * AI FREEZE: a mob whose nearest player is further away than `activeRange` blocks (or that has
 * no player in its world at all) is frozen: its goals are stopped and nothing is computed for it
 * until a player comes back within range. A small hysteresis band stops mobs flickering between
 * the two states at the boundary.
 *
 * Install: copy this folder to  src/plugins/mob-ai  and enable it in config/settings.json:
 *   "plugins": { "mob-ai": { "activeRange": 32 } }
 */

const { BlockView } = require('./lib/blockView')
const { Pathfinder } = require('./lib/pathfinder')
const { MobAI } = require('./lib/mobAI')
const { Goal, GoalSelector, Control } = require('./lib/goalSelector')
const goals = require('./lib/goals')
const { profiles, NO_GROUND_AI, normalise } = require('./lib/profiles')

const DEFAULTS = {
  enabled: true,
  activeRange: 32, // blocks: mobs further than this from every player are frozen
  hysteresis: 4, // extra blocks before an awake mob is frozen again
  ignoreSpectators: true,
  maxPathfindsPerTick: 4,
  maxPathNodes: 200,
  undeadBurnInSun: true,
  aiForUnknownMobs: false, // give unlisted land mobs wander + look-at-player
  patchRegistry: true, // 26.1: let serv.spawnMob create cows, zombies etc. (see patchMobRegistry below)
  debug: false
}

// In the 26.1 registry only entities whose minecraft-data type is 'mob' (allay, ghast, slime ...) are
// listed in registry.mobs, which is what serv.spawnMob reads. Cows, zombies, pigs ... are typed
// 'animal' / 'hostile' / 'passive' ... so spawnMob(cow) throws. Copying them in (in place, the spawn
// plugin keeps a reference to the same object) makes every living entity spawnable.
const SPAWNABLE_TYPES = new Set(['mob', 'animal', 'hostile', 'passive', 'ambient', 'water_creature'])
function patchMobRegistry (registry) {
  if (!registry.mobs) return 0
  let added = 0
  for (const e of Object.values(registry.entitiesByName || {})) {
    if (SPAWNABLE_TYPES.has(e.type) && !registry.mobs[e.id]) { registry.mobs[e.id] = e; added++ }
  }
  return added
}

module.exports.server = function (serv, options) {
  const settings = Object.assign({}, options || {})
  const config = Object.assign({}, DEFAULTS, (this && this.settings) || {})
  const view = new BlockView(serv.registry)
  const pathfinder = new Pathfinder(view)
  const allProfiles = Object.assign({}, profiles)

  if (config.patchRegistry) {
    const n = patchMobRegistry(serv.registry)
    if (n) serv.info?.(`[mob-ai] added ${n} entity types to registry.mobs so serv.spawnMob can create them`)
  }

  const controllers = new Map() // entity id -> MobAI
  const ignored = new Set() // mob ids that will never get AI
  let pathBudget = 0
  let running = false
  const failures = new Map()

  const manager = {
    serv,
    settings,
    config,
    view,
    pathfinder,
    takePathBudget () { return pathBudget-- > 0 },
    debug (msg) { if (config.debug) serv.info(`[mob-ai] ${msg}`) }
  }

  function profileFor (mob) {
    const name = normalise(mob.name)
    if (allProfiles[name]) return allProfiles[name]
    if (config.aiForUnknownMobs && name && !NO_GROUND_AI.has(name)) return allProfiles.pig
    return null
  }

  function attach (mob) {
    if (ignored.has(mob.id)) return null
    if (!mob.name || !mob.position || !mob.world) return null // spawnMob has not finished filling it in yet
    const profile = profileFor(mob)
    if (!profile) { ignored.add(mob.id); return null }
    const ai = new MobAI(manager, mob, profile)
    controllers.set(mob.id, ai)
    return ai
  }

  // Attach the AI synchronously inside spawnMob. Otherwise the stock physics (which still applies gravity
  // to a mob until we switch it off) gets one tick on the brand-new mob and nudges it.
  function wrapSpawnMob () {
    if (typeof serv.spawnMob !== 'function' || serv.spawnMob.mobAIWrapped) return
    const original = serv.spawnMob
    serv.spawnMob = function (...args) {
      const mob = original.apply(this, args)
      try { if (config.enabled) attach(mob) } catch (e) { manager.debug('attach failed: ' + e.message) }
      return mob
    }
    serv.spawnMob.mobAIWrapped = true
  }
  if (serv.pluginsReady) wrapSpawnMob()
  else serv.once('pluginsReady', wrapSpawnMob)

  function release (id) {
    const ai = controllers.get(id)
    if (ai) ai.selector.stopAll()
    controllers.delete(id)
    ignored.delete(id)
    failures.delete(id)
  }

  function nearestPlayerDistSq (mob, players) {
    let best = Infinity
    const p = mob.position
    for (const pl of players) {
      if (pl.world !== mob.world) continue
      const dx = pl.position.x - p.x
      const dy = pl.position.y - p.y
      const dz = pl.position.z - p.z
      const d = dx * dx + dy * dy + dz * dz
      if (d < best) best = d
    }
    return best
  }

  serv.on('tick', delta => {
    if (!config.enabled || running) return // skip a tick rather than queue work behind a slow one
    running = true
    const dt = Math.min(0.1, Math.max(0.02, delta || 0.05)) // seconds since the previous server tick
    tickAll(dt)
      .catch(err => serv.err?.(`[mob-ai] tick failed: ${err.stack || err}`))
      .finally(() => { running = false })
  })

  async function tickAll (dt) {
    view.tick()
    pathBudget = config.maxPathfindsPerTick

    const players = serv.players.filter(p => p.world && p.position && !(config.ignoreSpectators && p.gameMode === 3))
    const wakeSq = config.activeRange * config.activeRange
    const sleepSq = (config.activeRange + config.hysteresis) ** 2

    const work = []
    for (const id of Object.keys(serv.entities)) {
      const mob = serv.entities[id]
      if (mob.type !== 'mob') continue
      const ai = controllers.get(mob.id) || attach(mob)
      if (!ai) continue

      const d2 = nearestPlayerDistSq(mob, players)
      if (ai.frozen) {
        if (d2 <= wakeSq) { ai.thaw(); manager.debug(`wake ${mob.name}#${mob.id}`) }
      } else if (d2 > sleepSq) {
        ai.freeze()
        manager.debug(`freeze ${mob.name}#${mob.id}`)
      }

      if (!ai.frozen) work.push(safely(ai, ai.tick(dt)))
      else if (!ai.settled) work.push(safely(ai, ai.settle(dt))) // finish a fall, then stop completely
      else ai.absorbVelocity() // keep the stock physics from moving a sleeping mob
    }

    // forget controllers of mobs that were killed / removed
    for (const id of controllers.keys()) if (!serv.entities[id]) release(id)
    for (const id of ignored) if (!serv.entities[id]) ignored.delete(id)

    await Promise.all(work)
  }

  function safely (ai, promise) {
    return promise.catch(err => {
      const n = (failures.get(ai.mob.id) || 0) + 1
      failures.set(ai.mob.id, n)
      if (n === 1) serv.err?.(`[mob-ai] ${ai.mob.name}#${ai.mob.id}: ${err.stack || err}`)
      if (n >= 5) { // a mob that keeps failing is switched off instead of spamming the log
        ai.freeze()
        ignored.add(ai.mob.id)
        controllers.delete(ai.mob.id)
      }
    })
  }

  function stats () {
    let active = 0
    let frozen = 0
    for (const ai of controllers.values()) ai.frozen ? frozen++ : active++
    return { total: controllers.size, active, frozen, ignored: ignored.size }
  }

  serv.mobAI = {
    config,
    controllers,
    stats,
    Goal,
    GoalSelector,
    Control,
    goals,
    /** The MobAI controller for a mob entity (or undefined). Add goals with ai.selector.add(priority, goal). */
    get: entity => controllers.get(entity.id),
    /** Register / replace a profile: { type, height, attributes, goals: [[priority, ai => Goal], ...] } */
    registerProfile (name, profile) { allProfiles[normalise(name)] = profile },
    setActiveRange (blocks) { config.activeRange = Math.max(1, Number(blocks)) },
    setEnabled (on) {
      config.enabled = !!on
      if (!on) for (const ai of controllers.values()) { ai.selector.stopAll(); ai.nav.stop() }
    }
  }

  serv.commands.add({
    base: 'mobai',
    info: 'Inspect or configure the mob AI',
    usage: '/mobai [status|range <blocks>|on|off|debug|spawn <mob> [count]]',
    op: true,
    action (params, ctx) {
      const [sub, arg, arg2] = String(params || '').trim().split(/\s+/)
      switch (sub) {
        case '': case 'status': {
          const s = stats()
          return `Mob AI ${config.enabled ? 'on' : 'off'}: ${s.total} mobs (${s.active} active, ${s.frozen} frozen); active range ${config.activeRange} blocks`
        }
        case 'range':
          if (!(Number(arg) > 0)) return 'Usage: /mobai range <blocks>'
          serv.mobAI.setActiveRange(arg)
          return `Mobs further than ${config.activeRange} blocks from every player now have their AI frozen`
        case 'on': serv.mobAI.setEnabled(true); return 'Mob AI enabled'
        case 'off': serv.mobAI.setEnabled(false); return 'Mob AI disabled'
        case 'spawn': {
          const player = ctx && ctx.player
          if (!player) return 'Only players can use /mobai spawn'
          const entity = serv.registry.entitiesByName[normalise(arg)]
          if (!entity || !serv.registry.mobs?.[entity.id]) return `Unknown mob: ${arg || '(none)'}`
          const count = Math.max(1, Math.min(20, parseInt(arg2, 10) || 1))
          try {
            for (let i = 0; i < count; i++) {
              const a = Math.random() * Math.PI * 2
              const d = 2 + Math.random() * 3
              serv.spawnMob(entity.id, player.world, player.position.offset(Math.cos(a) * d, 0, Math.sin(a) * d))
            }
          } catch (e) {
            return `Could not spawn: ${e.message}`
          }
          return `Spawned ${count} ${entity.name}`
        }
        case 'debug': config.debug = !config.debug; return `Debug logging ${config.debug ? 'on' : 'off'}`
        default: return 'Usage: /mobai [status|range <blocks>|on|off|debug|spawn <mob> [count]]'
      }
    }
  })

  serv.info?.(`[mob-ai] ready; AI freezes beyond ${config.activeRange} blocks from players`)
}

module.exports.player = function (player, serv) {
  // A player hitting a mob provokes it: passive mobs panic, hostile and neutral mobs retaliate.
  player.on('attack', ({ attackedEntity } = {}, cancelled) => {
    if (cancelled || !attackedEntity || attackedEntity.type !== 'mob') return
    serv.mobAI?.get(attackedEntity)?.provoke(player)
  })
}
