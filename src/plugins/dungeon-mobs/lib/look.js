'use strict'

// NPCs turn to the nearest player. [capture] Hypixel sends `entity_look` + `entity_head_rotation` (head yaw = body yaw, angle bytes,
// onGround true) every 200 ms (4 ticks) for the Mort NPC; pitch goes from -43 to 0 bytes (he looks up at a player standing on the platform).

const EYE = 1.62 // eye height of a standing player model

// protocol angle byte (-128..127) for an angle in degrees
const angleByte = deg => { const b = Math.round(deg / 360 * 256); return ((b + 128) & 255) - 128 }

// Minecraft yaw (0 = +z, 90 = -x, 180 = -z) and pitch (negative looks up), in degrees, from `npc` feet to `target` feet
function lookAngles (npc, target, npcEye = EYE, targetEye = EYE) {
  const dx = target.x - npc.x; const dz = target.z - npc.z
  const dy = (target.y + targetEye) - (npc.y + npcEye)
  const flat = Math.hypot(dx, dz)
  return { yaw: flat < 1e-6 ? null : Math.atan2(-dx, dz) * 180 / Math.PI, pitch: -Math.atan2(dy, flat) * 180 / Math.PI }
}

// the nearest of `players` within `range` blocks (horizontal + vertical distance), or null
function nearest (pos, players, range) {
  let best = null; let bestD = range * range
  for (const p of players) {
    if (!p || !p.position) continue
    const d = (p.position.x - pos.x) ** 2 + (p.position.y - pos.y) ** 2 + (p.position.z - pos.z) ** 2
    if (d <= bestD) { best = p; bestD = d }
  }
  return best
}

module.exports = { EYE, angleByte, lookAngles, nearest }
