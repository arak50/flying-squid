'use strict'
/**
 * Reads data/secretlocations.json (Quantizr's Dungeon Rooms data as shipped with Skyblocker, GPL-3.0, see data/README.md)
 * and turns it into per-room secrets.
 *
 * File shape:  { "copyright": "...", "license": "...", "<Room-Name>": [ { secretName, category, x, y, z } ... ], ... }
 *   * room name  = the sidecar / template name (e.g. "Banners-1")
 *   * secretName = "<secret number> - <what>", e.g. "1 - Chest", "2/3 - Superboom"
 *   * x, z       = block position in the room schematic (rotation 0), y = absolute world y of the Hypixel room
 *                  (room-local y = y - floorYWorld; verified against the canonical schematics)
 *
 * Only some categories are secrets (they count toward "Secrets Found"); the rest are hints for reaching one.
 */
const fs = require('fs')
const path = require('path')

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'secretlocations.json')

/** category in the file -> secret type. These count toward the room's secret total. */
const SECRET_CATEGORY = { chest: 'chest', item: 'item', bat: 'bat', wither: 'essence' }
/** categories that only help reach a secret (not counted, not collectable). */
const HINT_CATEGORY = ['entrance', 'superboom', 'stonk', 'lever', 'aotv', 'pearl', 'fairysoul', 'puzzle']
const SECRET_TYPES = Object.values(SECRET_CATEGORY)

const NAME = /^([0-9]+(?:\/[0-9]+)*) - (.+)$/

function parseName (secretName) {
  const m = NAME.exec(secretName || '')
  return m ? { numbers: m[1].split('/').map(Number), label: m[2] } : { numbers: [], label: secretName || '' }
}

/** @returns {{ meta:{copyright,license}, rooms: Map<string, object[]> }} */
function loadLocations (file = DEFAULT_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const rooms = new Map()
  for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) rooms.set(k, v)
  return { meta: { copyright: raw.copyright, license: raw.license }, rooms }
}

/** Problems with the file's contents (unknown category, bad coordinates). */
function validateLocations (loaded) {
  const errors = []
  for (const [room, list] of loaded.rooms) {
    list.forEach((e, i) => {
      const at = `${room}[${i}]`
      if (!(e.category in SECRET_CATEGORY) && !HINT_CATEGORY.includes(e.category)) errors.push(`${at}: unknown category "${e.category}"`)
      if (![e.x, e.y, e.z].every(Number.isInteger)) errors.push(`${at}: x/y/z must be integers`)
      if (typeof e.secretName !== 'string') errors.push(`${at}: secretName missing`)
    })
  }
  return errors
}

/**
 * Split one room's entries into secrets and hints with room-local positions (block centre, y relative to the floor).
 * @param {object[]} entries  the room's entries from the file
 * @param {number} floorY     the sidecar's floorYWorld
 */
function roomSecrets (entries, floorY) {
  const secrets = []; const hints = []
  entries.forEach(e => {
    const { numbers, label } = parseName(e.secretName)
    const pos = { x: e.x + 0.5, y: e.y - floorY, z: e.z + 0.5 }
    const type = SECRET_CATEGORY[e.category]
    if (type) secrets.push({ id: `${type}-${secrets.length + 1}`, type, numbers, name: e.secretName, counts: true, data: null, pos })
    else hints.push({ category: e.category, numbers, label, name: e.secretName, pos })
  })
  return { secrets, hints }
}

module.exports = { loadLocations, validateLocations, roomSecrets, parseName, SECRET_CATEGORY, HINT_CATEGORY, SECRET_TYPES, DEFAULT_FILE }
