'use strict'
/**
 * Mob density: one setting that makes every combat room hold more or fewer mobs, bounded so a room can never be empty or
 * crowded out, whatever its size. Pure and deterministic.
 *
 *   mobDensity: {
 *     percent:    100,  // 100 = the stock counts, 50 = half the mobs, 150 = half as many again
 *     minPercent: 10,   // the percent itself is clamped to [minPercent, maxPercent], so a typo cannot empty or flood the dungeon
 *     maxPercent: 300,
 *     minPerCell: 1,    // lower limit: every room keeps at least this many mobs per cell of its size ...
 *     maxPerCell: 16,   // ... and at most this many (a 1x1 room is 1 cell, a 1x2 is 2, an L-shape 3, a 2x2 4 ...)
 *     minStars:   1     // a room that has star mobs at all keeps at least this many, so it is still something to clear
 *   }
 *
 * The stock planner already gives bigger rooms more mobs (`starMobs` / `fillerMobs` in the run config: a base per room plus
 * a share per extra cell). The percentage scales those counts and the per-cell limits then scale with the room, so
 * "at most 16 per cell" means 16 in a 1x1 room and 64 in a 2x2 one. The defaults leave the stock counts exactly as they were.
 */
const DEFAULTS = Object.freeze({ percent: 100, minPercent: 10, maxPercent: 300, minPerCell: 1, maxPerCell: 16, minStars: 1 })

const num = (v, d) => typeof v === 'number' && Number.isFinite(v) ? v : d

/** The effective density settings (defaults filled in, limits sane, percent clamped to its limits). */
function resolveDensity (d) {
  const o = { ...DEFAULTS, ...(d || {}) }
  const minPercent = Math.max(0, num(o.minPercent, DEFAULTS.minPercent))
  const maxPercent = Math.max(minPercent, num(o.maxPercent, DEFAULTS.maxPercent))
  const minPerCell = Math.max(0, Math.floor(num(o.minPerCell, DEFAULTS.minPerCell)))
  const maxPerCell = Math.max(minPerCell, Math.floor(num(o.maxPerCell, DEFAULTS.maxPerCell)))
  const percent = Math.min(maxPercent, Math.max(minPercent, num(o.percent, DEFAULTS.percent)))
  return { percent, minPercent, maxPercent, minPerCell, maxPerCell, minStars: Math.max(0, Math.floor(num(o.minStars, DEFAULTS.minStars))) }
}

/** Limits on the number of mobs of a room of `cells` cells: { min, max }. */
const limitsFor = (d, cells) => ({ min: d.minPerCell * Math.max(1, cells), max: d.maxPerCell * Math.max(1, cells) })

/**
 * Scale the stock counts of a room.
 * @param stock  { stars, fillers } the counts the planner drew
 * @param cells  number of cells of the room
 * @returns { stars, fillers }
 */
function scaleCounts (stock, cells, density) {
  const d = resolveDensity(density)
  const f = d.percent / 100
  const { min, max } = limitsFor(d, cells)
  return fit(Math.round(stock.stars * f), Math.round(stock.fillers * f), { min, max, minStars: stock.stars > 0 ? d.minStars : 0, fixed: 0 })
}

/**
 * Bring a star / filler pair inside the limits. Above the upper limit both shrink in proportion (so a crowded room keeps its
 * mix of star mobs and fillers instead of turning into all stars), but stars never fall below `minStars`. Below the lower
 * limit the difference is made up with fillers. `fixed` counts mobs that are not scaled but do count towards the limits.
 */
function fit (stars, fillers, { min, max, minStars, fixed }) {
  stars = Math.max(stars, minStars)
  const total = stars + fillers + fixed
  if (total > max) {
    const room = Math.max(0, max - fixed)
    const ratio = room / (stars + fillers)
    stars = Math.min(room, Math.max(minStars, Math.floor(stars * ratio)))
    fillers = Math.max(0, room - stars)
  }
  if (stars + fillers + fixed < min) fillers = min - stars - fixed
  return { stars, fillers: Math.max(0, fillers) }
}

/**
 * Scale a finished list of entries (sidecar rooms, whose spawn list is authored): fillers are dropped first and then stars (never
 * below minStars, never required / mini boss entries); when the target is higher than what the room lists, extra basic mobs are
 * added next to existing ones. `extra(i, base)` builds the i-th extra entry from an existing one; it is only called when needed.
 * @returns the new list (same objects for the kept entries, original order, extras at the end)
 */
function scaleEntries (entries, cells, density, { shuffle, extra }) {
  const d = resolveDensity(density)
  const f = d.percent / 100
  const { min, max } = limitsFor(d, cells)
  const protectedEntry = e => e.miniboss || (e.required && !e.star)
  const stars = entries.filter(e => e.star)
  const fillers = entries.filter(e => !e.star && !protectedEntry(e))
  const fixed = entries.filter(e => protectedEntry(e))

  const { stars: wantStars, fillers: wantFillers } = fit(Math.round(stars.length * f), Math.round(fillers.length * f), {
    min, max, minStars: stars.length ? d.minStars : 0, fixed: fixed.length
  })

  const keep = new Set(fixed)
  const pick = (list, n) => {
    const kept = n >= list.length ? list : shuffle([...list]).slice(0, n)
    kept.forEach(e => keep.add(e))
    return kept
  }
  pick(stars, wantStars)
  pick(fillers, wantFillers)

  const out = entries.filter(e => keep.has(e))
  const base = entries.filter(e => !protectedEntry(e))
  const pool = base.length ? base : entries
  const needStars = Math.max(0, wantStars - stars.length)
  const needFillers = Math.max(0, wantFillers - fillers.length)
  for (let i = 0; i < needStars + needFillers && pool.length; i++) out.push(extra(i, pool[i % pool.length], i < needStars))
  return out
}

module.exports = { DEFAULTS, resolveDensity, limitsFor, scaleCounts, scaleEntries }
