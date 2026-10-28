const Vec3 = require('vec3')

module.exports.player = function (player, serv, { version }) {
  const Item = require('prismarine-item')(serv.registry)
  const windows = require('prismarine-windows')(serv.registry)

  player.heldItemSlot = 0
  player.inventory = windows.createWindow(1, 'minecraft:inventory', 'inv', 36)
  const clicks = require('../windowClicks')(Item)
  let drag = null
  let stateId = 0

  // Plugins can claim an inventory click (return true): it is not applied, the client is re-synced instead. skyblock-ui uses
  // this so clicking the SkyBlock Menu star opens the menu rather than picking the star up.
  player.inventoryClickFilters = player.inventoryClickFilters || []

  const OFFHAND = 45 // disabled, as on Hypixel (every window it sends has slot 45 empty)
  const win = player.inventory
  const rawUpdateSlot = win.updateSlot.bind(win)
  win.updateSlot = (slot, item) => {
    if (slot === OFFHAND) item = null
    // a stack made by a click inherits the components of the stack it came from (see windowClicks.adoptComponents)
    if (item && win._clickSources && !(item.components && item.components.length)) {
      const src = win._clickSources.find(s => s.type === item.type)
      if (src) clicks.adoptComponents(item, src)
    }
    return rawUpdateSlot(slot, item)
  }

  // Where the stack on the cursor was picked up, so an attempt to put it in the (disabled) offhand can hand it back there.
  let cursorOrigin = null
  function returnCursorItem () {
    const held = win.selectedItem
    if (!held) return
    let slot = cursorOrigin
    if (slot === null || slot === OFFHAND || win.slots[slot]) { // origin gone or taken: first free inventory slot, hotbar last (window order)
      slot = [...Array(27).keys()].map(i => 9 + i).concat([...Array(9).keys()].map(i => 36 + i)).find(i => !win.slots[i])
    }
    win.selectedItem = null
    if (slot !== undefined) win.updateSlot(slot, held)
    cursorOrigin = null
  }

  // swap item with offhand (the F key): not allowed, put the client's view back
  player._client.on('block_dig', ({ status } = {}) => { if (status === 6) player.resyncInventory() })

  // entity_equipment slot ids: 1.8 = hand 0, boots 1, legs 2, chest 3, head 4
  //                            1.9+ = main hand 0, OFF HAND 1, boots 2, legs 3, chest 4, head 5
  // (the old table below was 1.8 only, which put boots in the off hand on 1.9+)
  const modernEquipment = serv.registry.version['>=']('1.9')
  const ARMOR_EQUIPMENT = modernEquipment ? { 5: 5, 6: 4, 7: 3, 8: 2 } : { 5: 4, 6: 3, 7: 2, 8: 1 } // window slot -> equipment slot

  // The player IS the entity: spawn.js reads entity.equipment[<protocol slot>] and prismarine-entity's read-only `heldItem`
  // returns equipment[0] (assigning player.heldItem does nothing), so equipment[] is the single place the held item lives.
  if (!player.setEquipment) {
    player.setEquipment = (slot, item) => {
      player.equipment = player.equipment || []
      player.equipment[slot] = item || undefined
    }
  }
  const broadcastEquipment = (slot, item) => {
    if (serv.supportFeature('allEntityEquipmentInOne')) {
      player._writeOthersNearby('entity_equipment', { entityId: player.id, equipments: [{ slot, item: Item.toNotch(item) }] })
    } else {
      player._writeOthersNearby('entity_equipment', { entityId: player.id, slot, item: Item.toNotch(item) })
    }
  }

  // Send the whole inventory (and the cursor) to the client again. Used whenever a click cannot be applied here, so the
  // client's prediction can never silently differ from the server's inventory.
  player.resyncInventory = () => {
    stateId = (stateId + 1) & 0x7fff
    player._client.write('window_items', {
      windowId: 0,
      stateId,
      items: player.inventory.slots.map(it => Item.toNotch(it)),
      carriedItem: Item.toNotch(player.inventory.selectedItem)
    })
  }

  player._client.on('held_item_slot', ({ slotId } = {}) => {
    player.heldItemSlot = slotId
    player.setEquipment(0, player.inventory.slots[36 + slotId]) // hotbar lives at window slots 36-44
    broadcastEquipment(0, player.heldItem)
  })

  // Dynamic window ID feature (closing window)
  player._client.on('close_window', function (clickInfo) {
    // When window is closed we remove data about it from player
    player.windowType = ''
    player.windowPos = undefined
  })

  player._client.on('window_click', function (clickInfo) {
    // Clicks inside the SkyBlock menu window are handled by skyblockMenu.js and must
    // never be applied to the player's own inventory
    if (player.skyblockMenu && clickInfo.windowId === player.skyblockMenu.windowId) return

    if (clickInfo.windowId === 0) {
      if (player.inventoryClickFilters.some(f => f(clickInfo))) { player.resyncInventory(); return }
      // offhand is disabled: its slot, and the number-key "swap with offhand" (button 40)
      if (clickInfo.slot === OFFHAND || (clickInfo.mode === 2 && clickInfo.mouseButton === 40)) {
        returnCursorItem() // a stack being carried goes back to the slot it was picked up from
        player.resyncInventory()
        return
      }
    }

    // Do other stuff the inventory doesn't do, eg spawn the dropped item.
    // I've left in stuff that inventory handles, because the cancelling hooks
    // might go here (?)
    switch (clickInfo.mode) {
      case 0:
      case 1: // shift click: applied by the inventory (previously skipped, which desynced the client)
      case 2: // number keys: applied by the inventory (previously skipped)
        break

      case 3: // middle click (creative only): nothing to apply, restore the client's view
        player.resyncInventory()
        return

      case 4: {
        if (clickInfo.slot === -999) {
          // Click with nothing outside window. Do nothing.
        } else {
          // I'd love to implement this, but dropped entities are not finished.
          if (clickInfo.mouseButton === 0) {
            // Drop one item at slot
            // Inventory handles removing one

            const heldItem = player.inventory.slots[36 + player.heldItemSlot]
            serv.spawnObject(2, player.world, player.position, {
              velocity: new Vec3(0, 0, 0),
              itemId: heldItem.type,
              itemDamage: heldItem.metadata,
              pickupTime: 500,
              deathTime: 60 * 5 * 100
            })
          } else {
            // Drop full stack at slot
            // Inventory handles removing the whole stack
            return
          }
        }
        break
      }

      // Drag: collect the slots, apply when the drag ends (prismarine-windows does not implement it)
      case 5: {
        drag = clicks.dragPacket(player.inventory, drag, clickInfo)
        return
      }

      // Double click: gather matching stacks onto the cursor
      case 6: {
        clicks.doubleClick(player.inventory)
        return
      }
    }

    // Let the inventory know of the click.
    // It's important to let it know of the click later, because it destroys
    // information we need about the inventory.
    // prismarine-windows' shift-click / number-key / middle-click / drop read click.item (the stack in the clicked slot) and
    // do nothing without it; the 1.8-era packets carried it, current ones carry only hashes, so take it from our own state
    if (clickInfo.slot >= 0 && clickInfo.item === undefined) clickInfo.item = player.inventory.slots[clickInfo.slot]
    const cursorBefore = player.inventory.selectedItem
    const sources = [clickInfo.item, player.inventory.selectedItem].filter(i => i && i.components && i.components.length)
    player.inventory._clickSources = sources
    try {
      player.inventory.acceptClick(clickInfo)
      const cur = player.inventory.selectedItem
      if (!cursorBefore && cur && clickInfo.mode === 0) cursorOrigin = clickInfo.slot // picked up from here
      if (!cur) cursorOrigin = null
      if (cur && !(cur.components && cur.components.length)) {
        const src = sources.find(x => x.type === cur.type)
        if (src) clicks.adoptComponents(cur, src)
      }
    } catch (err) {
      serv.emit('error', err)
      player.resyncInventory()
    } finally {
      player.inventory._clickSources = null
    }
  })

  player._client.on('set_creative_slot', ({ slot, item } = {}) => {
    if (item.blockId === -1) {
      player.inventory.updateSlot(slot, undefined)
      return
    }

    const newItem = Item.fromNotch(item)
    player.inventory.updateSlot(slot, newItem)
  })

  player.inventory.on('updateSlot', function (slot, oldItem, newItem) {
    const equipments = { ...ARMOR_EQUIPMENT }
    equipments[36 + player.heldItemSlot] = 0 // the held item is a hotbar slot (window slots 36-44), not slot 0-8
    if (equipments[slot] !== undefined) {
      player.setEquipment(equipments[slot], newItem)
      broadcastEquipment(equipments[slot], newItem)
    }

    player._client.write('set_slot', {
      windowId: 0,
      slot,
      item: Item.toNotch(newItem)
    })
  })

  player.collect = (collectEntity) => {
    // Add it to a stack already in the player's inventory if possible
    for (let slot = 0; slot < player.inventory.slots.length; slot++) {
      const item = player.inventory.slots[slot]
      if (item && (item.type === collectEntity.itemId) && (item.count < item.stackSize)) {
        item.count += 1
        player.inventory.updateSlot(slot, item)
        collectEntity._writeOthersNearby('collect', {
          collectedEntityId: collectEntity.id,
          collectorEntityId: player.id
        })
        player.playSoundAtSelf('random.pop')
        collectEntity.destroy()
        return
      }
    }

    // If we couldn't add it to a already existing stack, put it in a new stack if the inventory has room
    const emptySlot = player.inventory.firstEmptyInventorySlot()
    if (emptySlot) {
      collectEntity._writeOthersNearby('collect', {
        collectedEntityId: collectEntity.id,
        collectorEntityId: player.id
      })
      player.playSoundAtSelf('random.pop')

      const newItem = new Item(collectEntity.itemId, 1, collectEntity.damage)
      player.inventory.updateSlot(emptySlot, newItem)
      collectEntity.destroy()
    }
  }
}
