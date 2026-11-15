'use strict'
// Text of the floating damage number, shaped like Hypixel's:
//   normal hit   gray number                       1,234
//   crit         ✧ white-yellow-gold-red digits ✧   ✧1,234✧   (colours cycle per character)

const CRIT_COLORS = ['white', 'yellow', 'gold', 'red', 'red']
const fmt = n => Math.round(n).toLocaleString('en-US')

/** JSON-style text component for a hit. */
function damageComponent (damage, critical) {
  const text = fmt(damage)
  if (!critical) return { text: '', extra: [{ text, color: 'gray' }] }
  const extra = [{ text: '✧', color: 'white' }]
  for (let i = 0; i < text.length; i++) extra.push({ text: text[i], color: CRIT_COLORS[i % CRIT_COLORS.length] })
  extra.push({ text: '✧', color: 'white' })
  return { text: '', extra }
}

/** Plain text of the same component (logs / tests). */
const plain = c => (c.text || '') + (c.extra || []).map(plain).join('')

/** JSON-ish value -> typed NBT as prismarine-nbt writes it (what entity metadata components are sent as). */
function toNbt (v) {
  if (typeof v === 'string') return { type: 'string', value: v }
  if (typeof v === 'boolean') return { type: 'byte', value: v ? 1 : 0 }
  if (typeof v === 'number') return { type: 'int', value: v }
  if (Array.isArray(v)) return { type: 'list', value: { type: 'compound', value: v.map(e => toNbt(e).value) } }
  const out = {}
  for (const [k, x] of Object.entries(v)) if (!(Array.isArray(x) && x.length === 0)) out[k] = toNbt(x) // the client refuses empty component lists
  return { type: 'compound', value: out }
}

const componentToNbt = c => ({ ...toNbt(c), name: '' })

module.exports = { damageComponent, componentToNbt, plain, CRIT_COLORS }
