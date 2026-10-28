'use strict'
// Works out what the Add Resource Pack packet needs for a pack that is hosted elsewhere: its SHA-1.
// The pack is downloaded once (following redirects), hashed while streaming, and the result is cached per URL so a
// restart does not download it again. Hypixel's URLs are versioned (…/<uuid>/<n>.zip), so a cached hash cannot go stale;
// for a URL whose content changes in place, delete the cache file or pass { recheck: true }.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const https = require('https')

const key = url => crypto.createHash('sha1').update(url).digest('hex')

function download (url, { redirects = 5, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http
    const req = lib.get(url, { headers: { 'User-Agent': 'flying-squid-skyblock-resourcepack' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        if (!redirects) return reject(new Error('too many redirects'))
        return resolve(download(new URL(res.headers.location, url).toString(), { redirects: redirects - 1, timeoutMs }))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const h = crypto.createHash('sha1'); let size = 0
      res.on('data', d => { h.update(d); size += d.length })
      res.on('end', () => resolve({ hash: h.digest('hex'), size }))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')))
    req.on('error', reject)
  })
}

/** @returns {Promise<{ url, hash: string|null, size?: number, cached?: boolean, error?: string }>} */
async function resolvePack (url, { hash = null, cacheDir = null, recheck = false, log = () => {} } = {}) {
  if (hash) return { url, hash: String(hash).toLowerCase() }
  const file = cacheDir ? path.join(cacheDir, key(url) + '.json') : null
  if (file && !recheck && fs.existsSync(file)) {
    try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.url === url && /^[0-9a-f]{40}$/.test(c.hash)) return { ...c, cached: true } } catch { /* re-download */ }
  }
  try {
    log(`downloading ${url} once to compute its SHA-1 …`)
    const got = await download(url)
    const out = { url, hash: got.hash, size: got.size }
    if (file) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(out)) }
    return out
  } catch (e) {
    return { url, hash: null, error: e.message }
  }
}

module.exports = { resolvePack, download }
