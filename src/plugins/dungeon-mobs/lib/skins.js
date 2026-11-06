'use strict'
/**
 * Skins for the humanoid mobs that Hypixel draws as players.
 *
 * A player entity only takes a custom skin from a `textures` profile property whose URL is on a Mojang domain
 * (the client refuses any other host), so a PNG on disk cannot be sent directly. Mojang names every texture after the
 * SHA-256 of the PNG file, so for a skin that was downloaded from textures.minecraft.net the URL is just
 *   http://textures.minecraft.net/texture/<sha256 of the file>
 * (leading zeros of the hash are dropped, as in the Hypixel capture). Hypixel sends such unsigned `textures` properties for
 * its mobs, and clients accept them.
 *
 * skins/skins.json  (generated from the PNGs in skins/)
 *   { "<key>": { file, hash, slim, legacy, inCapture, value?, signature? } }
 *   inCapture: the same hash was seen in the Hypixel packet capture, so the URL is known to exist.
 *   value / signature: optional, paste a MineSkin / Mojang textures property here to override the computed one.
 */
const path = require('path')
const fs = require('fs')

const DIR = path.join(__dirname, '..', 'skins')
let table = null
function load () {
  if (table) return table
  try { table = JSON.parse(fs.readFileSync(path.join(DIR, 'skins.json'), 'utf8')) } catch { table = {} }
  return table
}

function textureValue (entry, name) {
  if (entry.value) return entry.value
  const url = `http://textures.minecraft.net/texture/${entry.hash}`
  const skin = { url }
  if (entry.slim) skin.metadata = { model: 'slim' }
  const json = { timestamp: 0, profileId: '00000000000000000000000000000000', profileName: name, textures: { SKIN: skin } }
  return Buffer.from(JSON.stringify(json)).toString('base64')
}

/** { key, name, properties: [...] } for a skin key (or a list of keys: one is picked at random), or null when unknown. */
function skinProfile (keyOrKeys, name = 'dungeon_mob', rng = Math.random) {
  const t = load()
  const keys = (Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]).filter(k => t[k])
  if (!keys.length) return null
  const key = keys[Math.floor(rng() * keys.length)]
  const e = t[key]
  const prop = { name: 'textures', key: 'textures', value: textureValue(e, name) }
  if (e.signature) prop.signature = e.signature
  return { key, slim: !!e.slim, properties: [prop] }
}

const known = () => Object.keys(load())

/**
 * skins/hashes.json: Mojang texture hashes pulled from the real-run capture and our skins.
 *   mobSkins    [{ hash, slim, key, file, mobs, seenInCapture, captureNames }]  skins of the mobs drawn as players
 *   otherHashes [{ hash, slim, kind: 'player' | 'head', seenIn }]               every other skin hash in the capture (for later)
 * `hash` is the textures.minecraft.net id with leading zeros dropped, as Hypixel sends it.
 */
let hashTable = null
function hashes () {
  if (hashTable) return hashTable
  try { hashTable = JSON.parse(fs.readFileSync(path.join(DIR, 'hashes.json'), 'utf8')) } catch { hashTable = { mobSkins: [], otherHashes: [] } }
  return hashTable
}

module.exports = { skinProfile, known, hashes, DIR }
