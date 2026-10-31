/**
 * skyblock-vitals — the live Health and Mana pools, their regeneration, the vanilla heart bar and the action bar.
 * Needs `skyblock-stats` (maxima come from player.skyblock.stats). Load order in settings does not matter.
 *
 *   player.skyblock.vitals                     Vitals (lib/vitals.js)
 *       .health .maxHealth .mana .maxMana .overflow .dead        .snapshot()
 *       .damage(n, {trueDamage})  .heal(n, {raw})  .spendMana(cost, {label})  .addMana(n)  .setOverflow(n)
 *       .addRegenBonus(id, percent)  .removeRegenBonus(id)
 *       .on('change') .on('death')
 *   player.skyblock.useMana(cost, label)       true if paid, otherwise tells the player "You do not have enough mana!"
 *   player.actionBar(text)                     raw action bar message (also used by the renderer)
 *   Events: player 'skyblock:vitals' (snapshot), 'skyblock:death'
 *
 * Core code keeps working: player.updateHealth(v) / player.health are the vanilla 0..20 *display* value
 * (the same fraction of 20 as Health / Max Health); updateHealth(20) (respawn) refills, updateHealth(0) kills.
 * Food is held at full: SkyBlock has no hunger.
 *
 * config/settings.json: "skyblock-vitals": { "actionBar": true, "legacyIcons": false, "refreshMs": 1000 }
 */
const { Vitals } = require('./lib/vitals')
const { renderActionBar } = require('./lib/actionBar')

module.exports.player = function (player, serv) {
  const settings = Object.assign({ actionBar: true, legacyIcons: false, refreshMs: 1000 }, this.settings)
  const sb = player.skyblock = player.skyblock || {}

  player.actionBar = (text) => {
    const component = serv._createChatComponent(text)
    if (serv.supportFeature('signedChat')) player._client.write('system_chat', { content: component.toNetworkFormat(), type: 2, isActionBar: true })
    else player._client.write('chat', { message: component.toNetworkFormat(), position: 2, sender: '0' })
  }

  let vitals = null
  let timer = null
  let refresher = null
  let scheduled = null
  let last = Date.now()
  let lastSentVanilla = null

  const sendHearts = () => {
    if (!vitals) return
    const v = vitals.vanillaHealth
    player.health = v
    player.food = 20
    player.foodSaturation = 5
    if (v === lastSentVanilla) return
    lastSentVanilla = v
    player._client.write('update_health', { health: v, food: 20, foodSaturation: 5 })
  }
  const sendBar = () => { if (settings.actionBar && vitals && !vitals.dead) player.actionBar(renderActionBar(vitals.snapshot(), { legacy: settings.legacyIcons })) }

  // coalesce bursts (a click can change several stats) into one packet pair per tick
  const publish = () => {
    if (scheduled) return
    scheduled = setImmediate(() => {
      scheduled = null
      if (!vitals) return
      sendHearts(); sendBar()
      player.emit('skyblock:vitals', vitals.snapshot())
    })
  }

  function start () {
    if (vitals) return
    vitals = sb.vitals = new Vitals(sb.stats)
    vitals.on('change', publish)
    vitals.on('death', () => { sendHearts(); player.emit('skyblock:death') })
    sb.stats.on('change', () => vitals.sync()) // gear swaps: lower max clamps current, higher max never refills

    // core code speaks vanilla health (0..20); translate it
    player.updateHealth = (v) => vitals.setFromVanilla(v)
    player.updateFood = () => sendHearts()
    player.updateFoodSaturation = () => sendHearts()

    sb.useMana = (cost, label) => {
      if (vitals.spendMana(cost, { label })) return true
      player.actionBar('§c§lNOT ENOUGH MANA')
      return false
    }

    last = Date.now()
    timer = setInterval(() => { const now = Date.now(); vitals.advance(now - last); last = now }, 50)
    // the client fades an action bar after ~3 s, so keep re-sending it even when nothing changed
    if (settings.refreshMs) refresher = setInterval(sendBar, settings.refreshMs)
    vitals.fill()
    publish()
  }

  player.once('skyblockProfileReady', () => {
    // stats may be computed already (their import handler can run first) or arrive with their next 'change'
    if (sb.stats && sb.stats.result) return start()
    if (sb.stats) sb.stats.once('change', start)
  })

  player._client.once('end', () => {
    clearInterval(timer); clearInterval(refresher)
    if (scheduled) clearImmediate(scheduled)
    if (vitals) vitals.removeAllListeners()
  })
}
