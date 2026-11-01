// highlightPlayers.js
// Flying-squid plugin: every player permanently gets the vanilla "Glowing"
// outline (visible through walls) while this plugin is enabled.
// Place in src/plugins/ and restart the server.
//
// Persistence strategy:
//  1. Wrap setAndUpdateMetadata so any write to the flags byte (index 0,
//     e.g. sneak/sprint/fire) always keeps the glow bit set.
//  2. Re-apply on spawn/respawn (death, dimension change).
//  3. Re-assert every second as a safety net for anything else that
//     overwrites the flags.

const GLOW_BIT = 0x40 // entity flags byte (metadata index 0): 0x40 = glowing

module.exports.player = (player, serv) => {
  function getFlags () {
    const current = (player.metadata || []).find(m => m.key === 0)
    return current ? current.value : 0
  }

  function sendFlags (flags) {
    const data = [{ key: 0, type: 0, value: flags }] // type 0 = byte
    if (typeof player._originalSetAndUpdate === 'function') {
      player._originalSetAndUpdate(data)
    } else {
      player.metadata = (player.metadata || []).filter(m => m.key !== 0).concat(data)
      const packet = { entityId: player.id, metadata: data }
      if (player._writeOthersNearby) player._writeOthersNearby('entity_metadata', packet)
      if (player._client) player._client.write('entity_metadata', packet)
    }
  }

  function applyGlow () {
    try {
      const flags = getFlags()
      if (flags & GLOW_BIT) return // already glowing
      sendFlags(flags | GLOW_BIT)
    } catch (err) {
      console.log('[highlightPlayers] failed to apply glow: ' + err.message)
    }
  }

  // 1. Make every later flags write keep the glow bit
  if (typeof player.setAndUpdateMetadata === 'function') {
    player._originalSetAndUpdate = player.setAndUpdateMetadata.bind(player)
    player.setAndUpdateMetadata = (data) => {
      const patched = (data || []).map(m =>
        m.key === 0 ? Object.assign({}, m, { value: (m.value || 0) | GLOW_BIT }) : m)
      return player._originalSetAndUpdate(patched)
    }
  }

  // 2. Re-apply on spawn / respawn
  const onSpawn = () => setTimeout(applyGlow, 500)
  player.on('spawned', onSpawn)
  player.on('respawn', onSpawn)
  player.on('changedDimension', onSpawn)

  // 3. Safety net
  const timer = setInterval(applyGlow, 1000)
  player.on('disconnected', () => clearInterval(timer))
  if (player._client) player._client.on('end', () => clearInterval(timer))
}
