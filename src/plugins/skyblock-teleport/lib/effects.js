'use strict'
// Sound + chat feedback for the teleports. Everything here is taken from the real-server packet capture
// (2026-10-31 sclogs): the packets a Hypixel SkyBlock server sends to a 26.1 client for AOTE / AOTV.
//
//   Instant Transmission  sound_effect  entity.enderman.teleport   source=hostile  volume 1.0  pitch 1.0   at the destination
//   Ether Transmission    sound_effect  entity.ender_dragon.hurt   source=hostile  volume 1.0  pitch 34/63 (0.5397)  at the destination
//   Blocked               system_chat   red "There are blocks in the way!" (chat line, not the action bar)
//
// The sound id on the wire in the capture equals minecraft-data's sound id (598 = entity.enderman.teleport), but the
// protocol serializer writes `soundId + 1` for registry holders, so we hand it `id + idOffset` (idOffset = -1) to put the
// capture's exact value on the wire. If a client ever plays the neighbouring sound, change `sounds.idOffset`.

const nbt = require('prismarine-nbt')

const DEFAULT_SOUNDS = {
  enabled: true,
  radius: 32, // blocks around the destination that hear it (the teleporting player always does)
  idOffset: -1,
  instant: { name: 'entity.enderman.teleport', category: 'hostile', volume: 1.0, pitch: 1.0 },
  ether: { name: 'entity.ender_dragon.hurt', category: 'hostile', volume: 1.0, pitch: 34 / 63 }
}

const DEFAULT_MESSAGES = {
  blocked: 'There are blocks in the way!', // instant: nothing to teleport through; ether: target/landing space obstructed
  noTarget: null, // ether: no block in range (the capture has no example of Hypixel's wording, so it's off by default)
  color: 'red'
}

function mergeSounds (user) {
  const u = user || {}
  return {
    ...DEFAULT_SOUNDS,
    ...u,
    instant: { ...DEFAULT_SOUNDS.instant, ...(u.instant || {}) },
    ether: { ...DEFAULT_SOUNDS.ether, ...(u.ether || {}) }
  }
}

function mergeMessages (user) {
  return { ...DEFAULT_MESSAGES, ...(user || {}) }
}

function randomSeed () {
  return BigInt.asIntN(64, (BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n) | BigInt(Math.floor(Math.random() * 2 ** 32)))
}

/** `sound_effect` packet params for a teleport sound at `pos`, or null when the sound isn't in the registry. */
function soundParams (registry, def, pos, idOffset = -1) {
  const entry = registry && registry.soundsByName && registry.soundsByName[def.name]
  if (!entry) return null
  return {
    sound: { soundId: entry.id + idOffset },
    soundCategory: def.category,
    x: Math.round(pos.x * 8), // fixed point, 3 fractional bits
    y: Math.round(pos.y * 8),
    z: Math.round(pos.z * 8),
    volume: def.volume,
    pitch: def.pitch,
    seed: randomSeed()
  }
}

/** Play the teleport sound for everybody near the destination. */
function playTeleportSound (serv, player, kind, dest, sounds) {
  if (!sounds.enabled) return 0
  const params = soundParams(serv.registry, sounds[kind], dest, sounds.idOffset)
  if (!params) return 0
  const listeners = new Set(serv.getNearby({ world: player.world, position: dest, radius: sounds.radius }))
  listeners.add(player)
  let n = 0
  for (const p of listeners) {
    try { p._client.write('sound_effect', params); n++ } catch (e) { serv.err?.(`[skyblock-teleport] sound: ${e.message}`) }
  }
  return n
}

/** The NBT text component of the capture's chat line: {extra:[{color,text}], italic:0b, text:''}. */
function messageComponent (text, color) {
  return nbt.comp({
    extra: nbt.list(nbt.comp([{ color: nbt.string(color), text: nbt.string(text) }])),
    italic: nbt.byte(0),
    text: nbt.string('')
  })
}

/** Send a chat-line system message (not the action bar) like the server does. */
function sendMessage (player, text, color = 'red') {
  if (!text) return false
  player._client.write('system_chat', { content: messageComponent(String(text), color), isActionBar: false })
  return true
}

module.exports = { DEFAULT_SOUNDS, DEFAULT_MESSAGES, mergeSounds, mergeMessages, soundParams, playTeleportSound, messageComponent, sendMessage }
