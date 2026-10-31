# mob-ai: Pumpkin-style mob AI for flying-squid (26.1+)

Goal-based mob AI modelled on the [Pumpkin AI docs](https://docs.pumpkinmc.org/developer/entities/ai-and-mobs),
plus **AI freezing**: a mob with no player within `activeRange` blocks has its AI switched off.

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
| `undeadBurnInSun` | `true` | zombies/skeletons take 1 damage/s in daylight sky exposure |
| `aiForUnknownMobs` | `false` | give unlisted land mobs wander + look-at-player |
| `patchRegistry` | `true` | see "26.1 notes" |
| `debug` | `false` | log freeze/wake events |

## Commands (op)

`/mobai [status]`, `/mobai range <blocks>`, `/mobai on|off`, `/mobai debug`, `/mobai spawn <mob> [count]`

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

* Skeleton/pillager "arrows" are a hitscan roll (event `mobAi:rangedAttack`), not projectile entities.
* Creepers wander/look but do not explode; fire from sun burning has no visual flame.
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
cd src/plugins/mob-ai && node test/mob-ai.test.js     # unit tests, no server needed
node src/plugins/mob-ai/test/integration.js 26.1      # real server + mineflayer bot (from repo root)
```
