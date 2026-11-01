'use strict'
// Vanilla Minecraft projectile motion (Java Edition). Units: blocks, ticks (20/s), degrees.
// Per tick, in this order:  pos += vel;  vel *= drag (water drag when submerged);  vel.y -= gravity.
// "pitch" here is the angle ABOVE the horizon (positive = up), not Minecraft's own pitch (negative = up).

const PROJECTILES = {
  arrow: { gravity: 0.05, drag: 0.99, waterDrag: 0.6, note: 'also spectral arrow' },
  trident: { gravity: 0.05, drag: 0.99, waterDrag: 0.99 },
  snowball: { gravity: 0.03, drag: 0.99, waterDrag: 0.8 },
  egg: { gravity: 0.03, drag: 0.99, waterDrag: 0.8 },
  ender_pearl: { gravity: 0.03, drag: 0.99, waterDrag: 0.8 },
  splash_potion: { gravity: 0.05, drag: 0.99, waterDrag: 0.8, note: 'also lingering potion' },
  experience_bottle: { gravity: 0.07, drag: 0.99, waterDrag: 0.8 },
  fishing_bobber: { gravity: 0.03, drag: 0.92, waterDrag: 0.92 },
  item: { gravity: 0.04, drag: 0.98, waterDrag: 0.99, note: 'dropped items, falling blocks, primed TNT' },
  falling_block: { gravity: 0.04, drag: 0.98, waterDrag: 0.99 },
  tnt: { gravity: 0.04, drag: 0.98, waterDrag: 0.99 }
}

// Bow constants (BowItem.getPowerForTime and AbstractArrow damage rules)
const BOW = { fullDrawTicks: 20, maxSpeed: 3.0, playerDivergence: 1.0, minPower: 0.1 }

const rad = d => d * Math.PI / 180
const deg = r => r * 180 / Math.PI

function resolve (opts) {
  const base = PROJECTILES[opts.projectile || 'arrow']
  if (!base && opts.gravity === undefined) throw new Error('unknown projectile: ' + opts.projectile)
  const b = base || {}
  return {
    gravity: opts.gravity !== undefined ? opts.gravity : b.gravity,
    drag: opts.drag !== undefined ? opts.drag : (opts.water ? b.waterDrag : b.drag)
  }
}

// Fly until the projectile comes back down to `targetY` (relative to the launch point's own y of 0, so a target
// BELOW the launcher has a negative targetY), or maxTicks. Returns the sampled path and summary numbers.
function simulate (opts) {
  const { gravity, drag } = resolve(opts)
  const speed = opts.speed
  const pitch = rad(opts.pitch || 0)
  const targetY = opts.targetY !== undefined ? opts.targetY : 0
  const maxTicks = opts.maxTicks || 2400
  let x = 0
  let y = opts.height || 0 // launch height above the reference plane
  let vx = speed * Math.cos(pitch)
  let vy = speed * Math.sin(pitch)
  const path = [{ t: 0, x, y, vx, vy }]
  let maxY = y
  let apexTick = 0
  let landed = null
  for (let t = 1; t <= maxTicks; t++) {
    const px = x
    const py = y
    x += vx
    y += vy
    vx *= drag
    vy = vy * drag - gravity
    path.push({ t, x, y, vx, vy })
    if (y > maxY) { maxY = y; apexTick = t }
    if (!landed && t > 1 && py >= targetY && y < targetY && vy < 0) {
      const f = (py - targetY) / (py - y) // interpolate the crossing inside the tick
      landed = { ticks: t - 1 + f, range: px + (x - px) * f }
    } else if (!landed && t === 1 && y < targetY && py >= targetY) {
      const f = (py - targetY) / (py - y)
      landed = { ticks: f, range: px + (x - px) * f }
    }
    if (landed && !opts.keepGoing) break
  }
  return {
    path,
    landed: !!landed,
    range: landed ? landed.range : null,
    flightTicks: landed ? landed.ticks : null,
    flightSeconds: landed ? landed.ticks / 20 : null,
    maxHeight: maxY,
    apexTick,
    apexSeconds: apexTick / 20,
    impactSpeed: landed ? impactSpeed(path, landed.ticks) : null
  }
}

function impactSpeed (path, ticks) {
  const i = Math.max(1, Math.min(path.length - 1, Math.ceil(ticks)))
  const p = path[i - 1]
  return Math.hypot(p.vx, p.vy) // velocity used for the move that crossed the plane
}

// Height of the path at a horizontal distance (first time it reaches that distance)
function heightAt (opts, distance) {
  const r = simulate({ ...opts, targetY: -1e9, keepGoing: true, maxTicks: opts.maxTicks || 2400 })
  for (let i = 1; i < r.path.length; i++) {
    const a = r.path[i - 1]
    const b = r.path[i]
    if (b.x >= distance) return { y: a.y + (b.y - a.y) * (distance - a.x) / (b.x - a.x), ticks: a.t + (distance - a.x) / (b.x - a.x) }
    if (b.vx <= 0) break
  }
  return null
}

// Pitch (deg above horizon) that hits (distance, dy) with the given speed. Returns {low, high} (either may be null).
function solvePitch (opts) {
  const { distance, dy = 0, speed } = opts
  const err = pitch => {
    const h = heightAt({ ...opts, pitch, height: 0, speed }, distance)
    return h ? h.y - dy : -1e6 // never reaches that distance = far too low
  }
  const scan = []
  for (let a = -89.9; a <= 89.9; a += 0.25) scan.push([a, err(a)])
  const roots = []
  for (let i = 1; i < scan.length; i++) {
    const [a0, e0] = scan[i - 1]
    const [a1, e1] = scan[i]
    if (e0 === -1e6 || e1 === -1e6) { if (!(e0 === -1e6 && e1 === -1e6) && (e0 > 0 || e1 > 0)) { /* edge of reach */ } }
    if ((e0 <= 0 && e1 > 0) || (e0 >= 0 && e1 < 0)) {
      if (e0 === -1e6 || e1 === -1e6) continue
      let lo = a0
      let hi = a1
      let elo = e0
      for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2
        const em = err(mid)
        if ((em <= 0) === (elo <= 0)) { lo = mid; elo = em } else hi = mid
      }
      roots.push((lo + hi) / 2)
    }
  }
  if (!roots.length) return { low: null, high: null, reachable: false }
  roots.sort((a, b) => a - b)
  return { low: roots[0], high: roots.length > 1 ? roots[roots.length - 1] : null, reachable: true }
}

// Smallest speed (blocks/tick) that reaches (distance, dy) at some angle, by bisection on the best-angle reach.
function solveSpeed (opts) {
  const { distance, dy = 0 } = opts
  let lo = 0.05
  let hi = 20
  if (!solvePitch({ ...opts, speed: hi, distance, dy }).reachable) return null
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2
    if (solvePitch({ ...opts, speed: mid, distance, dy }).reachable) hi = mid
    else lo = mid
  }
  return hi
}

// Angle giving the longest range for a launch speed and height difference
function bestAngle (opts) {
  let best = null
  for (let a = -10; a <= 89.9; a += 0.5) {
    const r = simulate({ ...opts, pitch: a, targetY: opts.targetY !== undefined ? opts.targetY : 0, height: opts.height || 0 })
    if (r.landed && (!best || r.range > best.range)) best = { pitch: a, range: r.range }
  }
  if (!best) return null
  let lo = best.pitch - 0.5
  let hi = best.pitch + 0.5
  for (let k = 0; k < 40; k++) { // golden-ish refinement
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    const r1 = simulate({ ...opts, pitch: m1 }).range || 0
    const r2 = simulate({ ...opts, pitch: m2 }).range || 0
    if (r1 < r2) lo = m1; else hi = m2
  }
  const pitch = (lo + hi) / 2
  return { pitch, range: simulate({ ...opts, pitch }).range }
}

// ---- bow helpers -------------------------------------------------------------------------------
function bowPower (drawTicks) {
  const t = Math.min(drawTicks, BOW.fullDrawTicks) / BOW.fullDrawTicks
  const p = (t * t + t * 2) / 3
  return p < BOW.minPower ? 0 : Math.min(1, p)
}
function bowSpeed (drawTicks) { return bowPower(drawTicks) * BOW.maxSpeed }
// Smallest draw (ticks) whose speed reaches `speed`; null if more than a full draw is needed
function drawTicksForSpeed (speed) {
  for (let t = 1; t <= BOW.fullDrawTicks; t++) if (bowSpeed(t) >= speed - 1e-9) return t
  return null
}
// Expected-ish arrow damage for a speed: ceil(speed * baseDamage); crits add up to floor(d/2)+2
function arrowDamage (speed, baseDamage = 2, extraPowerLevels = 0) {
  const base = baseDamage + (extraPowerLevels > 0 ? extraPowerLevels * 0.5 + 0.5 : 0)
  const d = Math.ceil(speed * base)
  return { min: d, max: d + Math.floor(d / 2) + 2, critical: speed >= 3 - 1e-9 }
}

module.exports = {
  PROJECTILES,
  BOW,
  rad,
  deg,
  simulate,
  heightAt,
  solvePitch,
  solveSpeed,
  bestAngle,
  bowPower,
  bowSpeed,
  drawTicksForSpeed,
  arrowDamage
}
