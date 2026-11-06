# dungeon-secrets (stub)

Secrets come from `data/secretlocations.json` (Quantizr's Dungeon Rooms data as shipped with Skyblocker, **GPL-3.0**, see `data/README.md`). Rooms are matched by template name (`Banners-1`, ...); a room needs a sidecar (for its size and `floorYWorld`) and an entry in the file, otherwise it has no secrets. The room sidecars' own `secrets` block is no longer used.

Coordinates in the file are block positions in the unrotated schematic: `x`/`z` as they are, room-local `y = y - floorYWorld` (checked against the canonical schematics). They are turned into block centres and rotated into the world like the `mobs` block.

| file category | meaning | counts as a secret |
|---|---|---|
| chest, item, bat | secret chest / item drop / bat | yes (`chest`, `item`, `bat`) |
| wither | wither essence | yes (`essence`) |
| entrance, superboom, stonk, lever, aotv, pearl, fairysoul, puzzle | how to reach a secret | no, listed as hints |

Works now: `serv.dungeonSecrets.totals(layout)` (`{ roomId: n }`, used by `dungeon-run` unless `secrets` is passed), `list(layout, roomId)` and `hints(layout, roomId)` (world positions), `spawnRoom(ctx)` (announces `dungeonSecretsSpawn { roomId, secrets, hints, world }`, spawns nothing; called on `dungeonRoomEntered`).
Settings: `schematics`, `locations` (another file of the same shape).
To do (marked `TODO` in `index.js`): spawn each type in the world and call `run.secretFound(playerId, roomId, secretId)` when a player gets one.
Rooms of ours with no data in the file: Creeper-Room, Three-Chests, Water Puzzle and the 1x1_cell-* sidecars.

Tests: `node src/plugins/dungeon-secrets/test/dungeon-secrets.test.js`
