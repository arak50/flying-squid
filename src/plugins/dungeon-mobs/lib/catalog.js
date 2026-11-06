'use strict'
/**
 * Catacombs mob catalogue, transcribed from the SkyBlock wiki "Catacombs Mobs" page.
 *
 *   entity      vanilla entity type used for the body (Hypixel uses player skins for the humanoids; zombie is the stand-in)
 *   kind        'basic' | 'miniboss' | 'special'
 *   star        true when the mob can carry a ✯ in a normal room (a "star mob"). Mobs that only appear through
 *               a mechanic (tombs, secrets, merging skeletons, puzzle rooms ...) are never starred.
 *   floors      [first, last] floor the mob spawns on, 0 = Entrance, 1-7 = F1-F7. Master mode (M1-M7) reuses them.
 *   level       [lowest, highest] level shown in the nametag
 *   health      [lowest, highest] base health. Lowest = first floor it appears on, highest = last master floor.
 *   damage      [lowest, highest] (kept as data for the combat layer)
 *   defense     number or [lowest, highest]
 *   modChance   chance of a random modifier prefix (spiders have a higher one)
 *   traits      free-form behaviour tags for the AI / combat layer to read
 */
const basic = (name, entity, floors, level, health, damage, extra = {}) =>
  ({ name, entity, kind: 'basic', star: true, floors, level, health, damage, defense: 0, modChance: 0.05, traits: [], ...extra })
const mini = (name, entity, floors, level, health, damage, extra = {}) =>
  ({ name, entity, kind: 'miniboss', star: false, floors, level, health, damage, defense: 100, modChance: 0, traits: [], ...extra })
const special = (name, entity, floors, level, health, damage, extra = {}) =>
  ({ name, entity, kind: 'special', star: false, floors, level, health, damage, defense: 0, modChance: 0, traits: [], ...extra })

const mobs = {
  // ---- zombies ----
  crypt_lurker: basic('Crypt Lurker', 'zombie', [0, 7], [47, 395], [9000, 13e6], [291, 72000], { traits: ['bone_throw'] }),
  zombie_grunt: basic('Zombie Grunt', 'zombie', [0, 2], [40, 286], [7000, 3e6], [201, 21600]),
  zombie_soldier: basic('Zombie Soldier', 'zombie', [3, 7], [94, 463], [77000, 36e6], [738, 111600], { traits: ['enrage'] }),
  zombie_knight: basic('Zombie Knight', 'zombie', [3, 7], [104, 477], [93500, 40e6], [1026, 133200], { traits: ['heal_on_hit'] }),
  zombie_commander: basic('Zombie Commander', 'zombie', [6, 7], [221, 613], [1.7e6, 250e6], [5632, 256000], { traits: ['whip'] }),
  zombie_lord: basic('Zombie Lord', 'zombie', [7, 7], [298, 630], [5e6, 300e6], [18000, 288000]),
  tank_zombie: basic('Tank Zombie', 'zombie', [0, 3], [23, 192], [1200, 160000], [201, 22500], { defense: [2000, 2300], traits: ['knockback_immune'] }),
  super_tank_zombie: basic('Super Tank Zombie', 'zombie', [4, 7], [67, 277], [20000, 1.05e6], [2320, 48000], { defense: 2500, traits: ['knockback_immune'] }),

  // ---- skeletons ----
  scared_skeleton: basic('Scared Skeleton', 'skeleton', [0, 2], [48, 298], [12000, 3.3e6], [226, 27000], { traits: ['flees_when_low'] }),
  skeleton_grunt: basic('Skeleton Grunt', 'skeleton', [0, 3], [49, 349], [14000, 6e6], [226, 54000], { traits: ['bow', 'fast_shot'] }),
  skeleton_soldier: basic('Skeleton Soldier', 'skeleton', [1, 7], [61, 449], [22400, 28e6], [324, 108000], { traits: ['bow'] }),
  skeleton_master: basic('Skeleton Master', 'skeleton', [2, 7], [82, 496], [31200, 42e6], [945, 182000], { traits: ['bow', 'wither_skull'] }),
  skeleton_lord: basic('Skeleton Lord', 'skeleton', [7, 7], [271, 573], [2e6, 120e6], [21600, 270000], { traits: ['bow'] }),
  super_archer: basic('Super Archer', 'skeleton', [4, 7], [133, 578], [240000, 200e6], [1526, 176000], { traits: ['bow', 'bouncing_arrows'] }),
  sniper: basic('Sniper', 'skeleton', [0, 7], [54, 515], [9000, 36e6], [503, 306000], { traits: ['bow', 'stationary', 'long_range'] }),
  crypt_souleater: basic('Crypt Souleater', 'skeleton', [0, 7], [53, 429], [13000, 20e6], [327, 99000], { traits: ['bow', 'wither_skull', 'strafes'] }),
  crypt_dreadlord: basic('Crypt Dreadlord', 'skeleton', [0, 7], [54, 431], [14000, 20e6], [327, 102600], { traits: ['bow', 'wither_skull'] }),
  withermancer: basic('Withermancer', 'wither_skeleton', [4, 7], [131, 573], [180000, 150e6], [1879, 216000], { traits: ['wither_skull_homing'], magicResist: 0.9 }),

  // ---- spiders ----
  lonely_spider: basic('Lonely Spider', 'spider', [0, 7], [31, 315], [3500, 2e6], [176, 70200], { modChance: 0.25, traits: ['leap'] }),
  cellar_spider: basic('Cellar Spider', 'spider', [0, 7], [58, 394], [17000, 9.5e6], [352, 97200], { modChance: 0.25, traits: ['ambush_from_door'] }),

  // ---- minibosses (one per brown room at most, or alone in the yellow room) ----
  lost_adventurer: mini('Lost Adventurer', 'zombie', [0, 7], [96, 860], [40000, 160e6], [226, 240000], { traits: ['bow', 'aotd', 'golden_apples'], variants: ['Young', 'Unstable', 'Holy', 'Superior'] }),
  angry_archaeologist: mini('Angry Archaeologist', 'zombie', [0, 7], [63, 673], [8500, 18e6], [201, 165600], { defense: [900, 1200], traits: ['healing_potions'] }),
  shadow_assassin: mini('Shadow Assassin', 'zombie', [3, 7], [196, 855], [385000, 145e6], [862, 210000], { defense: 0, traits: ['invisible_until_engaged', 'teleport_behind'] }),
  frozen_adventurer: mini('Frozen Adventurer', 'zombie', [4, 7], [189, 850], [285000, 160e6], [958, 180000], { traits: ['bow', 'freeze', 'thunderstorm'] }),
  redstone_warrior: mini('Redstone Warrior', 'zombie', [2, 7], [160, 860], [150000, 150e6], [712, 216000], { traits: ['redstone_room'] }),
  king_midas: mini('King Midas', 'zombie', [3, 7], [190, 716], [165000, 4.3e6], [1692, 18720], { traits: ['tomb', 'armor_breaks'] }),

  // The Watcher's guardians (blood room). [capture 2026-11-02] player bodies at scale 0.28 (0.2716 for Putrid, Psycho, Mute), each with its own
  // skin, health and gear. Health is the Entrance value; other floors scale like the rest ([assumed]).
  watcher_parasite: special('Parasite', 'zombie', [0, 7], [1, 1], [12000, 3e6], [0, 0], { nameColor: 'gold', traits: ['watcher'], scale: 0.28, armor: { mainhand: 'diamond_axe', chestplate: 'iron_chestplate', leggings: 'chainmail_leggings', boots: 'leather_boots' } }),
  watcher_putrid: special('Putrid', 'zombie', [0, 7], [1, 1], [20000, 4e6], [0, 0], { nameColor: 'gold', traits: ['watcher'], scale: 0.2716, armor: { mainhand: 'golden_sword', chestplate: 'iron_chestplate', leggings: 'leather_leggings', boots: 'leather_boots' } }),
  watcher_psycho: special('Psycho', 'zombie', [0, 7], [1, 1], [20000, 4e6], [0, 0], { nameColor: 'gold', traits: ['watcher'], scale: 0.2716, armor: { mainhand: 'golden_sword', chestplate: 'iron_chestplate', leggings: 'leather_leggings', boots: 'iron_boots' } }),
  watcher_reaper: special('Reaper', 'zombie', [0, 7], [1, 1], [20000, 4e6], [0, 0], { nameColor: 'gold', traits: ['watcher'], scale: 0.28, armor: { mainhand: 'golden_axe', chestplate: 'chainmail_chestplate', boots: 'iron_boots' } }),
  watcher_flamer: special('Flamer', 'zombie', [0, 7], [1, 1], [16000, 3.2e6], [0, 0], { nameColor: 'gold', traits: ['watcher'], scale: 0.28, armor: { mainhand: 'diamond_axe', chestplate: 'chainmail_chestplate', boots: 'chainmail_boots' } }),
  watcher_ooze: special('Ooze', 'zombie', [0, 7], [1, 1], [14000, 2.8e6], [0, 0], { nameColor: 'gold', traits: ['watcher'], scale: 0.28, armor: { mainhand: 'iron_axe', chestplate: 'chainmail_chestplate', leggings: 'iron_leggings', boots: 'iron_boots' } }),
  watcher_freak: special('Freak', 'zombie', [0, 7], [1, 1], [16000, 3.2e6], [0, 0], { nameColor: 'gold', traits: ['watcher'], scale: 0.28, armor: { mainhand: 'iron_sword', leggings: 'iron_leggings', boots: 'chainmail_boots' } }),
  watcher_mute: special('Mute', 'zombie', [0, 7], [1, 1], [12000, 2.4e6], [0, 0], { nameColor: 'gold', traits: ['watcher'], scale: 0.2716, armor: { chestplate: 'chainmail_chestplate', leggings: 'leather_leggings', boots: 'chainmail_boots' } }),

  // ---- mechanic-only mobs: never starred ----
  undead_skeleton: special('Undead Skeleton', 'skeleton', [0, 7], [74, 419], [25000, 12.8e6], [720, 126000], { traits: ['from_skull'] }),
  skeletor: special('Skeletor', 'skeleton', [3, 7], [149, 396], [250000, 10.2e6], [2848, 93600], { traits: ['merge', 'bone_throw'] }),
  skeletor_prime: special('Skeletor Prime', 'skeleton', [6, 7], [227, 451], [1515151, 20606060], [7680, 153600], { traits: ['merge'] }),
  crypt_undead: special('Crypt Undead', 'zombie', [0, 7], [89, 220], [45000, 800000], [936, 11700], { defense: 150, traits: ['tomb', 'bow'] }),
  prince: special('Prince', 'zombie', [0, 7], [91, 234], [60000, 1e6], [806, 14400], { defense: 175, traits: ['tomb', 'drops_revive_stone'] }),
  admin: special('Admin', 'zombie', [0, 7], [89, 220], [45000, 800000], [936, 11700], { defense: 150, traits: ['admin_room'] }),
  fels: special('Fels', 'enderman', [5, 7], [172, 563], [450000, 160e6], [3919, 168000], { traits: ['no_teleport'] }),
  mimic: special('Mimic', 'zombie', [6, 7], [231, 568], [1.5e6, 180e6], [8640, 162000], { traits: ['trapped_chest', 'baby'] }),
  deathmite: special('Deathmite', 'silverfish', [3, 7], [772, 864], [1e9, 1e9], [800000, 3e6], { traits: ['trap_room'] }),
  blaze: special('Blaze', 'blaze', [0, 7], [11, 27], [1000, 6499], [0, 0], { traits: ['passive', 'blaze_puzzle'] }),
  bat: special('Bat', 'bat', [0, 7], [1, 1], [100, 300], [0, 1], { traits: ['secret', 'airborne'] }),
  fairy: special('Fairy', 'allay', [0, 7], [1, 1], [4, 4], [0, 0], { traits: ['passive', 'fairy_room'] })
}

// Mobs Hypixel draws as players. `skin` is a key (or list: one is picked per spawn) of skins/skins.json; `fallback` is the
// vanilla body used when the skin is unknown or `players: false` is set in the plugin settings.
const PLAYER_SKINS = {
  lost_adventurer: ['lost_adventurer', 'lost_adventurer_1', 'lost_adventurer_2'],
  redstone_warrior: ['lost_adventurer', 'lost_adventurer_1', 'lost_adventurer_2'],
  angry_archaeologist: 'angry_archeologist',
  shadow_assassin: 'shadow_assassin',
  frozen_adventurer: 'frozen_adventurer',
  king_midas: 'king_midas',
  crypt_dreadlord: 'crypt_dreadlord',
  crypt_undead: 'crypt_undead',
  admin: 'crypt_undead',
  prince: 'prince_christian',
  zombie_commander: 'zombie_commander',
  skeletor_prime: 'skeletor_prime',
  watcher_parasite: 'watcher_parasite',
  watcher_putrid: 'watcher_putrid',
  watcher_psycho: 'watcher_psycho',
  watcher_reaper: 'watcher_reaper',
  watcher_flamer: 'watcher_flamer',
  watcher_ooze: 'watcher_ooze',
  watcher_freak: 'watcher_freak',
  watcher_mute: 'watcher_mute'
}
for (const [key, skin] of Object.entries(PLAYER_SKINS)) {
  mobs[key].fallback = mobs[key].entity
  mobs[key].entity = 'player'
  mobs[key].skin = skin
}

/** The five random nametag prefixes (non-boss, non-Watcher mobs). */
const modifiers = {
  healthy: { prefix: 'Healthy', healthMul: 1.3 },
  stormy: { prefix: 'Stormy' },
  speedy: { prefix: 'Speedy' },
  fortified: { prefix: 'Fortified', defenseMul: 1.1 },
  flaming: { prefix: 'Flaming' }
}

const normalise = s => String(s).toLowerCase().replace(/^minecraft:/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

module.exports = { mobs, modifiers, normalise }
