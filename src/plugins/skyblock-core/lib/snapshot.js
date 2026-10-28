'use strict'
// API snapshot (hypixel-api fetchSnapshot) -> ProfileState
const { ProfileState } = require('./profile')
const { ArrayContainer } = require('./container')
const { decodeInventory } = require('../../hypixel-api/lib/nbt')
const { SbItem } = require('../../hypixel-api/lib/item')
const { ARMOR_KEYS } = require('./layout')

const SINGLE = list => (list && list[0] ? SbItem.fromRaw(list[0]) : null)

function decodeSet (obj, keys) {
  const out = {}
  for (const k of keys) { try { out[k] = obj[k] && obj[k].data ? SINGLE(decodeInventory(obj[k].data)) : null } catch { out[k] = null } }
  return out
}

/** @param snap result of serv.hypixel.fetchSnapshot  @param conv hypixel-api item converter */
function profileFromSnapshot (uuid, snap, conv) {
  const { decoded: d, member } = snap
  const toItems = list => list.map(sb => (sb ? conv.toItem(sb) : null))

  // member minus the (large) item containers, which live in containers now
  const rest = { ...member }
  delete rest.inventory
  const loadout = member.loadout || {}
  rest.loadout = undefined

  const p = new ProfileState({ uuid, profileId: snap.profile.profile_id, cuteName: snap.profile.cute_name, source: snap.source, member: JSON.parse(JSON.stringify(rest)), loadouts: Object.values(loadout.loadouts || {}), settings: {} })
  const add = (name, items, size) => p.addContainer(new ArrayContainer(name, size === undefined ? items.length : size, items))

  add('inventory', toItems(d.inventory), 36)
  add('armor', toItems(d.armor.slice().reverse()), 4) // API: boots..helmet -> helmet..boots
  add('equipment', toItems(d.equipment), 4)
  add('accessoryBag', toItems(d.accessories))
  add('enderChest', toItems(d.enderChest))
  add('personalVault', toItems(d.personalVault))
  add('potionBag', toItems(d.potionBag))
  add('quiver', toItems(d.quiver))
  add('fishingBag', toItems(d.fishingBag))
  for (const bp of d.backpacks) {
    add('backpack:' + bp.slot, toItems(bp.items))
    const icon = (d.containers['backpack_icons/' + bp.slot] || [])[0] // the backpack item shown in the Storage window
    if (icon) add('backpackIcon:' + bp.slot, toItems([icon]), 1)
  }

  for (const [id, set] of Object.entries(loadout.armor || {})) {
    const s = decodeSet(set, ARMOR_KEYS)
    p.sets.armor[id] = Object.fromEntries(Object.entries(s).map(([k, sb]) => [k, sb ? conv.toItem(sb) : null]))
  }
  for (const [id, set] of Object.entries(loadout.equipment || {})) {
    const s = decodeSet(set, ['EQUIPMENT_SLOT_1', 'EQUIPMENT_SLOT_2', 'EQUIPMENT_SLOT_3', 'EQUIPMENT_SLOT_4'])
    p.sets.equipment[id] = Object.fromEntries(Object.entries(s).map(([k, sb]) => [k, sb ? conv.toItem(sb) : null]))
  }
  return p
}

module.exports = { profileFromSnapshot }
