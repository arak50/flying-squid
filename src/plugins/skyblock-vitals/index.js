/**
 * skyblock-vitals — the live Health and Mana pools, their regeneration, the vanilla heart bar and the action bar.
 * Needs `skyblock-stats` (maxima come from player.skyblock.stats). Load order in settings does not matter.
 *
 *   player.skyblock.vitals                     Vitals (lib/vitals.js)
 *       .health .maxHealth .mana .maxMana .overflow .dead        .snapshot()
 *       .damage(n, {trueDamage})  .heal(n, {raw})  .spendMana(cost, {label})  .addMana(n)  .setOverflow(n)
 *       .addAbsorption(n)/.setAbsorption(n)   gold extra HP above max, damaged first
 *       .showZone(name, {color, ms})          zone name in place of Defense for ~2 s (nothing in the repo calls it yet)
 *       .addRegenBonus(id, percent)  .removeRegenBonus(id)
 *       .on('change') .on('death')
 *   player.skyblock.useMana(cost, label)       true if paid, otherwise the mana segment shows NOT ENOUGH MANA for ~1.5 s
 *   player.actionBar(text)                     raw action bar message (also used by the renderer)
 *   Events: player 'skyblock:vitals' (snapshot), 'skyblock:death'
 *
 * Core code keeps working: player.updateHealth(v) / player.health are the vanilla 0..20 value
 * (the same fraction of 20 as Health / Max Health); updateHealth(20) (respawn) refills, updateHealth(0) kills.
 * Food is held at full: SkyBlock has no hunger.
 *
 * update_health on the wire (RECORDED from Hypixel SkyBlock, protocol 26.1, 223 packets over 62 s):
 *   health 40.0 at full (the lobby sent 20.0), food 20, saturation 20.0 (the lobby sent 5.0), and the server re-sends
 *   the packet unconditionally every ~300 ms (median 0.299 s = 6 ticks), whether or not anything changed.
 *   `player.health` stays on the core's 0..20 scale; only the packet is scaled (`heartsFull`).
 *
 * Action bar (RECORDED, 131 packets): purely periodic, one every ~0.5 s (median 0.507 s, p10 0.469, p90 0.600) - not on each change.
 * Own max health: the server sets generic.max_health = 40 at the same moment update_health jumps 20 -> 40; so do we.
 *
 * config/settings.json: "skyblock-vitals": { "actionBar": true, "legacyIcons": false, "refreshMs": 500, "barOnChange": false,
 *                         "manaFlash": false, "healthRefreshMs": 300, "heartsFull": 40, "saturation": 20, "maxHealthAttribute": 40 }
 *   healthRefreshMs      0 = only send update_health when the heart value changes
 *   refreshMs            0 = no periodic action bar; barOnChange sends an extra bar at once on every change (not what Hypixel does)
 *   manaFlash            show "-N Mana (label)" after a paid ability (never seen in the recording)
 *   maxHealthAttribute   0 = do not send the max_health attribute
 */
const { Vitals } = require('./lib/vitals')
const { renderActionBar } = require('./lib/actionBar')

module.exports.player = function (player, serv) {
  const settings = Object.assign({ actionBar: true, legacyIcons: false, refreshMs: 500, barOnChange: false, manaFlash: false, healthRefreshMs: 300, heartsFull: 40, saturation: 20, maxHealthAttribute: 40 }, this.settings)
  const sb = player.skyblock = player.skyblock || {}

  player.actionBar = (text) => {
    const component = serv._createChatComponent(text)
    if (serv.supportFeature('signedChat')) player._client.write('system_chat', { content: component.toNetworkFormat(), type: 2, isActionBar: true })
    else player._client.write('chat', { message: component.toNetworkFormat(), position: 2, sender: '0' })
  }

  let keyField = null
  // 1.20.5+ calls the property field `key` (attribute id), earlier versions `name`; read it from the protocol instead of guessing
  const propertyKeyField = () => {
    if (keyField) return keyField
    try {
      const t = serv.registry.protocol.play.toClient.types.packet_entity_update_attributes
      keyField = t[1].find(f => f.name === 'properties').type[1].type[1][0].name
    } catch (e) { keyField = 'key' }
    return keyField
  }
  // recorded: generic.max_health = 40 arrives together with the first update_health of 40.0; respawns make the client forget it
  const sendMaxHealth = () => {
    if (!settings.maxHealthAttribute) return
    player._client.write('entity_update_attributes', {
      entityId: player.id,
      properties: [{ [propertyKeyField()]: 'generic.max_health', value: settings.maxHealthAttribute, modifiers: [] }]
    })
  }

  let vitals = null
  let timer = null
  let refresher = null
  let healthRefresher = null
  let scheduled = null
  let last = Date.now()
  let lastSentVanilla = null

  // `force` = the periodic resend: the real server repeats the packet even when nothing changed
  const sendHearts = (force = false) => {
    if (!vitals) return
    player.health = vitals.vanillaHealth // core code keeps its 0..20 scale
    player.food = 20
    player.foodSaturation = settings.saturation
    const wire = vitals.heartsHealth(settings.heartsFull)
    if (!force && wire === lastSentVanilla) return
    lastSentVanilla = wire
    player._client.write('update_health', { health: wire, food: 20, foodSaturation: settings.saturation })
  }
  const sendBar = () => { if (settings.actionBar && vitals && !vitals.dead) player.actionBar(renderActionBar(vitals.snapshot(), { legacy: settings.legacyIcons })) }

  // coalesce bursts (a click can change several stats) into one packet per tick. The bar itself follows its own 0.5 s clock.
  const publish = () => {
    if (scheduled) return
    scheduled = setImmediate(() => {
      scheduled = null
      if (!vitals) return
      sendHearts()
      if (settings.barOnChange) sendBar()
      player.emit('skyblock:vitals', vitals.snapshot())
    })
  }

  function start () {
    if (vitals) return
    vitals = sb.vitals = new Vitals(sb.stats, { manaFlash: settings.manaFlash })
    vitals.on('change', publish)
    vitals.on('death', () => { sendHearts(); player.emit('skyblock:death') })
    sb.stats.on('change', () => vitals.sync()) // gear swaps: lower max clamps current, higher max never refills

    // core code speaks vanilla health (0..20); translate it
    player.updateHealth = (v) => vitals.setFromVanilla(v)
    player.updateFood = () => sendHearts()
    player.updateFoodSaturation = () => sendHearts()

    sb.useMana = (cost, label) => {
      if (vitals.spendMana(cost, { label })) return true
      vitals.failMana() // only the mana segment changes (recorded); it appears with the next bar
      return false
    }

    last = Date.now()
    timer = setInterval(() => { const now = Date.now(); vitals.advance(now - last); last = now }, 50)
    // the client fades an action bar after ~3 s, so keep re-sending it even when nothing changed
    if (settings.refreshMs) refresher = setInterval(sendBar, settings.refreshMs)
    // recorded: Hypixel repeats update_health every ~300 ms; a dead player is left alone (the death screen is up)
    if (settings.healthRefreshMs) healthRefresher = setInterval(() => { if (vitals && !vitals.dead) sendHearts(true) }, settings.healthRefreshMs)
    vitals.fill()
    sendMaxHealth()
    sendBar()
    publish()
  }

  player.once('skyblockProfileReady', () => {
    // stats may be computed already (their import handler can run first) or arrive with their next 'change'
    if (sb.stats && sb.stats.result) return start()
    if (sb.stats) sb.stats.once('change', start)
  })

  player.on('spawned', () => { if (vitals) sendMaxHealth() })
  // respawn and dimension changes reset the client's attributes (same hook as skyblock-speed)
  const hookRespawn = () => {
    const orig = player._sendRespawn
    if (!orig || orig.skyblockVitals) return
    player._sendRespawn = function (...args) { const r = orig.apply(this, args); if (vitals) sendMaxHealth(); return r }
    player._sendRespawn.skyblockVitals = true
  }
  hookRespawn()
  player.once('spawned', hookRespawn)

  player._client.once('end', () => {
    clearInterval(timer); clearInterval(refresher); clearInterval(healthRefresher)
    if (scheduled) clearImmediate(scheduled)
    if (vitals) vitals.removeAllListeners()
  })
}
