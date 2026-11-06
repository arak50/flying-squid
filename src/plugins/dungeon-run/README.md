# dungeon-run

The backend logic of a Catacombs run: the rules of a floor from "Starting in 5" to the results screen.
`lib/run.js` is pure and deterministic (no flying-squid, no clock, no `Math.random`); `index.js` wires it into the server.

```
inputs  (what happens)                        DungeonRun                       effects (events you act on)
players walking, mobs dying, keys, doors  ->  4 state machines + seeded RNG ->  spawnMobs, doorOpened, keyDropped,
secrets, puzzles, deaths, tick()              (dungeon / room / player /        roomCleared, dialogue, playerDied,
                                               watcher)                         dungeonComplete ...
```

Plugins it uses: `dungeon-spawner` (mobs), `dungeon-secrets` (stub: secret totals from the sidecars), `dungeon-mobs`, optionally `dungeon-map`.

## Using it

With `dungeon-server.js` the plugin is already on (`"dungeon-run": { "autoStart": true }`): the run starts when the first player has
joined, with the generated floor and seed. Op command: `/dungeon <start|stop|status|score|clear [room]|tp <room>|die|key [wither|blood]>`.

```js
const run = serv.dungeonRun.start({ layout, seed, floor, master, secrets: { roomId: total }, players, config })
serv.dungeonRun.current   // the DungeonRun
```

Standalone (tests, replays, a different server):

```js
const { DungeonRun } = require('./lib/run')
const run = new DungeonRun({ layout /* catacombs-generator.exportLayout() */, party: [{ id: 'p1' }], seed: 42 })
run.on('*', e => console.log(e.tick, e.type))
run.start(); while (run.state === 'COUNTDOWN') run.tick()
run.playerMoved('p1', x, z)          // entering a room spawns its plan: see the `spawnMobs` event
run.mobDied('m1.0')                  // ids come from the plan
run.digest()                         // hash of the event log: same layout + seed + inputs = same digest
```

## What is modelled

| | |
|---|---|
| **Dungeon** | `LOBBY → COUNTDOWN (5 s) → RUNNING → WATCHER → (BOSS →) COMPLETE`, `FAILED` from any live state (wipe, timeout, everyone left) |
| **Rooms** | `UNENTERED → ENTERED → CLEARED → COMPLETED`. Combat rooms clear when every required mob is dead (fillers don't count), puzzle / trap / fairy rooms through `roomObjectiveDone`, completed = cleared + all secrets. Re-entering never respawns anything. |
| **Mobs** | per-room plan from a seeded stream (`seed + room id`), so a room is identical whatever the entry order. Planning and spawning live in the `dungeon-spawner` plugin: a room's sidecar `mobs` block (stars drawn from its spawn list) or the generic random planner. Star mobs, fillers, seeded modifiers, yellow room = one miniboss. Carries `roomsExplored` for the +5 % per explored square bonus. |
| **Keys / doors** | normal doors open, entrance doors open at "go", each wither door takes a Wither Key, the blood door the Blood Key. Keys drop on clearing their room, go into one party pool. |
| **Watcher** | entering the blood room starts the script timed from the real run: 5 intro lines, then 8 named guardians (Parasite, Putrid, Psycho, Reaper, Flamer, Ooze, Freak, Mute) appear one by one (23.7 s … 57.6 s), kill lines ("That one was weak anyway." …), "You have proven yourself. You may pass." when the last one dies → blood room cleared → Entrance completes, other floors go to `BOSS` until `bossDefeated()`. |
| **Players** | `ALIVE ↔ GHOST`, timed revive (50 s, 5 s on the Entrance), `revive(id, {cause})` for souls / fairies, leave → rejoin as ghost, all ghosts = fail. |
| **Score** | Skyblocker's `DungeonScore.java` (`lib/score.js`): skill 20 + rooms − 10 per unfinished puzzle − deaths, explore rooms + secrets vs the floor requirement, speed bands per floor, bonus (crypts, mimic, prince, bat, EZPZ), ×0.7 per component on the Entrance. Reproduces the capture's `Team Score: 155 (C)` exactly (test). |
| **Sidebar** | `scoreboardLines(viewer)` in the real Hypixel layout (date, location `(E)`, `Keys: ■ ✗ ■ 0x`, `Time Elapsed: 01m 03s`, `Cleared: 40% (32)`, the *other* party members with `[H] Name 890❤` / `DEAD`), colour codes parsed into components by `lib/sidebar.js`; `tabStats()` gives the tab-list Dungeon Stats (Opened / Completed Rooms, Secrets Found %, Crypts, Puzzles). |
| **Doors** | the capture's animation (`lib/door-anim.js`): per door block an invisible bat carries a falling block of the door material (entrance = infested chiseled stone bricks, wither = coal block, blood = red terracotta), the real blocks go barrier at +33 ms and air at +736 ms while the copies sink 3.75 blocks in four steps (+486…+937 ms) and are removed at +1132 ms. `doorAnimation: false` only swaps the blocks, `doorTimeScale` stretches / zeroes the timing. |
| **Opening doors** | a locked wither / blood door opens when a player right-clicks any block of its 3x3x4 footprint within `clickReach` (6) blocks while the team holds a key (`block_place` packet, `serv.dungeonRun.doorClick`). Without a key they get `You do not have the key for this door!` (the capture's line, at most once a second). Ghosts and clicks outside the run are ignored. `doorOpen: 'proximity'` restores walking up to a door (`doorRange`), `'both'` allows either. |
| **Chat / titles** | strings copied from the capture: `Starting in 4 seconds.`, Mort's three lines, `☠ Name was killed by X and became a ghost.`, `❣ Name was revived!`, key / door messages, the results block (`Team Score: 155 (C)`), the spectator and `BEING REVIVED` titles. |

## Assumptions to check (all tunable in `lib/config.js`, tagged `[wiki] [capture] [assumed]`)

* **Which rooms hold the keys** is not in the layout export. Keys are placed per seed by walking the floor and putting each needed key in a random room already reachable before its door, so every floor is finishable (the test plays 48 generated floors to the end). Pin it with `config.keyRooms`.
* **Mob counts per room**, the **Watcher size on floors above the Entrance** (copied from the Entrance's 9), Watcher timings and **where the wave stands** (a ring around the blood room, not the wall heads) are placeholders.
* **Revive time**: the wiki report says 50 s, the capture shows 5 s on the Entrance; both are used (per-floor table).
* **Score**: the formula is Skyblocker's and matches the capture's final 155; rank colours other than C, and the live `(score)` on the sidebar are not pinned: Hypixel's live number moves in steps (0, 32, 74, 91 ... 183 over the capture) and ends below the final score, ours is simply the current Team Score. Floors with no registered secrets score 0 for the secrets half, so pass `secrets` once room secret counts are known.
* **Capture facts not modelled**: Hypixel spawns every room's mobs when the run starts (they show up as you get in range), ours appear on room entry; the Watcher entity itself (an armor stand at y 79); the wall-head spawn animation of the guardians; the dungeon map packets; the "REVIVING" party chat lines.
* Mob stats still use `Math.random` inside `dungeon-mobs` (health roll). Everything the run decides (which mob, where, modifier) is seeded and passed in; for fully reproducible stats set `randomHealth: false` on `dungeon-mobs`.

## Not done

* Keys are not physical items: the plugin defaults to `autoPickupKeys` (straight into the pool). The core supports the drop → `pickupKey` flow.
* Blessings, Superboom TNT, mimics, crypts, reward chests, Catacombs XP, floor boss fights, trap / puzzle mechanics themselves (the run only needs to be told the objective is done), wandering souls, 2-5 player party rules.
* Only tested against a fake server and the real generator; **not yet with a real Minecraft client** (sidebar, titles, spectator switch and door carving are the parts to eyeball).

Tests: `node src/plugins/dungeon-run/test/dungeon-run.test.js` (`DUNGEON_SWEEP=10` for more real floors per level).

## The Watcher fight (from the capture)

`lib/watcher-anim.js` (pure packet builders) + `index.js` (`startFight`, `guardianEntrance`, `endFight`); setting `watcherAnimation` (default on).

What the real run does, and what we send:

| What | Capture | Here |
|---|---|---|
| The Watcher | zombie, invisible (flags 32), scale 0.23→0.26, max health 3000, `player_head` on its head (profile texture 51967db5…), ambient `entity_effect` particle list; spawned the tick the blood door opens, at the blood room centre, 4 blocks above the floor | same, sent as raw packets (no AI, not hittable) |
| Name tag | invisible marker armor stand 1.97 blocks above it: ` ` (dark purple) + `The Watcher` (red) | same, moves with the Watcher |
| Movement | 133 position/rotation steps over 61 s: it flies up and out over the room (up to 11 blocks away, 7 up) while it speaks, then returns above the centre | the same 133 steps, replayed from the Watcher's spawn (`PATH`) |
| Health | key 9 goes 3000 → 2625 → … → 375 → 0.1, 375 per dead guardian | same |
| Boss bar | `§c§l☬`, yellow and full; with k of 8 dead: round(1 - k/8, 2) (0.88 shows as 0.75, 0.63 … in the capture because two died together), colour turns red from the first death; removed with the results | same |
| Aura | every ~4 ticks around the Watcher (5 blocks up, spread 1.4): large_smoke, witch, dust (-10105499), enchant, entity_effect | same |
| Guardian entrance | each of the 8 (Parasite, Putrid, Psycho, Reaper, Flamer, Ooze, Freak, Mute) appears 5-6 blocks above the floor under the Watcher with a `cloud` puff (10, spread 0.8), then walks down | same, `y = floor + 5.5` |
| Guardians | player bodies, scale 0.28 (0.2716 for Putrid, Psycho, Mute), own skin each, health 12k/20k/20k/20k/16k/14k/16k/12k, gear per mob, gold name | `dungeon-mobs` catalog `watcher_*` (skins in `skins/skins.json`, hashes in `skins/hashes.json`) |

Not recreated yet: Hypixel sends every guardian twice in the same tick (first with the generic `Undead ` skin, then again with its own profile under the same entity id), which we do not need; the Parasite, Putrid and Flamer switch to a bow later in the fight and shoot arrows (about one a second); the guardians' idle/attack swing timing follows our mob AI, not the capture; the note-block and `entity.silverfish.death` sounds Hypixel plays in the room (record category) are not sent; the Watcher stand's arm poses are invisible so they are skipped.
