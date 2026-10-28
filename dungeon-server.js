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
 *   --skulls               keep player/mob head blocks (flying-squid cannot send their textures, so they render blank)
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
    const bool = ['open-doors', 'skulls', 'online', 'dry-run', 'help'].includes(k)
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
  skullBlocks: !!args.skulls
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
    "skyblock-resourcepack": { "url": "https://resourcepacks.hypixel.net/SkyBlock/d8e24365-a992-480e-a1dc-7e95688f0b15/84.zip" }
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
  // our spawn replaces flying-squid's random surface search (there is no surface here)
  server.getSpawnPoint = async () => { const s = builtDungeon ? builtDungeon.spawn : { x: -4, y: 72, z: -3 }; return new Vec3(s.x, s.y, s.z) }
})
server.on('listening', port => console.log(`Server listening on port ${port} (Minecraft ${version}${settings['online-mode'] ? '' : ', offline mode'})`))
server.on('error', e => { console.error(e); process.exit(1) })
