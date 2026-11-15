# dungeon-items

Items that lie in the dungeon and are picked up by walking over them (within `pickupRadius`, 1.5 blocks). Each drop is built as in the capture: an invisible, ordinary-size armour stand wearing the item (a signed player head on its helmet; for Superboom TNT a `paper` with the `hypixel_skyblock:item/uncategorized/superboom_tnt` model, glint, in its main hand with the arm raised) plus a separate still name stand at scale 0.1 (blessings light purple with no level in the name, Blood Key red, Superboom blue, Revive Stone gold). The item stand is synced every tick: y bobs +-0.2 in 0.01 steps (a tick held at each end) and yaw turns 2 degrees. Unclaimed blessings / consumables vanish after 30 s (read off the capture's Superboom despawns); keys stay. Heights are relative to the dungeon floor (the capture's mobs stand at y 69: item stand 0.72 below, name stand 0.47 below).

| type | kind | effect |
|---|---|---|
| `wither_key`, `blood_key` | key | dropped by dungeon-run when a room is cleared; walking over one moves it into the party's key pool |
| `blessing_power`, `blessing_life`, `blessing_wisdom`, `blessing_stone`, `blessing_time` | blessing | level I-XIII (rolled from the floor, or `level`); levels of one kind add up per player; stats are recorded in `bonuses(player)` |
| `superboom_tnt`, `revive_stone` | consumable | carried per player, `inventory(player)` / `use(player, 'superboom')` |

Blessing numbers per level: Power, Stone and Life are read off the capture's "Granted you" lines (e.g. Stone V: +20.4 & +1.1x Defense and +30 Damage, Life V: +1.15x HP and Health Regen); Wisdom and Time were not captured and are placeholders. `bonuses(player)` returns `{ stat: { add, mult } }`; applying them to health / damage is the combat layer's job. Blessings are granted to the whole party.

**Effects (from the capture):** a drop appears with an `explosion` puff (3 particles, speed 8) at the floor (Superboom TNT / Revive Stone also get the `explosion_emitter`, and a `firework` sparkle every 10 ticks); a second drop lies 0.5 away in x and z. Picking one up plays `entity.item.break` to the picker, a `lava` particle at the item stand, and chat to the party: `<name> has obtained <item>!`, then for blessings `DUNGEON BUFF! You found a Blessing of Stone V! (03m 06s)` (the run clock is only shown at level V, as captured) and `     Granted you ...`.

**Drops (`planDrops`, wired by dungeon-run when this plugin is loaded):** the last required mob of a room always drops items: the room's key if it holds one (Wither / Blood Key, falling where the mob died), otherwise a Blessing; plus Superboom TNT or a Revive Stone (2 : 1 weights, from three captured drops). A miniboss that is not the last required mob drops a Blessing with 50% chance (assumed). The floor and master mode set the blessing level. Switch off with dungeon-run's `drops: false`.

```js
serv.dungeonItems.spawn('blessing_life', { x, y, z }, { world, level: 7 })   // or floor / master to roll the level
serv.dungeonItems.spawn('wither_key', pos, { world, claim: (player, item) => true })  // claim: spawner takes it; false leaves it
serv.dungeonItems.bonuses(player)   // { health: 70, ... }
```

Op command: `/ditem <type> [level]` drops one at your feet (`/ditem life 5` works too).
Events: `dungeonItemSpawned`, `dungeonItemPickedUp`. Pure rules (no flying-squid) live in `lib/items.js`.

Not done: drops from secrets, applying the stats, using TNT / revive stones, the Wither Key head (no stand was captured, a skull stands in), and per-blessing textures (all captured blessings share one head, so all five do).
