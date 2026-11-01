'use strict'
// Vanilla Minecraft projectile motion (Java Edition). Units: blocks, ticks (20/s), degrees.
//
// Every projectile has its own tick order, gravity, and horizontal/vertical drag (see PROJECTILES). One tick is the
// profile's `tickOrder` applied to {pos, vel}, e.g. 'position-drag-gravity' (arrows):
//   pos += vel;  vel.xz *= dragH, vel.y *= dragV;  vel.y -= gravity
// Angles: `pitch` is degrees ABOVE the horizon (positive = up, unlike Minecraft's own pitch which is negative up).
// `yaw` follows Minecraft: 0 faces +Z, positive yaw turns towards -X. Simulations start at the origin, at y = `height`.
//
// `verified` on a profile says whether the numbers were checked against the entity source. The 26.1 sources could not
// be read when this was written, so values marked verified:false come from the wiki / memory and need checking.

const PROJECTILES = {
  arrow: {
    gravity: 0.05,
    drag: { h: 0.99, v: 0.99 },
    waterDrag: { h: 0.6, v: 0.6 },
    tickOrder: 'position-drag-gravity',
    launch: { speed: null, pitchOffset: 0, inaccuracy: 1.0 }, // bow: speed comes from the draw, see bowSpeed
    verified: true,
    note: 'also covers spectral arrows'
  },
  spectral_arrow: {
    gravity: 0.05,
    drag: { h: 0.99, v: 0.99 },
    waterDrag: { h: 0.6, v: 0.6 },
    tickOrder: 'position-drag-gravity',
    launch: { speed: null, pitchOffset: 0, inaccuracy: 1.0 },
    verified: true
  },
  trident: {
    gravity: 0.05,
    drag: { h: 0.99, v: 0.99 },
    waterDrag: { h: 0.99, v: 0.99 },
    tickOrder: 'position-drag-gravity',
    launch: { speed: 2.5, pitchOffset: 0, inaccuracy: 1.0 },
    verified: false
  },
  snowball: throwable(0.03, 1.5, 0),
  egg: throwable(0.03, 1.5, 0),
  ender_pearl: throwable(0.03, 1.5, 0),
  splash_potion: throwable(0.05, 0.5, 20), // thrown 20 degrees ABOVE where the player looks
  lingering_potion: throwable(0.05, 0.5, 20),
  experience_bottle: throwable(0.07, 0.7, 20),
  fishing_bobber: {
    gravity: 0.03,
    drag: { h: 0.92, v: 0.92 },
    waterDrag: { h: 0.92, v: 0.92 },
    tickOrder: 'position-gravity-drag',
    launch: null,
    verified: false,
    approximate: true,
    note: 'airborne movement only: hooked / landed / in-water-bobbing states are not modelled. The wiki-derived list this was reviewed against gives 0.99 horizontal drag; 0.92 on all axes is what the entity code is believed to use. Override with dragH / dragV if you know better.'
  },
  // Simplified models: these entities also have their own collision / friction / environment rules.
  item: falling(),
  falling_block: falling(),
  tnt: falling()
}

function throwable (gravity, speed, pitchOffset) {
  return {
    gravity,
    drag: { h: 0.99, v: 0.99 },
    waterDrag: { h: 0.8, v: 0.8 },
    tickOrder: 'gravity-drag-position', // ThrowableProjectile.tick since 1.21.2 (believed; bodies not readable here)
    launch: { speed, pitchOffset, inaccuracy: 1.0 },
    verified: false
  }
}

function falling () {
  return {
    gravity: 0.04,
    drag: { h: 0.98, v: 0.98 },
    waterDrag: { h: 0.98, v: 0.98 },
    tickOrder: 'gravity-position-drag',
    launch: null,
    verified: false,
    approximate: true
  }
}

// Bow constants (BowItem.getPowerForTime and AbstractArrow damage rules)
const BOW = { fullDrawTicks: 20, maxSpeed: 3.0, playerDivergence: 1.0, minPower: 0.1 }
const SPREAD = 0.0172275 // Projectile.shoot: per-axis triangular spread = SPREAD * inaccuracy

const rad = d => d * Math.PI / 180
const deg = r => r * 180 / Math.PI
const triangle = (center, maxDev, random) => center + maxDev * (random() - random())

// ---- profiles -----------------------------------------------------------------------------------
function toDrag (v, fallback) {
  if (v === undefined) return fallback
  return typeof v === 'number' ? { h: v, v } : { h: v.h !== undefined ? v.h : fallback.h, v: v.v !== undefined ? v.v : fallback.v }
}

/** Resolve the physics parameters for opts.projectile with the optional overrides gravity, drag (number or {h,v}),
 *  dragH, dragV, waterDrag, tickOrder. */
function resolve (opts) {
  const base = PROJECTILES[opts.projectile || 'arrow']
  if (!base && opts.gravity === undefined) throw new Error('unknown projectile: ' + opts.projectile)
  const b = base || PROJECTILES.arrow
  let drag = toDrag(opts.drag, b.drag)
  if (opts.dragH !== undefined) drag = { ...drag, h: opts.dragH }
  if (opts.dragV !== undefined) drag = { ...drag, v: opts.dragV }
  const waterDrag = toDrag(opts.waterDrag, base ? b.waterDrag : drag)
  const order = String(opts.tickOrder || (base ? b.tickOrder : 'position-drag-gravity')).split('-')
  for (const op of order) if (!['position', 'drag', 'gravity'].includes(op)) throw new Error('bad tickOrder: ' + opts.tickOrder)
  return { gravity: opts.gravity !== undefined ? opts.gravity : b.gravity, drag, waterDrag, order, profile: base || null }
}

/** One physics tick. state = {pos:{x,y,z}, vel:{x,y,z}}. Returns the new state plus `moveVel`, the velocity that was
 *  used for the displacement (this is what hits things: impact speed and arrow damage use it). */
function step (state, params, inWater = false) {
  const p = params.order ? params : resolve(params)
  const d = inWater ? p.waterDrag : p.drag
  const pos = { ...state.pos }
  const vel = { ...state.vel }
  let moveVel = null
  for (const op of p.order) {
    if (op === 'position') {
      pos.x += vel.x; pos.y += vel.y; pos.z += vel.z
      moveVel = { ...vel }
    } else if (op === 'drag') {
      vel.x *= d.h; vel.z *= d.h; vel.y *= d.v
    } else {
      vel.y -= p.gravity
    }
  }
  return { pos, vel, moveVel }
}

// ---- launching ----------------------------------------------------------------------------------
/** Unit-length-times-speed vector for a yaw / pitch (pitch positive = up). */
function velocityFromAngles (yaw, pitch, speed = 1) {
  const y = rad(yaw)
  const p = rad(pitch)
  return { x: -Math.sin(y) * Math.cos(p) * speed, y: Math.sin(p) * speed, z: Math.cos(y) * Math.cos(p) * speed }
}

/** Initial velocity the way Projectile.shootFromRotation builds it: aim = look pitch + the projectile's pitch offset,
 *  normalise, add spread, scale by speed, then add the shooter's velocity (horizontal always; vertical only when not
 *  on the ground).
 *  opts: projectile, yaw, pitch (look pitch, up positive), speed (default: the projectile's launch speed),
 *        pitchOffset, inaccuracy, spread {x,y,z} (deterministic offset added to the unit direction),
 *        random (function returning [0,1): adds vanilla triangular spread; none by default so results are reproducible),
 *        playerVelocity {x,y,z} in blocks/tick, onGround (default true). */
function launchVelocity (opts) {
  const profile = PROJECTILES[opts.projectile || 'arrow']
  const launch = (profile && profile.launch) || {}
  const speed = opts.speed !== undefined ? opts.speed : launch.speed
  if (speed === undefined || speed === null) throw new Error('no launch speed for ' + (opts.projectile || 'arrow') + ': give speed or draw')
  const offset = opts.pitchOffset !== undefined ? opts.pitchOffset : (launch.pitchOffset || 0)
  const aimPitch = (opts.pitch || 0) + offset
  const dir = velocityFromAngles(opts.yaw || 0, aimPitch, 1)
  const inaccuracy = opts.inaccuracy !== undefined ? opts.inaccuracy : (launch.inaccuracy !== undefined ? launch.inaccuracy : 1)
  const s = opts.spread || { x: 0, y: 0, z: 0 }
  const r = opts.random
  const dev = r ? SPREAD * inaccuracy : 0
  const v = {
    x: (dir.x + (s.x || 0) + (r ? triangle(0, dev, r) : 0)) * speed,
    y: (dir.y + (s.y || 0) + (r ? triangle(0, dev, r) : 0)) * speed,
    z: (dir.z + (s.z || 0) + (r ? triangle(0, dev, r) : 0)) * speed
  }
  const pv = opts.playerVelocity
  if (pv) {
    v.x += pv.x || 0
    v.z += pv.z || 0
    if (opts.onGround === false) v.y += pv.y || 0
  }
  const horizontal = Math.hypot(v.x, v.z)
  return { ...v, speed: Math.hypot(v.x, v.y, v.z), horizontal, pitch: deg(Math.atan2(v.y, horizontal)), yaw: horizontal ? deg(Math.atan2(-v.x, v.z)) : (opts.yaw || 0) }
}

function initialVelocity (opts) {
  if (opts.velocity) return { x: opts.velocity.x, y: opts.velocity.y, z: opts.velocity.z }
  const v = velocityFromAngles(opts.yaw || 0, opts.pitch || 0, opts.speed)
  const pv = opts.playerVelocity
  if (pv) { v.x += pv.x || 0; v.y += pv.y || 0; v.z += pv.z || 0 }
  return v
}

// ---- environment --------------------------------------------------------------------------------
/** Is the projectile in water on tick number `tick` (0 = the first simulated tick)?  opts.inWater may be a boolean,
 *  a function ({tick, pos, vel}) => boolean, or a list of inclusive tick ranges [[from, to], ...].  opts.water: true
 *  is the legacy "always in water" switch. */
function inWaterAt (opts, tick, pos, vel) {
  const w = opts.inWater !== undefined ? opts.inWater : opts.water
  if (typeof w === 'function') return !!w({ tick, pos, vel })
  if (Array.isArray(w)) return w.some(r => tick >= r[0] && tick <= r[1])
  return !!w
}

// ---- simulation ---------------------------------------------------------------------------------
/** Fly until the projectile comes back down through the plane y = targetY (default 0), or maxTicks.
 *  Raw input: speed + pitch (+ yaw, playerVelocity) or an explicit velocity vector (see launchVelocity). */
function simulate (opts) {
  const params = resolve(opts)
  const targetY = opts.targetY !== undefined ? opts.targetY : 0
  const maxTicks = opts.maxTicks || 2400
  let state = { pos: { x: 0, y: opts.height || 0, z: 0 }, vel: initialVelocity(opts) }
  const entry = (t, s) => ({
    t,
    x: Math.hypot(s.pos.x, s.pos.z),
    y: s.pos.y,
    vx: Math.hypot(s.vel.x, s.vel.z),
    vy: s.vel.y,
    pos: s.pos,
    vel: s.vel,
    moveVel: s.moveVel || null
  })
  const path = [entry(0, state)]
  let maxY = state.pos.y
  let apexTick = 0
  let landed = null
  for (let t = 1; t <= maxTicks; t++) {
    const prev = state
    state = step(state, params, inWaterAt(opts, t - 1, prev.pos, prev.vel))
    const e = entry(t, state)
    path.push(e)
    if (state.pos.y > maxY) { maxY = state.pos.y; apexTick = t }
    if (!landed && prev.pos.y >= targetY && state.pos.y < targetY) {
      const f = (prev.pos.y - targetY) / (prev.pos.y - state.pos.y) // where inside the tick the plane is crossed
      const at = {
        x: prev.pos.x + (state.pos.x - prev.pos.x) * f,
        y: targetY,
        z: prev.pos.z + (state.pos.z - prev.pos.z) * f
      }
      landed = { ticks: t - 1 + f, range: Math.hypot(at.x, at.z), at, moveVel: state.moveVel }
      if (!opts.keepGoing) break
    }
    if (opts.stopRange !== undefined && e.x >= opts.stopRange) break
  }
  return {
    path,
    landed: !!landed,
    range: landed ? landed.range : null,
    landing: landed ? landed.at : null,
    flightTicks: landed ? landed.ticks : null,
    flightSeconds: landed ? landed.ticks / 20 : null,
    maxHeight: maxY,
    apexTick,
    apexSeconds: apexTick / 20,
    // the velocity the projectile was moving with when it crossed the plane (not the one after the next tick's drag)
    impactSpeed: landed && landed.moveVel ? Math.hypot(landed.moveVel.x, landed.moveVel.y, landed.moveVel.z) : null,
    impactVelocity: landed ? landed.moveVel : null
  }
}

/** Every tick's position and velocity */
function trajectory (opts) {
  return simulate({ ...opts, targetY: -1e9, keepGoing: true, maxTicks: opts.maxTicks || 200 }).path
}

// Height of the path at a horizontal distance (first time it reaches that distance)
function heightAt (opts, distance) {
  const r = simulate({ ...opts, targetY: -1e9, keepGoing: true, stopRange: distance, maxTicks: opts.maxTicks || 2400 })
  for (let i = 1; i < r.path.length; i++) {
    const a = r.path[i - 1]
    const b = r.path[i]
    if (b.x >= distance) {
      const f = b.x === a.x ? 0 : (distance - a.x) / (b.x - a.x)
      return { y: a.y + (b.y - a.y) * f, ticks: a.t + f }
    }
  }
  return null
}

// ---- collision ----------------------------------------------------------------------------------
/** Swept collision: the first place the projectile's per-tick movement segments cross a target box.
 *  box = {min:{x,y,z}, max:{x,y,z}} in the simulation frame (origin at the launch point, y = height). Like vanilla's
 *  ProjectileUtil.getEntityHitResult the projectile is treated as a point and the box is inflated by `margin` (0.3).
 *  Pass either a path (from simulate / trajectory) or the same options as simulate. */
function collision (pathOrOpts, box, { margin = 0.3 } = {}) {
  const path = Array.isArray(pathOrOpts) ? pathOrOpts : trajectory({ maxTicks: 600, ...pathOrOpts })
  const lo = { x: box.min.x - margin, y: box.min.y - margin, z: box.min.z - margin }
  const hi = { x: box.max.x + margin, y: box.max.y + margin, z: box.max.z + margin }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1].pos
    const b = path[i].pos
    let t0 = 0
    let t1 = 1
    let ok = true
    for (const ax of ['x', 'y', 'z']) {
      const d = b[ax] - a[ax]
      if (Math.abs(d) < 1e-12) {
        if (a[ax] < lo[ax] || a[ax] > hi[ax]) { ok = false; break }
        continue
      }
      let n = (lo[ax] - a[ax]) / d
      let f = (hi[ax] - a[ax]) / d
      if (n > f) { const tmp = n; n = f; f = tmp }
      t0 = Math.max(t0, n)
      t1 = Math.min(t1, f)
      if (t0 > t1) { ok = false; break }
    }
    if (ok) {
      const point = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0, z: a.z + (b.z - a.z) * t0 }
      const mv = path[i].moveVel || { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
      return { hit: true, tick: i - 1 + t0, point, speed: Math.hypot(mv.x, mv.y, mv.z), velocity: mv }
    }
  }
  return { hit: false }
}

// ---- solving ------------------------------------------------------------------------------------
// Pitch (deg above horizon) that hits (distance, dy) with the given speed. Returns {low, high} (either may be null).
function solvePitch (opts) {
  const { distance, dy = 0, speed } = opts
  const sim = { ...opts, height: 0, speed, yaw: 0, playerVelocity: undefined, velocity: undefined }
  const err = pitch => {
    const h = heightAt({ ...sim, pitch }, distance)
    return h ? h.y - dy : null // null = never reaches that distance
  }
  const scan = []
  for (let a = -89.9; a <= 89.9; a += 0.25) scan.push([a, err(a)])
  const roots = []
  for (let i = 1; i < scan.length; i++) {
    const [a0, e0] = scan[i - 1]
    const [a1, e1] = scan[i]
    if (e0 === null || e1 === null) continue
    if ((e0 <= 0 && e1 > 0) || (e0 >= 0 && e1 < 0)) {
      let lo = a0
      let hi = a1
      const elo = e0
      for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2
        const em = err(mid)
        if (em === null) break
        if ((em <= 0) === (elo <= 0)) lo = mid; else hi = mid
      }
      roots.push((lo + hi) / 2)
    }
  }
  if (!roots.length) return { low: null, high: null, reachable: false }
  roots.sort((a, b) => a - b)
  return { low: roots[0], high: roots.length > 1 ? roots[roots.length - 1] : null, reachable: true }
}

// Smallest speed (blocks/tick) that reaches (distance, dy) at some angle, by bisection.
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

// Angle giving the longest range for a launch speed (numerical, on the real tick-based physics)
function bestAngle (opts) {
  const base = { ...opts, yaw: 0, playerVelocity: undefined, velocity: undefined }
  let best = null
  for (let a = -10; a <= 89.9; a += 0.5) {
    const r = simulate({ ...base, pitch: a })
    if (r.landed && (!best || r.range > best.range)) best = { pitch: a, range: r.range }
  }
  if (!best) return null
  let lo = best.pitch - 0.5
  let hi = best.pitch + 0.5
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    const r1 = simulate({ ...base, pitch: m1 }).range || 0
    const r2 = simulate({ ...base, pitch: m2 }).range || 0
    if (r1 < r2) lo = m1; else hi = m2
  }
  const pitch = (lo + hi) / 2
  return { pitch, range: simulate({ ...base, pitch }).range }
}

// ---- randomised launches --------------------------------------------------------------------------
function mulberry32 (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Many launches with vanilla random inaccuracy (seeded, so repeatable). `opts` are launchVelocity + simulate options
 *  (a `box` adds a hit rate). Returns the landing points and summary statistics. */
function simulateMany (opts, { count = 200, seed = 1, box = null } = {}) {
  const random = mulberry32(seed)
  const runs = []
  let hits = 0
  for (let i = 0; i < count; i++) {
    const velocity = launchVelocity({ ...opts, random })
    const sim = simulate({ ...opts, velocity, keepGoing: !!box, maxTicks: opts.maxTicks || 1200 })
    const c = box ? collision(sim.path, box) : null
    if (c && c.hit) hits++
    runs.push({ range: sim.range, landing: sim.landing, ticks: sim.flightTicks, hit: c ? c.hit : undefined })
  }
  const landed = runs.filter(r => r.landing)
  const mean = k => landed.reduce((s, r) => s + r.landing[k], 0) / (landed.length || 1)
  const std = (k, m) => Math.sqrt(landed.reduce((s, r) => s + (r.landing[k] - m) ** 2, 0) / (landed.length || 1))
  const mx = mean('x')
  const mz = mean('z')
  const ranges = landed.map(r => r.range)
  return {
    runs,
    landed: landed.length,
    meanLanding: { x: mx, z: mz },
    stdDev: { x: std('x', mx), z: std('z', mz) },
    minRange: ranges.length ? Math.min(...ranges) : null,
    maxRange: ranges.length ? Math.max(...ranges) : null,
    hitRate: box ? hits / count : undefined
  }
}

// ---- bow helpers --------------------------------------------------------------------------------
function bowPower (drawTicks) {
  const t = Math.min(drawTicks, BOW.fullDrawTicks) / BOW.fullDrawTicks
  const p = (t * t + t * 2) / 3
  return p < BOW.minPower ? 0 : Math.min(1, p)
}
function bowSpeed (drawTicks) { return bowPower(drawTicks) * BOW.maxSpeed }
/** A fully drawn bow shot sets the critical flag (an explicit property of the shot, not inferred from speed) */
function bowCritical (drawTicks) { return bowPower(drawTicks) >= 1 }
// Smallest draw (ticks) whose speed reaches `speed`; null if more than a full draw is needed
function drawTicksForSpeed (speed) {
  for (let t = 1; t <= BOW.fullDrawTicks; t++) if (bowSpeed(t) >= speed - 1e-9) return t
  return null
}
/** Arrow damage = ceil(speed * baseDamage); `speed` should be the speed AT IMPACT (see simulate().impactSpeed).
 *  A critical arrow adds a random 0..floor(d/2)+2. Power adds 0.5 * level + 0.5 to the base damage.
 *  arrowDamage(speed, { baseDamage = 2, power = 0, critical = false });  the old (speed, baseDamage, powerLevels) form
 *  still works. Armour and other mitigation are not modelled. */
function arrowDamage (speed, options = {}, legacyPower = 0) {
  const o = typeof options === 'number' ? { baseDamage: options, power: legacyPower } : options
  const baseDamage = o.baseDamage !== undefined ? o.baseDamage : 2
  const powerBonus = o.power > 0 ? o.power * 0.5 + 0.5 : 0
  const d = Math.ceil(speed * (baseDamage + powerBonus))
  const critical = !!o.critical
  return { base: baseDamage, powerBonus, min: d, max: critical ? d + Math.floor(d / 2) + 2 : d, critical }
}

module.exports = {
  PROJECTILES,
  BOW,
  rad,
  deg,
  resolve,
  step,
  velocityFromAngles,
  launchVelocity,
  simulate,
  trajectory,
  heightAt,
  collision,
  solvePitch,
  solveSpeed,
  bestAngle,
  simulateMany,
  bowPower,
  bowSpeed,
  bowCritical,
  drawTicksForSpeed,
  arrowDamage
}
