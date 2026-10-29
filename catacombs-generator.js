'use strict'
/**
 * Catacombs dungeon world generator for flying-squid.
 *
 *   generation: { name: '/abs/path/catacombs-generator.js',
 *                 options: { dungeonSeed: 44900679, floor: 3 } }
 *
 * Layout logic is a faithful port of Catacombs_Dungeon_Generator.html (same seed + floor => same layout).
 * Rooms are stamped from the .schem files (Sponge v2/v3) and rotated so their built-in doorways face the
 * neighbours the layout algorithm connected them to. Doors the template does not already have are added:
 * a tunnel is carved from the door inward until it breaks into the room, then the door schematic is stamped.
 *
 * Door schematics:  blood_door -> doors touching the Blood room
 *                   door_var5  -> doors touching the Entrance room
 *                   door_var1  -> wither doors (critical path, coal-block plug)
 *                   var2/3/4   -> every other (branch) door, picked per door from the seed
 *
 * Door slots: every room's .json may carry `doorSlots` (made by dungeon-doorway-sync from the blue/lime/red door map painted
 * on top of the room): per outer edge of each cell whether a doorway may be generated there (lime = 'allowed', red = 'forbidden',
 * 'unmarked'). The generator only uses 'allowed' edges: it prefers templates and rotations whose allowed edges cover the doors
 * the layout needs, and where two rooms touch along several cell pairs it moves a door that sits on a blocked edge to the pair
 * with the fewest blocked ends (ideally allowed on both sides). Without `doorSlots` in a room's .json that room behaves as before. options.doorSlots = false switches
 * all of this off (the exact previous behaviour: same seed => same door cells as the HTML).
 *
 * World coordinates: grid cell (gx,gz) covers blocks [gx*32 .. gx*32+30] on x/z; the 1-block gap between cells
 * is where doors sit. Door base is y=66 (same as the real dungeon). Needs a flattened version (1.13+).
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')

// ====================================================================================================
// 1. Layout generator (port of the HTML)
// ====================================================================================================
const T = { NORMAL: 1, ENTRANCE: 2, BLOOD: 3, FAIRY: 4, PUZZLE: 5, TRAP: 6, YELLOW: 7 }
const NAME = { 1: 'Normal', 2: 'Entrance', 3: 'Blood', 4: 'Fairy', 5: 'Puzzle', 6: 'Trap', 7: 'Boss' }
const FLOORS = [
  { min: [4, 4], max: [4, 4] }, { min: [4, 4], max: [5, 5] }, { min: [5, 4], max: [6, 5] }, { min: [5, 5], max: [6, 6] },
  { min: [5, 5], max: [6, 6] }, { min: [5, 5], max: [6, 6] }, { min: [5, 6], max: [6, 6] }, { min: [6, 6], max: [6, 6] }]

function mulberry32 (a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const shuffle = (a, r) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[a[i], a[j]] = [a[j], a[i]] } return a }
const norm = c => { const my = Math.min(...c.map(p => p[0])), mx = Math.min(...c.map(p => p[1])); return c.map(([y, x]) => [y - my, x - mx]) }
const rots = c => { const o = []; let cur = c; for (let i = 0; i < 4; i++) { cur = norm(cur.map(([y, x]) => [x, -y])); o.push(cur) } return o }
const SHAPES = [{ w: 0.42, c: [[0, 0]] }, { w: 0.2, c: [[0, 0], [0, 1]] }, { w: 0.09, c: [[0, 0], [0, 1], [0, 2]] },
  { w: 0.04, c: [[0, 0], [0, 1], [0, 2], [0, 3]] }, { w: 0.07, c: [[0, 0], [0, 1], [1, 0], [1, 1]] }, { w: 0.18, c: [[0, 0], [1, 0], [1, 1]] }]
const pickShape = r => { let x = r() * SHAPES.reduce((s, a) => s + a.w, 0); for (const s of SHAPES) if ((x -= s.w) < 0) return s; return SHAPES[0] }

function tryGenerate (r, floor) {
  const cfg = FLOORS[floor]; const [W, H] = cfg.max; const [mw, mh] = cfg.min
  const own = Array.from({ length: H }, () => Array(W).fill(-2))
  const ox = Math.floor(r() * (W - mw + 1)); const oy = Math.floor(r() * (H - mh + 1))
  for (let y = oy; y < oy + mh; y++) for (let x = ox; x < ox + mw; x++) own[y][x] = -1
  const inb = (y, x) => y >= 0 && x >= 0 && y < H && x < W
  const N4 = (y, x) => [[y - 1, x], [y + 1, x], [y, x - 1], [y, x + 1]].filter(([a, b]) => inb(a, b))
  let extra = Math.floor(r() * (W * H - mw * mh + 1) * 0.75)
  while (extra-- > 0) {
    const c = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (own[y][x] === -2 && N4(y, x).some(([a, b]) => own[a][b] !== -2)) c.push([y, x])
    if (!c.length) break; const [y, x] = c[Math.floor(r() * c.length)]; own[y][x] = -1
  }
  const rooms = []
  const free = (y, x) => inb(y, x) && own[y][x] === -1
  const add = (type, cells) => { const id = rooms.length; rooms.push({ id, type, cells, deg: 0 }); cells.forEach(([y, x]) => { own[y][x] = id }); return id }
  const act = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (own[y][x] !== -2) act.push([y, x])
  const edge = act.filter(([y, x]) => N4(y, x).filter(([a, b]) => own[a][b] !== -2).length < 4)
  const [ey, ex] = edge[Math.floor(r() * edge.length)]; const ent = add(T.ENTRANCE, [[ey, ex]])
  const dmin = Math.floor((mw + mh) / 2) - 1
  const far = edge.filter(([y, x]) => free(y, x) && Math.abs(y - ey) + Math.abs(x - ex) >= dmin)
  if (!far.length) return null
  const [by, bx] = far[Math.floor(r() * far.length)]; const blood = add(T.BLOOD, [[by, bx]])
  for (const [y, x] of shuffle(act.slice(), r)) {
    if (!free(y, x)) continue; let done = false
    for (let t = 0; t < 6 && !done; t++) {
      for (const cells of shuffle(rots(pickShape(r).c), r)) {
        for (const [oy2, ox2] of shuffle(cells.slice(), r)) {
          const cs = cells.map(([a, b]) => [y - oy2 + a, x - ox2 + b])
          if (cs.every(([a, b]) => free(a, b))) { add(T.NORMAL, cs); done = true; break }
        } if (done) break
      }
    }
    if (!done) add(T.NORMAL, [[y, x]])
  }
  const pairs = new Map(); const adj = rooms.map(() => new Set())
  for (const [y, x] of act) {
    for (const [y2, x2] of [[y + 1, x], [y, x + 1]]) {
      if (!inb(y2, x2) || own[y2][x2] < 0 || own[y][x] === own[y2][x2]) continue
      const a = own[y][x]; const b = own[y2][x2]; const k = Math.min(a, b) + '-' + Math.max(a, b)
      if (!pairs.has(k)) pairs.set(k, []); pairs.get(k).push([[y, x], [y2, x2]]); adj[a].add(b); adj[b].add(a)
    }
  }
  const minLen = 4 + (mw * mh >= 20 ? 1 : 0) + (mw * mh >= 30 ? 1 : 0); const path = [ent]; const seen = new Set([ent]); let steps = 0
  const dfs = u => {
    if (++steps > 4000) return false
    if (u === blood) return path.length >= minLen
    for (const v of shuffle([...adj[u]], r)) {
      if (seen.has(v) || (v !== blood && rooms[v].type !== T.NORMAL)) continue
      seen.add(v); path.push(v); if (dfs(v)) return true; path.pop(); seen.delete(v)
    } return false
  }
  if (!dfs(ent)) return null
  const mid = (path.length - 1) / 2
  const fc = path.slice(1, -1).filter(id => rooms[id].cells.length === 1).sort((a, b) => Math.abs(path.indexOf(a) - mid) - Math.abs(path.indexOf(b) - mid))
  if (!fc.length) return null; rooms[fc[0]].type = T.FAIRY
  const doors = []
  const link = (a, b, wither) => {
    const s = pairs.get(Math.min(a, b) + '-' + Math.max(a, b)); const [f, t] = s[Math.floor(r() * s.length)]
    doors.push({ a, b, from: f, to: t, wither, alts: s }); rooms[a].deg++; rooms[b].deg++ // alts: every [from,to] cell pair along the shared border
  }
  path.forEach((id, i) => { if (i) link(path[i - 1], id, true) })
  const conn = new Set(path)
  while (conn.size < rooms.length) {
    const cand = []; for (const c of conn) { if (c === ent || c === blood) continue; for (const v of adj[c]) if (!conn.has(v)) cand.push([c, v]) }
    if (!cand.length) return null
    const [c, v] = cand[Math.floor(r() * cand.length)]; link(c, v, false); conn.add(v)
  }
  const leaves = shuffle(rooms.filter(q => q.type === T.NORMAL && q.deg === 1 && q.cells.length === 1), r)
  const need = 1 + (floor >= 3 ? 1 : 0) + 2; if (leaves.length < need) return null
  let i = 0; leaves[i++].type = T.YELLOW; if (floor >= 3) leaves[i++].type = T.TRAP
  for (let p = 0; i < leaves.length; i++, p++) { if (p >= 2 && r() < 0.05) continue; leaves[i].type = T.PUZZLE }
  const ys = act.map(c => c[0]); const xs = act.map(c => c[1]); const y0 = Math.min(...ys); const x0 = Math.min(...xs)
  const h = Math.max(...ys) - y0 + 1; const w = Math.max(...xs) - x0 + 1
  const sh = ([y, x]) => [y - y0, x - x0]
  rooms.forEach(q => { q.cells = q.cells.map(sh) }); doors.forEach(d => { d.from = sh(d.from); d.to = sh(d.to); d.alts = d.alts.map(([f, t]) => [sh(f), sh(t)]) })
  return { floor, width: w, height: h, rooms, doors, critical: path }
}
function generateLayout (floor, seed) {
  const r = mulberry32(seed)
  for (let i = 0; i < 3000; i++) { const d = tryGenerate(r, floor); if (d) { d.seed = seed; return d } }
  throw new Error('layout generation failed')
}
function seedToInt (s) { // numeric strings behave exactly like the HTML; anything else is hashed
  if (typeof s === 'number') return s | 0
  if (/^-?\d+$/.test(String(s).trim())) return parseInt(s, 10) | 0
  let h = 1779033703 ^ String(s).length
  for (let i = 0; i < String(s).length; i++) { h = Math.imul(h ^ String(s).charCodeAt(i), 3432918353); h = h << 13 | h >>> 19 }
  return (h ^ h >>> 16) | 0
}

// ====================================================================================================
// 2. Geometry helpers (grid frame: cell = [x,z]; sides N(-z) E(+x) S(+z) W(-x); rotation = clockwise 90deg steps)
// ====================================================================================================
const P = 32; const S = 31; const MID = 15 // cell pitch, room size, door centre inside a cell
const DOOR_Y0 = 66 // door schematic y=0 sits here; opening is y 69..72, sill y=68
const DIRS = ['north', 'east', 'south', 'west']
const rotDir = (d, k) => DIRS[(DIRS.indexOf(d) + k) % 4]
const rotCell = ([x, z], nw, nh) => [nh - 1 - z, x] // clockwise, grid is nw x nh -> nh x nw
function rotCells (cells, k) {
  let c = cells.map(a => a.slice()); let nw = Math.max(...c.map(a => a[0])) + 1; let nh = Math.max(...c.map(a => a[1])) + 1
  for (let i = 0; i < k; i++) { c = c.map(a => rotCell(a, nw, nh)); [nw, nh] = [nh, nw] }
  const mx = Math.min(...c.map(a => a[0])); const mz = Math.min(...c.map(a => a[1]))
  return c.map(([x, z]) => [x - mx, z - mz])
}
const cellsKey = c => c.map(a => a.join(',')).sort().join(';')
const edgeKey = (x, z, side) => x + ',' + z + ',' + side

// ====================================================================================================
// 3. Block-state handling (name[props] -> state id of the running registry, with rotation)
// ====================================================================================================
function parseState (s) {
  const i = s.indexOf('['); if (i < 0) return { name: s.replace('minecraft:', ''), props: {} }
  const props = {}; for (const kv of s.slice(i + 1, -1).split(',')) { const [k, v] = kv.split('='); props[k] = v }
  return { name: s.slice(0, i).replace('minecraft:', ''), props }
}
function rotateProps (name, props, k) {
  if (!k) return props
  const p = { ...props }
  if (p.facing && DIRS.includes(p.facing)) p.facing = rotDir(p.facing, k)
  if (p.axis && k % 2) p.axis = p.axis === 'x' ? 'z' : p.axis === 'z' ? 'x' : p.axis
  if (p.rotation !== undefined) p.rotation = String((parseInt(p.rotation, 10) + 4 * k) % 16)
  for (const d of DIRS) { if (d in props) { p[rotDir(d, k)] = props[d] } } // north/east/south/west connections (walls, panes, fences, vines...)
  for (const d of DIRS) { if (!(rotDir(d, -k + 4) in props) && d in p && !(d in props)) delete p[d] }
  if (p.orientation) { const [a, ...rest] = p.orientation.split('_'); if (DIRS.includes(a)) p.orientation = [rotDir(a, k), ...rest].join('_') }
  if (name.endsWith('rail') && p.shape) {
    const parts = p.shape.split('_')
    if (parts[0] === 'ascending') p.shape = 'ascending_' + rotDir(parts[1], k)
    else {
      const m = parts.map(d => rotDir(d, k)).sort((a, b) => (DIRS.indexOf(a) % 2) - (DIRS.indexOf(b) % 2) || DIRS.indexOf(a) - DIRS.indexOf(b))
      p.shape = m[0] === 'east' && m[1] === 'west' ? 'east_west' : m.join('_')
    }
  }
  return p
}
class BlockTable {
  constructor (registry, opts) {
    this.registry = registry; this.cache = new Map(); this.missing = new Map(); this.opts = opts
    this.skull = new Set(['player_head', 'player_wall_head', 'skeleton_skull', 'skeleton_wall_skull', 'wither_skeleton_skull', 'wither_skeleton_wall_skull', 'zombie_head', 'zombie_wall_head', 'creeper_head', 'creeper_wall_head', 'dragon_head', 'dragon_wall_head', 'piglin_head', 'piglin_wall_head'])
  }

  stateId (str, rot) {
    const key = str + '#' + rot; let v = this.cache.get(key); if (v !== undefined) return v
    const { name, props } = parseState(str); v = 0
    if (name === 'air' || name === 'cave_air' || name === 'void_air' || (!this.opts.skullBlocks && this.skull.has(name))) v = 0
    else {
      const b = this.registry.blocksByName[name]
      if (!b) { this.missing.set(name, (this.missing.get(name) || 0) + 1); v = 0 } else v = this._resolve(b, rotateProps(name, props, rot))
    }
    this.cache.set(key, v); return v
  }

  _resolve (b, props) {
    if (!b.states || !b.states.length) return b.minStateId
    const def = (b.defaultState ?? b.minStateId) - b.minStateId
    let off = 0; let stride = 1; let rem = def
    const strides = []
    for (let i = b.states.length - 1; i >= 0; i--) { const n = b.states[i].num_values; strides[i] = { stride, n, defIdx: rem % n }; rem = Math.floor(rem / n); stride *= n }
    for (let i = 0; i < b.states.length; i++) {
      const st = b.states[i]; const want = props[st.name]; let idx = strides[i].defIdx
      if (want !== undefined) {
        const j = st.type === 'bool' ? (want === 'true' ? 0 : 1) : st.values.indexOf(String(want))
        if (j >= 0) idx = j
      }
      off += idx * strides[i].stride
    }
    return b.minStateId + off
  }
}

// ====================================================================================================
// 4. Schematic loading (Sponge v2 / v3) + rotation
// ====================================================================================================
function readSchem (file) {
  const raw = fs.readFileSync(file)
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw
  let root = nbt.simplify(nbt.parseUncompressed(buf, 'big'))
  if (root.Schematic) root = root.Schematic
  const blocks = root.Blocks || root
  const palette = blocks.Palette; const bytes = blocks.BlockData || blocks.Data
  const W = root.Width; const H = root.Height; const L = root.Length
  const names = []; for (const [k, v] of Object.entries(palette)) names[v] = k
  const data = new Uint16Array(W * H * L); let i = 0; let n = 0
  while (i < bytes.length) { let v = 0; let s = 0; for (;;) { const b = bytes[i++] & 0xff; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break } data[n++] = v }
  const rawBE = root.BlockEntities || blocks.BlockEntities || []
  const blockEntities = rawBE.filter(b => b.Pos && /skull|head/i.test(String(b.Id))).map(b => ({ pos: [b.Pos[0], b.Pos[1], b.Pos[2]], profile: b.profile || null }))
  return { W, H, L, names, data, blockEntities } // data index = (y*L + z)*W + x
}
function rotateSchem (sc, k) {
  if (!k) return sc
  let { W, H, L, data } = sc
  for (let r = 0; r < k; r++) {
    const out = new Uint16Array(data.length)
    for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) { out[(y * W + x) * L + (L - 1 - z)] = data[(y * L + z) * W + x] } // (x,z)->(L-1-z, x); new dims W'=L, L'=W
    data = out;[W, L] = [L, W]
  }
  return { W, H, L, names: sc.names, data, rot: k, blockEntities: sc.blockEntities }
}

// ====================================================================================================
// 5. Template library
// ====================================================================================================
const DOOR_FILES = { blood: 'blood_door', entrance: 'door_var5', wither: 'door_var1', normal: ['door_var2', 'door_var3_(wooden)', 'door_var4'] }
function loadTemplates (dir) {
  const lib = { byShape: {}, puzzle: [], special: {}, doors: {} }
  const load = (cat, file) => {
    const base = path.join(dir, cat, file.replace(/\.schem$/, ''))
    if (!fs.existsSync(base + '.schem')) return null
    const sc = readSchem(base + '.schem'); const meta = fs.existsSync(base + '.json') ? JSON.parse(fs.readFileSync(base + '.json', 'utf8')) : { cells: [{ i: 0, j: 0 }], doorways: [], floorYWorld: DOOR_Y0 }
    // JSON cells are in the room's *world* position in the source dungeon; the .schem is normalised, so derive canonical cells
    // from its size: 1xN runs along +x, L-shapes miss their NE cell (see HTML)
    const nw = Math.round((sc.W + 1) / P); const nh = Math.round((sc.L + 1) / P); const cells = []
    for (let z = 0; z < nh; z++) for (let x = 0; x < nw; x++) cells.push([x, z])
    if (nw === 2 && nh === 2 && /^L/i.test(String(meta.shape || cat))) cells.splice(cells.findIndex(c => c[0] === 1 && c[1] === 0), 1)
    const doorways = []; const seenD = new Set()
    for (const d of meta.doorways || []) {
      if (d.along[1] - d.along[0] < 3) continue // stray 1-block detections
      const k = Math.max(0, Math.round(((d.along[0] + d.along[1]) / 2 - MID) / P)); const side = d.side
      let cell
      if (side === 'north') cell = cells.filter(c => c[0] === k).sort((a, b) => a[1] - b[1])[0]
      else if (side === 'south') cell = cells.filter(c => c[0] === k).sort((a, b) => b[1] - a[1])[0]
      else if (side === 'west') cell = cells.filter(c => c[1] === k).sort((a, b) => a[0] - b[0])[0]
      else cell = cells.filter(c => c[1] === k).sort((a, b) => b[0] - a[0])[0]
      if (!cell) continue
      const key = edgeKey(cell[0], cell[1], side); if (seenD.has(key)) continue; seenD.add(key)
      doorways.push({ x: cell[0], z: cell[1], side, material: d.material })
    }
    // door map (see header): cell i/j are in the schematic's own frame, like `cells`; null = this room has no door map
    let slots = null
    if (meta.doorSlots && Array.isArray(meta.doorSlots.slots)) {
      const have = new Set(cells.map(c => c.join(',')))
      slots = meta.doorSlots.slots.filter(sl => sl.cell && have.has(sl.cell.i + ',' + sl.cell.j) && DIRS.includes(sl.side))
        .map(sl => ({ x: sl.cell.i, z: sl.cell.j, side: sl.side, state: sl.state }))
      if (!slots.length) slots = null
    }
    return { name: meta.category === 'unidentified' || !meta.name ? file.replace(/\.schem$/, '') : meta.name, file, sc, cells, doorways, slots, y0: meta.floorYWorld ?? DOOR_Y0, rots: {} }
  }
  for (const cat of fs.readdirSync(dir)) {
    const cd = path.join(dir, cat); if (!fs.statSync(cd).isDirectory() || cat === 'Doors') continue
    for (const f of fs.readdirSync(cd).filter(f => f.endsWith('.schem'))) {
      const t = load(cat, f); if (!t) continue
      if (cat === 'Special') lib.special[f.replace('.schem', '').toLowerCase()] = t
      else if (cat === 'Puzzle') lib.puzzle.push(t)
      else (lib.byShape[cat] = lib.byShape[cat] || []).push(t)
    }
  }
  for (const [k, v] of Object.entries(DOOR_FILES)) {
    for (const f of [].concat(v)) {
      const p = path.join(dir, 'Doors', f + '.schem'); if (!fs.existsSync(p)) throw new Error('missing door schematic ' + p)
      ;(lib.doors[k] = lib.doors[k] || []).push({ name: f, sc: readSchem(p) })
    }
  }
  return lib
}
const shapeKind = cells => {
  const n = cells.length; if (n === 1) return '1x1'
  const bw = Math.max(...cells.map(c => c[0])) - Math.min(...cells.map(c => c[0])) + 1
  const bh = Math.max(...cells.map(c => c[1])) - Math.min(...cells.map(c => c[1])) + 1
  return bw === 1 || bh === 1 ? '1x' + n : n === 4 ? '2x2' : 'L-shape'
}

// ====================================================================================================
// 5b. Skull block entities
// ====================================================================================================
/**
 * Protocol id of the 'skull' block entity type (the `type` field of the chunk packet's blockEntities).
 * Ids follow vanilla registration order, so they change between versions and are NOT in minecraft-data.
 * 16 holds for 1.21.2 - 26.1.x (creaking_heart was inserted before skull in 1.21.2; later additions come after it).
 * Returns null for versions this has not been established for: pass options.skullBlockEntityId there.
 */
function skullTypeId (registry) {
  const v = registry.version
  return v['>=']('1.21.2') ? 16 : null
}
function skullNbt (profile) {
  if (!profile) return nbt.comp({})
  const p = {}
  if (profile.name !== undefined) p.name = nbt.string(String(profile.name))
  if (Array.isArray(profile.id) && profile.id.length === 4) p.id = nbt.intArray(profile.id.map(n => n | 0))
  if (Array.isArray(profile.properties) && profile.properties.length) {
    p.properties = nbt.list(nbt.comp(profile.properties.map(pr => {
      const o = { name: nbt.string(String(pr.name)), value: nbt.string(String(pr.value)) }
      if (pr.signature) o.signature = nbt.string(String(pr.signature))
      return o
    })))
  }
  return nbt.comp({ profile: nbt.comp(p) })
}

// ====================================================================================================
// 6. Dungeon builder
// ====================================================================================================
function buildDungeon (registry, opts) {
  const floor = Math.max(0, Math.min(7, parseInt(opts.floor, 10) || 0))
  const seed = seedToInt(opts.dungeonSeed ?? opts.seed ?? 0)
  const log = opts.log || (() => {})
  const lib = opts.library || loadTemplates(opts.schematicsDir || path.join(__dirname, 'dungeon-room-schematics'))
  const skullType = opts.skullBlockEntityId ?? skullTypeId(registry)
  const heads = opts.heads !== false && skullType !== null // heads need the block entity packet field; without a known id they stay off
  const bt = new BlockTable(registry, { ...opts, skullBlocks: heads })
  const layout = generateLayout(floor, seed)
  const rng = mulberry32((seed ^ 0x9e3779b9) + floor * 7919) // separate stream: template choice never disturbs the layout
  const useSlots = opts.doorSlots !== false

  // ---- 6a. door edges per room (grid frame) --------------------------------------------------------
  // (only needs the layout, so it runs before the templates are chosen: the doors a room needs decide which templates fit)
  const sideOf = (a, b) => a[0] === b[0] ? (b[1] > a[1] ? 'east' : 'west') : (b[0] > a[0] ? 'south' : 'north') // cells are [z,x]
  const owns = (q, c) => q.cells.some(k => k[0] === c[0] && k[1] === c[1])
  layout.doors.forEach((d, i) => {
    d.id = i
    d.kind = (layout.rooms[d.a].type === T.BLOOD || layout.rooms[d.b].type === T.BLOOD) ? 'blood'
      : (layout.rooms[d.a].type === T.ENTRANCE || layout.rooms[d.b].type === T.ENTRANCE) ? 'entrance' : d.wither ? 'wither' : 'normal'
  })
  const assignNeed = () => {
    for (const q of layout.rooms) q.need = new Map()
    for (const d of layout.doors) {
      const [fz, fx] = d.from; const [tz, tx] = d.to
      // 'from' is simply the first cell the layout scan met: it may belong to either room
      d.rf = owns(layout.rooms[d.a], d.from) ? layout.rooms[d.a] : layout.rooms[d.b]
      d.rt = d.rf === layout.rooms[d.a] ? layout.rooms[d.b] : layout.rooms[d.a]
      d.rf.need.set(edgeKey(fx, fz, sideOf(d.from, d.to)), d)
      d.rt.need.set(edgeKey(tx, tz, sideOf(d.to, d.from)), d)
    }
  }
  assignNeed()
  for (const q of layout.rooms) { q.gx0 = Math.min(...q.cells.map(c => c[1])); q.gz0 = Math.min(...q.cells.map(c => c[0])) }

  // ---- 6b. the ways a template can sit in a room: rotations that fit its cells, with doorways and door-map slots rotated along
  const fitRotations = (t, q) => {
    const pk = cellsKey(q.cells.map(([z, x]) => [x - q.gx0, z - q.gz0])); const out = []
    for (let k = 0; k < 4; k++) {
      if (cellsKey(rotCells(t.cells, k)) !== pk) continue
      let nw = Math.max(...t.cells.map(c => c[0])) + 1; let nh = Math.max(...t.cells.map(c => c[1])) + 1
      let cs = t.cells.map(a => a.slice()); let dw = t.doorways.map(d => ({ ...d })); let sl = t.slots ? t.slots.map(d => ({ ...d })) : null
      const turn = d => { const [x, z] = rotCell([d.x, d.z], nw, nh); return { ...d, x, z, side: rotDir(d.side, 1) } }
      for (let i = 0; i < k; i++) { cs = cs.map(a => rotCell(a, nw, nh)); dw = dw.map(turn); if (sl) sl = sl.map(turn);[nw, nh] = [nh, nw] }
      const mx = Math.min(...cs.map(a => a[0])); const mz = Math.min(...cs.map(a => a[1]))
      dw.forEach(d => { d.x -= mx; d.z -= mz }); if (sl) sl.forEach(d => { d.x -= mx; d.z -= mz })
      out.push({
        k, dw, have: new Set(dw.map(d => edgeKey(d.x + q.gx0, d.z + q.gz0, d.side))),
        slotState: sl ? new Map(sl.map(d => [edgeKey(d.x + q.gx0, d.z + q.gz0, d.side), d.state])) : null // edge -> 'allowed' | 'forbidden' | 'unmarked'
      })
    }
    return out
  }
  // doors the room needs on an edge its door map does not allow (rooms/rotations without a door map: none)
  const blockedEdges = (r, q) => { if (!useSlots || !r.slotState) return 0; let n = 0; for (const key of q.need.keys()) if (r.slotState.get(key) !== 'allowed') n++; return n }

  // ---- 6c. template per room -----------------------------------------------------------------------
  const pickFrom = (list, used, q) => {
    let pool = list
    if (useSlots && q) { // keep the templates whose allowed edges can take every door this room needs
      pool = list.filter(t => !t.slots || fitRotations(t, q).some(r => blockedEdges(r, q) === 0))
      if (!pool.length && list.length) { pool = list; warnings.push(`room ${q.id}: no ${q.kind} template allows doors at all the edges this room needs`) }
    }
    let c = pool.filter(t => !used.has(t.name)); if (!c.length) c = pool; const t = c[Math.floor(rng() * c.length)]; used.add(t.name); return t
  }
  const used = new Set(); let blaze = false; const warnings = []
  for (const q of layout.rooms) {
    const kind = shapeKind(q.cells.map(([z, x]) => [x, z]))
    q.kind = kind // set first: pickFrom reports it
    let t = null
    if (q.type === T.ENTRANCE) t = lib.special.entrance
    else if (q.type === T.BLOOD) t = lib.special.blood
    else if (q.type === T.FAIRY) t = lib.special.fairy
    else if (q.type === T.YELLOW) t = lib.special.boss_1 || lib.special.boss
    else if (q.type === T.PUZZLE) { const pool = lib.puzzle.filter(x => !(blaze && /Blaze-Room/.test(x.name))); t = pool.length ? pickFrom(pool, used, q) : null; if (t && /Blaze-Room/.test(t.name)) blaze = true } else if (q.type === T.TRAP) {
      t = null; warnings.push('no Trap schematics supplied: trap room(s) use a normal 1x1 template')
      const pool = lib.byShape['1x1'] || []; if (pool.length) t = pickFrom(pool, used, q)
    } else {
      const pool = lib.byShape[kind] || []
      if (!pool.length) warnings.push(`no ${kind} schematic: room ${q.id} left empty`)
      else t = pickFrom(pool, used, q)
    }
    q.template = t
  }

  // ---- 6d. choose rotation: avoid doors on edges the door map forbids, then maximise built-in doorways that coincide with required doors
  for (const q of layout.rooms) {
    const t = q.template; if (!t) continue
    let best = null
    for (const r of fitRotations(t, q)) {
      let matched = 0; for (const key of q.need.keys()) if (r.have.has(key)) matched++
      const unused = r.dw.length - matched
      const score = matched * 1000 - unused * 10 - blockedEdges(r, q) * 100000 + rng()
      if (!best || score > best.score) best = { ...r, score, matched }
    }
    if (!best) { warnings.push(`room ${q.id}: no rotation of ${t.name} fits its cells`); q.template = null; continue }
    q.rot = best.k; q.doorways = best.dw; q.have = best.have; q.matched = best.matched
    q.slotState = best.slotState // also kept when door slots are off, so the stats can show what the map would have said
  }

  // ---- 6e. door map: where two rooms touch along several cell pairs, move a door that sits on an edge the map does not allow
  //          to the pair with the fewest blocked ends (ideally allowed on both sides; then preferring edges with a built-in doorway)
  let rerouted = 0
  if (useSlots) {
    for (const d of layout.doors) {
      if (!d.alts || d.alts.length < 2) continue
      const A = layout.rooms[d.a]; const B = layout.rooms[d.b]
      const cost = ([f, t]) => {
        const rf = owns(A, f) ? A : B; const rt = rf === A ? B : A; let c = 0
        for (const [q, cell, other] of [[rf, f, t], [rt, t, f]]) {
          if (!q.slotState) continue
          const key = edgeKey(cell[1], cell[0], sideOf(cell, other))
          if (q.slotState.get(key) !== 'allowed') c += 1000; else if (!q.have.has(key)) c += 1
        }
        return c
      }
      const cur = [d.from, d.to]; if (cost(cur) < 1000) continue
      let best = cur; let bc = cost(cur)
      for (const alt of d.alts) { const c = cost(alt); if (c < bc) { best = alt; bc = c } }
      if (best !== cur) { d.from = best[0]; d.to = best[1]; d.rerouted = true; rerouted++ }
    }
    if (rerouted) assignNeed()
  }
  for (const q of layout.rooms) { if (q.template) q.addedDoors = [...q.need.keys()].filter(k => !q.have.has(k)).length }
  // doors that still sit on an edge the door map does not allow
  const slotStats = { slotRooms: layout.rooms.filter(q => q.slotState).length, doorsRerouted: rerouted, doorsOnBlockedSlots: 0 }
  for (const q of layout.rooms) {
    q.blockedDoors = 0; if (!q.slotState) continue
    for (const [key, d] of q.need) if (q.slotState.get(key) !== 'allowed') { q.blockedDoors++; slotStats.doorsOnBlockedSlots++; d.onBlockedSlot = true }
  }
  if (useSlots && slotStats.doorsOnBlockedSlots) warnings.push(`${slotStats.doorsOnBlockedSlots} door end(s) sit on an edge the room's door map does not allow (no allowed alternative)`)

  // ---- 6f. world buffer -----------------------------------------------------------------------------
  const gw = layout.width; const gh = layout.height
  const SX = gw * P - 1; const SZ = gh * P - 1
  let yMin = 60; let yMax = 80
  for (const q of layout.rooms) if (q.template) { yMin = Math.min(yMin, q.template.y0); yMax = Math.max(yMax, q.template.y0 + q.template.sc.H) }
  yMin = Math.max(yMin - 2, registry.version && registry.version['<=']('1.17.1') ? 0 : -64); yMax += 2
  const SY = yMax - yMin
  const grid = new Uint16Array(SX * SY * SZ)
  const idx = (x, y, z) => ((y - yMin) * SZ + z) * SX + x
  const inside = (x, y, z) => x >= 0 && z >= 0 && x < SX && z < SZ && y >= yMin && y < yMax
  const set = (x, y, z, v) => { if (inside(x, y, z)) grid[idx(x, y, z)] = v }
  const get = (x, y, z) => inside(x, y, z) ? grid[idx(x, y, z)] : 0
  const beList = [] // skull block entities in world space (checked against the final blocks later)
  const stamp = (sc, rot, ox, oy, oz, skipAir = true) => {
    for (const be of sc.blockEntities || []) {
      let [x, y, z] = be.pos; let w = sc.W; let l = sc.L
      for (let i = 0; i < (rot || 0); i++) { [x, z] = [l - 1 - z, x];[w, l] = [l, w] } // same quarter-turn as the blocks
      beList.push({ x: ox + x, y: oy + y, z: oz + z, profile: be.profile })
    }
    const r = rot ? (sc['_r' + rot] || (sc['_r' + rot] = rotateSchem(sc, rot))) : sc
    const pal = r.names.map(n => bt.stateId(n, rot || 0)); // rotation of properties matches rotation of geometry
    for (let y = 0; y < r.H; y++) for (let z = 0; z < r.L; z++) for (let x = 0; x < r.W; x++) {
      const v = pal[r.data[(y * r.L + z) * r.W + x]]; if (v || !skipAir) set(ox + x, oy + y, oz + z, v)
    }
  }
  const stone = bt.stateId('stone_bricks', 0)
  const sideVec = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
  // world position helpers for an edge (cell gx,gz, side): centre of the door in the gap
  const edgeGeom = (gx, gz, side) => {
    const [dx, dz] = sideVec[side]; const cx = gx * P + MID; const cz = gz * P + MID
    return { dx, dz, ex: cx + dx * (MID + 1), ez: cz + dz * (MID + 1), cx, cz } // ex,ez = gap-line centre
  }
  const openBox = (g, depth0, depth1, y0, y1, v) => { // fill a 3-wide box going inward from the gap (depth 1 = first block inside the cell)
    for (let d = depth0; d <= depth1; d++) for (let w = -1; w <= 1; w++) for (let y = y0; y <= y1; y++) {
      const x = g.ex - g.dx * d + (g.dx === 0 ? w : 0); const z = g.ez - g.dz * d + (g.dz === 0 ? w : 0); set(x, y, z, v)
    }
  }
  const airBox = (g, d) => { for (let w = -1; w <= 1; w++) for (let y = 69; y <= 72; y++) { if (get(g.ex - g.dx * d + (g.dx === 0 ? w : 0), y, g.ez - g.dz * d + (g.dz === 0 ? w : 0)) !== 0) return false } return true }

  const stats = { addedDoors: 0, tunnels: 0, tunnelBlind: 0, sealed: 0, matchedDoors: 0, ...slotStats }
  // rooms
  for (const q of layout.rooms) {
    if (!q.template) continue
    stamp(q.template.sc, q.rot, q.gx0 * P, q.template.y0, q.gz0 * P)
  }
  // seal unused built-in doorways
  for (const q of layout.rooms) {
    if (!q.template) continue
    for (const d of q.doorways) {
      const gx = d.x + q.gx0; const gz = d.z + q.gz0; if (q.need.has(edgeKey(gx, gz, d.side))) continue
      openBox(edgeGeom(gx, gz, d.side), 1, 2, 69, 72, stone); stats.sealed++
    }
  }
  // doors (+ tunnels where the room has no built-in doorway there)
  const doorChoice = (d) => { const arr = lib.doors[d.kind]; return arr.length === 1 ? arr[0] : arr[Math.floor(rng() * arr.length)] }
  for (const d of layout.doors) {
    const door = doorChoice(d); d.style = door.name
    const [fz, fx] = d.from; const [tz, tx] = d.to
    for (const [q, gx, gz, side] of [[d.rf, fx, fz, sideOf(d.from, d.to)], [d.rt, tx, tz, sideOf(d.to, d.from)]]) {
      if (!q.template) continue
      if (q.have.has(edgeKey(gx, gz, side))) { stats.matchedDoors++; continue }
      stats.addedDoors++
      const g = edgeGeom(gx, gz, side)
      let reached = false; let depth = 1
      for (; depth <= 30; depth++) {
        openBox(g, depth, depth, 69, 72, 0)
        for (let w = -1; w <= 1; w++) { const x = g.ex - g.dx * depth + (g.dx === 0 ? w : 0); const z = g.ez - g.dz * depth + (g.dz === 0 ? w : 0); if (get(x, 68, z) === 0) set(x, 68, z, stone) }
        if (depth >= 3) {
          // reached the interior once the next slice is already open air (we just carved this one, so peek ahead)
          if (airBox(g, depth + 1) && airBox(g, depth + 2)) { reached = true; break }
        }
      }
      stats.tunnels++; if (!reached) stats.tunnelBlind++
      d.tunnels = (d.tunnels || 0) + 1
    }
    // door schematic is saved running east-west (passage along x); north-south connections need a quarter turn
    const ew = d.from[0] === d.to[0]
    const gapX = ew ? Math.max(fx, tx) * P - 1 : fx * P + MID; const gapZ = ew ? fz * P + MID : Math.max(fz, tz) * P - 1
    const ox = gapX - 2; const oz = gapZ - 2
    const sc = door.sc; const rot = ew ? 0 : 1
    // 1) carve the 3-wide, 4-high passage through the full 5-block depth (clears room-side vestibules and old plugs)
    for (let w = -1; w <= 1; w++) for (let dd = -2; dd <= 2; dd++) for (let y = 69; y <= 72; y++) set(gapX + (ew ? dd : w), y, gapZ + (ew ? w : dd), 0)
    // 2) stamp only the door's solid blocks (frame, trim, plug); its air never overwrites the room's floor
    stamp(sc, rot, ox, DOOR_Y0, oz, true)
    // optional: remove the plug + gate layers of closed doors (wither / blood / entrance)
    if (opts.openDoors) for (let w = -1; w <= 1; w++) for (let dd = -2; dd <= 2; dd++) for (let y = 69; y <= 72; y++) set(gapX + (ew ? dd : w), y, gapZ + (ew ? w : dd), 0)
  }
  if (bt.missing.size) warnings.push('blocks missing from this version: ' + [...bt.missing.keys()].join(', '))

  // ---- 6g. spawn: open spot in the Entrance room closest to its centre --------------------------------
  const ent = layout.rooms.find(q => q.type === T.ENTRANCE)
  const ecx = ent.gx0 * P + MID; const ecz = ent.gz0 * P + MID; let spawn = { x: ecx + 0.5, y: 70, z: ecz + 0.5 }
  const standable = (x, y, z) => get(x, y - 1, z) !== 0 && get(x, y, z) === 0 && get(x, y + 1, z) === 0 && get(x, y + 2, z) === 0
  // prefer the ordinary floor level (feet at y=69) near the room centre; otherwise any supported spot (e.g. a ledge)
  let found = false
  for (const strict of [true, false]) {
    for (let r = 0; r < 16 && !found; r++) for (let dx = -r; dx <= r && !found; dx++) for (let dz = -r; dz <= r && !found; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
      const x = ecx + dx; const z = ecz + dz
      if (strict) { if (standable(x, 69, z)) { spawn = { x: x + 0.5, y: 69, z: z + 0.5 }; found = true } } else {
        for (let y = 66; y < 90 && !found; y++) if (standable(x, y, z)) { spawn = { x: x + 0.5, y, z: z + 0.5 }; found = true }
      }
    }
    if (found) break
  }

  // block entities: keep only those whose block really is a skull in the final world, grouped per chunk for the chunk packet
  const skullNames = bt.skull; const beByChunk = new Map(); let beCount = 0
  if (heads) {
    const seenBE = new Set()
    for (const be of beList) {
      const key = be.x + ',' + be.y + ',' + be.z; if (seenBE.has(key)) continue; seenBE.add(key)
      const id = get(be.x, be.y, be.z); const b = id ? registry.blocksByStateId[id] : null
      if (!b || !skullNames.has(b.name)) continue
      const ck = (be.x >> 4) + ',' + (be.z >> 4); if (!beByChunk.has(ck)) beByChunk.set(ck, [])
      beByChunk.get(ck).push({ x: be.x & 15, z: be.z & 15, y: be.y, type: skullType, nbtData: skullNbt(be.profile) }); beCount++
    }
  }
  stats.headBlockEntities = beCount
  if (!heads && opts.heads !== false) warnings.push('player heads dropped: no skull block entity id known for this version (pass skullBlockEntityId)')

  const dungeon = { floor, seed, layout, grid, SX, SY, SZ, yMin, yMax, spawn, stats, warnings, bt, blockEntitiesFor: (cx, cz) => beByChunk.get(cx + ',' + cz) || [] }
  dungeon.light = opts.lighting === 'fullbright' ? null : computeLight(dungeon, registry)
  return dungeon
}

// ====================================================================================================
// 7. Lighting (block light BFS + sky light BFS inside the dungeon box; everything outside is open sky)
// ====================================================================================================
function computeLight (dg, registry) {
  const { grid, SX, SY, SZ } = dg; const N = SX * SY * SZ
  const emit = new Uint8Array(65536); const filt = new Uint8Array(65536)
  for (const b of registry.blocksArray) {
    for (let s = b.minStateId; s <= b.maxStateId; s++) { emit[s] = b.emitLight || 0; filt[s] = b.name === 'air' || b.name.endsWith('_air') ? 0 : (b.transparent || b.filterLight === 0 ? Math.max(b.filterLight || 0, 0) : 15) }
  }
  const I = (x, y, z) => (y * SZ + z) * SX + x
  const run = (level, seedFn) => {
    const q = new Int32Array(N); let h = 0; let t = 0
    seedFn(q, () => t++)
    const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    while (h < t) {
      const i = q[h++]; const x = i % SX; const z = Math.floor(i / SX) % SZ; const y = Math.floor(i / (SX * SZ)); const l = level[i]; if (l <= 1) continue
      for (const [dx, dy, dz] of nb) {
        const nx = x + dx; const ny = y + dy; const nz = z + dz
        if (nx < 0 || nz < 0 || ny < 0 || nx >= SX || nz >= SZ || ny >= SY) continue
        const j = I(nx, ny, nz); const f = filt[grid[j]]; if (f >= 15) continue
        const nl = l - Math.max(1, f); if (nl > level[j]) { level[j] = nl; q[t++] = j }
      }
    }
  }
  const block = new Uint8Array(N); const sky = new Uint8Array(N)
  run(block, (q, push) => { for (let i = 0; i < N; i++) { const e = emit[grid[i]]; if (e) { block[i] = e; q[push()] = i } } })
  run(sky, (q, push) => { // open sky above the box + straight down through non-opaque blocks; gap columns on the box edge also receive light
    for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) { for (let y = SY - 1; y >= 0; y--) { const i = I(x, y, z); if (filt[grid[i]] >= 15) break; sky[i] = 15; q[push()] = i } }
  })
  return { block, sky }
}

// ====================================================================================================
// 8. flying-squid entry point
// ====================================================================================================
function generation (options) {
  const { registry } = options
  if (!registry.supportFeature('theFlattening')) throw new Error('catacombs-generator needs a flattened Minecraft version (1.13+)')
  const Chunk = require('prismarine-chunk')(registry)
  const tall = registry.supportFeature('tallWorld')
  let dungeon = null
  const biomeId = (registry.biomesByName[options.biome] || registry.biomesByName.plains || registry.biomesByName.the_void || Object.values(registry.biomesByName)[0]).id
  const ensure = () => { if (!dungeon) { dungeon = buildDungeon(registry, options); generation.last = dungeon; if (options.onBuilt) options.onBuilt(dungeon) } return dungeon }
  if (options.eager !== false) ensure()

  return function generateChunk (cx, cz) {
    const dg = ensure(); const chunk = new Chunk(); const minY = chunk.minY ?? 0; const maxY = minY + (chunk.worldHeight ?? 256)
    const ox = cx * 16; const oz = cz * 16
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        const wx = ox + x; const wz = oz + z; const inCol = wx >= 0 && wz >= 0 && wx < dg.SX && wz < dg.SZ
        for (let y = minY; y < maxY; y++) {
          const p = { x, y, z }
          if (inCol && y >= dg.yMin && y < dg.yMax) {
            const i = ((y - dg.yMin) * dg.SZ + wz) * dg.SX + wx; const s = dg.grid[i]
            if (s) chunk.setBlockStateId(p, s)
            if (dg.light) { chunk.setSkyLight(p, dg.light.sky[i]); if (dg.light.block[i]) chunk.setBlockLight(p, dg.light.block[i]) } else { chunk.setSkyLight(p, 15) }
          } else chunk.setSkyLight(p, 15)
        }
        if (tall) { for (let y = minY; y < maxY; y += 4) chunk.setBiome({ x, y, z }, biomeId) } else chunk.setBiome({ x, y: 0, z }, biomeId)
      }
    }
    return chunk
  }
}

// ====================================================================================================
// 9. Helpers for tooling: layout export + ASCII plan
// ====================================================================================================
function exportLayout (dg) {
  const L = dg.layout
  return {
    floor: dg.floor, seed: dg.seed, gridWidth: L.width, gridHeight: L.height, cellPitch: P, roomSize: S, doorBaseY: DOOR_Y0,
    spawn: dg.spawn, stats: dg.stats, warnings: [...new Set(dg.warnings)],
    criticalPath: L.critical,
    rooms: L.rooms.map(q => ({
      id: q.id, type: NAME[q.type], shape: q.kind, template: q.template ? q.template.name : null, rotationQuarterTurns: q.rot ?? null,
      cells: q.cells.map(([z, x]) => ({ x, z })), blockMin: { x: q.gx0 * P, z: q.gz0 * P },
      doorsRequired: q.need.size, doorsAddedByGenerator: q.addedDoors ?? 0,
      hasDoorMap: !!q.slotState, doorsOnBlockedSlots: q.blockedDoors ?? 0
    })),
    doors: L.doors.map(d => {
      const ew = d.from[0] === d.to[0]; const [fz, fx] = d.from; const [tz, tx] = d.to
      return {
        rooms: [d.a, d.b], kind: d.kind, schematic: d.style, axis: ew ? 'east-west' : 'north-south', rerouted: !!d.rerouted, onBlockedSlot: !!d.onBlockedSlot,
        center: { x: ew ? Math.max(fx, tx) * P - 1 : fx * P + MID, y: DOOR_Y0, z: ew ? fz * P + MID : Math.max(fz, tz) * P - 1 },
        tunnelsCarved: d.tunnels || 0
      }
    })
  }
}
function asciiPlan (dg) {
  const L = dg.layout; const ch = { 1: 'N', 2: 'E', 3: 'B', 4: 'F', 5: 'P', 6: 'T', 7: 'Y' }
  const link = (z, x, z2, x2) => L.doors.find(d => (d.from[0] === z && d.from[1] === x && d.to[0] === z2 && d.to[1] === x2) || (d.to[0] === z && d.to[1] === x && d.from[0] === z2 && d.from[1] === x2))
  const sym = (d, closed, open) => d ? (d.kind === 'normal' ? open : closed) : ' '
  const rows = []
  for (let z = 0; z < L.height; z++) {
    let a = ''; let b = ''
    for (let x = 0; x < L.width; x++) {
      const q = L.rooms.find(r => r.cells.some(c => c[0] === z && c[1] === x))
      a += q ? ch[q.type] : ' '; a += sym(link(z, x, z, x + 1), '#', '-')
      b += sym(link(z, x, z + 1, x), '#', '|') + ' '
    }
    rows.push(a); rows.push(b)
  }
  return rows.join('\n')
}

module.exports = generation
module.exports.exportLayout = exportLayout
module.exports.asciiPlan = asciiPlan
module.exports.buildDungeon = buildDungeon
module.exports.generateLayout = generateLayout
module.exports.loadTemplates = loadTemplates
module.exports.seedToInt = seedToInt
module.exports.skullTypeId = skullTypeId
module.exports.T = T
module.exports.NAME = NAME
