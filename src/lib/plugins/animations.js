module.exports.player = function (player, serv) {
  player._client.on('arm_animation', () =>
    player.behavior('punch', {}, () => {
      player._writeOthersNearby('animation', {
        entityId: player.id,
        animation: 0
      })
    })
  )

  function setSprinting (sprinting) {
    player.setAndUpdateMetadata([{ key: 0, type: 0, value: sprinting ? 0x08 : 0x00 }])
  }

  function setCrouching (crouching) {
    player.setAndUpdateMetadata([{ key: 0, type: 0, value: crouching ? 0x02 : 0x00 }])
    player.crouching = crouching
  }

  // Depending on the protocol version the action id is either a number or a mapped name
  const legacyActionNames = { 0: 'start_sneaking', 1: 'stop_sneaking', 3: 'start_sprinting', 4: 'stop_sprinting' }

  player._client.on('entity_action', ({ actionId } = {}) => {
    const action = typeof actionId === 'string' ? actionId : legacyActionNames[actionId]
    if (action === 'start_sprinting') {
      setSprinting(true)
    } else if (action === 'stop_sprinting') {
      setSprinting(false)
    } else if (action === 'start_sneaking') {
      setCrouching(true)
    } else if (action === 'stop_sneaking') {
      setCrouching(false)
    }
  })

  // 1.21.6+: sneaking is no longer part of entity_action and is sent as part of the player's input state
  if (serv.registry.version['>=']('1.21.6')) {
    player._client.on('player_input', ({ inputs } = {}) => {
      const sneaking = !!inputs?.shift
      if (sneaking !== player.crouching) setCrouching(sneaking)
    })
  }
}
