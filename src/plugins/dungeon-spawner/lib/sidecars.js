'use strict'
/**
 * Reads the room sidecar JSONs (dungeon-room-schematics/<category>/<Room>.json) and keeps what the run needs:
 * name, canonical size, floor height and the validated `mobs` / `secrets` blocks. A block that fails validation is dropped
 * (the room then uses the generic planner) and reported in `problems`.
 */
const fs = require('fs')
const path = require('path')
const { validateMobs } = require('./schema')
const { mobs: CATALOG } = require('../../dungeon-mobs/lib/catalog')

/** @returns { byName: Map, problems: string[] } */
function loadSidecars (dir, { validateSecrets, skipMobs } = {}) {
  const byName = new Map(); const problems = []
  if (!dir || !fs.existsSync(dir)) return { byName, problems: dir ? [`schematics folder not found: ${dir}`] : [] }
  for (const cat of fs.readdirSync(dir)) {
    const cd = path.join(dir, cat)
    if (!fs.statSync(cd).isDirectory() || cat === 'Doors') continue
    for (const f of fs.readdirSync(cd).filter(f => f.endsWith('.json'))) {
      let j
      try { j = JSON.parse(fs.readFileSync(path.join(cd, f), 'utf8')) } catch (e) { problems.push(`${cat}/${f}: ${e.message}`); continue }
      const name = j.category === 'unidentified' || !j.name ? f.replace(/\.json$/, '') : j.name
      const entry = { name, category: cat, file: `${cat}/${f}`, size: j.size || null, floorYWorld: j.floorYWorld ?? 66, mobs: null, secrets: null }
      if (j.mobs !== undefined && !skipMobs) {
        const errs = validateMobs(j.mobs, { catalog: CATALOG, size: j.size })
        if (errs.length) problems.push(...errs.map(e => `${entry.file}: ${e}`))
        else if (!j.size) problems.push(`${entry.file}: mobs block needs the sidecar's "size"`)
        else entry.mobs = j.mobs
      }
      if (j.secrets !== undefined && validateSecrets) {
        const errs = validateSecrets(j.secrets, { size: j.size })
        if (errs.length) problems.push(...errs.map(e => `${entry.file}: ${e}`))
        else entry.secrets = j.secrets
      }
      byName.set(name, entry)
    }
  }
  return { byName, problems }
}

module.exports = { loadSidecars }
