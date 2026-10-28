/**
 * skyblock-resourcepack — sends the SkyBlock resource pack to every player who joins (Add Resource Pack packet).
 *
 * The only thing to configure is the pack's URL (the real game's pack by default). SkyBlock items carry `item_model` /
 * `tooltip_style` ids from that pack; without it the client draws them as purple-black missing-texture cubes.
 *
 * config/settings.json:
 *   "skyblock-resourcepack": { "url": "https://resourcepacks.hypixel.net/SkyBlock/b9f0ff91-1baa-48d1-b122-29ca9f810f14/84.zip" }
 *
 * Optional: "required" (default true: players who decline or fail are removed), "prompt" (text shown to the player),
 * "hash" (the pack's SHA-1, to skip the one-time download), "cacheDir".
 *
 * The packet needs the pack's SHA-1, so the plugin downloads the pack ONCE, hashes it and caches the hash per URL
 * (skyblock-data/resourcepack/). If that download fails the pack is still sent, without a hash: the client downloads it
 * but cannot verify or cache it.
 *
 *   player.resourcePack = { status, uuid }     status: pending | accepted | downloaded | loaded | declined | failed_download | …
 *   player.on('resourcePackStatus', status)
 *   serv.skyblock.resourcePack.{ url, hash, uuid, send(player) }       Command: /resourcepack   (send it again)
 *
 * It is sent in the play state right after the player spawns (the configuration phase is not held open).
 */
const path = require('path')
const crypto = require('crypto')
const { legacyToComponent } = require('../hypixel-api/lib/text')
const { resolvePack } = require('./lib/pack')

const DEFAULT_URL = 'https://resourcepacks.hypixel.net/SkyBlock/b9f0ff91-1baa-48d1-b122-29ca9f810f14/84.zip'

// Add Resource Pack response codes (resource_pack_receive.result)
const RESULT = { 0: 'loaded', 1: 'declined', 2: 'failed_download', 3: 'accepted', 4: 'downloaded', 5: 'invalid_url', 6: 'failed_reload', 7: 'discarded' }
const FATAL = new Set(['declined', 'failed_download', 'invalid_url', 'failed_reload'])

// stable per pack (hash when known, else URL) so clients can cache it
const uuidFor = seed => {
  const b = crypto.createHash('sha1').update(seed).digest().subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80
  const x = b.toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

module.exports.server = function (serv) {
  const cfg = Object.assign({ url: DEFAULT_URL, required: true, prompt: null, hash: null, recheck: false, cacheDir: path.join(process.cwd(), 'skyblock-data', 'resourcepack') }, this.settings || {})
  const log = m => serv.info?.(`[skyblock-resourcepack] ${m}`)
  const state = { url: cfg.url, hash: null, uuid: uuidFor(cfg.url), ready: null, error: null }
  serv.skyblock = serv.skyblock || {}
  serv.skyblock.resourcePack = state

  state.ready = resolvePack(cfg.url, { hash: cfg.hash, cacheDir: cfg.cacheDir, recheck: cfg.recheck, log }).then(r => {
    state.hash = r.hash; state.error = r.error || null
    if (r.hash) { state.uuid = uuidFor(r.hash); log(`${r.cached ? 'cached ' : ''}pack ${r.url} sha1 ${r.hash}`) } else log(`could not hash ${r.url} (${r.error}); it will be sent without a hash`)
    return state
  })

  state.send = async (player) => {
    await state.ready
    player.resourcePack = { status: 'pending', uuid: state.uuid }
    player._client.write('add_resource_pack', {
      uuid: state.uuid,
      url: state.url,
      hash: state.hash || '',
      forced: cfg.required,
      promptMessage: cfg.prompt ? legacyToComponent(cfg.prompt) : undefined
    })
  }

  serv.commands?.add({
    base: 'resourcepack',
    info: 'Send the server resource pack again',
    usage: '/resourcepack',
    onlyPlayer: true,
    action (_, ctx) { state.send(ctx.player).catch(e => ctx.player.chat(serv.color.red + e.message)) }
  })
}

module.exports.player = function (player, serv) {
  const rp = serv.skyblock && serv.skyblock.resourcePack
  if (!rp) return
  const required = (this.settings || {}).required !== false
  player._client.on('resource_pack_receive', ({ uuid, result } = {}) => {
    if (player.resourcePack && uuid && player.resourcePack.uuid && uuid !== player.resourcePack.uuid) return // an older pack
    const status = RESULT[result] || `unknown(${result})`
    player.resourcePack = Object.assign(player.resourcePack || {}, { status })
    player.emit('resourcePackStatus', status)
    serv.debug?.(`[skyblock-resourcepack] ${player._client.username}: ${status}`)
    if (FATAL.has(status) && required) {
      serv.info?.(`[skyblock-resourcepack] ${player._client.username} could not use the pack (${status}); removing`)
      try { player.kick('You need the server resource pack to play here. (' + status + ')') } catch { /* already gone */ }
    }
  })
  player.once('spawned', () => rp.send(player).catch(e => serv.info?.(`[skyblock-resourcepack] not sent: ${e.message}`)))
}
