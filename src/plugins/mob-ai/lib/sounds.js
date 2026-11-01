'use strict'

/**
 * Positional sound helper. Core's serv.playSound divides the position by 32 (a leftover from the old
 * fixed-point positions), which puts sounds at a quarter of the real coordinates on 26.1, so the bow
 * code sends sound_effect itself: x/y/z are block coordinates * 8.
 */
function createSounds (serv) {
  const { registry } = serv
  // SoundSource ids: 4 blocks, 5 hostile, 6 neutral, 7 players
  return function playSound (world, position, name, { volume = 1, pitch = 1, category = 5, radius = 32, whitelist } = {}) {
    const entry = registry.soundsByName && registry.soundsByName[name]
    if (!entry) return
    const players = whitelist || serv.getNearby({ world, position, radius })
    const x = Math.floor(position.x * 8)
    const y = Math.floor(position.y * 8)
    const z = Math.floor(position.z * 8)
    for (const p of players) {
      try {
        p._client.write('sound_effect', { sound: { soundId: entry.id }, soundCategory: category, x, y, z, volume, pitch, seed: 0n })
      } catch { /* a closing connection */ }
    }
  }
}

module.exports = { createSounds }
