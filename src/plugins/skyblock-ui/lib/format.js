'use strict'
// Number formatting as Hypixel shows it: thousands separators, up to `d` decimals, trailing zeros trimmed.
const fmt = (v, d = 2) => {
  const k = 10 ** d
  const r = Math.round((Number(v) + Number.EPSILON) * k) / k
  return (Object.is(r, -0) ? 0 : r).toLocaleString('en-US', { maximumFractionDigits: d })
}
const signed = (v, d = 2) => (v < 0 ? '-' : '+') + fmt(Math.abs(v), d)
module.exports = { fmt, signed }
