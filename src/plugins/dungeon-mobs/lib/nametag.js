'use strict'
/**
 * Dungeon mob nametags, shaped like the ones in the Hypixel packet capture (Set Entity Data, custom_name = text component):
 *
 *   [glyphs] ✯ <Name> <health>❤          ✯ gold, name red (dark gray when it has a modifier), health green, ❤ red
 *
 * `glyphs` are the resource-pack icons (private-use characters such as U+E083 / U+E084) Hypixel puts in front. They only
 * mean something with its resource pack, so they are off unless you pass them in.
 */

const fmt = n => Math.round(n).toLocaleString('en-US')

/** JSON-style text component for a mob. */
function nametagComponent ({ name, star = false, health, modifier = null, glyphs = [] }) {
  const extra = []
  for (const g of glyphs) extra.push({ text: g.text, color: g.color || 'white' })
  if (star) extra.push({ text: '✯ ', color: 'gold' })
  extra.push(modifier
    ? { text: `${modifier} ${name}`, color: 'dark_gray' }
    : { text: name, color: 'red' })
  if (health !== undefined) {
    extra.push({ text: ' ' })
    extra.push({ text: fmt(health), color: 'green' })
    extra.push({ text: '❤', color: 'red' })
  }
  return { text: '', extra }
}

/** Plain text of the same tag (for logs / tests). */
const plain = c => (c.text || '') + (c.extra || []).map(plain).join('')

/** JSON-ish value -> typed NBT as prismarine-nbt writes it (what entity metadata components are sent as). */
function toNbt (v) {
  if (typeof v === 'string') return { type: 'string', value: v }
  if (typeof v === 'boolean') return { type: 'byte', value: v ? 1 : 0 }
  if (typeof v === 'number') return { type: 'int', value: v }
  if (Array.isArray(v)) return { type: 'list', value: { type: 'compound', value: v.map(e => toNbt(e).value) } }
  const out = {}
  for (const [k, x] of Object.entries(v)) out[k] = toNbt(x)
  return { type: 'compound', value: out }
}

const componentToNbt = c => ({ ...toNbt(c), name: '' })

module.exports = { nametagComponent, componentToNbt, plain, fmt }
