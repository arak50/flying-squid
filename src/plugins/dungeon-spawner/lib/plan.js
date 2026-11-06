'use strict'
/**
 * Mob plans for a room: which mobs, where, which of them are starred. Pure and seeded (same seed + room + inputs = same plan).
 *
 *   sidecarPlan  the room's sidecar `mobs` block (dungeon-room-schematics/room-mobs.schema.json): its spawn list is the pool,
 *                the stars are drawn from it, positions are room-local and get rotated / moved into the world
 *   randomPlan   the generic planner for rooms without a block (spots at random inside the room's cells)
 *
 * A plan is { roomId, floor, master, roomsExplored, entries: [{ mobId, spawnId?, mob, required, star, miniboss, modifier,
 * position: { x, z, y? }, yaw? }] }. `position.y` is only set by sidecar spawns; otherwise the plugin looks the floor up.
 */
const { derive } = require('../../dungeon-run/lib/rng')
const { mobs: CATALOG, modifiers: MODIFIERS } = require('../../dungeon-mobs/lib/catalog')

const round2 = n => Math.round(n * 100) / 100

/** Basic (starrable) mobs that live on `floor`. */
function mobPool (floor, { allowSpiders = true } = {}) {
  return Object.keys(CATALOG).sort().filter(k => {
    const d = CATALOG[k]
    return d.kind === 'basic' && d.star && d.floors[0] <= floor && floor <= d.floors[1] && (allowSpiders || d.entity !== 'spider')
  })
}

/** Room-local -> world: quarter turns clockwise (the generator's (x, z) -> (L - z, x)), then the room's origin and floor height. */
function toWorld (local, geo) {
  let { x, z } = local
  let W = geo.size.x; let L = geo.size.z
  for (let i = 0; i < (geo.rot || 0); i++) { [x, z] = [L - z, x]; [W, L] = [L, W] }
  return { x: round2(geo.origin.x + x), y: round2(geo.floorY + local.y), z: round2(geo.origin.z + z) }
}

const countOf = (c, rng, dflt) => c === undefined ? dflt : Array.isArray(c) ? rng.range(c[0], c[1]) : c

// ---------------------------------------------------------------------------------------------------------------------
function randomPlan (ctx) {
  const { room, floor, cfg } = ctx
  const rng = derive(ctx.seed, 'room', room.id, 'mobs')
  const modKeys = Object.keys(MODIFIERS).sort()
  const m = cfg.spawnMargin
  const spot = cell => ({ x: round2(cell.x * ctx.P + m + rng.int(ctx.S - 2 * m) + 0.5), z: round2(cell.z * ctx.P + m + rng.int(ctx.S - 2 * m) + 0.5) })
  const entries = []
  const add = (key, required, star, extra = {}) => {
    const def = CATALOG[key]
    const cell = rng.pick(room.cells)
    const position = extra.position || spot(cell)
    const roll = rng.next(); const pick = rng.int(modKeys.length) // always drawn, so later entries do not shift
    const modifier = !extra.miniboss && roll < (def.modChance || 0) ? modKeys[pick] : null
    entries.push({ mobId: `m${room.id}.${entries.length}`, mob: key, required, star, miniboss: !!extra.miniboss, modifier, position })
  }

  if (room.type === 'Boss') {
    const pool = Object.keys(CATALOG).sort().filter(k => {
      const d = CATALOG[k]
      return d.kind === 'miniboss' && d.floors[0] <= floor && floor <= d.floors[1] && !d.traits.includes('tomb') && !d.traits.includes('redstone_room')
    })
    const key = (pool.length ? rng.pick(pool) : rng.pick(mobPool(floor)))
    add(key, true, false, { miniboss: true, position: { x: round2(ctx.roomCenter.x), z: round2(ctx.roomCenter.z) } })
  } else {
    const pool = mobPool(floor)
    const extra = room.cells.length - 1
    const count = ({ perRoom, perExtraCell }) => { let n = rng.range(...perRoom); for (let i = 0; i < extra; i++) n += rng.range(...perExtraCell); return n }
    const stars = count(cfg.starMobs)
    const fillers = count(cfg.fillerMobs)
    for (let i = 0; i < stars; i++) add(rng.pick(pool), true, true)
    for (let i = 0; i < fillers; i++) add(rng.pick(pool), false, false)
  }
  return { roomId: room.id, floor, master: ctx.master, roomsExplored: ctx.exploredCells, entries }
}

// ---------------------------------------------------------------------------------------------------------------------
/**
 * @param ctx   as randomPlan plus `sidecar` = { mobs, size, floorYWorld } and `layoutRoom` = { blockMin, rotationQuarterTurns }
 */
function sidecarPlan (ctx) {
  const { room, floor, master } = ctx
  const block = ctx.sidecar.mobs
  const rng = derive(ctx.seed, 'room', room.id, 'mobs')
  const modKeys = Object.keys(MODIFIERS).sort()
  const geo = { origin: ctx.layoutRoom.blockMin, rot: ctx.layoutRoom.rotationQuarterTurns || 0, size: ctx.sidecar.size, floorY: ctx.sidecar.floorYWorld }
  const fallbackPool = mobPool(floor)

  // 1. which spawns exist on this floor / mode / roll. Every random value is drawn for every spawn, used or not, so editing one
  //    spawn (or a floor filter) does not reshuffle the others.
  const slots = block.spawns.map(s => {
    const roll = rng.next(); const draw = rng.next(); const modRoll = rng.next(); const modPick = rng.int(modKeys.length)
    const onFloor = !s.floors || (s.floors[0] <= floor && floor <= s.floors[1])
    const inMode = !s.modes || s.modes.includes(master ? 'master' : 'normal')
    const used = onFloor && inMode && roll < (s.chance ?? 1)
    let mob = s.mob
    if (mob === 'random') mob = fallbackPool.length ? fallbackPool[Math.floor(draw * fallbackPool.length)] : null
    else if (mob.startsWith('pool:')) { const list = block.pools[mob.slice(5)]; mob = list[Math.floor(draw * list.length)] }
    return { s, used: used && !!mob && !!CATALOG[mob], mob, modRoll, modPick }
  }).filter(x => x.used)

  // 2. stars, drawn from the list
  const from = block.star && block.star.from ? new Set(block.star.from) : null
  const canStar = x => x.s.star !== 'never' && CATALOG[x.mob].star && CATALOG[x.mob].kind === 'basic' && (!from || from.has(x.s.id))
  const stars = new Set(slots.filter(x => x.s.star === 'always' && CATALOG[x.mob].star).map(x => x.s.id))
  const want = countOf(block.star && block.star.count, rng, Math.min(slots.filter(canStar).length, 3))
  const candidates = rng.shuffle(slots.filter(x => canStar(x) && !stars.has(x.s.id)))
  for (const x of candidates) { if (stars.size >= want) break; stars.add(x.s.id) }

  // 3. entries, in the order of the file
  const entries = slots.map((x, i) => {
    const def = CATALOG[x.mob]
    const star = stars.has(x.s.id)
    const miniboss = def.kind === 'miniboss'
    const entry = {
      mobId: `m${room.id}.${i}`,
      spawnId: x.s.id,
      mob: x.mob,
      required: x.s.required ?? (star || miniboss),
      star,
      miniboss,
      modifier: !miniboss && x.modRoll < (def.modChance || 0) ? modKeys[x.modPick] : null,
      position: toWorld(x.s.pos, geo)
    }
    if (x.s.yaw !== undefined) entry.yaw = ((x.s.yaw + 90 * geo.rot) % 360 + 360) % 360
    return entry
  })
  return { roomId: room.id, floor, master, roomsExplored: ctx.exploredCells, entries }
}

/** Sidecar plan when the room has a usable block, the generic one otherwise. */
function planRoom (ctx) {
  return ctx.sidecar && ctx.sidecar.mobs && ctx.layoutRoom && ctx.layoutRoom.blockMin ? sidecarPlan(ctx) : randomPlan(ctx)
}

module.exports = { planRoom, sidecarPlan, randomPlan, toWorld, mobPool }
