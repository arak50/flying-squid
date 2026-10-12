// Number / time formatting that matches the Hypixel SkyBlock menu lore (checked against the sniff).
const trim = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')

// 4306115.4 -> "4,306,115.4"  ·  1719734.0028 -> "1,719,734"  ·  (1 decimal, trailing .0 dropped)
function fmt (n, decimals = 1) {
  const s = Number(n).toFixed(decimals)
  const [i, f] = s.split('.')
  const withCommas = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return trim(f ? withCommas + '.' + f : withCommas)
}

// 5200000 -> "5.2M"  ·  800000 -> "800k"  ·  2000 -> "2k"
function abbr (n) {
  if (n >= 1e9) return trim((n / 1e9).toFixed(1)) + 'B'
  if (n >= 1e6) return trim((n / 1e6).toFixed(1)) + 'M'
  if (n >= 1e3) return trim((n / 1e3).toFixed(1)) + 'k'
  return fmt(n)
}

const pct = (frac) => trim((frac * 100).toFixed(1)) + '%'

function ordinal (n) {
  const v = n % 100
  if (v >= 11 && v <= 13) return n + 'th'
  return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th')
}

// seconds -> "18h 11m 39s" (leading zero units dropped, days shown when >= 1d)
function duration (sec) {
  sec = Math.max(0, Math.floor(sec))
  const d = Math.floor(sec / 86400); const h = Math.floor(sec % 86400 / 3600); const m = Math.floor(sec % 3600 / 60); const s = sec % 60
  const parts = []
  if (d) parts.push(d + 'd')
  if (d || h) parts.push(h + 'h')
  if (d || h || m) parts.push(m + 'm')
  parts.push(s + 's')
  return parts.join(' ')
}

const titleCase = (id) => id.toLowerCase().split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')

module.exports = { fmt, abbr, pct, ordinal, duration, titleCase, trim }
