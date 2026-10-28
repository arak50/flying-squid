module.exports.server = function (serv) {
  let ticking = false
  serv.on('tick', function (delta) {
    if (ticking || delta > 1) { return }
    ticking = true
    Promise.all(
      Object.keys(serv.entities).map(async (id) => {
        const entity = serv.entities[id]
        if (entity.deathTime && Date.now() - entity.bornTime >= entity.deathTime) {
          entity.destroy()
          return
        } else if (entity.pickupTime && Date.now() - entity.bornTime >= entity.pickupTime) {
          const players = serv.getNearby({
            world: entity.world,
            position: entity.position,
            radius: 1.75 // Seems good for now
          })
          if (players.length) {
            players[0].collect(entity)
          }
        }
        if (!entity.velocity || !entity.size) return
        const { position, onGround } = await entity.calculatePhysics(delta)
        if (entity.type === 'mob' ||
          (entity.type === 'object' &&
            (
              entity.velocity.x !== 0 ||
              entity.velocity.y !== 0 ||
              entity.velocity.z !== 0
            )
          )) entity.sendPosition(position, onGround)
      })
    )
      .then(() => { ticking = false })
      .catch((err) => setTimeout(() => { throw err }, 0))
  })
}

module.exports.entity = function (entity, serv) {
  // 1.20.2+ writes the entry type as its name ('byte', 'pose', ...); older callers pass the numeric id
  const modern = serv.registry.version['>=']('1.20.2')
  let typeNames = null
  if (modern) {
    try { typeNames = serv.registry.protocol.types.entityMetadataEntry[1][1].type[1].mappings } catch { /* keep numeric */ }
  }
  entity.sendMetadata = (data) => {
    const metadata = typeNames ? data.map(e => ({ ...e, type: typeof e.type === 'number' ? typeNames[e.type] : e.type })) : data
    entity._writeOthersNearby('entity_metadata', {
      entityId: entity.id,
      metadata
    })
  }

  entity.setAndUpdateMetadata = (data) => {
    entity.metadata = data
    entity.sendMetadata(data)
  }
}
