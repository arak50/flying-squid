'use strict'
// Builds server-version items (26.1 data components) from Hypixel's 1.8 inventory NBT.

const nbt = require('prismarine-nbt')
const { createLegacyResolver } = require('./legacyItems')
const { legacyToComponent, componentToLegacy } = require('./text')
const { parseFooter } = require('./lore')
const mc8 = require('minecraft-data')('1.8')
let MODELS = {}
try { MODELS = require('../data/item-models.json') } catch { /* optional: built by tools/extract-item-models.js */ }

const writeNbt = typed => Buffer.from(nbt.writeUncompressed({ type: 'compound', name: '', value: typed.value }, 'big')).toString('base64')
const readNbt = b64 => nbt.parseUncompressed(Buffer.from(b64, 'base64'), 'big')

const RARITY_COLOR = { COMMON: 'f', UNCOMMON: 'a', RARE: '9', EPIC: '5', LEGENDARY: '6', MYTHIC: 'd', DIVINE: 'b', SPECIAL: 'c', VERY_SPECIAL: 'c', ULTIMATE: 'c', ADMIN: '4' }
const HIDE = ['attribute_modifiers', 'enchantments', 'stored_enchantments', 'dyed_color', 'unbreakable', 'can_break', 'can_place_on', 'trim', 'potion_contents', 'jukebox_playable', 'firework_explosion', 'fireworks', 'written_book_content', 'map_id']
const MAX_STR = 4096
const MAX_ARRAY = 4096

// Strip bulky payloads (backpack contents etc.) the client never needs.
function slimCompound (typed) {
  const out = {}
  for (const [k, v] of Object.entries(typed.value)) {
    if (['byteArray', 'intArray', 'longArray'].includes(v.type) && v.value.length > MAX_ARRAY) continue // backpack contents etc.
    if (v.type === 'string' && v.value.length > MAX_STR) continue
    out[k] = v.type === 'compound' ? { type: 'compound', value: slimCompound(v).value } : v
  }
  return { type: 'compound', name: '', value: out }
}

// typed NBT compound -> plain JSON (longs become Numbers, arrays of numbers are kept as arrays)
function untyped (typed) {
  const plain = nbt.simplify(typed)
  return JSON.parse(JSON.stringify(plain, (k, v) => (typeof v === 'bigint' ? Number(v) : v)))
}

// plain JSON -> typed NBT compound (anonymous root)
function typedValue (v) {
  if (typeof v === 'string') return nbt.string(v)
  if (typeof v === 'boolean') return nbt.byte(v ? 1 : 0)
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2 ** 31 ? nbt.int(v) : (Number.isInteger(v) ? nbt.long([Math.floor(v / 2 ** 32) | 0, v >>> 0]) : nbt.double(v))
  if (Array.isArray(v)) {
    if (!v.length) return nbt.list(nbt.string([]))
    const kids = v.map(typedValue)
    return kids.every(k => k.type === kids[0].type) ? { type: 'list', value: { type: kids[0].type, value: kids.map(k => k.value) } } : nbt.list(nbt.string(v.map(String)))
  }
  if (v && typeof v === 'object') return typedCompound(v)
  return nbt.string(String(v))
}
function typedCompound (obj) {
  const value = {}
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) value[k] = typedValue(v)
  return { type: 'compound', name: '', value }
}

// Hypixel always sets a uuid on texture heads; derive a stable one from the texture so identical heads still stack
function uuidFromTexture (value) {
  const h = require('crypto').createHash('md5').update(value).digest()
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

function createConverter (registry, resources) {
  const Item = require('prismarine-item')(registry)
  const resolver = createLegacyResolver(registry)
  const typeNames = registry.protocol.types.SlotComponentType[1].mappings
  const typeId = Object.fromEntries(Object.entries(typeNames).map(([id, n]) => [n, +id]))
  const hidden = HIDE.map(n => typeId[n]).filter(n => n !== undefined)
  // enchantment ids are positions in the registry this server sends in the configuration phase
  const ench = []
  try {
    const e = registry.loginPacket.dimensionCodec['minecraft:enchantment']
    for (const x of (e.entries || [])) ench.push(String(x.key || x.name).replace(/^minecraft:/, ''))
  } catch { /* no codec: fall back to the glint override */ }
  const enchId = name => ench.indexOf(name)
  const stats = { converted: 0, fallback: 0, unknown: 0, unknownIds: new Set() }

  function resourceFor (sb) {
    const id = sb.extra && sb.extra.id
    return id && resources && resources.byId ? resources.byId.get(id) : null
  }

  function pickType (sb, res) {
    let name = resolver.resolve(sb.mcId, sb.damage)
    if (!name && res) { name = resolver.resolveMaterial(res.material, res.durability || sb.damage); if (name) stats.fallback++ }
    if (!name) { stats.unknown++; stats.unknownIds.add(`${sb.mcId}:${sb.damage}`); name = 'paper' }
    return registry.itemsByName[name]
  }

  function skullProfile (tag, res) {
    const owner = tag && tag.value.SkullOwner
    let value, uuid, signature
    if (owner) {
      const o = nbt.simplify(owner)
      const t0 = o.Properties && o.Properties.textures && o.Properties.textures[0]
      value = t0 && t0.Value
      signature = t0 && t0.Signature
      uuid = o.Id
    }
    if (!value && res && res.skin) {
      value = /^[{]/.test(res.skin) ? Buffer.from(res.skin).toString('base64') : res.skin
    }
    if (!value) return null
    const u = uuid && /^[0-9a-f-]{32,36}$/i.test(uuid) ? uuid : undefined
    return { type: 'partial', name: undefined, uuid: u, properties: [{ name: 'textures', value, signature }], skinPatch: {} }
  }

  // ---- neutral form -------------------------------------------------------------------------
  // Version-independent description of an item; what gets persisted and what the window item is built from:
  //   { type:'iron_sword', count, name:'§6..'|null, lore:['§7..'], extra:{...}|null, skin:'<b64>'|null,
  //     skinId:'uuid'|null, color:int|null, glint:bool, unbreakable:bool }

  // Hypixel 1.8 SbItem (+ optional items-resource entry) -> neutral
  function toNeutral (sb) {
    const res = resourceFor(sb)
    const def = pickType(sb, res)
    const tag = sb.nbt
    const display = tag && tag.value.display ? tag.value.display.value : {}
    let name = sb.displayName
    if (!name && res) name = `§${RARITY_COLOR[res.tier] || 'f'}${res.name}`
    let lore = sb.lore && sb.lore.length ? sb.lore : null
    if (!lore && res) lore = [`§${RARITY_COLOR[res.tier] || 'f'}§l${(res.tier || 'COMMON').replace(/_/g, ' ')}${res.category ? ' ' + res.category : ''}`]
    const known = sb.id && MODELS[sb.id] // what the real server sent for this SkyBlock item (recordings)
    const base = known && registry.itemsByName[known.base] ? known.base : def.name
    const n = { type: base, count: sb.count || 1, name: name || null, lore: lore || [], extra: null, extraNbt: null, model: known && known.model ? known.model : null, style: null, skin: null, skinSig: null, skinId: null, color: null, glint: false, ench: null, unbreakable: false }
    const foot = parseFooter(n.lore)
    if (foot && foot.rarity) n.style = 'hypixel_skyblock:' + String(foot.rarity).toLowerCase().replace(/\s+/g, '_')
    if (sb.extra && Object.keys(sb.extra).length && tag.value.ExtraAttributes) {
      const slim = slimCompound(tag.value.ExtraAttributes)
      n.extra = untyped(slim)
      n.extraNbt = writeNbt(slim)
    }
    if (base === 'player_head') { const p = skullProfile(tag, res); if (p) { n.skin = p.properties[0].value; n.skinSig = p.properties[0].signature || null; n.skinId = p.uuid || null } }
    let color = display.color ? display.color.value : null
    if (color === null && res && res.color) { const [r, g, b] = String(res.color).split(',').map(Number); if ([r, g, b].every(Number.isFinite)) color = (r << 16) | (g << 8) | b }
    if (color !== null && /^leather_/.test(def.name)) n.color = color
    const list = tag && tag.value.ench ? nbt.simplify(tag.value.ench) : null
    if (list && list.length) {
      n.ench = list.map(e => ({ id: (mc8.enchantments[e.id] || {}).name, level: e.lvl })).filter(e => e.id && enchId(e.id) >= 0)
      if (!n.ench.length) { n.ench = null; n.glint = true }
    } else n.glint = !!(list || (res && res.glowing))
    n.unbreakable = !!(tag && tag.value.Unbreakable)
    stats.converted++
    return n
  }

  // neutral -> prismarine Item with 26.1 data components
  function build (n) {
    const def = registry.itemsByName[n.type] || registry.itemsByName.paper
    const item = new Item(def.id, n.count || 1)
    const add = (type, data) => {
      const c = { type, data }
      item.components.push(c)
      if (item.componentMap) item.componentMap.set(type, c)
    }
    if (n.name !== null && n.name !== undefined) add('custom_name', legacyToComponent(n.name))
    if (n.lore && n.lore.length) add('lore', n.lore.map(legacyToComponent))
    // item_model / tooltip_style point into the Hypixel resource pack: the skyblock-resourcepack plugin sends it to players
    if (n.model) add('item_model', n.model)
    if (n.extraNbt) add('custom_data', readNbt(n.extraNbt))
    else if (n.extra && Object.keys(n.extra).length) add('custom_data', typedCompound(n.extra))
    if (n.skin) add('profile', { type: 'partial', name: undefined, uuid: n.skinId || uuidFromTexture(n.skin), properties: [{ name: 'textures', value: n.skin, signature: n.skinSig || undefined }], skinPatch: {} })
    if (n.color !== null && n.color !== undefined) add('dyed_color', n.color)
    if (n.ench && n.ench.length) add('enchantments', { enchantments: n.ench.map(e => ({ id: enchId(e.id), level: e.level })) })
    else if (n.glint) add('enchantment_glint_override', true)
    if (n.style) add('tooltip_style', n.style)
    if (n.unbreakable) add('unbreakable', undefined)
    add('tooltip_display', { hideTooltip: false, hiddenComponents: hidden })
    Object.defineProperty(item, '_n', { value: n, enumerable: false, writable: true, configurable: true })
    return item
  }

  // live prismarine Item -> neutral (reads the components, so it reflects whatever the player did to the stack)
  function neutralFromItem (item) {
    if (!item) return null
    const comps = new Map((item.components || []).map(c => [c.type, c.data]))
    const cd = comps.get('custom_data')
    const prof = comps.get('profile')
    const tex = prof && (prof.properties || []).find(p => p.name === 'textures')
    return {
      type: registry.items[item.type].name,
      count: item.count,
      name: comps.has('custom_name') ? componentToLegacy(comps.get('custom_name')) : null,
      lore: comps.has('lore') ? comps.get('lore').map(componentToLegacy) : [],
      extra: cd ? untyped(cd) : null,
      extraNbt: cd ? writeNbt(cd) : null,
      model: comps.get('item_model') || null,
      style: comps.get('tooltip_style') || null,
      skin: tex ? tex.value : null,
      skinSig: tex && tex.signature ? tex.signature : null,
      skinId: prof && prof.uuid ? prof.uuid : null,
      color: comps.has('dyed_color') ? comps.get('dyed_color') : null,
      ench: comps.has('enchantments') ? comps.get('enchantments').enchantments.map(e => ({ id: ench[e.id], level: e.level })) : null,
      glint: comps.get('enchantment_glint_override') === true,
      unbreakable: comps.has('unbreakable')
    }
  }

  function toItem (sb) { return build(toNeutral(sb)) }

  return { toItem, toNeutral, build, neutralFromItem, stats, resolver }
}

// Rebuild SbItem-like raw data from a live 26.1 item (after the player moved it around).
function liveToRaw (item) {
  const comps = new Map((item.components || []).map(c => [c.type, c.data]))
  const cd = comps.get('custom_data')
  return {
    name: comps.has('custom_name') ? componentToLegacy(comps.get('custom_name')) : null,
    lore: comps.has('lore') ? comps.get('lore').map(componentToLegacy) : [],
    extra: cd ? nbt.simplify(cd) : {}
  }
}

module.exports = { createConverter, liveToRaw, untyped, typedCompound }
