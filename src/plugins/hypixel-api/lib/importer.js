'use strict'
// Imports a player's SkyBlock inventory from the Hypixel API into their server inventory.

const { decodeMember } = require('./inventory')
const { createConverter } = require('./convert')

// API container index -> prismarine 'inv' window slot (0 result, 1-4 craft, 5-8 armour, 9-35 main, 36-44 hotbar, 45 offhand)
const invSlot = i => (i < 9 ? 36 + i : i)
const ARMOR_SLOT = [8, 7, 6, 5] // API order: boots, leggings, chestplate, helmet

function pickProfile (response, memberUuid, wanted) {
  const profiles = (response.profiles || []).filter(p => p.members && p.members[memberUuid])
  if (!profiles.length) return null
  if (wanted) {
    const w = String(wanted).toLowerCase()
    const hit = profiles.find(p => p.profile_id === wanted || String(p.cute_name).toLowerCase() === w)
    if (hit) return hit
  }
  return profiles.find(p => p.selected) || profiles[0]
}

function createImporter (serv, hypixel, opts = {}) {
  let converter = null
  const getConverter = async () => {
    if (converter) return converter
    const items = await hypixel.getItems().catch(() => null)
    converter = createConverter(serv.registry, items)
    return converter
  }

  /** Pure data: fetch + pick profile + decode every container. Touches no player state. */
  async function fetchSnapshot (player, { profile: wanted = opts.profile, force = false } = {}) {
    const got = await hypixel.getSkyblockProfiles(player._client.uuid, { force })
    if (!got) throw new Error('no profile data (no API key and no sample)')
    const profile = pickProfile(got.response, got.memberUuid, wanted)
    if (!profile) throw new Error('player has no SkyBlock profile')
    const member = profile.members[got.memberUuid]
    return { profile, member, decoded: decodeMember(member), source: got.source, actingAs: !!got.actingAs, memberUuid: got.memberUuid }
  }

  /**
   * Standalone import straight into the window (used when skyblock-core is not loaded).
   * @returns {Promise<{profile, member, decoded, source, placed:number, stats}>}
   */
  async function importPlayer (player, { profile: wanted = opts.profile } = {}) {
    const got = await hypixel.getSkyblockProfiles(player._client.uuid)
    if (!got) throw new Error('no profile data (no API key and no sample)')
    const profile = pickProfile(got.response, got.memberUuid, wanted)
    if (!profile) throw new Error('player has no SkyBlock profile')
    const member = profile.members[got.memberUuid]
    const decoded = decodeMember(member)
    const conv = await getConverter()

    if (!player.inventory) throw new Error('player inventory not ready yet')
    // wipe everything first so no vanilla / old items remain
    for (let s = 0; s <= 45; s++) if (player.inventory.slots[s]) player.inventory.updateSlot(s, null)

    let placed = 0
    const put = (slot, sb) => {
      if (!sb) return
      const it = conv.toItem(sb)
      Object.defineProperty(it, '_sb', { value: sb, enumerable: false, configurable: true })
      player.inventory.updateSlot(slot, it)
      placed++
    }
    decoded.inventory.forEach((sb, i) => { if (i < 36) put(invSlot(i), sb) })
    decoded.armor.forEach((sb, i) => { if (i < 4) put(ARMOR_SLOT[i], sb) })

    return { profile, member, decoded, source: got.source, actingAs: !!got.actingAs, memberUuid: got.memberUuid, placed, converter: conv }
  }

  return { importPlayer, fetchSnapshot, getConverter, pickProfile }
}

module.exports = { createImporter, pickProfile, invSlot, ARMOR_SLOT }
