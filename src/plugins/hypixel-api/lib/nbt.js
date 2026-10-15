'use strict'
// Dependency-free NBT reader. Produces prismarine-nbt *typed* tags
// ({ type, value }) so results can be handed straight to prismarine-item,
// plus simplify() for plain-object access.
const zlib = require('zlib')

const TYPES = ['end', 'byte', 'short', 'int', 'long', 'float', 'double',
  'byteArray', 'string', 'list', 'compound', 'intArray', 'longArray']

class Reader {
  constructor (buf) { this.buf = buf; this.o = 0 }
  i8 () { const v = this.buf.readInt8(this.o); this.o += 1; return v }
  i16 () { const v = this.buf.readInt16BE(this.o); this.o += 2; return v }
  u16 () { const v = this.buf.readUInt16BE(this.o); this.o += 2; return v }
  i32 () { const v = this.buf.readInt32BE(this.o); this.o += 4; return v }
  f32 () { const v = this.buf.readFloatBE(this.o); this.o += 4; return v }
  f64 () { const v = this.buf.readDoubleBE(this.o); this.o += 8; return v }
  str () { const n = this.u16(); const s = this.buf.toString('utf8', this.o, this.o + n); this.o += n; return s }
}

function readPayload (r, t) {
  switch (t) {
    case 1: return r.i8()
    case 2: return r.i16()
    case 3: return r.i32()
    case 4: { const hi = r.i32(); const lo = r.i32(); return [hi, lo] } // prismarine long = [hi, lo]
    case 5: return r.f32()
    case 6: return r.f64()
    case 7: { const n = r.i32(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.i8(); return a }
    case 8: return r.str()
    case 9: {
      const it = r.i8(); const n = r.i32()
      if (n === 0 || it === 0) return { type: 'end', value: [] }
      const value = new Array(n)
      for (let i = 0; i < n; i++) value[i] = readPayload(r, it)
      return { type: TYPES[it], value }
    }
    case 10: {
      const o = {}
      for (;;) {
        const tt = r.i8()
        if (tt === 0) break
        const k = r.str()
        o[k] = { type: TYPES[tt], value: readPayload(r, tt) }
      }
      return o
    }
    case 11: { const n = r.i32(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.i32(); return a }
    case 12: { const n = r.i32(); const a = new Array(n); for (let i = 0; i < n; i++) { const hi = r.i32(); const lo = r.i32(); a[i] = [hi, lo] } return a }
    default: throw new Error('Unknown NBT tag type ' + t)
  }
}

function parseNbt (buf) {
  const r = new Reader(buf)
  const t = r.i8()
  const name = r.str()
  return { type: TYPES[t], name, value: readPayload(r, t) }
}

function gunzipMaybe (buf) {
  return (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf) : buf
}

/** Hypixel API `{ type: 0, data: "<base64 gzip nbt>" }` -> typed root tag. */
function decodeBase64Nbt (b64) {
  return parseNbt(gunzipMaybe(Buffer.from(b64, 'base64')))
}

const long = ([hi, lo]) => Number((BigInt(hi) << 32n) | BigInt(lo >>> 0))

function simplifyValue (type, value) {
  switch (type) {
    case 'compound': {
      const o = {}
      for (const k of Object.keys(value)) o[k] = simplifyValue(value[k].type, value[k].value)
      return o
    }
    case 'list': return value.value.map(v => simplifyValue(value.type, v))
    case 'end': return []
    case 'long': return long(value)
    case 'longArray': return value.map(long)
    default: return value
  }
}
const simplify = tag => (tag ? simplifyValue(tag.type, tag.value) : undefined)

/**
 * Decode a Hypixel inventory blob into slot entries.
 * Empty slots are `null`. Each item keeps both the typed NBT (for sending to
 * clients) and the simplified tag (for reading stats).
 */
function decodeInventory (b64) {
  const root = decodeBase64Nbt(b64)
  const list = root.value.i
  if (!list || list.value.type === 'end') return []
  return list.value.value.map((e) => {
    if (!e || Object.keys(e).length === 0) return null
    const tagTyped = e.tag
    return {
      id: e.id ? e.id.value : 0,
      count: e.Count ? e.Count.value : 1,
      damage: e.Damage ? e.Damage.value : 0,
      nbt: tagTyped ? { type: 'compound', name: '', value: tagTyped.value } : undefined,
      tag: tagTyped ? simplify(tagTyped) : {}
    }
  })
}

module.exports = { parseNbt, decodeBase64Nbt, decodeInventory, simplify, simplifyValue }
