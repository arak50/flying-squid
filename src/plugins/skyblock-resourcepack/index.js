/**
 * skyblock-resourcepack — sends a resource pack from a local file to every player who joins (Add Resource Pack packet).
 *
 * Clients download resource packs over HTTP, so this plugin also serves the file: a small HTTP server that answers GET/HEAD
 * for exactly one path, /<sha1>.zip. SkyBlock items carry `item_model` / `tooltip_style` ids from the Hypixel pack; without
 * that pack the client draws them as purple-black missing-texture cubes.
 *
 * config/settings.json:
 *   "skyblock-resourcepack": {
 *     "file": "resourcepack/hypixel-skyblock.zip",   // local zip (relative to the server's working directory)
 *     "host": "127.0.0.1",                           // address PLAYERS use to reach this machine (public IP / domain)
 *     "port": 8765,                                  // HTTP port (open it in your firewall for remote players)
 *     "bind": "0.0.0.0",                             // interface to listen on
 *     "url": null,                                   // optional: full URL if the file is hosted elsewhere (CDN, reverse proxy)
 *     "required": true,                              // forced pack: players who decline / fail are removed
 *     "prompt": "§aThis server needs its SkyBlock resource pack.",
 *     "resend": true                                 // re-hash on every join so replacing the file needs no restart
 *   }
 *
 *   player.resourcePack = { status, uuid }           status: pending | accepted | downloaded | loaded | declined | failed | ...
 *   player.on('resourcePackStatus', status)
 *   serv.skyblock.resourcePack.{ url, hash, uuid, send(player) }      Command: /resourcepack  (send it again)
 *
 * The pack is sent in the play state right after the player spawns (the server's configuration phase is not held open).
 */
const fs = require('fs')
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const { legacyToComponent } = require('../hypixel-api/lib/text')

// Add Resource Pack response codes (resource_pack_receive.result)
const RESULT = { 0: 'loaded', 1: 'declined', 2: 'failed_download', 3: 'accepted', 4: 'downloaded', 5: 'invalid_url', 6: 'failed_reload', 7: 'discarded' }
const FATAL = new Set(['declined', 'failed_download', 'invalid_url', 'failed_reload'])

const sha1File = file => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha1')
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
})
// a stable UUID per pack content, so clients cache it and only re-download when the file changes
const uuidFor = hash => {
  const b = Buffer.from(hash.slice(0, 32), 'hex')
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80
  const x = b.toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

module.exports.server = function (serv) {
  const cfg = Object.assign({ file: null, host: '127.0.0.1', port: 8765, bind: '0.0.0.0', url: null, required: true, prompt: null, resend: true }, this.settings || {})
  const log = m => serv.info?.(`[skyblock-resourcepack] ${m}`)
  const file = cfg.file ? path.resolve(process.cwd(), cfg.file) : null
  const rp = serv.skyblock = serv.skyblock || {}
  const state = { file, hash: null, uuid: null, url: null, size: 0, mtime: 0, server: null, ready: false }
  rp.resourcePack = state

  if (!file || !fs.existsSync(file)) {
    log(file ? `file not found: ${file} — no resource pack will be sent` : 'no "file" configured — no resource pack will be sent')
    return
  }

  // the port is read from the listening socket so "port": 0 (any free port) works too
  const urlFor = () => cfg.url || `http://${cfg.host}:${(state.server && state.server.address() && state.server.address().port) || cfg.port}/${state.hash}.zip`

  async function refresh () {
    const st = fs.statSync(file)
    if (state.ready && st.size === state.size && st.mtimeMs === state.mtime) return state
    state.hash = await sha1File(file)
    state.size = st.size; state.mtime = st.mtimeMs
    state.uuid = uuidFor(state.hash)
    state.ready = true
    state.url = urlFor()
    log(`pack ${path.basename(file)} sha1 ${state.hash} (${(st.size / 1048576).toFixed(1)} MiB) at ${state.url}`)
    return state
  }

  // ---- HTTP: exactly one path, GET and HEAD, single-range requests --------------------------------------------------
  state.server = http.createServer((req, res) => {
    if (!state.ready || req.url.split('?')[0] !== `/${state.hash}.zip` || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); return res.end() }
    const size = state.size
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    let start = 0; let end = size - 1; let code = 200
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], size - 1) } else { start = Math.max(0, size - +m[2]) }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end() }
      code = 206
    }
    const headers = { 'Content-Type': 'application/zip', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' }
    if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    res.writeHead(code, headers)
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
  })
  state.server.on('error', e => log(`HTTP server error: ${e.message}`))
  state.server.listen(cfg.port, cfg.bind, () => log(`serving on ${cfg.bind}:${state.server.address().port}`))
  state.server.unref()
  state.port = () => state.server.address() && state.server.address().port
  serv.on?.('close', () => state.server.close())

  rp.resourcePack.send = async (player) => {
    if (cfg.resend || !state.ready) await refresh()
    player.resourcePack = { status: 'pending', uuid: state.uuid }
    player._client.write('add_resource_pack', { uuid: state.uuid, url: state.url, hash: state.hash, forced: cfg.required, promptMessage: cfg.prompt ? legacyToComponent(cfg.prompt) : undefined })
  }
  refresh().catch(e => log(`cannot read pack: ${e.message}`))

  serv.commands?.add({
    base: 'resourcepack',
    info: 'Send the server resource pack again',
    usage: '/resourcepack',
    onlyPlayer: true,
    action (_, ctx) { rp.resourcePack.send(ctx.player).catch(e => ctx.player.chat(serv.color.red + e.message)) }
  })
}

module.exports.player = function (player, serv) {
  const rp = serv.skyblock && serv.skyblock.resourcePack
  if (!rp || !rp.send) return
  player._client.on('resource_pack_receive', ({ uuid, result } = {}) => {
    if (player.resourcePack && uuid && player.resourcePack.uuid && uuid !== player.resourcePack.uuid) return // an older pack
    const status = RESULT[result] || `unknown(${result})`
    player.resourcePack = Object.assign(player.resourcePack || {}, { status })
    player.emit('resourcePackStatus', status)
    serv.debug?.(`[skyblock-resourcepack] ${player._client.username}: ${status}`)
    if (FATAL.has(status) && (this.settings || {}).required !== false) {
      serv.info?.(`[skyblock-resourcepack] ${player._client.username} could not use the pack (${status}); removing`)
      try { player.kick('You need the server resource pack to play here. (' + status + ')') } catch { /* already gone */ }
    }
  })
  player.once('spawned', () => rp.send(player).catch(e => serv.info?.(`[skyblock-resourcepack] not sent: ${e.message}`)))
}
