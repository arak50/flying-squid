'use strict'
/**
 * Draws a generated Catacombs layout (catacombs-generator.exportLayout) onto a 128x128 map-colour buffer.
 * Every constant below was measured from the Hypixel capture (sclogs, map id 1024, scale 2):
 *   room 18x18 px, gap 4 px (pitch 22), the grid is centred on the map, doors are 7 px wide and centred in the gap,
 *   unexplored neighbours are a single grey room with a black "?", ticks are 9x9 glyphs at room offset (5,5).
 */
const MAP = 128
const ROOM = 18
const GAP = 4
const PITCH = ROOM + GAP
const DOOR_W = 7
const DOOR_OFF = 6 // door strip starts 6 px into the room (room centre is 8.5)
const GLYPH_OFF = 5

// map colour bytes (base*4+shade), exactly as the capture sends them
const C = { NONE: 0, UNKNOWN: 85, ENTRANCE: 30, NORMAL: 63, BLOOD: 18, FAIRY: 82, PUZZLE: 66, TRAP: 62, YELLOW: 74, BLACK: 119, WHITE: 34, GREEN: 30 }
const TYPE_COLOR = { Normal: C.NORMAL, Entrance: C.ENTRANCE, Blood: C.BLOOD, Fairy: C.FAIRY, Puzzle: C.PUZZLE, Trap: C.TRAP, Boss: C.YELLOW }

// '#' = glyph pixel. Copied from the capture.
const QUESTION = ['.###.', '#...#', '....#', '...#.', '..#..', '..#..', '.....', '..#..', '..#..'] // 5x9, at room offset (6,6)
const TICK = ['.......##', '......###', '.....###.', '....###..', '##.###...', '#####....', '####.....', '.###.....', '.##......'] // 9x9

/** State of a room on the map. Higher = later. */
const State = { HIDDEN: 0, ADJACENT: 1, ENTERED: 2, CLEARED: 3, COMPLETED: 4 }

class Canvas {
  constructor () { this.px = new Uint8Array(MAP * MAP) }
  set (x, y, c) { if (x >= 0 && y >= 0 && x < MAP && y < MAP) this.px[y * MAP + x] = c }
  rect (x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c) }
  glyph (x, y, rows, c) { rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] === '#') this.set(x + i, y + j, c) }) }
}

/** Pre-computes cell positions/neighbours so render() (called on every change) stays cheap. */
class MapGeometry {
  constructor (layout, opts = {}) {
    this.layout = layout
    this.pitchBlocks = layout.cellPitch || 32
    this.roomBlocks = layout.roomSize || 31
    this.origin = opts.origin || { x: 0, z: 0 } // world block of grid cell (0,0)
    const W = layout.gridWidth; const H = layout.gridHeight
    this.ox = Math.floor((MAP - (W * PITCH - GAP)) / 2)
    this.oy = Math.floor((MAP - (H * PITCH - GAP)) / 2)
    this.rooms = new Map(layout.rooms.map(r => [r.id, r]))
    this.cellRoom = new Map() // "x,z" -> room id
    for (const r of layout.rooms) for (const c of r.cells) this.cellRoom.set(c.x + ',' + c.z, r.id)
    // doors: work out which two grid cells each door joins (from the door centre the generator exports)
    const P = this.pitchBlocks
    this.doors = layout.doors.map(d => {
      const ew = d.axis === 'east-west'
      const row = Math.floor(d.center.z / P); const col = Math.floor(d.center.x / P)
      const a = ew ? { x: Math.floor((d.center.x + 1) / P) - 1, z: row } : { x: col, z: Math.floor((d.center.z + 1) / P) - 1 }
      const b = ew ? { x: a.x + 1, z: row } : { x: col, z: a.z + 1 }
      return { ...d, ew, a, b, roomA: this.cellRoom.get(a.x + ',' + a.z), roomB: this.cellRoom.get(b.x + ',' + b.z) }
    })
    this.adjacent = new Map() // room id -> [{ door, other, cellOnOther }]
    for (const d of this.doors) {
      if (d.roomA === undefined || d.roomB === undefined || d.roomA === d.roomB) continue
      push(this.adjacent, d.roomA, { door: d, other: d.roomB, cell: d.b })
      push(this.adjacent, d.roomB, { door: d, other: d.roomA, cell: d.a })
    }
  }

  cellPx (c) { return { x: this.ox + c.x * PITCH, y: this.oy + c.z * PITCH } }

  /** world x/z -> map pixel (fractional), piecewise: 31 block room -> 18 px, 1 block gap -> 4 px */
  worldToPx (wx, wz) {
    const f = (v, o, base) => {
      const u = v - o; const cell = Math.floor(u / this.pitchBlocks); const b = u - cell * this.pitchBlocks
      const inCell = b < this.roomBlocks ? b * ROOM / this.roomBlocks : ROOM + (b - this.roomBlocks) * GAP / (this.pitchBlocks - this.roomBlocks)
      return base + cell * PITCH + inCell
    }
    return { x: f(wx, this.origin.x, this.ox), y: f(wz, this.origin.z, this.oy) }
  }

  /** world position -> map decoration coordinates (-128..127, half pixels) or null when off the grid */
  worldToIcon (wx, wz) {
    const p = this.worldToPx(wx, wz)
    if (p.x < 0 || p.y < 0 || p.x >= MAP || p.y >= MAP) return null
    const q = v => Math.max(-128, Math.min(127, Math.round((v - MAP / 2) * 2)))
    return { x: q(p.x), y: q(p.y) }
  }

  /** world position -> room id (or undefined in a gap / outside) */
  roomAt (wx, wz) {
    const cx = Math.floor((wx - this.origin.x) / this.pitchBlocks); const cz = Math.floor((wz - this.origin.z) / this.pitchBlocks)
    return this.cellRoom.get(cx + ',' + cz)
  }
}
const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v) }

/**
 * @param geo    MapGeometry
 * @param rooms  Map<roomId, { state:number, enteredAt:number }>   (missing = hidden)
 * @returns Uint8Array(128*128)
 */
function render (geo, rooms) {
  const cv = new Canvas()
  const st = id => (rooms.get(id) || {}).state || State.HIDDEN
  const visited = id => st(id) >= State.ENTERED
  const colorOf = id => TYPE_COLOR[geo.rooms.get(id).type] ?? C.NORMAL

  // 1. rooms the player has been in: full shape in the room's colour
  for (const r of geo.layout.rooms) {
    if (!visited(r.id)) continue
    const col = colorOf(r.id)
    const has = (x, z) => geo.cellRoom.get(x + ',' + z) === r.id
    for (const c of r.cells) {
      const p = geo.cellPx(c)
      cv.rect(p.x, p.y, ROOM, ROOM, col)
      if (has(c.x + 1, c.z)) cv.rect(p.x + ROOM, p.y, GAP, ROOM, col)
      if (has(c.x, c.z + 1)) cv.rect(p.x, p.y + ROOM, ROOM, GAP, col)
      if (has(c.x + 1, c.z) && has(c.x, c.z + 1) && has(c.x + 1, c.z + 1)) cv.rect(p.x + ROOM, p.y + ROOM, GAP, GAP, col)
    }
  }
  // 2. unexplored rooms next to a visited one: ONE grey cell (the one behind the door) with a "?"
  const shown = new Map() // room id -> cell drawn
  for (const [id, links] of geo.adjacent) {
    if (!visited(id)) continue
    for (const l of links) {
      if (visited(l.other) || shown.has(l.other)) continue
      shown.set(l.other, l.cell)
      const p = geo.cellPx(l.cell)
      cv.rect(p.x, p.y, ROOM, ROOM, C.UNKNOWN)
      cv.glyph(p.x + 6, p.y + 6, QUESTION, C.BLACK)
    }
  }
  // 3. doors: grey stub towards unexplored rooms (black = wither, red = blood), room colour once both sides are known
  for (const d of geo.doors) {
    if (d.roomA === undefined || d.roomB === undefined || d.roomA === d.roomB) continue
    const va = visited(d.roomA); const vb = visited(d.roomB)
    if (!va && !vb) continue
    if ((!va && !shown.has(d.roomA)) || (!vb && !shown.has(d.roomB))) continue
    let col
    if (va && vb) {
      const ta = (rooms.get(d.roomA) || {}).enteredAt || 0; const tb = (rooms.get(d.roomB) || {}).enteredAt || 0
      col = colorOf(ta > tb ? d.roomA : d.roomB) // the room you walked into through this door
    } else col = d.kind === 'wither' ? C.BLACK : d.kind === 'blood' ? C.BLOOD : C.UNKNOWN
    const pa = geo.cellPx(d.a)
    if (d.ew) cv.rect(pa.x + ROOM, pa.y + DOOR_OFF, GAP, DOOR_W, col)
    else cv.rect(pa.x + DOOR_OFF, pa.y + ROOM, DOOR_W, GAP, col)
  }
  // 4. ticks (top-left cell of the room): white = every mob dead, green = room complete. The entrance is green already.
  for (const r of geo.layout.rooms) {
    const s = st(r.id)
    if (s < State.CLEARED || r.type === 'Entrance') continue
    const c = r.cells.slice().sort((p, q) => p.z - q.z || p.x - q.x)[0]
    const p = geo.cellPx(c)
    cv.glyph(p.x + GLYPH_OFF, p.y + GLYPH_OFF, TICK, s === State.COMPLETED ? C.GREEN : C.WHITE)
  }
  return cv.px
}

module.exports = { render, MapGeometry, State, C, MAP, ROOM, GAP, PITCH, QUESTION, TICK }
