'use strict'
/**
 * Every tunable number of the run logic lives here, each tagged with where it comes from:
 *
 *   [wiki]     the Catacombs mechanics report (Hypixel SkyBlock wiki)
 *   [capture]  observed in the Entrance packet capture
 *   [assumed]  nothing in the sources pins it down; a reasonable placeholder, change it freely
 *
 * Pass overrides as `config` to `new DungeonRun({ config })`, or as the plugin's `run` setting.
 */
const defaults = {
  tps: 20,

  countdownSeconds: 5, // [capture] "Starting in 5…4…"
  timeLimitSeconds: null, // [assumed] null = no time limit; a number fails the run when the clock passes it

  // seconds a ghost waits before coming back on its own. [wiki] 50 s in normal and master mode; [capture] 5 s on the Entrance.
  reviveSeconds: 50,
  reviveSecondsByFloor: { 0: 5 },

  // Combat rooms. Star (✯) mobs are the ones that must die for the room to count as cleared; fillers are extra non-star mobs.
  // [assumed] counts: the wiki only says "groups", the exact numbers are per room template and not in the sources.
  starMobs: { perRoom: [2, 4], perExtraCell: [1, 2] },
  fillerMobs: { perRoom: [1, 3], perExtraCell: [0, 1] },
  spawnMargin: 4, // [assumed] blocks kept free from the walls of a cell when picking spawn spots

  // [wiki] each Wither Door takes one Wither Key, the Blood Door takes the Blood Key. Which rooms hold them is not in the
  // layout export, so it is decided per seed (see run.js, "key rooms"). Set keyRooms: { roomId: ['wither'|'blood', ...] } to pin it.
  keyRooms: null,
  autoPickupKeys: false, // true: a dropped key goes straight into the party's pool (no item to walk over)

  // [wiki] a room entered later is tougher: health x (1 + 0.05 * (squares explored - 1)); applied by dungeon-mobs through `roomsExplored`.
  strictEntry: false, // true: a room only counts as entered if an open door connects it to a room already entered

  // [capture] Mort's lines after the countdown ([seconds after go, text])
  mort: [[0, 'Here, I found this map when I first entered the dungeon.'], [2.1, 'You should find it useful if you get lost.'], [3.6, 'Good luck.']],

  // The Watcher, timed from the capture (seconds after the blood door opened -> ticks at 20 TPS).
  watcher: {
    mobsByFloor: { 0: 8 }, // [capture] Entrance: Parasite, Putrid, Psycho, Reaper, Flamer, Ooze, Freak, Mute, one after the other
    defaultMobs: 8, // [assumed] same on the other floors until measured
    pool: ['watcher_parasite', 'watcher_putrid', 'watcher_psycho', 'watcher_reaper', 'watcher_flamer', 'watcher_ooze', 'watcher_freak', 'watcher_mute'], // [capture] order
    spawnAtSeconds: [23.7, 25.9, 27.6, 32.6, 42.4, 49.3, 55.8, 57.6], // [capture] when each one appears (the last ones depend on the party's pace in the real run)
    spread: 3, // [capture] they all show up within ~3 blocks of the blood room centre
    completesRunOnFloor: 0, // [capture] on the Entrance the run ends when the wave is dead; higher floors go on to the boss
    script: [ // [capture] [at seconds, line]
      [0.1, 'Congratulations, you made it through the Entrance.'],
      [3.25, 'I have been watching you closely...'],
      [6.34, 'Unfortunately, for now, this is the end of the road.'],
      [10.43, 'I sense many dead spirits eager to return to the living..'],
      [14.54, 'I will bring some of them back. Watch this.'],
      [26.3, 'Go and live again!'],
      [29.4, "Let's see how you can handle this."],
      [40.3, 'Go and live again!'],
      [54.9, 'Go, fight!'],
      [58.1, 'Hmmm... this one!']
    ],
    killLines: ['That one was weak anyway.', 'That one was weak anyway.', "I'm impressed.", 'That one was weak anyway.'], // [capture] said on the 1st..4th kill
    doneLine: 'You have proven yourself. You may pass.'
  },

  // Dungeon Score = Skyblocker's DungeonScore.java, checked against the real run (capture 2026-11-02): Entrance, 10 of 15 rooms
  // completed, 28.6 % secrets, 5 deaths, 2 unfinished puzzles, 215 s -> "Team Score: 155 (C)" is reproduced exactly (see lib/score.js).
  score: {
    skillBase: 20, // skill = 20 + clamp(roomsPart - puzzlePenalty - deathPenalty, 0, 80)
    skillRoomsMax: 80,
    exploreRoomsMax: 60,
    exploreSecretsMax: 40,
    puzzlePenalty: 10, // per puzzle that is not completed (failed or not done)
    deathPenalty: 2, // per death; -1 in total when the first one to die has a legendary Spirit pet
    entranceMultiplier: 0.7, // each of the four components is multiplied and rounded on the Entrance
    // Secrets needed (% of the floor) for the full 40 points, and the time (s) after which speed points start dropping.
    floors: {
      E: { secrets: 30, time: 1200 },
      F1: { secrets: 30, time: 600 },
      F2: { secrets: 40, time: 600 },
      F3: { secrets: 50, time: 600 },
      F4: { secrets: 60, time: 720 },
      F5: { secrets: 70, time: 600 },
      F6: { secrets: 85, time: 720 },
      F7: { secrets: 100, time: 840 },
      M1: { secrets: 100, time: 480 },
      M2: { secrets: 100, time: 480 },
      M3: { secrets: 100, time: 480 },
      M4: { secrets: 100, time: 480 },
      M5: { secrets: 100, time: 480 },
      M6: { secrets: 100, time: 600 },
      M7: { secrets: 100, time: 840 }
    },
    bonus: { cryptsMax: 5, mimic: 2, mimicFloors: ['F6', 'F7', 'M6', 'M7'], prince: 1, bat: 1, ezpz: 10 },
    rankColors: { 'S+': '§6', S: '§6', A: '§a', B: '§a', C: '§6', D: '§c' }, // [capture] only C (§6) is observed
    ranks: [['S+', 300], ['S', 270], ['A', 230], ['B', 160], ['C', 100], ['D', 0]] // [capture] 155 shows as C
  },

  lines: { // sidebar / chat text, from the capture
    title: 'SKYBLOCK', // bold, flashes yellow / white
    website: 'www.hypixel.net',
    bossByFloor: { 0: 'The Watcher', 1: 'Bonzo', 2: 'Scarf', 3: 'The Professor', 4: 'Thorn', 5: 'Livid', 6: 'Sadan', 7: 'Necron' }, // [capture] Entrance; the rest from the tab list's collection names
    locationGlyph: '⏣', // [capture] U+E067, a resource-pack icon; the plain symbol shows without the pack
    date: '11/02/26',
    skyDate: 'Late Autumn 5th',
    skyTime: '11:30pm',
    server: 'm22V' // [assumed] fixed; the plugin fills real values
  }
}

const isObject = v => v && typeof v === 'object' && !Array.isArray(v)
function merge (base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v
  return out
}

module.exports = { defaults, resolve: over => merge(defaults, over) }
