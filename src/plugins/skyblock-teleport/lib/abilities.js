'use strict'
// Which held items teleport, and how. Rules from Skyblocker's TeleportOverlay (the same rules the real game applies):
//   ASPECT_OF_THE_END / ASPECT_OF_THE_VOID
//     sneaking + `ethermerge` == 1  -> Ether Transmission  (range 57 + tuned_transmission, lands on the targeted block)
//     otherwise                     -> Instant Transmission (range 8  + tuned_transmission, ahead of you)
//   (the packet capture confirms 8 blocks for the plain right-click on an AOTV)
// Add more items by adding rows (e.g. ETHERWARP_CONDUIT: ether only, ASPECT_OF_THE_LEECH_*: instant 3/4/5).

const TELEPORT_ITEMS = {
  ASPECT_OF_THE_END: { instant: { range: 8 }, ether: { range: 57, requiresEthermerge: true } },
  ASPECT_OF_THE_VOID: { instant: { range: 8 }, ether: { range: 57, requiresEthermerge: true } }
}

/**
 * Pick the ability for a held item.
 * @param {string} id        SkyBlock id (ExtraAttributes.id)
 * @param {object} extra     simplified ExtraAttributes
 * @param {boolean} sneaking
 * @returns {{ kind: 'instant'|'ether', range: number, itemId: string } | null}
 */
function resolveAbility (table, id, extra, sneaking) {
  const def = table[id]
  if (!def) return null
  const tuned = Number(extra && extra.tuned_transmission) || 0
  if (def.ether && sneaking && (!def.ether.requiresEthermerge || (extra && Number(extra.ethermerge) === 1))) {
    return { kind: 'ether', range: def.ether.range + tuned, itemId: id }
  }
  if (def.instant) return { kind: 'instant', range: def.instant.range + tuned, itemId: id }
  return null
}

module.exports = { TELEPORT_ITEMS, resolveAbility }
