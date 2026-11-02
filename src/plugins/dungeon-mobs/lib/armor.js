'use strict'
/**
 * Armour / held-item specs for dungeon mobs.
 *
 *   armor: 'diamond'                                     full set (leather, chainmail, iron, golden, diamond, netherite)
 *   armor: { material: 'leather', color: 0x66ccff }      dyed leather set
 *   armor: { helmet: 'iron_helmet', chestplate: { item: 'leather_chestplate', color: 0xff0000 }, boots: null }
 *   armor: { helmet: { item: 'player_head', skin: '<64 hex texture hash | textures.minecraft.net URL | base64 textures value>' } }
 *   armor: { mainhand: 'diamond_sword', offhand: 'shield', ... }
 *
 * A slot value is an item name, `{ item, color?, skin?, count? }`, or null / false to leave the slot empty.
 */

// entity_equipment slot ids
const SLOTS_MODERN = { mainhand: 0, offhand: 1, boots: 2, leggings: 3, chestplate: 4, helmet: 5 }
const SLOTS_LEGACY = { mainhand: 0, boots: 1, leggings: 2, chestplate: 3, helmet: 4 } // 1.8: no off hand
const PIECES = ['helmet', 'chestplate', 'leggings', 'boots']
const MATERIALS = { leather: 'leather', chain: 'chainmail', chainmail: 'chainmail', iron: 'iron', gold: 'golden', golden: 'golden', diamond: 'diamond', netherite: 'netherite' }

const slotIds = registry => registry.version['>=']('1.9') ? SLOTS_MODERN : SLOTS_LEGACY

/** Spec (see above) -> { slotName: itemSpecObject | null }. Unknown keys throw so typos do not silently do nothing. */
function normalise (spec) {
  if (spec === undefined || spec === null || spec === false) return {}
  if (typeof spec === 'string') spec = { material: spec }
  const out = {}
  const { material, color, ...slots } = spec
  if (material) {
    const m = MATERIALS[String(material).toLowerCase()]
    if (!m) throw new Error(`Unknown armour material: ${material} (${Object.keys(MATERIALS).join(', ')})`)
    for (const p of PIECES) out[p] = { item: `${m}_${p}`, ...(m === 'leather' && color !== undefined ? { color } : {}) }
  }
  for (const [slot, v] of Object.entries(slots)) {
    if (!(slot in SLOTS_MODERN)) throw new Error(`Unknown equipment slot: ${slot} (${Object.keys(SLOTS_MODERN).join(', ')})`)
    out[slot] = !v ? null : typeof v === 'string' ? { item: v } : v
  }
  return out
}

/** Texture hash / URL / base64 -> the base64 `textures` value of a profile property. */
function textureValueFor (skin) {
  if (/^[0-9a-f]{40,64}$/i.test(skin)) skin = `http://textures.minecraft.net/texture/${skin}`
  if (/^https?:/.test(skin)) return Buffer.from(JSON.stringify({ textures: { SKIN: { url: skin } } })).toString('base64')
  return skin
}

/** Item spec -> prismarine Item (with 1.20.5+ data components where the item supports them). */
function makeItem (registry, Item, spec) {
  const name = String(spec.item).replace(/^minecraft:/, '')
  const def = registry.itemsByName[name]
  if (!def) throw new Error(`Unknown item: ${spec.item}`)
  const item = new Item(def.id, spec.count || 1)
  const add = (type, data) => {
    if (!Array.isArray(item.components)) return false // pre-component versions: colour / skull skin are not supported here
    const c = { type, data }
    item.components.push(c)
    if (item.componentMap) item.componentMap.set(type, c)
    return true
  }
  if (spec.color !== undefined && /^leather_/.test(name)) add('dyed_color', spec.color)
  if (spec.skin) add('profile', { type: 'partial', name: undefined, uuid: undefined, properties: [{ name: 'textures', value: textureValueFor(spec.skin), signature: undefined }], skinPatch: {} })
  return item
}

module.exports = { normalise, makeItem, slotIds, PIECES, MATERIALS, textureValueFor }
