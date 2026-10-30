/**
 * skyblock-teleport — Aspect of the End / Aspect of the Void teleports, as on Hypixel SkyBlock.
 *
 * Hold an AOTE/AOTV (SkyBlock id from the item's custom_data) and right-click:
 *   Instant Transmission  right-click                    teleports `8 (+tuned_transmission)` blocks along your look
 *   Ether Transmission    sneak + right-click, AOTE/AOTV with ethermerge: 1
 *                         teleports onto the block you're looking at, up to `57 (+tuned_transmission)` blocks
 * Behaviour (distances, block snapping, landing heights, relative/absolute look in the position packet) is taken from
 * Skyblocker's teleport code and checked against a real protocol capture: see test/replay-capture.js.
 *
 * Costs are stubs: serv.skyblockTeleport.hooks.canUse / onUse always allow (mana, cooldowns, zone restrictions go there).
 *
 *   serv.skyblockTeleport.items        the item table (lib/abilities.js) — add rows to support more items
 *   serv.skyblockTeleport.hooks        { canUse(player, ability) -> bool|Promise<bool>, onUse(player, ability, result) }
 *   serv.skyblockTeleport.use(player)  run the held item's teleport as if the player right-clicked
 *   serv.on('skyblock:teleport', (player, { kind, from, to, itemId }))
 *
 * config: "skyblock-teleport": { "delayMs": 0, "landingYOffset": 0.05, "messages": { "blocked": null, "noTarget": null } }
 */
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { classify } = require('./lib/blocks')
const { TELEPORT_ITEMS, resolveAbility } = require('./lib/abilities')
const { instantDestination, etherDestination } = require('./lib/raycast')

const EYE_STANDING = 1.62
const EYE_SNEAKING = 1.27

/** Simplified ExtraAttributes of a live prismarine item (26.1 stores them in the custom_data component). */
function extraAttributes (item) {
  if (!item || !item.components) return null
  const c = item.components.find(c => c.type === 'custom_data')
  if (!c) return null
  try { return nbt.simplify(c.data) } catch (e) { return null }
}

module.exports.server = function (serv) {
  const settings = Object.assign({ delayMs: 0, landingYOffset: 0.05, messages: {} }, this.settings || {})

  const api = serv.skyblockTeleport = {
    items: TELEPORT_ITEMS,
    // STUBS — mana cost, cooldowns and "not allowed here" zones plug in here. Unlimited use for now.
    hooks: {
      canUse: (player, ability) => true,
      onUse: (player, ability, result) => {}
    },
    classify,
    extraAttributes,

    /** Block info (air / through / floor) at a block position, cached per teleport by the caller. */
    makeInfo (world) {
      const cache = new Map()
      return async (x, y, z) => {
        const key = x + ',' + y + ',' + z
        let v = cache.get(key)
        if (!v) {
          let block = null
          try { block = await world.getBlock(new Vec3(x, y, z)) } catch (e) { /* unloaded: solid */ }
          v = classify(block)
          cache.set(key, v)
        }
        return v
      }
    },

    /** Which teleport (if any) the player's held item would do right now. */
    abilityFor (player) {
      const held = player.inventory && player.inventory.slots[36 + (player.heldItemSlot || 0)]
      const extra = extraAttributes(held)
      if (!extra || !extra.id) return null
      return resolveAbility(api.items, extra.id, extra, !!player.crouching)
    },

    /** Run the held item's teleport. `rotation` = { yaw, pitch } in degrees (the use_item packet's); defaults to the player's. */
    async use (player, rotation) {
      const ability = api.abilityFor(player)
      if (!ability) return null
      if (!(await api.hooks.canUse(player, ability))) return null

      const sneaking = !!player.crouching
      const eyeHeight = sneaking ? EYE_SNEAKING : EYE_STANDING
      const yaw = rotation ? rotation.yaw : player.yaw * 360 / 256
      const pitch = rotation ? rotation.pitch : player.pitch * 360 / 256
      const pos = player.position
      const info = api.makeInfo(player.world)

      let dest = null
      let absoluteLook = false
      if (ability.kind === 'ether') {
        const r = await etherDestination(info, { pos, eyeHeight, yaw, pitch, range: ability.range, landingYOffset: settings.landingYOffset })
        if (r.error) { if (settings.messages[r.error]) player.chat(settings.messages[r.error]); return null }
        dest = r.dest
        absoluteLook = true // the capture shows ether sends the look as an absolute rotation, instant as a zero relative one
      } else {
        dest = await instantDestination(info, { pos, eyeHeight, yaw, pitch, distance: ability.range })
        if (!dest) { if (settings.messages.noTarget) player.chat(settings.messages.noTarget); return null }
      }

      const from = pos.clone()
      if (settings.delayMs > 0) await new Promise(resolve => setTimeout(resolve, settings.delayMs))
      await player.sendPosition(dest, false, true) // updates the server-side position and tells nearby players
      player.position = dest
      player.sbTeleportId = (player.sbTeleportId || 100) + 1
      player._client.write('position', {
        teleportId: player.sbTeleportId,
        x: dest.x,
        y: dest.y,
        z: dest.z,
        dx: 0,
        dy: 0,
        dz: 0,
        yaw: absoluteLook ? yaw : 0,
        pitch: absoluteLook ? pitch : 0,
        flags: absoluteLook ? {} : { yaw: true, pitch: true } // relative yaw/pitch with a 0 delta keeps the client's look (0x18)
      })

      const result = { kind: ability.kind, from, to: dest, itemId: ability.itemId, range: ability.range }
      api.hooks.onUse(player, ability, result)
      serv.emit('skyblock:teleport', player, result)
      return result
    }
  }
}

module.exports.player = function (player, serv) {
  // Right-clicking sends use_item (main hand) whether or not a block is targeted; block_place is deliberately ignored so a
  // click on a block doesn't teleport twice (the capture shows both packets for one click, and one teleport back).
  player._client.on('use_item', (packet) => {
    const p = packet || {}
    if (p.hand !== 'main_hand' && p.hand !== 0) return
    const rot = p.rotation ? { yaw: p.rotation.x, pitch: p.rotation.y } : undefined
    serv.skyblockTeleport.use(player, rot).catch(e => serv.err?.(`[skyblock-teleport] ${e.stack || e}`))
  })
}
