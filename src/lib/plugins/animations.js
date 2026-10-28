module.exports.player = function (player, serv) {
  player._client.on('arm_animation', () =>
    player.behavior('punch', {}, () => {
      player._writeOthersNearby('animation', {
        entityId: player.id,
        animation: 0
      })
    })
  )

  // Entity flags (metadata 0, a bitmask: 0x02 crouching, 0x08 sprinting) and, from 1.14, the pose (metadata 6: 5 = crouching).
  // Sprinting and crouching must be combined into one byte; writing them separately made each cancel the other.
  const FLAG_CROUCHING = 0x02
  const FLAG_SPRINTING = 0x08
  const modernMetadata = serv.registry.version['>=']('1.20.2')
  player.metaFlags = player.metaFlags || 0
  player.crouching = false

  function sendEntityState () {
    const data = [{ key: 0, type: modernMetadata ? 'byte' : 0, value: player.metaFlags }]
    if (modernMetadata) data.push({ key: 6, type: 'pose', value: player.crouching ? 5 : 0 })
    player.setAndUpdateMetadata(data)
  }

  function setSprinting (sprinting) {
    player.metaFlags = sprinting ? (player.metaFlags | FLAG_SPRINTING) : (player.metaFlags & ~FLAG_SPRINTING)
    sendEntityState()
  }

  function setCrouching (crouching) {
    player.crouching = crouching
    player.metaFlags = crouching ? (player.metaFlags | FLAG_CROUCHING) : (player.metaFlags & ~FLAG_CROUCHING)
    sendEntityState()
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
