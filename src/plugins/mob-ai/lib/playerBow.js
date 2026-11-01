'use strict'

const bow = require('./bow')

const HOTBAR_FIRST = 36 // window slot of hotbar slot 0
const AMMO_ORDER = [...Array(9).keys()].map(i => 36 + i).concat([...Array(27).keys()].map(i => 9 + i)) // hotbar then main inventory

/**
 * Player bows, vanilla rules:
 *  - holding right-click starts a draw (`use_item`), releasing (`block_dig` status 5) fires
 *  - power = (t^2 + 2t) / 3 for t = ticks / 20 capped at 1; below 0.1 nothing is fired
 *  - arrow speed = power * 3 blocks/tick, divergence 1.0, critical only at full power
 *  - base damage 2.0 (+0.5 * level + 0.5 with Power), Punch / Flame / Infinity honoured
 *  - one arrow is used per shot unless the player is in creative mode or the bow has Infinity
 */
function attachPlayerBow (player, serv, manager) {
  const { registry } = serv
  const bowItemId = registry.itemsByName.bow && registry.itemsByName.bow.id
  const arrowItemId = registry.itemsByName.arrow && registry.itemsByName.arrow.id
  if (bowItemId === undefined || arrowItemId === undefined) return
  let drawing = null // { startTick, slot }

  const heldItem = () => player.inventory && player.inventory.slots[HOTBAR_FIRST + player.heldItemSlot]

  function findAmmo () {
    for (const slot of AMMO_ORDER) {
      const it = player.inventory.slots[slot]
      if (it && it.type === arrowItemId && it.count > 0) return slot
    }
    return -1
  }

  const canDraw = () => player.gameMode === 1 || findAmmo() !== -1

  player._client.on('use_item', ({ hand } = {}) => {
    if (hand !== undefined && hand !== 'main_hand' && hand !== 0) return
    const item = heldItem()
    if (!item || item.type !== bowItemId || !canDraw()) { drawing = null; return }
    drawing = { startTick: serv.tickCount, slot: player.heldItemSlot }
  })

  player._client.on('held_item_slot', () => { drawing = null }) // switching items cancels the draw

  player._client.on('block_dig', ({ status } = {}) => {
    if (status !== 5 || !drawing) return
    const d = drawing
    drawing = null
    release(d)
  })

  function release (d) {
    if (player.heldItemSlot !== d.slot) return
    const item = heldItem()
    if (!item || item.type !== bowItemId) return
    const creative = player.gameMode === 1
    const ammoSlot = findAmmo()
    if (!creative && ammoSlot === -1) return

    const power = bow.powerForTicks(serv.tickCount - d.startTick)
    if (power < bow.MIN_POWER) return

    const ench = bow.bowEnchants(item)
    const dir = bow.directionFromAngles(player.yaw * 360 / 256, player.pitch * 360 / 256) // yaw/pitch are stored as 1/256 turns
    const velocity = bow.aimVelocity(dir, power * bow.FULL_DRAW_SPEED, 1.0)
    const infinite = ench.infinity > 0
    const arrow = manager.projectiles.shoot({
      owner: player,
      world: player.world,
      origin: player.position.offset(0, 1.62 - 0.1, 0),
      velocity,
      baseDamage: bow.baseDamageForPower(ench.power),
      critical: power >= 1,
      punch: ench.punch,
      flame: ench.flame > 0,
      pickup: creative || infinite ? 'creative' : 'allowed'
    })
    if (!arrow) return // entity limit reached: keep the arrow

    manager.projectiles.sound(player.world, player.position, 'entity.arrow.shoot', {
      volume: 1,
      pitch: 1 / (Math.random() * 0.4 + 1.2) + power * 0.5,
      category: 7,
      whitelist: undefined
    })

    if (!creative && !infinite) {
      const ammo = player.inventory.slots[ammoSlot]
      ammo.count--
      player.inventory.updateSlot(ammoSlot, ammo.count > 0 ? ammo : undefined)
    }
    serv.emit('bowShot', { player, power, arrow })
  }
}

module.exports = { attachPlayerBow }
