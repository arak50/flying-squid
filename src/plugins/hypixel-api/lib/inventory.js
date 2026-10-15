'use strict'
const { decodeInventory } = require('./nbt')
const { SbItem } = require('./item')

const isBlob = (o) => o && typeof o === 'object' && typeof o.data === 'string' && 'type' in o

function * walk (o, path = '') {
  if (isBlob(o)) { yield [path, o.data]; return }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) yield * walk(o[k], path ? path + '/' + k : k)
}

const wrap = (arr) => arr.map(e => (e ? SbItem.fromRaw(e) : null))

/**
 * Decode every gzipped-NBT container found in `member.inventory` (+ legacy top-level
 * keys) into SbItem arrays. Nothing is hard-coded to one profile layout: unknown
 * containers are still decoded and exposed under `containers[path]`.
 */
function decodeMember (member) {
  const inv = member.inventory || {}
  const containers = {}
  const errors = []
  for (const [path, data] of walk(inv)) {
    try { containers[path] = wrap(decodeInventory(data)) } catch (e) { errors.push({ path, error: e.message }) }
  }
  const pick = (p) => containers[p] || []
  const backpacks = Object.keys(containers).filter(k => k.startsWith('backpack_contents/')).sort((a, b) => +a.split('/')[1] - +b.split('/')[1])
  const talismans = pick('bag_contents/talisman_bag')
  return {
    inventory: pick('inv_contents'), // 36 slots: 0-8 hotbar, 9-35 main
    armor: pick('inv_armor'), // API order: boots, leggings, chestplate, helmet
    equipment: pick('equipment_contents'), // necklace, cloak, belt, gloves
    accessories: talismans.filter(Boolean),
    enderChest: pick('ender_chest_contents'),
    wardrobe: pick('wardrobe_contents'),
    personalVault: pick('personal_vault_contents'),
    potionBag: pick('bag_contents/potion_bag'),
    quiver: pick('bag_contents/quiver'),
    fishingBag: pick('bag_contents/fishing_bag'),
    backpacks: backpacks.map(k => ({ slot: +k.split('/')[1], items: containers[k] })),
    containers,
    errors
  }
}

module.exports = { decodeMember, walk }
