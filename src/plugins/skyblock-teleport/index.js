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
 * Feedback (from the real-server capture, see lib/effects.js): Instant Transmission plays entity.enderman.teleport, Ether
 * Transmission plays entity.ender_dragon.hurt at pitch 0.54, both at the destination; a teleport with blocks in the way sends
 * the red chat line "There are blocks in the way!".
 *
 * Teleport sync (the "wrong location for other players" fix): after a teleport the server ignores the client's movement
 * packets until it sends back teleport_confirm for the teleport id (what vanilla does). Without that, packets the client
 * sent before it processed the teleport moved the player back and every other client saw them jump back and forth.
 * Uses of the item are also serialised per player, so rapid right-clicks always start from the last destination.
 *
 * Mana: every teleport costs what the held item's own tooltip says (lib/mana.js reads the "Mana Cost: N" line under the
 * "Ability: Instant Transmission" / "Ether Transmission" header of the item's lore, which already includes Ultimate Wise etc.;
 * the sample Warped AOTV says 19 / 74 and the recorded mana drops are exactly that). An item without such a line falls back to
 * the table in lib/abilities.js (AOTE 50, AOTV 45 instant; 90 ether, unverified). Mana is taken through
 * player.skyblock.useMana (skyblock-vitals): too little mana means no teleport and the action bar shows NOT ENOUGH MANA.
 * It is charged only once the destination is valid, so "There are blocks in the way!" costs nothing (UNVERIFIED: the
 * recording has no blocked attempt with a mana reading), and it is refunded if another plugin cancels the move.
 * Without skyblock-vitals (no player.skyblock.useMana) teleports are free, with one warning in the log.
 * Not charged: the Soulflow cost the Ether tooltip also lists (the repo has no Soulflow); it is reported as result.soulflow.
 *
 * Other costs (cooldowns, zone restrictions) plug into the hooks:
 *   serv.skyblockTeleport.items        the item table (lib/abilities.js) — add rows to support more items
 *   serv.skyblockTeleport.hooks        { canUse(player, ability) -> bool|Promise<bool>,
 *                                        manaCost(player, ability, cost) -> number   (change/waive the tooltip cost),
 *                                        onUse(player, ability, result) }
 *   serv.skyblockTeleport.use(player)  run the held item's teleport as if the player right-clicked
 *   serv.on('skyblock:teleport', (player, { kind, from, to, itemId, mana, soulflow }))
 *
 * config: "skyblock-teleport": { "delayMs": 0, "landingYOffset": 0.05, "confirmTimeoutMs": 1000, "confirmRetries": 4,
 *           "mana": { "enabled": true },
 *           "messages": { "blocked": "There are blocks in the way!", "noTarget": null, "color": "red" },
 *           "sounds": { "enabled": true, "radius": 32, "idOffset": -1, "instant": {...}, "ether": {...} } }
 */
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { classify } = require('./lib/blocks')
const { TELEPORT_ITEMS, resolveAbility } = require('./lib/abilities')
const { abilityCostsOf } = require('./lib/mana')
const { instantDestination, etherDestination } = require('./lib/raycast')
const { mergeSounds, mergeMessages, playTeleportSound, sendMessage } = require('./lib/effects')

const EYE_STANDING = 1.62
const EYE_SNEAKING = 1.27
const FIRST_TELEPORT_ID = 100 // core's sendSelfPosition uses id 1; ours start well clear of it

/** Simplified ExtraAttributes of a live prismarine item (26.1 stores them in the custom_data component). */
function extraAttributes (item) {
  if (!item || !item.components) return null
  const c = item.components.find(c => c.type === 'custom_data')
  if (!c) return null
  try { return nbt.simplify(c.data) } catch (e) { return null }
}

// degrees -> the byte angle (1/256 turn) the rest of flying-squid stores in entity.yaw / entity.pitch
function toByteAngle (deg) {
  let b = Math.floor((deg % 360) * 256 / 360)
  if (b < -128) b += 256
  else if (b > 127) b -= 256
  return b
}

module.exports.server = function (serv) {
  const user = this.settings || {}
  const settings = Object.assign({ delayMs: 0, landingYOffset: 0.05, confirmTimeoutMs: 1000, confirmRetries: 4 }, user, {
    messages: mergeMessages(user.messages),
    sounds: mergeSounds(user.sounds),
    mana: Object.assign({ enabled: true }, user.mana)
  })
  let warnedNoVitals = false

  /** Per-player teleport bookkeeping: the unconfirmed teleport id (if any), its timer and the use() queue. */
  function stateOf (player) {
    if (!player.sbTp) player.sbTp = { nextId: FIRST_TELEPORT_ID, pendingId: null, timer: null, retries: 0, queue: Promise.resolve(), guarded: false }
    return player.sbTp
  }

  function release (player) {
    const st = stateOf(player)
    clearTimeout(st.timer)
    st.timer = null
    st.pendingId = null
    st.retries = 0
  }

  /**
   * Until the client confirms our teleport, drop its ordinary movement packets. They were sent from where it stood before
   * it saw the teleport, so applying them (as core's position handlers do) puts the player back at the old spot on the
   * server and tells everybody else they are back there. Installed lazily so it wraps the sendPosition core already set up.
   */
  function guardMovement (player) {
    const st = stateOf(player)
    if (st.guarded) return
    st.guarded = true
    const original = player.sendPosition
    player.sendPosition = function (position, onGround, teleport = false) {
      if (st.pendingId !== null && !teleport) return Promise.resolve()
      return original.call(this, position, onGround, teleport)
    }
  }

  /** Write the position packet for a teleport and start waiting for the client's confirmation. */
  function sendTeleportPacket (player, dest, { yaw, pitch, absoluteLook }) {
    const st = stateOf(player)
    const id = st.nextId++
    st.pendingId = id
    player._client.write('position', {
      teleportId: id,
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
    clearTimeout(st.timer)
    st.timer = setTimeout(() => {
      if (st.pendingId !== id) return
      if (st.retries < settings.confirmRetries && player.position) {
        // no confirm yet: keep ignoring the client's movement and send the current server position again (what vanilla does)
        st.retries++
        sendTeleportPacket(player, player.position, { yaw, pitch, absoluteLook })
      } else {
        // the client never answered: stop waiting, but resync it to the server position before trusting its movement again
        release(player)
        serv.warn?.(`[skyblock-teleport] ${player.username} did not confirm teleport ${id}; resyncing`)
        if (player.sendSelfPosition) player.sendSelfPosition()
      }
    }, settings.confirmTimeoutMs)
    if (st.timer.unref) st.timer.unref()
    return id
  }

  const api = serv.skyblockTeleport = {
    items: TELEPORT_ITEMS,
    // cooldowns and "not allowed here" zones plug in here (canUse); manaCost can change or waive the tooltip cost
    hooks: {
      canUse: (player, ability) => true,
      manaCost: (player, ability, cost) => cost,
      onUse: (player, ability, result) => {}
    },
    classify,
    extraAttributes,
    settings,

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
      const ability = resolveAbility(api.items, extra.id, extra, !!player.crouching)
      if (!ability) return null
      // what this very item's tooltip says it costs (null when it prints no such line: the table's defaultMana applies)
      const printed = abilityCostsOf(held)[ability.name]
      ability.manaCost = printed && printed.mana !== null ? printed.mana : null
      ability.soulflow = printed && printed.soulflow !== null ? printed.soulflow : null
      return ability
    },

    /** Mana this use costs: the item's printed cost, else the table's, then the manaCost hook. 0 = free. */
    async manaCostOf (player, ability) {
      if (!settings.mana.enabled) return 0
      const base = Number.isFinite(ability.manaCost) ? ability.manaCost : ability.defaultMana
      const cost = await api.hooks.manaCost(player, ability, Number.isFinite(base) ? base : 0)
      return Number.isFinite(cost) && cost > 0 ? cost : 0
    },

    /**
     * Take the mana for `ability`. Returns the amount taken (0 when it is free) or false when the player cannot pay, in which
     * case nothing was spent and skyblock-vitals shows NOT ENOUGH MANA.
     */
    async chargeMana (player, ability) {
      const cost = await api.manaCostOf(player, ability)
      if (cost === 0) return 0
      const sb = player.skyblock
      if (!sb || typeof sb.useMana !== 'function') {
        if (!warnedNoVitals) { warnedNoVitals = true; serv.warn?.('[skyblock-teleport] mana is enabled but skyblock-vitals is not active for this player: teleports are free') }
        return 0
      }
      return sb.useMana(cost, ability.name) ? cost : false
    },

    refundMana (player, amount) {
      const vitals = player.skyblock && player.skyblock.vitals
      if (amount > 0 && vitals && typeof vitals.addMana === 'function') vitals.addMana(amount)
    },

    /** True while a teleport sent to this player has not been confirmed yet (its movement packets are being ignored). */
    isAwaitingConfirm (player) {
      return !!player.sbTp && player.sbTp.pendingId !== null
    },

    /**
     * Run the held item's teleport. `rotation` = { yaw, pitch } in degrees (the use_item packet's); defaults to the player's.
     * Calls for the same player run one after another, so a fast right-click sequence chains from the previous destination.
     */
    use (player, rotation) {
      const st = stateOf(player)
      const run = st.queue.then(() => api._use(player, rotation))
      st.queue = run.catch(() => {})
      return run
    },

    async _use (player, rotation) {
      const ability = api.abilityFor(player)
      if (!ability) return null
      if (!(await api.hooks.canUse(player, ability))) return null
      guardMovement(player)

      const say = (key) => { if (settings.messages[key]) sendMessage(player, settings.messages[key], settings.messages.color) }

      const sneaking = !!player.crouching
      const eyeHeight = sneaking ? EYE_SNEAKING : EYE_STANDING
      const yaw = rotation ? rotation.yaw : player.yaw * 360 / 256
      const pitch = rotation ? rotation.pitch : player.pitch * 360 / 256
      const info = api.makeInfo(player.world)

      // The destination is worked out from the player's position, and the block lookups (and `delayMs`) take time during
      // which the client's movement packets keep arriving. Aim again from the newest position if it changed, so the hop
      // never starts from an outdated spot (a few tries; a player who is still walking uses the last one).
      let pos, dest, absoluteLook
      for (let attempt = 0; attempt < 3; attempt++) {
        pos = player.position.clone()
        absoluteLook = false
        if (ability.kind === 'ether') {
          const r = await etherDestination(info, { pos, eyeHeight, yaw, pitch, range: ability.range, landingYOffset: settings.landingYOffset })
          if (r.error) { say(r.error === 'no_target' ? 'noTarget' : 'blocked'); return null }
          dest = r.dest
          absoluteLook = true // the capture shows ether sends the look as an absolute rotation, instant as a zero relative one
        } else {
          dest = await instantDestination(info, { pos, eyeHeight, yaw, pitch, distance: ability.range })
          if (!dest) { say('blocked'); return null }
        }
        if (attempt === 0 && settings.delayMs > 0) await new Promise(resolve => setTimeout(resolve, settings.delayMs))
        if (player.position.equals(pos)) break // nothing moved the player while we were computing or waiting
      }
      const from = pos

      // Pay now that the hop is possible and before anything moves. Uses are queued per player, so two quick clicks can
      // never both spend the same mana.
      const paid = await api.chargeMana(player, ability)
      if (paid === false) return null

      const st = stateOf(player)
      const previousPending = st.pendingId
      st.pendingId = st.nextId // from here on the client's older movement packets must not move us (the real id is assigned when the packet is written)
      if (absoluteLook) { // others get the new look in the same entity_teleport
        player.yaw = toByteAngle(yaw)
        player.pitch = toByteAngle(pitch)
        player._writeOthersNearby('entity_head_rotation', { entityId: player.id, headYaw: player.yaw })
      }
      const moved = await player.sendPosition(dest, false, true) // updates the server-side position and tells nearby players
      if (moved !== true && !player.position.equals(dest)) { // another plugin cancelled the move; core already resent the real position
        st.pendingId = previousPending
        api.refundMana(player, paid)
        return null
      }
      player.position = dest
      sendTeleportPacket(player, dest, { yaw, pitch, absoluteLook })
      playTeleportSound(serv, player, ability.kind, dest, settings.sounds)

      const result = { kind: ability.kind, from, to: dest, itemId: ability.itemId, range: ability.range, mana: paid, soulflow: ability.soulflow || 0 }
      api.hooks.onUse(player, ability, result)
      serv.emit('skyblock:teleport', player, result)
      return result
    }
  }
}

module.exports.player = function (player, serv) {
  // The client acknowledges every position packet with teleport_confirm; only then are its movement packets trusted again.
  player._client.on('teleport_confirm', ({ teleportId } = {}) => {
    const st = player.sbTp
    if (!st || st.pendingId === null) return
    if (teleportId === st.pendingId) {
      clearTimeout(st.timer)
      st.timer = null
      st.pendingId = null
      st.retries = 0
    }
  })
  player._client.on('end', () => {
    if (player.sbTp) { clearTimeout(player.sbTp.timer); player.sbTp.pendingId = null }
  })

  // Right-clicking sends use_item (main hand) whether or not a block is targeted; block_place is deliberately ignored so a
  // click on a block doesn't teleport twice (the capture shows both packets for one click, and one teleport back).
  player._client.on('use_item', (packet) => {
    const p = packet || {}
    if (p.hand !== 'main_hand' && p.hand !== 0) return
    const rot = p.rotation ? { yaw: p.rotation.x, pitch: p.rotation.y } : undefined
    serv.skyblockTeleport.use(player, rot).catch(e => serv.err?.(`[skyblock-teleport] ${e.stack || e}`))
  })
}
