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

Tests: `node src/plugins/dungeon-spawner/test/dungeon-spawner.test.js`
