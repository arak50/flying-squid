'use strict'
// Legacy "§" strings <-> NBT text components (26.1 item names/lore are NBT text components).

const nbt = require('prismarine-nbt')

const COLOR = { 0: 'black', 1: 'dark_blue', 2: 'dark_green', 3: 'dark_aqua', 4: 'dark_red', 5: 'dark_purple', 6: 'gold', 7: 'gray', 8: 'dark_gray', 9: 'blue', a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white' }
const CODE = Object.fromEntries(Object.entries(COLOR).map(([k, v]) => [v, k]))
const FORMAT = { k: 'obfuscated', l: 'bold', m: 'strikethrough', n: 'underlined', o: 'italic' }
const FORMAT_CODE = Object.fromEntries(Object.entries(FORMAT).map(([k, v]) => [v, k]))

function parseLegacy (str) {
  const segs = []
  let cur = { text: '' }
  const push = () => { if (cur.text) segs.push(cur) }
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '§' && i + 1 < str.length) {
      const c = str[++i].toLowerCase()
      if (COLOR[c]) { push(); cur = { text: '', color: COLOR[c] } } else if (FORMAT[c]) { push(); cur = { ...cur, text: '', [FORMAT[c]]: true } } else if (c === 'r') { push(); cur = { text: '' } } else { cur.text += ch + str[i] }
    } else cur.text += ch
  }
  push()
  return segs
}

// One legacy line -> typed NBT compound text component. italic:false because name/lore default to italic.
function legacyToComponent (str) {
  const extra = parseLegacy(str || '').map(s => {
    const v = { text: nbt.string(s.text) }
    if (s.color) v.color = nbt.string(s.color)
    for (const f of Object.values(FORMAT)) if (s[f]) v[f] = nbt.byte(1)
    return v
  })
  const root = { text: nbt.string(''), color: nbt.string('white'), italic: nbt.byte(0) }
  // the vanilla client rejects empty lists inside text components ("List must have contents"), so blank lines get no `extra`
  if (extra.length) root.extra = nbt.list(nbt.comp(extra))
  return nbt.comp(root)
}

// Typed (or simplified) NBT / JSON text component -> legacy "§" string.
function componentToLegacy (value, inherited) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') {
    if (value.trim().startsWith('{') || value.trim().startsWith('[')) { try { return componentToLegacy(JSON.parse(value), inherited) } catch { /* plain */ } }
    return value
  }
  if (value && typeof value === 'object' && value.type && 'value' in value) value = nbt.simplify(value)
  if (Array.isArray(value)) return value.map(v => componentToLegacy(v, inherited)).join('')
  const text = value.text !== undefined ? value.text : ''
  const color = value.color || (inherited !== 'white' ? inherited : undefined) // our wrapper's white is implicit
  let out = ''
  if (text === '' && !value.color) {
    // empty wrapper: contributes nothing itself, children inherit its formatting
  } else if (text !== '' || value.color) {
    if (color && CODE[color]) out += '§' + CODE[color]
    for (const f of Object.keys(FORMAT_CODE)) if (value[f]) out += '§' + FORMAT_CODE[f]
  }
  // an empty-text wrapper that carries a colour only matters as the colour its children inherit
  if (text === '' && value.color) out = ''
  out += text
  for (const e of (value.extra || [])) out += componentToLegacy(e, text === '' ? color : undefined)
  return out
}

module.exports = { legacyToComponent, componentToLegacy, parseLegacy }
