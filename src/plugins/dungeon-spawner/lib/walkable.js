'use strict'
/**
 * Where a mob of a room may stand, and putting planned mobs there. Pure: no flying-squid, no clock, no Math.random.
 *
 * Why this exists: the generic planner (lib/plan.js) picks a random x / z inside a room's cells and the plugin then scans the
 * world bottom-up for "the floor". On a real generated floor that lands mobs inside walls, floating over holes, in pits and in
 * closed-off pockets, i.e. somewhere the party cannot reach, and a room whose star mob stands there never clears. Measured on
 * 226 generated rooms (floors 0 / 3 / 6, six seeds) about 28 % of the planned mobs were such spots.
 *
 * A spot is good when it is
 *   standable   solid block below, two free blocks (feet + head) above, and not liquid
 *   inside      in one of the room's own cells (or the gap column between two of its cells), never a neighbour's
 *   reachable   connected by walking (up 1, down 3 per step) to a spot next to one of the room's doors
 * which is the closest cheap model of "a player can get to it". `roomy` spots also have free blocks all around them and are
 * kept a couple of blocks away from the doors (a mob in the doorway blocks it and looks wrong); they are preferred.
 */
const FREE = 0
const SOLID = 1
const LIQUID = 2

/** Block class (FREE / SOLID / LIQUID) of a block state id, from a prismarine / minecraft-data registry. Cached. */
function classifier (registry) {
  const cache = new Map()
  return stateId => {
    if (!stateId) return FREE
    let c = cache.get(stateId)
    if (c !== undefined) return c
    const b = registry && registry.blocksByStateId && registry.blocksByStateId[stateId]
    if (!b) c = FREE
    else if (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column') c = LIQUID
    else c = b.boundingBox === 'block' ? SOLID : FREE
    cache.set(stateId, c)
    return c
  }
}

/** A dense block-class volume over [x0..x1] x [y0..y1] x [z0..z1] (inclusive). Outside it everything reads as SOLID. */
class Volume {
  constructor (x0, y0, z0, x1, y1, z1) {
    Object.assign(this, { x0, y0, z0, x1, y1, z1 })
    this.w = x1 - x0 + 1; this.h = y1 - y0 + 1; this.l = z1 - z0 + 1
    this.data = new Uint8Array(this.w * this.h * this.l) // FREE by default
  }

  index (x, y, z) { return ((y - this.y0) * this.l + (z - this.z0)) * this.w + (x - this.x0) }
  has (x, y, z) { return x >= this.x0 && x <= this.x1 && y >= this.y0 && y <= this.y1 && z >= this.z0 && z <= this.z1 }
  get (x, y, z) { return this.has(x, y, z) ? this.data[this.index(x, y, z)] : SOLID }
  set (x, y, z, c) { if (this.has(x, y, z)) this.data[this.index(x, y, z)] = c }
}

const standable = (v, x, y, z) => v.get(x, y - 1, z) === SOLID && v.get(x, y, z) === FREE && v.get(x, y + 1, z) === FREE

/**
 * Predicate "is this block column inside the room": a column of one of its cells, or the 1-block gap between two of its cells
 * (P = cell pitch, S = room size; the column P - 1 of a cell is the gap towards the next one).
 */
function roomMask (cells, P = 32, S = 31) {
  const has = new Set(cells.map(c => `${c.x},${c.z}`))
  const span = n => { const c = Math.floor(n / P); return n - c * P < S ? [c] : [c, c + 1] }
  return (x, z) => span(x).every(cx => span(z).every(cz => has.has(`${cx},${cz}`)))
}

/** Bounding box (block columns) of a set of cells. */
function cellBox (cells, P = 32, S = 31) {
  const xs = cells.map(c => c.x); const zs = cells.map(c => c.z)
  return { x0: Math.min(...xs) * P, x1: Math.max(...xs) * P + S - 1, z0: Math.min(...zs) * P, z1: Math.max(...zs) * P + S - 1 }
}

/**
 * Standing spots of one room.
 * @param o.volume   Volume covering at least the room's box and its floor-to-ceiling heights
 * @param o.cells    [{ x, z }] cell coordinates of the room
 * @param o.doors    [{ center: { x, y, z } }] the room's doors (their walkable surroundings seed the search)
 * @param o.P, o.S   cell pitch / room size
 * @returns null when there is nothing to start from (no door with a floor next to it), else
 *   { spots, roomy, has(x, y, z), column(x, z) -> [y...], size }
 *   spots / roomy: [{ x, y, z }] block coordinates (feet), sorted by x, z, y
 */
function scanRoom ({ volume: v, cells, doors, P = 32, S = 31 }) {
  const inside = roomMask(cells, P, S)
  const box = cellBox(cells, P, S)
  const key = (x, y, z) => (y * 8192 + z) * 8192 + x
  const cols = new Map()
  const col = (x, z) => {
    const k = x * 8192 + z
    let c = cols.get(k)
    if (!c) { c = []; if (inside(x, z)) for (let y = v.y0 + 1; y <= v.y1 - 1; y++) if (standable(v, x, y, z)) c.push(y); cols.set(k, c) }
    return c
  }

  const seen = new Set(); const stack = []
  for (const d of doors || []) {
    const c = d.center
    for (let dz = -5; dz <= 5; dz++) {
      for (let dx = -5; dx <= 5; dx++) {
        const x = Math.floor(c.x) + dx; const z = Math.floor(c.z) + dz
        if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) continue
        for (const y of col(x, z)) {
          if (y < c.y - 2 || y > c.y + 4) continue
          const k = key(x, y, z); if (!seen.has(k)) { seen.add(k); stack.push([x, y, z]) }
        }
      }
    }
  }
  if (!stack.length) return null

  const out = []
  while (stack.length) {
    const [cx, cy, cz] = stack.pop()
    out.push({ x: cx, y: cy, z: cz })
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx; const nz = cz + dz
      for (const ny of col(nx, nz)) {
        if (ny > cy + 1 || ny < cy - 3) continue // one up (a jump), three down (a drop)
        if (ny > cy && v.get(cx, cy + 2, cz) !== FREE) continue // no headroom to step up
        const k = key(nx, ny, nz); if (seen.has(k)) continue
        seen.add(k); stack.push([nx, ny, nz])
      }
    }
  }
  const order = (a, b) => a.x - b.x || a.z - b.z || a.y - b.y
  const spots = out.sort(order)

  const doorC = (doors || []).map(d => d.center)
  const roomyAt = s => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) if (v.get(s.x + dx, s.y + dy, s.z + dz) === SOLID) return false
    return !doorC.some(c => Math.hypot(c.x - s.x, c.z - s.z) <= 2.5)
  }
  const roomy = spots.filter(roomyAt)
  return {
    spots,
    roomy,
    size: spots.length,
    has: (x, y, z) => seen.has(key(x, y, z)),
    column: (x, z) => col(x, z).filter(y => seen.has(key(x, y, z)))
  }
}

/** FNV-1a: a stable number for a string (so a relocated mob always picks the same spot, whatever the order of the calls). */
function hash (s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

/**
 * Put the entries of a plan on good spots.
 *   - an entry that is already on one stays where it is (planned heights are respected: a spot must exist at that height);
 *   - an entry with a height that is not on one (hand-placed spawn, wrong by a block or two) moves to the nearest spot;
 *   - an entry without a height (generic planner) stands on the spot of its column that is closest to `floorY`, and when its
 *     column has none it is moved to a spot picked from the roomy ones by a hash of its id, at least `minSeparation` blocks from
 *     the mobs already placed (when the room has room for that).
 * @returns Map mobId -> { x, y, z, moved }   (feet position; x / z are block centres for a moved entry)
 */
function placeEntries (entries, scan, { floorY = 67, minSeparation = 1.5, roomId = '' } = {}) {
  const result = new Map()
  if (!scan || !scan.spots.length) return result
  const taken = []
  const far = (x, z) => taken.every(t => Math.hypot(t.x - x, t.z - z) >= minSeparation)
  const preferred = scan.roomy.length >= Math.min(entries.length, 4) ? scan.roomy : scan.spots

  for (const e of entries) {
    const px = e.position.x; const pz = e.position.z
    const bx = Math.floor(px); const bz = Math.floor(pz)
    let at = null

    if (e.position.y !== undefined) {
      const by = Math.floor(e.position.y + 1e-6)
      if (scan.has(bx, by, bz)) at = { x: px, y: e.position.y, z: pz, moved: false }
      else {
        let best = null; let bd = Infinity
        for (const s of scan.spots) {
          const d = (s.x + 0.5 - px) ** 2 + (s.z + 0.5 - pz) ** 2 + (s.y - by) ** 2 * 4
          if (d < bd) { bd = d; best = s }
        }
        at = { x: best.x + 0.5, y: best.y, z: best.z + 0.5, moved: true }
      }
    } else {
      const ys = scan.column(bx, bz)
      if (ys.length) {
        const y = ys.reduce((a, b) => Math.abs(b - floorY) < Math.abs(a - floorY) ? b : a)
        at = { x: px, y, z: pz, moved: false }
      } else {
        const start = hash(`${roomId}:${e.mobId}`) % preferred.length
        let pick = preferred[start]
        for (let i = 0; i < preferred.length; i++) {
          const s = preferred[(start + i * 7919) % preferred.length] // a prime stride visits every spot once when the count is not a multiple of it
          if (far(s.x + 0.5, s.z + 0.5)) { pick = s; break }
        }
        at = { x: pick.x + 0.5, y: pick.y, z: pick.z + 0.5, moved: true }
      }
    }
    taken.push(at)
    result.set(e.mobId, at)
  }
  return result
}

module.exports = { FREE, SOLID, LIQUID, Volume, classifier, standable, roomMask, cellBox, scanRoom, placeEntries, hash }
