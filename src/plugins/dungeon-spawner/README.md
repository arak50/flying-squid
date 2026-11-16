# dungeon-spawner

Plans and spawns the mobs of a Catacombs room. Split out of `dungeon-run`: the run asks for a plan when a room is entered (`DungeonRun({ mobPlanner })`), this plugin makes the plan and puts the mobs in the world.

## The `mobs` block of a room sidecar

Every room has a sidecar next to its `.schem` (`dungeon-room-schematics/<category>/<Room>.json`). Add an optional `mobs` block; schema: `dungeon-room-schematics/room-mobs.schema.json`, validated on load (`lib/schema.js`). A room **without** the block uses the generic random planner, so rooms can be filled in one at a time.

```json
"mobs": {
  "version": 1,
  "pools": { "undead": ["zombie_grunt", "skeleton_grunt"] },
  "spawns": [
    { "id": "a", "mob": "crypt_lurker",    "pos": { "x": 5.5,  "y": 1, "z": 6.5 }, "yaw": 90 },
    { "id": "b", "mob": "pool:undead",     "pos": { "x": 10.5, "y": 1, "z": 6.5 } },
    { "id": "c", "mob": "random",          "pos": { "x": 15.5, "y": 1, "z": 6.5 }, "floors": [3, 7] },
    { "id": "d", "mob": "tank_zombie",     "pos": { "x": 20.5, "y": 1, "z": 6.5 }, "star": "never", "chance": 0.5 }
  ],
  "star": { "count": [2, 3], "from": ["a", "b", "c"] }
}
```

* **`spawns`** is the list of every spot the room can use. `mob` is a catalogue key (`dungeon-mobs/lib/catalog.js`), `random` (a basic mob of the floor) or `pool:<name>`.
* **Starred mobs are drawn from that list**: `star.count` (a number or `[min, max]`) of the spawns become ✯ mobs that must die for the room to clear; `star.from` limits which spawns may be drawn (default: all that are not `"star": "never"` and whose mob can be a star mob). `"star": "always"` on a spawn forces it (and counts toward `count`). The rest are fillers that spawn but do not have to die (`required: true` changes that; minibosses must die by default).
* `floors` `[first, last]`, `modes` (`normal` / `master`) and `chance` decide whether a spawn is used on this run. Every random value is drawn for every spawn, used or not, so editing one spawn does not reshuffle the others.
* **Coordinates** are room-local: the `.schem`'s block coordinates in its canonical orientation (the sidecar's `size`), `y` = feet height above the schematic's lowest layer. The plan rotates them with the quarter turns the generator applied (`rotationQuarterTurns`), adds the room origin (`blockMin`) and the sidecar's `floorYWorld`; `yaw` turns with the room. A test stamps real generated rooms and checks the transform lands on the right blocks.

## Plugin

`serv.dungeonSpawner`: `plannerFor(layout)`, `session({ world, layout })` (`spawn(plan, onFail)`, `gone()`, `despawn(id)`, `clear()`), `sidecars`, `problems`, `validate(block, size)`. Settings: `schematics` (folder), `groundScan`. A spawn without a height (generic planner) is stood on the floor found by scanning the world.

## Where mobs stand (placement)

The generic planner picks a random x / z in the room's cells, which on a real floor can be inside a wall, over a hole, or in a pit or pocket the party cannot reach, so a room could never clear. Before a room's mobs are spawned the plugin now reads the room's blocks (`lib/walkable.js`) and finds every spot that is

* **standable** (solid block below, feet and head free, not liquid),
* **inside** the room (its own cells, plus the gap column between two of its cells),
* **reachable** by walking (up 1, down 3 per step) from a spot next to one of the room's doors.

A mob already on such a spot stays where it is. A hand-placed (sidecar) spawn that is not on one moves to the nearest spot; a generic one stands on the reachable floor of its column closest to the floor height, or, if its column has none, on a spot picked by a hash of its id (preferring spots with free blocks around them and away from doors), at least `spacing` blocks from the others. Measured on 178 generated combat rooms (3 floors, 6 seeds): 30 % of the planned mobs were unreachable or inside blocks before, none after, at 50-300 % density. A room that cannot be scanned (no cells, no door) keeps its plan unchanged. `spawn(plan, onFail, { place: false })` skips placement (the Watcher's guardians use it).

Settings: `placement` (true), `spacing` (1.5 blocks), `scanRange` ([-24, 46] around the floor's door height).

## Mob density

`mobDensity` in the run config (`run: { mobDensity: { ... } }` on `dungeon-run`, `--mob-density <percent>` on `dungeon-server.js`, `/dungeon density [percent]` live):

| | default | |
|---|---|---|
| `percent` | 100 | 100 = stock counts, 50 = half, 150 = half again; clamped to `[minPercent, maxPercent]` |
| `minPercent` / `maxPercent` | 10 / 300 | limits of `percent` itself |
| `minPerCell` / `maxPerCell` | 1 / 16 | limits on a room's mob count **per cell of its size** (1x1 = 1 cell, 1x2 = 2, L-shape = 3, 2x2 = 4), so a 2x2 room may hold up to 64 |
| `minStars` | 1 | a room that has star mobs keeps at least this many |

The stock planner already gives bigger rooms more mobs; the percentage scales those counts and the limits scale with the room. Above the upper limit stars and fillers shrink in proportion (the mix is kept), below the lower limit fillers fill the gap. Sidecar rooms lose fillers first (never required or mini boss entries) or gain extra basic mobs next to the listed spawns. Mini boss rooms are not scaled. At 100 % plans are identical to before. The capture (Entrance run) shows roughly 6-20 zombies / skeletons / spiders per combat grid cell against about 5 per 1x1 room here, so about 250 % is Hypixel-like.

Tests: `node src/plugins/dungeon-spawner/test/dungeon-spawner.test.js` (density, walkability, and a sweep of real generated floors).
