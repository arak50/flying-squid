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
  const serv = squid.createMCServer({
    ...settings,
    port,
    version,
    'online-mode': false,
    logging: false,
    gameMode: 0,
    difficulty: 1,
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
  out('server ready, mobAI present:', !!serv.mobAI)

  const bot = mineflayer.createBot({ host: 'localhost', port, username: 'Tester', version, auth: 'offline' })
  bot.on('error', e => errors.push('bot: ' + e.message))
  await new Promise((resolve, reject) => { bot.once('spawn', resolve); setTimeout(() => reject(new Error('bot spawn timeout')), 20000) })
  await sleep(1500)
  const base = bot.entity.position.clone()
  out('bot at', base.toString(), 'health', bot.health)

  const spawn = (name, dx, dz) => serv.spawnMob(registry.entitiesByName[name].id, serv.overworld, new Vec3(base.x + dx, base.y, base.z + dz))
  const near = spawn('cow', 6, 0)
  const far = spawn('pig', 60, 0)
  const zombie = spawn('zombie', -9, 0)
  const track = e => bot.entities[e.id]
  const startNear = near.position.clone()
  const startFar = far.position.clone()

  let maxNear = 0
  let sawFar = false
  const t0 = Date.now()
  while (Date.now() - t0 < 14000) {
    await sleep(500)
    maxNear = Math.max(maxNear, near.position.distanceTo(startNear))
    sawFar = sawFar || !!track(far)
  }

  const nearOnClient = track(near)
  out('cow (near) server moved', maxNear.toFixed(2), 'blocks; client sees it at', nearOnClient ? nearOnClient.position.toString() : 'NOT TRACKED', 'server', near.position.toString())
  out('pig (60 blocks away, beyond activeRange) moved', far.position.distanceTo(startFar).toFixed(3), 'client sees it:', sawFar)
  out('zombie dist to bot', zombie.position.distanceTo(bot.entity.position).toFixed(2), '| bot health', bot.health)
  out('mobAI stats', JSON.stringify(serv.mobAI.stats()))
  out('errors:', errors.length ? errors.slice(0, 3) : 'none')

  const problems = []
  if (maxNear < 0.5) problems.push('near cow never moved')
  if (far.position.distanceTo(startFar) > 0.01) problems.push('far pig moved (freeze failed)')
  if (!(bot.health < 20)) problems.push('zombie never damaged the bot')
  if (errors.length) problems.push('errors logged')
  out(problems.length ? 'PROBLEMS: ' + problems.join('; ') : 'PASS')

  bot.quit()
  await serv.destroy().catch(() => {})
  process.exit(problems.length ? 1 : 0)
})().catch(e => { console.error(`[${version}] FATAL`, e); process.exit(2) })
