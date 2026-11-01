// Integration check: real flying-squid server + real mineflayer client, plugin enabled.
// usage: node src/plugins/mob-ai/test/integration.js [version]   (run from the flying-squid checkout root)
// TEST-ONLY: the installed prismarine-provider-anvil@2.13.0 throws for 26.1 at startup; this run uses an
// in-memory world, so the provider is never instantiated. Stub it so the server can boot.
require('prismarine-provider-anvil').Anvil = () => class {}
const squid = require('flying-squid')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const settings = require(process.cwd() + '/config/default-settings.json')

const version = process.argv[2] || '26.1'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const out = (...a) => console.log(`[${version}]`, ...a)

;(async () => {
  const port = 25600 + Math.floor(Math.random() * 300)
  const registry = require('prismarine-registry')(version)
  const Item = require('prismarine-item')(registry)
  const serv = squid.createMCServer({
    ...settings,
    port,
    version,
    'online-mode': false,
    logging: false,
    gameMode: 0,
    difficulty: 2,
    worldFolder: undefined,
    generation: { name: 'superflat', options: {} },
    'max-entities': 200,
    plugins: { 'mob-ai': { activeRange: 24, hysteresis: 2 } }
  })
  const errors = []
  const origErr = serv.err?.bind(serv)
  serv.err = (m) => { errors.push(String(m)); origErr?.(m) }
  serv.on('error', e => errors.push(String(e)))

  await serv.waitForReady(15000)
  const bot = mineflayer.createBot({ host: 'localhost', port, username: 'Tester', version, auth: 'offline' })
  bot.on('error', e => errors.push('bot: ' + e.message))
  await new Promise((resolve, reject) => { bot.once('spawn', resolve); setTimeout(() => reject(new Error('bot spawn timeout')), 20000) })
  await sleep(1500)
  const base = bot.entity.position.clone()
  const player = serv.players[0]
  const problems = []
  const check = (ok, msg) => { if (!ok) problems.push(msg) }
  const spawn = (name, dx, dz) => serv.spawnMob(registry.entitiesByName[name].id, serv.overworld, new Vec3(base.x + dx, base.y, base.z + dz))
  out('bot at', base.toString(), 'health', bot.health)

  // ---- A: wandering and freezing ----------------------------------------------------------
  out('--- A: wander + distance freeze')
  const cow = spawn('cow', 6, 0)
  const pig = spawn('pig', 60, 0)
  const cowStart = cow.position.clone()
  const pigStart = pig.position.clone()
  let cowFar = 0
  // wandering starts at a vanilla-like 1/120 chance per tick (about 6 s on average), so wait up to 40 s for the first walk
  for (let i = 0; i < 80 && cowFar <= 0.5; i++) { await sleep(500); cowFar = Math.max(cowFar, cow.position.distanceTo(cowStart)) }
  out('cow moved', cowFar.toFixed(2), '| pig (60 blocks away) moved', pig.position.distanceTo(pigStart).toFixed(3))
  check(cowFar > 0.5, 'near cow never moved')
  check(pig.position.distanceTo(pigStart) < 0.01, 'far pig moved (freeze failed)')
  cow.destroy(); pig.destroy()

  // ---- B: the player's bow ------------------------------------------------------------------
  out('--- B: player bow (mob AI switched off, arrows must still fly)')
  serv.mobAI.setEnabled(false)
  player.inventory.updateSlot(36, new Item(registry.itemsByName.bow.id, 1))
  player.inventory.updateSlot(37, new Item(registry.itemsByName.arrow.id, 8))
  await sleep(400)
  bot.setQuickBarSlot(0)
  const target = spawn('cow', 0, 9)
  await sleep(1200) // lets it fall to the ground and settle
  const arrowCount = () => bot.inventory.items().filter(i => i.name === 'arrow').reduce((n, i) => n + i.count, 0)
  out('client sees bow:', bot.inventory.slots[36] && bot.inventory.slots[36].name, '| arrows:', arrowCount())
  check(bot.inventory.slots[36] && bot.inventory.slots[36].name === 'bow', 'bot does not hold the bow')
  const healthBefore = target.health
  const hurtPackets = []
  bot._client.on('damage_event', p => hurtPackets.push(p))
  const hurtEvents = []
  bot.on('entityHurt', e => hurtEvents.push(e.id))
  const shots = []
  serv.on('bowShot', s => shots.push(s))
  // with AI off the stock physics keeps the cow hopping, so aim at where it is right now (slightly high: arrows drop)
  const aim = () => bot.lookAt(target.position.offset(0, 1.1, 0), true)
  await aim()
  bot.activateItem()
  await sleep(1100) // > 20 ticks: full draw
  await aim()
  await sleep(50)
  bot.deactivateItem()
  await sleep(1500)
  out('shots', shots.length, '| power', shots[0] && shots[0].power.toFixed(2), '| arrows left (client)', arrowCount(), '| cow health', healthBefore, '->', target.health)
  check(shots.length === 1, 'expected exactly one arrow to be shot, got ' + shots.length)
  check(shots[0] && shots[0].power >= 0.99, 'not a full draw')
  check(arrowCount() === 7, 'arrow was not consumed (client sees ' + arrowCount() + ')')
  check(target.health < healthBefore, 'the arrow did not hurt the cow')
  const dmgTypes = require('minecraft-data')(version).loginPacket.dimensionCodec['minecraft:damage_type']
  const arrowType = (Array.isArray(dmgTypes) ? dmgTypes : dmgTypes.entries).findIndex(e => e.key === 'minecraft:arrow')
  const cowHurt = hurtPackets.filter(p => p.entityId === target.id)
  out('damage_event packets for the cow', cowHurt.length, '| type id', cowHurt[0] && cowHurt[0].sourceTypeId, '(arrow =', arrowType + ') | client entityHurt for cow:', hurtEvents.includes(target.id))
  check(cowHurt.length === 1 && cowHurt[0].sourceTypeId === arrowType, 'client did not get exactly one arrow damage_event for the cow')
  check(hurtEvents.includes(target.id), 'mineflayer never saw the cow get hurt')

  // a quick tap must not fire
  bot.activateItem(); await sleep(60); bot.deactivateItem(); await sleep(300)
  check(shots.length === 1, 'a tap fired an arrow')
  target.destroy()

  // ---- C: skeleton ----------------------------------------------------------------------------
  out('--- C: skeleton shoots the player')
  serv.mobAI.setEnabled(true)
  const seenArrows = new Set()
  bot.on('entitySpawn', e => { if (e.name === 'arrow') seenArrows.add(e.id) })
  const skeleton = spawn('skeleton', 11, 0)
  const healthStart = bot.health
  let sawBow = false
  let sawDraw = false
  let sawLower = false
  let sawAggressive = false
  const aiShots = []
  serv.on('mobAi:rangedAttack', s => aiShots.push(s))
  for (let i = 0; i < 44; i++) {
    await sleep(500)
    const e = bot.entities[skeleton.id]
    if (e) {
      if (e.equipment && e.equipment[0] && e.equipment[0].name === 'bow') sawBow = true
      if (e.metadata && (e.metadata[15] & 4)) sawAggressive = true // mob_flags 0x04: the arms-up bow pose
      const flag = e.metadata && e.metadata[8]
      if (flag === 1) sawDraw = true
      else if (sawDraw && flag === 0) sawLower = true
    }
    if (aiShots.length >= 4 && sawBow && sawLower && sawAggressive) break
  }
  out('skeleton shots', aiShots.length, '| arrow entities seen by client', seenArrows.size, '| bot health', healthStart, '->', bot.health)
  out('client saw bow in hand:', sawBow, '| draw pose:', sawDraw, '| lowered after:', sawLower, '| aggressive (bow-up pose) flag:', sawAggressive)
  out('skeleton distance to bot', skeleton.position.distanceTo(bot.entity.position).toFixed(1), '| mobAI stats', JSON.stringify(serv.mobAI.stats()))
  check(aiShots.length >= 2, 'skeleton shot fewer than 2 arrows')
  check(seenArrows.size >= 1, 'the client never saw an arrow entity')
  check(bot.health < healthStart, 'the skeleton never hurt the bot')
  check(sawBow, 'the client never saw the skeleton holding a bow')
  check(sawDraw && sawLower, 'the client never saw the draw pose go up and down')
  check(sawAggressive, 'the client never received the aggressive mob flag (mob_flags 0x04)')

  out('errors:', errors.length ? errors.slice(0, 3) : 'none')
  check(errors.length === 0, 'errors logged')
  out(problems.length ? 'PROBLEMS: ' + problems.join('; ') : 'PASS')

  bot.quit()
  await serv.destroy().catch(() => {})
  process.exit(problems.length ? 1 : 0)
})().catch(e => { console.error(`[${version}] FATAL`, e); process.exit(2) })
