const Vec3 = require('vec3').Vec3
const UserError = require('../user_error')
const colors = require('colors')

module.exports.player = function (player, serv) {
  function attackEntity (entityId) {
    const attackedEntity = serv.entities[entityId]
    if (!attackedEntity || (attackedEntity.gameMode !== 0 && attackedEntity.type === 'player')) return

    player.behavior('attack', {
      attackedEntity,
      damageType: 'player_attack',
      cause: player,
      velocity: attackedEntity.position.minus(player.position).plus(new Vec3(0, 0.5, 0)).scaled(5)
    }, (o) => o.attackedEntity.takeDamage(o))
  }

  function resolveTarget (target) {
    if (!serv.entities[target]) {
      let dragon = target - 1
      while (dragon >= target - 7 && !serv.entities[dragon]) {
        dragon--
      }
      if (serv.entities[dragon] && serv.entities[dragon].entityType === 63) { target = dragon }
    }
    return target
  }

  // Before 26.1, attacks are use_entity packets with mouse === 1
  player._client.on('use_entity', ({ mouse, target } = {}) => {
    if (mouse === 1) { attackEntity(resolveTarget(target)) }
  })

  // 26.1+: attacks have their own packet, and use_entity is only used for interactions
  player._client.on('attack', ({ entityId } = {}) => {
    attackEntity(resolveTarget(entityId))
  })
}

// 1.19.4+ clients no longer know the old "take damage" animation id; hurt entities are shown with a damage_event
// packet {entityId, sourceTypeId, sourceCauseId, sourceDirectId}. sourceTypeId is the index of the damage type in the
// damage_type registry sent at login (resolved by name), cause/direct are entity id + 1 (0 = none).
function damageTypeIds (registry) {
  if (!registry.protocol?.play?.toClient?.types?.packet_damage_event) return null
  const entry = registry.loginPacket?.dimensionCodec?.['minecraft:damage_type']
  const list = Array.isArray(entry) ? entry : entry?.entries
  if (!Array.isArray(list)) return null
  const ids = {}
  list.forEach((e, i) => { ids[String(e.key).replace(/^minecraft:/, '')] = i })
  return ids
}

module.exports.entity = function (entity, serv) {
  // damageType: name of a vanilla damage type ('arrow', 'mob_attack', 'on_fire', ...), cause / direct: attacker and
  // projectile entities. All three are optional.
  entity.takeDamage = ({ sound = 'game.player.hurt', damage = 1, velocity = new Vec3(0, 0, 0), maxVelocity = new Vec3(4, 4, 4), animation = true, damageType = 'generic', cause = null, direct = null }) => {
    const wasAlive = entity.health > 0
    entity.updateHealth(entity.health - damage)
    serv.playSound(sound, entity.world, entity.position)

    entity.sendVelocity(velocity, maxVelocity)

    const ids = damageTypeIds(serv.registry)
    if (animation && ids) {
      entity._writeNearby('damage_event', {
        entityId: entity.id,
        sourceTypeId: ids[damageType] ?? ids.generic ?? 0,
        sourceCauseId: cause ? cause.id + 1 : 0,
        sourceDirectId: direct ? direct.id + 1 : (cause ? cause.id + 1 : 0)
      })
      if (wasAlive && entity.health <= 0) entity._writeNearby('entity_status', { entityId: entity.id, entityStatus: 3 })
      if (entity.health <= 0 && entity.type !== 'player') { delete serv.entities[entity.id] }
      return
    }

    if (entity.health <= 0) {
      if (animation) {
        entity._writeOthers('entity_status', {
          entityId: entity.id,
          entityStatus: 3
        })
      }
      if (entity.type !== 'player') { delete serv.entities[entity.id] }
    } else if (animation) {
      entity._writeOthers('animation', {
        entityId: entity.id,
        animation: 1
      })
    }
  }

  if (entity.type !== 'player') {
    entity.updateHealth = (health) => {
      entity.health = health
    }
  }
}

module.exports.server = function (serv) {
  serv.commands.add({
    base: 'kill',
    info: 'Kill entities',
    usage: '/kill <selector>|<player>',
    tab: ['player'],
    parse (str) {
      return str || false
    },
    action (sel, ctx) {
      if (sel !== '') {
        if (serv.getPlayer(sel) !== null) {
          serv.getPlayer(sel).takeDamage({ damage: 20 })
          serv.info(`Killed ${colors.bold(sel)}`)
        } else {
          const arr = serv.selectorString(sel)
          if (arr.length === 0) throw new UserError('Could not find player')
          arr.forEach(entity => {
            entity.takeDamage({ damage: 20 })
            serv.info(`Killed ${colors.bold(entity.type === 'player' ? entity.username : entity.name)}`)
          })
        }
      } else {
        if (ctx.player) ctx.player.takeDamage({ damage: 20 })
        else serv.err('Can\'t kill console')
      }
    }
  })
}
