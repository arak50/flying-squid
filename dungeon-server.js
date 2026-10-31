#!/usr/bin/env node
'use strict'
/**
 * Start a flying-squid server that serves a generated Catacombs floor.
 *
 *   node dungeon-server.js --seed 44900679 --floor 3
 *
 * Options
 *   --seed <n|text>        dungeon seed (numbers behave exactly like the HTML generator; text is hashed)   [random]
 *   --floor <0-7>          floor number                                                                     [0]
 *   --version <mc>         Minecraft version to serve, 1.13+ (flying-squid 1.12 supports up to 1.21.4)      [1.21.4]
 *   --port <n>             server port                                                                      [25565]
 *   --schematics <dir>     folder holding the room/door schematics                       [./dungeon-room-schematics]
 *   --lighting <mode>      calculated (dark, torches matter) | fullbright                                   [calculated]
 *   --open-doors           remove the plugs of wither / blood / entrance doors (normal doors are open already)
 *   --no-heads             leave out player/mob head blocks (by default they are sent with their textures)
 *   --skull-be-id <n>      override the skull block entity protocol id (default 16, valid for 1.21.2 - 26.1.x)
 *   --gamemode <0-3>       default game mode                                                                [1 = creative]
 *   --online               require Mojang authentication (default is offline mode)
 *   --dump <file.json>     write the layout (rooms, rotations, doors, spawn) to a JSON file
 *   --dry-run              generate, print the plan + stats, and exit without starting the server
 */
const path = require('path')
const fs = require('fs')
const generator = require('./catacombs-generator.js')

function parseArgs (argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const [k, inline] = a.slice(2).split('=')
    const bool = ['open-doors', 'no-heads', 'online', 'dry-run', 'help'].includes(k)
    o[k] = bool ? true : inline !== undefined ? inline : argv[++i]
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*\n/, '').replace(/^ \* ?/gm, '')); process.exit(0) }

const floor = Math.max(0, Math.min(7, parseInt(args.floor ?? '0', 10) || 0))
const seedArg = args.seed ?? String(Math.floor(Math.random() * 2 ** 31))
const dungeonSeed = generator.seedToInt(seedArg)
const version = args.version || '1.21.4'
const schematicsDir = path.resolve(args.schematics || path.join(__dirname, 'dungeon-room-schematics'))
if (!fs.existsSync(schematicsDir)) { console.error(`Schematics folder not found: ${schematicsDir}\nPass --schematics <dir> or put dungeon-room-schematics/ next to this script.`); process.exit(1) }

const genOptions = {
  dungeonSeed, floor, schematicsDir,
  lighting: args.lighting || 'calculated',
  openDoors: !!args['open-doors'],
  heads: !args['no-heads'],
  skullBlockEntityId: args['skull-be-id'] !== undefined ? parseInt(args['skull-be-id'], 10) : undefined
}

function report (dg) {
  const E = generator.exportLayout(dg)
  console.log(`\nCatacombs floor ${dg.floor}  seed ${seedArg}${String(dungeonSeed) !== String(seedArg) ? ` (=${dungeonSeed})` : ''}  grid ${E.gridWidth}x${E.gridHeight}`)
  console.log(generator.asciiPlan(dg))
  console.log('  E entrance  B blood  F fairy  Y boss  P puzzle  T trap  N normal   # wither/blood door  -|  normal door\n')
  for (const r of E.rooms) console.log(`  room ${String(r.id).padStart(2)}  ${r.type.padEnd(8)} ${r.shape.padEnd(8)} ${String(r.template).padEnd(22)} rot ${r.rotationQuarterTurns}  doors ${r.doorsRequired}${r.doorsAddedByGenerator ? ` (+${r.doorsAddedByGenerator} added)` : ''}`)
  console.log(`\n  door stats: ${JSON.stringify(dg.stats)}`)
  for (const w of E.warnings) console.log('  note: ' + w)
  console.log(`  spawn: ${dg.spawn.x} ${dg.spawn.y} ${dg.spawn.z}\n`)
  if (args.dump) { fs.writeFileSync(args.dump, JSON.stringify(E, null, 2)); console.log('  layout written to ' + args.dump) }
}

if (args['dry-run']) {
  const registry = require('prismarine-registry')(version)
  report(generator.buildDungeon(registry, { ...genOptions, log: console.log }))
  process.exit(0)
}

let builtDungeon = null // set when the generator finishes (may happen while the server is still being constructed)
const mcServer = require('flying-squid')
// prismarine-provider-anvil (2.13) has no 26.1 support and flying-squid builds it even when no world folder is used.
// Make that harmless: construction only fails if a save folder is actually requested.
try {
  const anvil = require(require.resolve('prismarine-provider-anvil', { paths: [path.dirname(require.resolve('flying-squid'))] }))
  const original = anvil.Anvil
  anvil.Anvil = registry => {
    try { return original(registry) } catch (e) {
      return class UnsupportedAnvil { constructor () { throw new Error(`Saving worlds is not supported on this version: ${e.message}`) } }
    }
  }
} catch (e) { /* provider not installed: nothing to wrap */ }
const defaults = require('flying-squid/config/default-settings.json')
const settings = {
  ...defaults,
  version,
  port: parseInt(args.port || defaults.port, 10),
  'online-mode': !!args.online,
  logging: false,
  gameMode: parseInt(args.gamemode ?? '1', 10),
  'everybody-op': true,
  'version': '26.1',
  'plugins': {
    "hypixel-api": {
      "key": process.env.API_KEY,
      "sampleFile": "./apiresponsesample.json",
      "sampleMemberUuid": "88e266f9f6dd41028bda58e009ab1c3c",
      "sampleMode": "fallback"
    },
    "skyblock-stats": {},
    "skyblock-ui": {},
    "skyblock-core": {},
    "dungeon-map": {},
    "skyblock-teleport": {},
    "skyblock-resourcepack": { "url": "https://resourcepacks.hypixel.net/SkyBlock/d8e24365-a992-480e-a1dc-7e95688f0b15/84.zip" },
    "skyblock-vitals": {},
    "skyblock-speed":{},
    "mob-ai": { "activeRange": 32 }
  },
  worldFolder: undefined, // the dungeon is deterministic; nothing to persist (set a folder here to save player edits)
  motd: `Catacombs floor ${floor} seed ${seedArg}\nflying-squid`,
generation: {
  name: path.resolve(__dirname, 'catacombs-generator.js'),
  options: { ...genOptions, onBuilt: dg => { builtDungeon = dg; report(dg) } }
}
}
const server = mcServer.createMCServer(settings)
server.on('pluginsReady', () => {
const { Vec3 } = require('vec3')
// the dungeon-map plugin reads the floor from here when a "dungeonStart" event carries no layout of its own
server.dungeon = { get layout () { return builtDungeon ? generator.exportLayout(builtDungeon) : null } }
// our spawn replaces flying-squid's random surface search (there is no surface here)
server.getSpawnPoint = async () => { const s = builtDungeon ? builtDungeon.spawn : { x: 0, y: 70, z: 0 }; return new Vec3(s.x, s.y, s.z) }
})
// flying-squid always sends `blockEntities: []` in map_chunk, so player heads would be invisible. Fill the list in on the way out.
server.on('newPlayer', player => {
const client = player._client; const write = client.write.bind(client)
client.write = (name, params) => {
  if (name === 'map_chunk' && builtDungeon && params && params.blockEntities && params.blockEntities.length === 0) {
    const list = builtDungeon.blockEntitiesFor(params.x, params.z)
    if (list.length) params = { ...params, blockEntities: list }
  }
  return write(name, params)
}
})
server.on('listening', port => console.log(`Server listening on port ${port} (Minecraft ${version}${settings['online-mode'] ? '' : ', offline mode'})`))
server.on('error', e => { console.error(e); process.exit(1) })
