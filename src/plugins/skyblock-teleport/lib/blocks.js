'use strict'
// Block classification used by the teleport raycasts. Everything is derived from the registry's collision shapes
// (prismarine-block `block.shapes` = [[minX, minY, minZ, maxX, maxY, maxZ], ...]); nothing is hard-coded per block id
// except the few special cases Skyblocker documents (carpets, flower pots, cobwebs, <=3 snow layers, mud).

const AIR = new Set(['air', 'cave_air', 'void_air'])

function maxY (shapes) {
  let m = 0
  for (const b of shapes || []) m = Math.max(m, b[4])
  return m
}

function snowLayers (block) {
  try {
    const p = block.getProperties ? block.getProperties() : null
    if (p && p.layers !== undefined) return Number(p.layers)
  } catch (e) { /* fall through */ }
  return 1
}

/**
 * Reduce a prismarine block to the four facts the raycasts need.
 *   air      — literally air (the two blocks above an etherwarp target must be this)
 *   through  — a teleport may pass through it: air, no collision shape, carpet, flower pot, cobweb, snow <= 3 layers
 *   floor    — a full-height block (collision top >= 1) or mud
 */
function classify (block) {
  if (!block) return { air: false, through: false, floor: false } // unloaded / unknown: treat as solid
  const name = block.name
  const shapes = block.shapes || []
  const air = AIR.has(name)
  const empty = air || shapes.length === 0 || block.boundingBox === 'empty'
  const through = empty ||
    name.endsWith('_carpet') || name === 'moss_carpet' ||
    name === 'flower_pot' || name.startsWith('potted_') ||
    name === 'cobweb' ||
    (name === 'snow' && snowLayers(block) <= 3)
  const floor = !empty && (maxY(shapes) >= 1 || name === 'mud')
  return { air, through, floor }
}

module.exports = { classify }
