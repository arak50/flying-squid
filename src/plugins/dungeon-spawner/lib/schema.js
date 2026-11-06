'use strict'
/**
 * Validation of a room sidecar's `mobs` block against dungeon-room-schematics/room-mobs.schema.json (written by hand so the
 * server needs no JSON-schema dependency; the .json schema file is for editors and CI). Returns a list of readable errors.
 */
const ID = /^[a-z0-9][a-z0-9_-]*$/
const MOB_REF = /^([a-z][a-z0-9_]*|random|pool:[a-z0-9_-]+)$/
const isInt = v => Number.isInteger(v)
const isNum = v => typeof v === 'number' && Number.isFinite(v)

/**
 * @param block   the sidecar's `mobs` value
 * @param opts    { catalog: object of mob defs (keys), size?: {x,y,z} room size for a bounds check }
 */
function validateMobs (block, opts = {}) {
  const errors = []
  const err = (p, m) => errors.push(`mobs${p}: ${m}`)
  const catalog = opts.catalog || {}
  if (!block || typeof block !== 'object' || Array.isArray(block)) return ['mobs: must be an object']
  for (const k of Object.keys(block)) if (!['version', 'spawns', 'pools', 'star'].includes(k)) err('', `unknown property "${k}"`)
  if (block.version !== 1) err('.version', 'must be 1')
  if (!Array.isArray(block.spawns)) { err('.spawns', 'must be an array'); return errors }

  const pools = block.pools === undefined ? {} : block.pools
  if (typeof pools !== 'object' || pools === null || Array.isArray(pools)) err('.pools', 'must be an object')
  else {
    for (const [name, list] of Object.entries(pools)) {
      if (!Array.isArray(list) || !list.length) { err(`.pools.${name}`, 'must be a non-empty array of mob keys'); continue }
      for (const k of list) if (!catalog[k]) err(`.pools.${name}`, `unknown mob "${k}"`)
    }
  }

  const ids = new Set()
  block.spawns.forEach((s, i) => {
    const at = `.spawns[${i}]`
    if (!s || typeof s !== 'object') return err(at, 'must be an object')
    for (const k of Object.keys(s)) if (!['id', 'mob', 'pos', 'yaw', 'floors', 'modes', 'chance', 'star', 'required'].includes(k)) err(at, `unknown property "${k}"`)
    if (typeof s.id !== 'string' || !ID.test(s.id)) err(at + '.id', 'must match ' + ID)
    else if (ids.has(s.id)) err(at + '.id', `duplicate id "${s.id}"`)
    else ids.add(s.id)
    if (typeof s.mob !== 'string' || !MOB_REF.test(s.mob)) err(at + '.mob', 'must be a catalogue key, "random" or "pool:<name>"')
    else if (s.mob.startsWith('pool:')) { if (!(pools && pools[s.mob.slice(5)])) err(at + '.mob', `unknown pool "${s.mob.slice(5)}"`) } else if (s.mob !== 'random' && !catalog[s.mob]) err(at + '.mob', `unknown mob "${s.mob}"`)
    if (!s.pos || !isNum(s.pos.x) || !isNum(s.pos.y) || !isNum(s.pos.z)) err(at + '.pos', 'must be { x, y, z } numbers')
    else if (opts.size && (s.pos.x < 0 || s.pos.z < 0 || s.pos.y < 0 || s.pos.x > opts.size.x || s.pos.z > opts.size.z || s.pos.y > opts.size.y)) err(at + '.pos', `outside the room (${opts.size.x} x ${opts.size.y} x ${opts.size.z})`)
    if (s.yaw !== undefined && !isNum(s.yaw)) err(at + '.yaw', 'must be a number')
    if (s.floors !== undefined && !(Array.isArray(s.floors) && s.floors.length === 2 && s.floors.every(f => isInt(f) && f >= 0 && f <= 7) && s.floors[0] <= s.floors[1])) err(at + '.floors', 'must be [first, last] with 0 <= first <= last <= 7')
    if (s.modes !== undefined && !(Array.isArray(s.modes) && s.modes.length && s.modes.every(m => m === 'normal' || m === 'master'))) err(at + '.modes', 'must be a non-empty list of "normal" / "master"')
    if (s.chance !== undefined && !(isNum(s.chance) && s.chance >= 0 && s.chance <= 1)) err(at + '.chance', 'must be a number from 0 to 1')
    if (s.star !== undefined && !['never', 'allowed', 'always'].includes(s.star)) err(at + '.star', 'must be "never", "allowed" or "always"')
    if (s.required !== undefined && typeof s.required !== 'boolean') err(at + '.required', 'must be a boolean')
  })

  if (block.star !== undefined) {
    const st = block.star
    if (!st || typeof st !== 'object' || Array.isArray(st)) err('.star', 'must be an object')
    else {
      for (const k of Object.keys(st)) if (!['count', 'from'].includes(k)) err('.star', `unknown property "${k}"`)
      const c = st.count
      if (c !== undefined && !((isInt(c) && c >= 0) || (Array.isArray(c) && c.length === 2 && c.every(n => isInt(n) && n >= 0) && c[0] <= c[1]))) err('.star.count', 'must be an integer or [min, max]')
      if (st.from !== undefined) {
        if (!Array.isArray(st.from)) err('.star.from', 'must be an array of spawn ids')
        else for (const id of st.from) if (!ids.has(id)) err('.star.from', `unknown spawn id "${id}"`)
      }
    }
  }
  return errors
}

module.exports = { validateMobs, ID, MOB_REF }
