/**
 * hypixel-api — thin Hypixel SkyBlock API client for flying-squid.
 *
 * Exposes `serv.hypixel`:
 *   await serv.hypixel.getSkyblockProfiles(uuid)  -> { source: 'api'|'sample', response, memberUuid }
 *   await serv.hypixel.getSkillTables()           -> { SKILL: number[] } | null   (public resources endpoint)
 *   serv.hypixel.config                            (resolved settings, key redacted)
 *
 * The API key is NEVER stored in this repo. Provide it with the HYPIXEL_API_KEY environment variable or
 * `"key"` in config/settings.json. Without a key (or when the request fails) the plugin can fall back to a
 * saved sample response, see `sampleFile` / `sampleMode`.
 *
 * config/settings.json:
 *   "plugins": { "hypixel-api": {
 *       "sampleFile": "./apiresponsesample.json",       // saved /v2/skyblock/profiles response
 *       "sampleMemberUuid": "88e266f9f6dd41028bda58e009ab1c3c", // whose data inside the sample to show
 *       "sampleMode": "fallback"                        // "off" | "fallback" | "force"
 *   } }
 */
const fs = require('fs')
const path = require('path')

const stripDashes = (u) => String(u).replace(/-/g, '').toLowerCase()

module.exports.server = function (serv, options) {
  const cfg = Object.assign({
    key: process.env.HYPIXEL_API_KEY || '',
    baseUrl: 'https://api.hypixel.net',
    cacheTtlMs: 5 * 60 * 1000, // /skyblock/profiles responses are cached server-side for ~minutes anyway
    cacheDir: path.join(process.cwd(), 'cache', 'hypixel'),
    sampleFile: null,
    sampleMemberUuid: null,
    sampleMode: 'fallback', // off | fallback | force
    requestTimeoutMs: 8000
  }, this.settings || {})
  if (!cfg.key && process.env.HYPIXEL_API_KEY) cfg.key = process.env.HYPIXEL_API_KEY

  let sample = null
  const loadSample = () => {
    if (sample || !cfg.sampleFile) return sample
    try {
      sample = JSON.parse(fs.readFileSync(path.resolve(cfg.sampleFile), 'utf8'))
      serv.info?.(`[hypixel-api] loaded sample response ${cfg.sampleFile} (${sample.profiles?.length} profiles)`)
    } catch (e) { serv.err?.(`[hypixel-api] could not read sampleFile ${cfg.sampleFile}: ${e.message}`) }
    return sample
  }

  // which member of the sample to act as when the joining player is not part of it
  const sampleMember = (resp) => {
    if (cfg.sampleMemberUuid) return stripDashes(cfg.sampleMemberUuid)
    const profs = resp.profiles || []
    const first = Object.keys(profs.find(p => p.selected)?.members || profs[0]?.members || {})
    return first.find(u => profs.every(p => p.members?.[u])) || first[0]
  }

  const cache = new Map() // uuid -> { t, value }
  const inflight = new Map()
  let nextSlot = 0
  const throttle = async () => { // keep well under the 300 requests / 5 min default key limit
    const now = Date.now(); const wait = Math.max(0, nextSlot - now); nextSlot = Math.max(now, nextSlot) + 250
    if (wait) await new Promise(resolve => setTimeout(resolve, wait))
  }

  async function http (pathAndQuery, { auth }) {
    await throttle()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), cfg.requestTimeoutMs)
    try {
      const res = await fetch(cfg.baseUrl + pathAndQuery, { headers: auth ? { 'API-Key': cfg.key } : {}, signal: ctl.signal })
      if (res.status === 429) {
        const reset = Number(res.headers.get('ratelimit-reset') || res.headers.get('retry-after') || 10)
        nextSlot = Date.now() + reset * 1000
        throw new Error(`rate limited, retry in ${reset}s`)
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.success === false) throw new Error(`HTTP ${res.status} ${body.cause || ''}`.trim())
      return body
    } finally { clearTimeout(timer) }
  }

  const fromSample = (uuid) => {
    const resp = loadSample()
    if (!resp) return null
    const clean = stripDashes(uuid)
    const isMember = (resp.profiles || []).some(p => p.members?.[clean])
    return { source: 'sample', response: resp, memberUuid: isMember ? clean : sampleMember(resp), actingAs: !isMember }
  }

  async function getSkyblockProfiles (uuid) {
    const clean = stripDashes(uuid)
    if (cfg.sampleMode === 'force') return fromSample(clean)

    const hit = cache.get(clean)
    if (hit && Date.now() - hit.t < cfg.cacheTtlMs) return hit.value
    if (inflight.has(clean)) return inflight.get(clean)

    const p = (async () => {
      if (cfg.key) {
        try {
          const response = await http(`/v2/skyblock/profiles?uuid=${clean}`, { auth: true })
          const value = { source: 'api', response, memberUuid: clean }
          cache.set(clean, { t: Date.now(), value })
          return value
        } catch (e) {
          serv.err?.(`[hypixel-api] profiles lookup failed for ${clean}: ${e.message}`)
        }
      } else if (cfg.sampleMode !== 'fallback') {
        serv.err?.('[hypixel-api] no API key configured (set HYPIXEL_API_KEY) and sampleMode is off')
      }
      return cfg.sampleMode === 'off' ? null : fromSample(clean)
    })().finally(() => inflight.delete(clean))
    inflight.set(clean, p)
    return p
  }

  // ---- public resources (no key needed) ----
  let skillTables
  async function getSkillTables () {
    if (skillTables !== undefined) return skillTables
    skillTables = null
    const file = path.join(cfg.cacheDir, 'skills.json')
    let body = null
    try { const st = fs.statSync(file); if (Date.now() - st.mtimeMs < 24 * 3600e3) body = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { /* no cache */ }
    if (!body) {
      try {
        body = await http('/v2/resources/skyblock/skills', { auth: false })
        fs.mkdirSync(cfg.cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(body))
      } catch (e) { serv.info?.(`[hypixel-api] skills resource unavailable (${e.message}); using built-in tables`) }
    }
    if (body?.skills) {
      skillTables = {}
      for (const [id, sk] of Object.entries(body.skills)) {
        const lv = sk.levels || []
        skillTables[id] = lv.map((l, i) => l.totalExpRequired - (i ? lv[i - 1].totalExpRequired : 0))
      }
    }
    return skillTables
  }

  serv.hypixel = {
    getSkyblockProfiles,
    getSkillTables,
    config: { ...cfg, key: cfg.key ? '<set>' : '<not set>' },
    stripDashes
  }

  serv.on?.('asap', () => {
    serv.info?.(`[hypixel-api] key: ${cfg.key ? 'configured' : 'NOT set'} · sampleMode: ${cfg.sampleMode}${cfg.sampleFile ? ' · sampleFile: ' + cfg.sampleFile : ''}`)
  })
}
