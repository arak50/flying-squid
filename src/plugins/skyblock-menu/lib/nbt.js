// Helpers for reading/editing item names + lore of decoded Slot objects (minecraft-protocol 26.1 layout).
// Chat components in item data are anonymous NBT: { type: 'compound', value: { text: {type:'string',value}, extra: {...}, ... } }

const str = (s) => ({ type: 'string', value: s })
const byte = (b) => ({ type: 'byte', value: b ? 1 : 0 })

// plain segment object (the "value" of a compound) – used inside a line's `extra`
function seg (text, color, flags = {}) {
  const o = { text: str(text) }
  if (color) o.color = str(color)
  for (const f of ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated']) if (flags[f] !== undefined) o[f] = byte(flags[f])
  return o
}

// a lore line made of segments (mirrors the server's own shape: empty text + extra list + italic:0)
function line (segs) {
  if (!segs.length) return { type: 'compound', value: { text: str('') } }
  return { type: 'compound', value: { extra: { type: 'list', value: { type: 'compound', value: segs } }, italic: byte(0), text: str('') } }
}
const blank = () => ({ type: 'compound', value: { text: str('') } })

// all segment objects of a line, in order: the line's own text first, then each extra element
function segsOf (ln) {
  const v = ln.value
  const extra = v.extra && v.extra.value && Array.isArray(v.extra.value.value) ? v.extra.value.value : []
  return [v, ...extra]
}
const textOf = (ln) => segsOf(ln).map(s => (s.text && s.text.value) || '').join('')
const setText = (s, t) => { s.text = str(t) }
const getText = (s) => (s.text && s.text.value) || ''

const getComp = (item, type) => item.components.find(c => c.type === type)
const loreOf = (item) => { const c = getComp(item, 'lore'); return c ? c.data : null }
const nameNbt = (item) => { const c = getComp(item, 'custom_name'); return c ? c.data : null }
const nameText = (item) => { const n = nameNbt(item); return n ? textOf(n) : '' }

// lore line index whose plain text matches
const findLine = (lore, re, from = 0) => { for (let i = from; i < lore.length; i++) if (re.test(textOf(lore[i]))) return i; return -1 }
const findSeg = (ln, re) => segsOf(ln).find(s => re.test(getText(s)))

function setComponent (item, type, data) {
  const c = getComp(item, type)
  if (c) c.data = data
  else { item.components.push({ type, data }); item.addedComponentCount = item.components.length }
}

module.exports = { str, byte, seg, line, blank, segsOf, textOf, setText, getText, getComp, loreOf, nameNbt, nameText, findLine, findSeg, setComponent }
