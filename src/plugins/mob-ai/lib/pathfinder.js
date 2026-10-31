'use strict'

const { Vec3 } = require('vec3')

/** Minimal binary min-heap keyed by node.f */
class Heap {
  constructor () { this.a = [] }
  get size () { return this.a.length }
  push (n) {
    const a = this.a
    a.push(n)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].f <= a[i].f) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }

  pop () {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l].f < a[m].f) m = l
        if (r < a.length && a[r].f < a[m].f) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

const key = (x, y, z) => x + ',' + y + ',' + z

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], // cardinal, cost 1
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2] // diagonal
]

/**
 * Bounded grid A* over block cells (x, y, z = the cell a mob's feet are in).
 *
 * Mirrors the behaviours listed for Pumpkin's navigator:
 *  - avoids hazardous blocks (lava, fire, cactus, berry bushes ...) via BlockView.standable
 *  - will not walk off ledges higher than `maxFall`
 *  - plans 1-block step-ups (jumps)
 *
 * If the goal is not reachable within `maxNodes` expansions, the path to the explored cell
 * closest to the goal is returned (`partial: true`) so chasing mobs still make progress.
 */
class Pathfinder {
  constructor (view) { this.view = view }

  /**
   * @param {object} world
   * @param {Vec3} startPos   mob position (feet)
   * @param {Vec3} goalPos    wanted position
   * @param {object} [o]
   * @returns {Promise<{path: Vec3[], partial: boolean} | null>} waypoints are cell centres (feet height)
   */
  async find (world, startPos, goalPos, { height = 2, maxFall = 3, maxNodes = 200, range = 48, reachDist = 0 } = {}) {
    const view = this.view
    const sx = Math.floor(startPos.x)
    const sz = Math.floor(startPos.z)
    let sy = Math.floor(startPos.y + 0.001)
    // snap the start onto walkable ground in case the mob is mid-fall / inside a liquid
    if (!(await view.standable(world, sx, sy, sz, height))) {
      const s = await view.findStandable(world, sx, sy, sz, 3, height)
      if (!s) return null
      sy = s.y
    }
    const gx = Math.floor(goalPos.x)
    const gz = Math.floor(goalPos.z)
    let gy = Math.floor(goalPos.y + 0.001)
    const gs = await view.findStandable(world, gx, gy, gz, 4, height)
    if (gs) gy = gs.y

    const h = (x, y, z) => {
      const dx = Math.abs(x - gx)
      const dz = Math.abs(z - gz)
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz) + Math.abs(y - gy) * 0.5
    }

    const open = new Heap()
    const nodes = new Map()
    const start = { x: sx, y: sy, z: sz, g: 0, f: h(sx, sy, sz), parent: null, closed: false }
    nodes.set(key(sx, sy, sz), start)
    open.push({ f: start.f, n: start })
    let best = start
    let bestH = h(sx, sy, sz)
    let expanded = 0
    const reach2 = Math.max(reachDist, 0) ** 2

    while (open.size && expanded < maxNodes) {
      const entry = open.pop()
      const n = entry.n
      if (n.closed || entry.f > n.f) continue // already expanded, or a stale entry superseded by a cheaper route
      n.closed = true
      expanded++

      const hn = h(n.x, n.y, n.z)
      if (hn < bestH) { best = n; bestH = hn }
      const ddx = n.x - gx
      const ddz = n.z - gz
      if ((n.x === gx && n.z === gz && Math.abs(n.y - gy) <= 1) || (reach2 > 0 && ddx * ddx + ddz * ddz <= reach2 && Math.abs(n.y - gy) <= 1)) {
        return { path: this._build(n), partial: false }
      }

      for (const [dx, dz, cost] of DIRS) {
        const nx = n.x + dx
        const nz = n.z + dz
        if (Math.abs(nx - sx) > range || Math.abs(nz - sz) > range) continue
        if (dx !== 0 && dz !== 0) {
          // no corner cutting: both orthogonal neighbours must be free at body height
          if (!(await this._bodyFree(world, n.x + dx, n.y, n.z, height)) || !(await this._bodyFree(world, n.x, n.y, n.z + dz, height))) continue
        }
        const ny = await this._stepY(world, nx, n.y, nz, n, height, maxFall)
        if (ny === null) continue
        const k = key(nx, ny, nz)
        const g = n.g + cost + Math.abs(ny - n.y) * 0.3
        let m = nodes.get(k)
        if (m) {
          if (m.closed || g >= m.g) continue
          m.g = g
          m.f = g + h(nx, ny, nz)
          m.parent = n
          open.push({ f: m.f, n: m })
          continue
        }
        m = { x: nx, y: ny, z: nz, g, f: g + h(nx, ny, nz), parent: n, closed: false }
        nodes.set(k, m)
        open.push({ f: m.f, n: m })
      }
    }

    if (best === start) return null
    return { path: this._build(best), partial: true }
  }

  async _bodyFree (world, x, y, z, height) {
    for (let i = 0; i < height; i++) if (!(await this.view.isFree(world, x, y + i, z))) return false
    return true
  }

  /** Feet y of the walkable cell reached when stepping from `n` to column (nx, nz), or null. */
  async _stepY (world, nx, ny, nz, n, height, maxFall) {
    const view = this.view
    if (await view.standable(world, nx, ny, nz, height)) return ny
    // step up one block: needs head room above the current cell as well
    if (await view.isFree(world, n.x, n.y + height, n.z) && await view.standable(world, nx, ny + 1, nz, height)) return ny + 1
    // drop down: body column must be free, then fall until something solid
    if (await this._bodyFree(world, nx, ny, nz, height)) {
      for (let d = 1; d <= maxFall; d++) {
        if (!(await view.isFree(world, nx, ny - d, nz))) break
        if (await view.standable(world, nx, ny - d, nz, height)) return ny - d
      }
    }
    return null
  }

  _build (node) {
    const out = []
    for (let n = node; n; n = n.parent) out.push(new Vec3(n.x + 0.5, n.y, n.z + 0.5))
    out.reverse()
    out.shift() // the first cell is where the mob already is
    return out
  }
}

module.exports = { Pathfinder }
