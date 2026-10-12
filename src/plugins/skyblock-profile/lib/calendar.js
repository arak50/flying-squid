// SkyBlock calendar. Verified against the sniff: at the capture time (2026-10-12 04:43:21 UTC) this yields
// "8th Autumn 519" and "Spooky Festival starting in 6h 51m 40s" - both identical to the captured menu.
const { ordinal, duration } = require('./format')

const EPOCH = 1560275700 // seconds, SkyBlock year 1 day 1
const DAY = 1200; const MONTH = 31 * DAY; const YEAR = 12 * MONTH
const MONTHS = ['Early Spring', 'Spring', 'Late Spring', 'Early Summer', 'Summer', 'Late Summer', 'Early Autumn', 'Autumn', 'Late Autumn', 'Early Winter', 'Winter', 'Late Winter']

// start/end are [month(0-11), day(1-31)]; end is inclusive and falls on the day's end.
const EVENTS = [
  { name: 'Spooky Festival', start: [7, 29], end: [7, 31], numbered: (year) => year },
  { name: 'Traveling Zoo', start: [3, 1], end: [3, 3] },
  { name: 'Traveling Zoo', start: [9, 1], end: [9, 3] },
  { name: 'Season of Jerry', start: [11, 24], end: [11, 26] },
  { name: 'New Year Celebration', start: [11, 29], end: [11, 31] },
  // INFERRED from one observation ("Ends in 18h 11m 39s" on 8th Autumn): it runs until the end of Late Autumn.
  // The ordinal (33rd in year 519) is likewise inferred as year-486.
  { name: 'Harvest Feast', start: [7, 1], end: [8, 31], numbered: (year) => year - 486, inferred: true }
]

function now (ms = Date.now()) {
  const t = ms / 1000 - EPOCH
  const year = Math.floor(t / YEAR) + 1
  const inYear = t % YEAR
  const month = Math.floor(inYear / MONTH)
  const day = Math.floor((inYear % MONTH) / DAY) + 1
  return { year, month, day, inYear, label: `${ordinal(day)} ${MONTHS[month]} ${year}` }
}

const at = (ev, which) => ev[which][0] * MONTH + (ev[which][1] - (which === 'start' ? 1 : 0)) * DAY // seconds into year

function calendar (ms = Date.now()) {
  const n = now(ms)
  let active = null; let next = null
  for (const ev of EVENTS) {
    const s = at(ev, 'start'); const e = at(ev, 'end')
    for (const yOff of [0, 1]) {
      const ys = s + yOff * YEAR; const ye = e + yOff * YEAR; const year = n.year + yOff
      if (n.inYear >= ys && n.inYear < ye && !yOff) { if (!active || ye - n.inYear < active.endsIn) active = { name: ev.name, ordinal: ev.numbered ? ordinal(ev.numbered(year)) + ' ' : '', endsIn: ye - n.inYear, inferred: !!ev.inferred } }
      if (ys > n.inYear && (!next || ys - n.inYear < next.startsIn) && !ev.inferred) next = { name: ev.name, ordinal: ev.numbered ? ordinal(ev.numbered(year)) + ' ' : '', startsIn: ys - n.inYear }
    }
  }
  return { date: n.label, ...n, active: active && { ...active, text: active.ordinal + active.name, endsInText: duration(active.endsIn) }, next: next && { ...next, text: next.ordinal + next.name, startsInText: duration(next.startsIn) } }
}

module.exports = { calendar, now, MONTHS, EVENTS }
