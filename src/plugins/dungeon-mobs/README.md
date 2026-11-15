# dungeon-mobs

Spawns Catacombs mobs at a position, carrying the dungeon flags room logic needs (✯ star, modifier, room, floor).
Spawning only: room clearing, Wither / Blood Key, Blessing and Superboom drops are in the dungeon-items plugin.

```js
const mob = serv.dungeonMobs.spawn('zombie_grunt', new Vec3(x, y, z), { star: true, floor: 3, roomId: 4 })
mob.dungeon   // { key, name, kind, star, canBeStar, floor, master, modifier, roomId, level, maxHealth, damage, defense, traits, tag }

serv.dungeonMobs.spawnGroup([{ mob: 'sniper', position: p1 }, { mob: 'crypt_lurker', position: p2, star: true }], { roomId: 4, floor: 3 })
serv.dungeonMobs.list({ roomId: 4, star: true, alive: true })   // what a "room cleared" check will use
```

Options: `world`, `star`, `floor` (0-7), `master`, `modifier` (`healthy|stormy|speedy|fortified|flaming`, `null` = none, omitted = random by chance),
`roomId`, `roomsExplored`, `health`, `level`, `yaw`, `pitch`, `nametag`. Emits `dungeonMobSpawned`.
Op command: `/dmob <mob> [star] [floor=N] [master] [modifier=<name>] [armor=<material>] [skin=<key>]`, `/dmob list`.

## Health bar

The name tag's health number follows `mob.health`, checked every tick, so any damage path updates it (melee, arrows, fire).
Core's attack handler deals 1 hp per hit, so dungeon mobs now take stat-based melee damage instead:
`(5 + floor(strength / 5)) * (1 + strength / 100) * (1 + crit_damage / 100 on a crit)` from `player.skyblock.stats`.
Weapon damage and enchantments are not read yet. Override with the `damageFn(player, mob, base)` setting, or `meleeDamage: false` for core's 1 hp.

## Player mobs and skins

These mobs are spawned as player entities: Lost Adventurer, Redstone Warrior, Angry Archaeologist, Shadow Assassin, Frozen Adventurer,
King Midas, Crypt Dreadlord, Crypt Undead, Admin, Prince, Zombie Commander, Skeletor Prime. The PNGs are in `skins/`, `skins/skins.json`
lists them (`/dmob frozen_adventurer skin=frozen_adventurer`; Lost Adventurer picks one of its three skins per spawn).

* Clients only accept skin URLs on Mojang's domains, and Mojang names a texture after the SHA-256 of the PNG, so the property is
  `http://textures.minecraft.net/texture/<sha256 of the file>` (unsigned, like the ones in the Hypixel capture). Three of your files
  (angry_archeologist, crypt_dreadlord, lost_adventurer_2) have the same hash as textures seen in the capture. For the others the URL
  is derived the same way but could not be checked from here; if one shows up as Steve/Alex, put a signed `value` / `signature`
  (from MineSkin) on its entry in `skins.json`.
* The random profile name (`dm1a2b3c`) is hidden by putting every profile name in a scoreboard team (`dm_hidden`) whose name tags are never shown.
* A player's own name plate cannot be edited, so the tag is a free invisible marker armour stand at generic.scale 0.1 (as Hypixel does), `1.8 * scale + tagLift`
  above the mob's feet (`tagLift` 0.15 above the head, not scaled;  the capture has 2.09-2.19 above zombies and skeletons), moved with the mob each tick. It has no gravity and no stock
  physics (an unsized stand is skipped by the core loop), otherwise it hops. The stand is sent with the mob, destroyed with it, and the fake profile is kept
  out of the tab list and removed a few seconds after death.
* Blood room guardians (`tagDy: 2.16` in the catalogue): the capture puts their tag stand 2.13-2.16 above their feet whatever their generic.scale, so they ignore `tagLift`.
* NPCs (`kind: 'npc'`, e.g. `mort`): no AI, invulnerable, no health in the name. Their name is a stack of ordinary stands (`lines: [{ text, color, bold, dy }]`,
  Mort: "Mort" at the feet height, "CLICK" 0.25 below, as in the capture) and they turn to the nearest player within `npcLookRange` (10): `entity_look` +
  `entity_head_rotation` every `npcLookEvery` (4) ticks, only when the angle changed, back to the spawn yaw when nobody is near.
* The mob AI gets a zombie-like melee profile for player bodies. Bow users (Crypt Dreadlord ...) just melee for now.
* `players: false` in the plugin settings uses the vanilla bodies (`fallback` in the catalogue) instead.

`skins/hashes.json` holds the texture hashes (`textures.minecraft.net/texture/<hash>`, leading zeros dropped): `mobSkins` for the mobs drawn as players (our PNGs plus the player-model mobs seen in the real-run capture: Crypt Dreadlord/Souleater, Diamond Guy, Lost Adventurer, and the Undead, Parasite, Putrid, Psycho, Reaper, Flamer, Ooze, Freak, Mute and Primal Fear profiles, which have a hash but no PNG), and `otherHashes` for every other skin hash in the capture (`kind: player` tab-list/NPC players, `kind: head` skull items and blocks), kept for later use. `require('./lib/skins').hashes()` returns it.

## Armour

```js
serv.dungeonMobs.spawn('zombie_knight', pos, { armor: 'diamond' })                          // leather | chainmail | iron | golden | diamond | netherite
serv.dungeonMobs.spawn('frozen_adventurer', pos, { armor: { material: 'leather', color: 0x66ccff } })
serv.dungeonMobs.spawn('crypt_lurker', pos, { armor: { helmet: { item: 'player_head', skin: '<texture hash|url|base64>' }, mainhand: 'iron_sword' } })
serv.dungeonMobs.setArmor(mob, { chestplate: 'netherite_chestplate' })   // live: nearby players see it, later arrivals get it on spawn
serv.dungeonMobs.equip(mob, 'helmet', null)                              // empty a slot
```
Slots: `helmet chestplate leggings boots mainhand offhand`. 
### Default armour per mob

Mobs wear their Hypixel armour automatically (an explicit `armor` option still wins, `armor: null` strips it). The pieces come from the
SkyBlock items endpoint: dyed leather uses the endpoint's colour, helmets that are skulls use its texture. The mapping is `ARMOR` in
`lib/catalog.js`; the data is `lib/armorSets.js`, generated with `node tools/build-armor-sets.js items.json`.

| Mob | Armour |
|---|---|
| Lost Adventurer | one of Young / Unstable / Holy / Superior Dragon, random per spawn or `variant: 'holy'` (`/dmob lost_adventurer variant=holy`); `mob.dungeon.variant` |
| Angry Archaeologist | Perfect (tier I; all tiers look the same) |
| Shadow Assassin | Shadow Assassin |
| King Midas | Golden |
| Frozen Adventurer | Frozen Blaze |
| Tank Zombie / Super Tank Zombie | Heavy / Super Heavy |
| Zombie Soldier / Knight / Commander / Lord | their own sets |
| Skeleton Grunt / Soldier / Master / Lord | their own sets |
| Sniper | Sniper Helmet only |
| Skeletor | Skeletor |
| Super Archer | Bouncy, on F4 only (M4 included) |
| Crypt Lurker, Crypt Undead, Undead Skeleton, Scared Skeleton | none |
| Redstone Warrior, Crypt Dreadlord, Crypt Souleater, Withermancer | none (no confirmed set) |
| **Zombie Grunt, Skeletor Prime** | **none yet: the items endpoint has no pieces for them** |

`armor` in a catalogue entry may also be a function `({ floor, master, variant, star }) => spec | null`.

## Notes

* `lib/catalog.js` is transcribed from the wiki's Catacombs Mobs page (levels, health, damage, defense, floors, traits).
  `star: true` there means "can be a star mob in a normal room"; tomb / secret / puzzle / merge mobs and minibosses are not.
  `star: true` passed to `spawn` is always honoured.
* Health: geometric interpolation between the wiki's lowest and highest value across the floors the mob appears on (F0..F7, then M1..M7).
  The wiki only gives the two ends, so intermediate floors are an approximation: pass `health` to pin an exact value.
  The room-entering bonus `1 + 0.05 * (roomsExplored - 1)`, the -2000..+6000 randomisation and modifier multipliers are applied on top.
* Name tag shape comes from the Hypixel capture: gold `✯ `, red name (dark gray with a modifier prefix), green health, red `❤`.
  It is the mob's own custom name, or the tag stand's for player mobs. Hypixel's private-use resource-pack glyphs are left out unless you set `glyphs` in the plugin settings.
* Humanoids without a supplied skin use a zombie body. `damage` (mob to player) is stored, not applied: the vanilla combat model would one-shot players.
* Metadata type ids and keys are read from the registry. Everything here, including the player_info / set_passengers / equipment packets,
  was tested against a fake server only; check `/dmob frozen_adventurer star armor=diamond` on a real client.

Test: `node src/plugins/dungeon-mobs/test/dungeon-mobs.test.js`
