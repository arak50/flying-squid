#!/usr/bin/env node
'use strict'
// Reduces the stat rules of SkyCrypt (https://github.com/SkyCryptWebsite/SkyCrypt, MIT) to JSON for skyblock-stats.
//   node tools/extract-skycrypt.js [path/to/SkyCrypt]        (default: ../SkyCrypt)
// Output: src/plugins/skyblock-stats/data/skycrypt/*.json  (+ LICENSE, meta.json). Re-run when SkyCrypt changes.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'SkyCrypt'))
const out = path.join(__dirname, '..', 'src', 'plugins', 'skyblock-stats', 'data', 'skycrypt')
// SkyCrypt's constants files import server-only modules (redis, ...) just for helpers, so they are evaluated in isolation:
// imports are dropped and every imported name becomes a harmless stub; only the plain `export const` data is kept.
const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : stub), apply: () => stub })
async function load (rel) {
  const text = fs.readFileSync(path.join(src, rel), 'utf8')
  const imported = []
  const body = text
    .replace(/^import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/gm, (m, names) => { imported.push(...names.replace(/[{}*]|\bas\b/g, ' ').split(/[\s,]+/).filter(Boolean)); return '' })
    .replace(/^export\s+(const|let|function|class)\s+/gm, '$1 ')
  const exported = [...text.matchAll(/^export\s+(?:const|let|function|class)\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1])
  const ctx = vm.createContext(Object.assign({ setInterval: () => 0, setTimeout: () => 0, console }, Object.fromEntries(imported.map(n => [n, stub]))))
  return vm.runInContext(`(async function(){${body}\nreturn {${exported.join(",")}}})()`, ctx)
}

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 1) + '\n')

  const { STATS_BONUS } = await load('common/constants/bonuses.js')
  const { HARP_QUEST, FORBIDDEN_STATS } = await load('common/constants/misc.js')
  const { POTION_EFFECTS } = await load('common/constants/potions.js')
  const lvl = await load('src/constants/leveling.js')
  const { PET_REWARDS } = await load('common/constants/rewards.js')
  const misc = await load('src/constants/misc.js')
  const pets = await load('src/constants/pets.js')
  const bestiary = await load('src/constants/bestiary.js')

  write('bonuses.json', STATS_BONUS) // per-level stat steps: skill_*, slayer_*, HOTM_perk_*
  write('misc.json', { harpQuest: HARP_QUEST, essenceShop: FORBIDDEN_STATS, centuryCakeStats: misc.CENTURY_CAKE_STATS })
  write('potions.json', Object.fromEntries(Object.entries(POTION_EFFECTS).map(([k, v]) => [k, { name: v.name, bonuses: v.bonuses }])))
  write('levels.json', { slayerXp: lvl.SLAYER_XP, dungeoneeringXp: lvl.DUNGEONEERING_XP })
  write('petScore.json', { petValue: pets.PET_VALUE, petRewards: PET_REWARDS, ignored: Object.entries(pets.PET_DATA).filter(([, d]) => d.ignoredInPetScoreCalculation).map(([k]) => k), maxLevel: Object.fromEntries(Object.entries(pets.PET_DATA).map(([k, d]) => [k, d.maxLevel])) })
  // Bestiary: only what the milestone needs - per family its bracket, cap and the mob ids whose kills are summed.
  write('bestiary.json', {
    brackets: bestiary.BESTIARY_BRACKETS,
    families: Object.values(bestiary.BESTIARY).flatMap(cat => cat.mobs.map(m => ({ name: m.name, bracket: m.bracket, cap: m.cap, mobs: m.mobs })))
  })

  fs.copyFileSync(path.join(src, 'LICENSE'), path.join(out, 'LICENSE'))
  let commit = null
  try { commit = fs.readFileSync(path.join(src, '.git', 'HEAD'), 'utf8').trim() } catch (e) {}
  write('meta.json', { generatedFrom: 'SkyCryptWebsite/SkyCrypt', license: 'MIT (see LICENSE)', head: commit, files: ['common/constants/{bonuses,misc,potions}.js', 'src/constants/{leveling,misc,pets,bestiary}.js'] })
  console.log('wrote', fs.readdirSync(out).join(', '))
})().catch(e => { console.error(e); process.exit(1) })
