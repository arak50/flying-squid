/**
 * skyblock-speed — applies the Speed stat to the player's real movement speed.
 * Needs `skyblock-stats`. Load order in settings does not matter.
 *
 *   player.skyblock.speed   { stat, cap, capped, attribute, blocksPerSecond(sprint) }   (null until stats exist)
 *   player 'skyblock:speed' (speedInfo)
 *
 * Sends the `movement_speed` attribute (base 0.1 x Speed/100) whenever Speed changes, and again after a respawn / dimension
 * change, which makes the client forget attributes. Sprinting and sneaking modifiers stay client-side.
 * Not covered: flying speed (abilities packet), the Rift-to-overworld switch is only as good as stats.setContext({dimension}).
 */
const { attributeFor, blocksPerSecond, speedStat } = require('./lib/speed')

module.exports.player = function (player, serv) {
  const sb = player.skyblock = player.skyblock || {}
  let sent = null
  let keyField = null

  // 1.20.5+ calls the property field `key` (attribute id), earlier versions `name`; read it from the protocol instead of guessing
  function propertyKeyField () {
    if (keyField) return keyField
    try {
      const t = serv.registry.protocol.play.toClient.types.packet_entity_update_attributes
      const props = t[1].find(f => f.name === 'properties')
      keyField = props.type[1].type[1][0].name
    } catch (e) { keyField = 'key' }
    return keyField
  }

  function send (value) {
    // modifiers stay empty on purpose: their field naming differs between versions and the base value carries everything
    player._client.write('entity_update_attributes', {
      entityId: player.id,
      properties: [{ [propertyKeyField()]: 'generic.movement_speed', value, modifiers: [] }]
    })
    sent = value
  }

  function apply (force) {
    const st = sb.stats && sb.stats.result && speedStat(sb.stats.result)
    if (!st) return
    const attribute = attributeFor(st.total)
    sb.speed = { stat: st.total, cap: st.cap, capped: st.capped, attribute, blocksPerSecond: (sprint) => blocksPerSecond(st.total, sprint) }
    if (force || attribute !== sent) { send(attribute); player.emit('skyblock:speed', sb.speed) }
  }

  player.once('skyblockProfileReady', () => {
    if (!sb.stats) return
    sb.stats.on('change', () => apply(false))
    apply(false)
  })
  player.on('spawned', () => apply(true))

  // respawn and dimension changes reset the client's attributes
  const hookRespawn = () => {
    const orig = player._sendRespawn
    if (!orig || orig.skyblockSpeed) return
    player._sendRespawn = function (...args) { const r = orig.apply(this, args); apply(true); return r }
    player._sendRespawn.skyblockSpeed = true
  }
  hookRespawn()
  player.once('spawned', hookRespawn) // in case the respawn plugin defines it after this one
}
