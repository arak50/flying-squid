# Vanilla parity notes

The mob AI and arrow code were reworked against [Horizon](https://github.com/horizon-rust/horizon) (MIT), a Rust
rewrite of Java Edition that is checked against vanilla with differential harnesses. Numbers and algorithms were
ported; no code was copied. Values that are our own derivation rather than read from Horizon are marked *derived*.

## Ported

| Area | What changed | Where |
|---|---|---|
| Scheduling | Full goal pass only when `(age + entityId)` is even; goals with `requiresUpdateEveryTick` tick in between; start delays halved (`adjustedTickDelay`) | `goalSelector.js`, `MobAI#tick` |
| Selectors | Separate goal and target selectors; goals using the `TARGET` flag are routed automatically | `SelectorPair` in `mobAI.js` |
| Control flags | One holder per flag; replacement needs a strictly lower priority number and an interruptible holder | `goalSelector.js` |
| Goal sets | Vanilla goals and priorities per species | `profiles.js` |
| Panic | Triggers on damage in the last 40 ticks or while burning; ends when the run finishes; per-species speed (cow 2.0, pig/sheep 1.25, chicken 1.4, rabbit 2.2) | `PanicGoal` |
| Stroll / look | 1-in-60 stroll per full tick, look range 6 (animals), random look around | `goals.js` |
| Melee | Attack box = hitbox + 0.83 blocks; 20 tick cooldown; randomised re-path delay that grows with distance; `canUse` throttled to 20 ticks | `MeleeAttackGoal`, `vanilla.js` |
| Targeting | Range scaled by visibility (sneaking 0.8, mob heads 0.5) with a 2 block floor; unseen memory 60 ticks (300 for hurt-by); alert nearby mobs of the same kind | `TargetGoal`, `HurtByTargetGoal` |
| Speed | Attributes are vanilla values; blocks/s is derived: ground speed scales with the *square* of `attribute * modifier` (*derived*, see `vanilla.groundSpeedBps`) | `vanilla.js` |
| Pathfinding | Node budget `followRange * 16`; max fall distance 3 (more while chasing and healthy) | `navigation.js` |
| Fire | Sun ignites for 8 s with chance `(brightness - 0.4) * 2 / 30` per tick, 1 damage per second | `MobAI#_sunBurn` |
| Creeper | Swell goal (starts < 3 blocks, aborts > 7 or out of sight), 30 tick fuse, radius 3 | `SwellGoal`, `MobAI#explode` |
| Explosion | 16³ shell rays, 0.3 step, `(resistance + 0.3) * 0.3 + 0.225` cost; damage `floor((i² + i) / 2 * 7 * d + 1)` | `explosion.js` |
| Spider | Leap at a target 2-4 blocks away | `LeapAtTargetGoal` |
| Skeleton | Avoids wolves; arrow damage spread 0.57425 | `AvoidEntityGoal` |
| Arrows | Piercing (`shoot({ pierce })`) | `projectiles.js` |
| Calculator | Gravity, drag, water drag and tick order verified for arrows, tridents and throwables; `llama_spit` added | `projectile-motion/lib/physics.js` |

## Config

| Key | Default | |
|---|---|---|
| `creeperExplosions` | `true` | creepers swell and explode (entities are hurt, knocked back) |
| `creeperBlockDamage` | `false` | explosions also destroy blocks (vanilla default is on) |
| `panicFleesAttacker` | `false` | bias panic away from whoever hit the mob (vanilla runs to a random spot) |
| `vanillaPathNodes` | `true` | path search budget from follow range instead of `maxPathNodes` |

Profiles can use `attributes.speedAttribute` (vanilla value). Profiles that still give `movementSpeed` in blocks/second
keep working unchanged.

## Not ported (yet)

* `RestrictSunGoal` (path avoidance of sunlit blocks), breeding, tempting, following parents, villages, door breaking
* Block-shape accurate arrow collision (arrows still treat any full-cube block as solid and everything else as air)
* Fireballs, wither skulls, wind charges (they need an acceleration step the calculator does not have)
* Throwable entities in-game (snowball, egg, pearl, potions). The calculator physics for them is verified, but spawning
  them needs live client testing
* Powered creepers, mob head visibility for items other than the three listed in `vanilla.js`
* Explosion knockback units are a tuned guess: `takeDamage` forwards `velocity` to `sendVelocity` and the scale was not
  checked against a real client
