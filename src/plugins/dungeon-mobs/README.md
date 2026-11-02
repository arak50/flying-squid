# dungeon-mobs

Spawns Catacombs mobs at a position, carrying the dungeon flags room logic needs (✯ star, modifier, room, floor).
Spawning only: room clearing, Wither / Blood Key, Blessing and Superboom drops are not here yet.

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
* A player's own name plate cannot be edited, so the tag is an invisible marker armour stand riding the mob (a mob with a passenger
  shows no name plate). The stand is sent with the mob, destroyed with it, and the fake profile is kept out of the tab list and removed
  a few seconds after death.
* The mob AI gets a zombie-like melee profile for player bodies. Bow users (Crypt Dreadlord ...) just melee for now.
* `players: false` in the plugin settings uses the vanilla bodies (`fallback` in the catalogue) instead.

## Armour

```js
serv.dungeonMobs.spawn('zombie_knight', pos, { armor: 'diamond' })                          // leather | chainmail | iron | golden | diamond | netherite
serv.dungeonMobs.spawn('frozen_adventurer', pos, { armor: { material: 'leather', color: 0x66ccff } })
serv.dungeonMobs.spawn('crypt_lurker', pos, { armor: { helmet: { item: 'player_head', skin: '<texture hash|url|base64>' }, mainhand: 'iron_sword' } })
serv.dungeonMobs.setArmor(mob, { chestplate: 'netherite_chestplate' })   // live: nearby players see it, later arrivals get it on spawn
serv.dungeonMobs.equip(mob, 'helmet', null)                              // empty a slot
```
Slots: `helmet chestplate leggings boots mainhand offhand`. A catalogue entry can carry a default `armor` (none do yet).

## Notes

* `lib/catalog.js` is transcribed from the wiki's Catacombs Mobs page (levels, health, damage, defense, floors, traits).
  `star: true` there means "can be a star mob in a normal room"; tomb / secret / puzzle / merge mobs and minibosses are not.
  `star: true` passed to `spawn` is always honoured.
* Health: geometric interpolation between the wiki's lowest and highest value across the floors the mob appears on (F0..F7, then M1..M7).
  The wiki only gives the two ends, so intermediate floors are an approximation: pass `health` to pin an exact value.
  The room-entering bonus `1 + 0.05 * (roomsExplored - 1)`, the -2000..+6000 randomisation and modifier multipliers are applied on top.
* Name tag shape comes from the Hypixel capture: gold `✯ `, red name (dark gray with a modifier prefix), green health, red `❤`.
  It is the mob's own custom name, or the riding stand's for player mobs. Hypixel's private-use resource-pack glyphs are left out unless you set `glyphs` in the plugin settings.
* Humanoids without a supplied skin use a zombie body. `damage` (mob to player) is stored, not applied: the vanilla combat model would one-shot players.
* Metadata type ids and keys are read from the registry. Everything here, including the player_info / set_passengers / equipment packets,
  was tested against a fake server only; check `/dmob frozen_adventurer star armor=diamond` on a real client.

Test: `node src/plugins/dungeon-mobs/test/dungeon-mobs.test.js`
