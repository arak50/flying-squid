# mob-ai: Pumpkin-style mob AI for flying-squid (26.1+)

Goal-based mob AI modelled on the [Pumpkin AI docs](https://docs.pumpkinmc.org/developer/entities/ai-and-mobs),
plus **AI freezing** (a mob with no player within `activeRange` blocks has its AI switched off) and
**vanilla bow mechanics**: real arrow entities, player bows, and skeletons that draw and shoot them.

## Install

1. Copy this folder to `src/plugins/mob-ai` in your flying-squid checkout.
2. Enable it in `config/settings.json`:

```json
"plugins": {
  "mob-ai": { "activeRange": 32 }
}
```

No new npm dependencies (uses `vec3`, already required by flying-squid).

## Distance freeze

Every server tick each AI mob's distance to the nearest player (same world, spectators ignored) is checked:

| state | rule |
|---|---|
| awake -> frozen | nearest player is further than `activeRange + hysteresis` (or no player in that world / none online) |
| frozen -> awake | nearest player is within `activeRange` |

Frozen mobs run **no goals, no pathfinding, no look/sun/burn logic**; they cost one distance check per tick.
A mob that is mid-fall or sliding finishes settling on the ground first, then goes fully idle.
The hysteresis band (default 4 blocks) stops mobs flapping at the boundary.

## Config (`settings.plugins["mob-ai"]`)

| key | default | meaning |
|---|---|---|
| `activeRange` | `32` | blocks; mobs further than this from every player are frozen |
| `hysteresis` | `4` | extra blocks before an awake mob freezes again |
| `ignoreSpectators` | `true` | spectators do not keep mobs awake |
| `maxPathfindsPerTick` | `4` | global A* budget per tick (requests are deferred, not dropped) |
| `maxPathNodes` | `200` | A* node limit per search |
| `playerBows` | `true` | vanilla draw / release for players (core's `block_dig` status 5 handler is an empty TODO) |
| `arrowLifetime` | `1200` | ticks an arrow may fly or stay stuck before it despawns |
| `undeadBurnInSun` | `true` | zombies/skeletons take 1 damage/s in daylight sky exposure |
| `aiForUnknownMobs` | `false` | give unlisted land mobs wander + look-at-player |
| `patchRegistry` | `true` | see "26.1 notes" |
| `debug` | `false` | log freeze/wake events |

## Commands (op)

`/mobai [status]`, `/mobai range <blocks>`, `/mobai on|off` (arrows keep flying when the AI is off), `/mobai debug`, `/mobai spawn <mob> [count]`

## Bow mechanics (vanilla numbers)

Arrows are real entities (`lib/projectiles.js`); the maths is in `lib/bow.js`.

| | |
|---|---|
| flight | every tick: move by velocity, then `vel *= 0.99` (`0.6` in water) and `vel.y -= 0.05` |
| collision | swept voxel walk against blocks and the target's box grown by 0.3; arrows stick 0.05 in front of the surface, fall again if the block goes, despawn after `arrowLifetime` ticks |
| draw power | `(t^2 + 2t) / 3` with `t = ticks / 20`, capped at 1; below 0.1 nothing fires |
| player arrow | speed `power * 3` blocks/tick, divergence 1.0, critical only at full power |
| damage | `ceil(speed * baseDamage)`, base 2.0 (+`0.5 * level + 0.5` with Power); critical adds `0..floor(d/2)+2` |
| knockback | 0.4 blocks/tick like any hit, Punch adds 0.6 blocks/tick per level |
| ammo | one arrow per shot (hotbar first), none in creative or with Infinity; Infinity / creative arrows can only be picked up by creative players |
| Flame | sets the target on fire: 1 damage per second for 5 s |
| pickup | stuck arrows go back into the inventory after a 7 tick delay |
| hit rules | the shooter is immune for 5 ticks, creative players bounce arrows, spectators are ignored |

**Skeletons** (`RangedAttackGoal` = vanilla `RangedBowAttackGoal`): holds a bow (sent as equipment), walks towards
the target until within 15 blocks with 20 ticks of line of sight, then stands and strafes, raises the bow for 20 ticks
(entity metadata: `living_entity_flags` 0x01 = using item while drawing, and `mob_flags` 0x04 = aggressive, which is what
makes the client hold the bow arm up; both indices are read from the registry's `metadataKeys`, e.g. 8 and 15 on 26.1), shoots at 1.6 blocks/tick with inaccuracy `14 - 4 * difficulty`
and base damage `2 + triangle(0.11 * difficulty, 0.57)`, then waits 20 ticks on hard or 40 otherwise.
It backs off when closer than 7.5 blocks and gives up drawing after 3 s without line of sight.
The server `difficulty` option drives all of this (1 easy, 2 normal, 3 hard).
Strays use the same goal.

## What is implemented (vs the Pumpkin doc)

* `Goal` lifecycle (`canStart / start / shouldContinue / tick / stop`) and a `GoalSelector` with priorities
  (lower number = higher precedence), control flags (MOVE/LOOK/JUMP/TARGET) and preemption.
* Goals: `SwimGoal`, `MeleeAttackGoal`, `RangedAttackGoal`, `FleeSunGoal`, `PanicGoal`, `WanderAroundGoal`,
  `LookAtEntityGoal`, plus `NearestAttackableTargetGoal` for target selection.
* Navigation: bounded grid A* (avoids lava/fire/cactus etc, step-ups, max 3-block drops, partial paths when
  the goal is unreachable), waypoint steering, jumping, gravity, water buoyancy.
* Attributes per profile: max health, movement speed (**blocks/second**), attack damage, follow range,
  knockback resistance.
* Profiles for cow, pig, sheep, chicken, horse, villager, zombie, husk, drowned, skeleton, stray, spider,
  pillager, wolf (neutral), iron golem, ... see `lib/profiles.js`.

## Known limits

* Arrow collision treats every solid block as a full cube (slabs, stairs, fences are full blocks to an arrow).
* No arrow critical particle trail, no flames on Flame targets, no bow durability loss, no spectral / tipped
  arrows, no armour or Protection reducing arrow damage (flying-squid has no armour model).
* Arrows count towards `max-entities` (default 100); at the limit a shot is simply not fired.
* Visual behaviour of *stuck* arrows on a vanilla client was not checked (only protocol level with mineflayer).
* Creepers wander/look but do not explode; fire from sun burning has no visual flame. Pillagers (crossbow) and
  bogged (poison) have no profile.
* Collision is centre-point per mob (not a full bounding box), so large mobs can clip corners.
* Mobs only target players.

## 26.1 notes (checked against the repo as cloned)

* In the 26.1 registry `registry.mobs` only lists 10 types, so core `serv.spawnMob(cow)` throws. With
  `patchRegistry` the plugin copies all living entity types into `registry.mobs` (same object core reads).
  Core `/summon` still only accepts entities typed `mob`; use `/mobai spawn`, spawn eggs, or `serv.spawnMob`.
* `prismarine-provider-anvil@2.13.0` (the lock-file version) throws `Unsupported version: 26.1` when the
  server starts. That is unrelated to this plugin; `test/integration.js` stubs the provider for its in-memory world.

## Extending

```js
const { Goal, Control } = serv.mobAI
class JumpAroundGoal extends Goal {
  constructor (ai) { super(ai, Control.JUMP) }
  canStart () { return Math.random() < 0.01 }
  tick () { this.mob.nav.vy = 8 }   // this.mob is the MobAI controller (this.mob.mob is the entity)
}
serv.mobAI.get(entity).selector.add(5, new JumpAroundGoal(serv.mobAI.get(entity)))
serv.mobAI.registerProfile('my_mob', { type: 'passive', height: 1, attributes: { maxHealth: 10, movementSpeed: 2, followRange: 16 }, goals: [] })
```

## Tests

```
cd src/plugins/mob-ai
node test/mob-ai.test.js     # AI / freeze / pathfinding unit tests, no server needed
node test/bow.test.js        # bow maths, arrow flight / hits / pickup, player bow, skeleton shooting
cd ../../.. && node src/plugins/mob-ai/test/integration.js 26.1   # real server + mineflayer bot: wander, freeze, player bow, skeleton
```

## Hurt feedback

Hit mobs flash red because flying-squid's core `takeDamage` (`src/lib/plugins/pvp.js`) sends the modern `damage_event`
packet. This plugin only passes `damageType` (`arrow`, `mob_attack`, `on_fire`), `cause` and `direct` to `takeDamage`; it
needs the core change that reads them (older cores ignore the extra fields).
