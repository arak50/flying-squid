# projectile-motion (flying-squid plugin)

A projectile motion calculator using vanilla Java Edition physics, for flying-squid (tested against 26.1).

> **Source note:** this was written to match <https://minecraft.wiki/w/Calculators/Projectile_motion>, but that page
> could not be fetched when the plugin was built. It is implemented from the vanilla rules below, not copied from the
> wiki's page, so field names and output wording may differ from the wiki calculator.

## Physics

Each tick: `pos += vel`, then `vel *= drag`, then `vel.y -= gravity`.

| projectile | gravity | drag (air) | drag (water) |
|---|---|---|---|
| arrow / spectral arrow | 0.05 | 0.99 | 0.6 |
| trident | 0.05 | 0.99 | 0.99 |
| snowball, egg, ender pearl | 0.03 | 0.99 | 0.8 |
| splash / lingering potion | 0.05 | 0.99 | 0.8 |
| experience bottle | 0.07 | 0.99 | 0.8 |
| fishing bobber | 0.03 | 0.92 | 0.92 |
| item, falling block, TNT | 0.04 | 0.98 | 0.99 |

Bow: power = `(t² + 2t) / 3` with `t = min(ticks, 20) / 20`, no shot below 0.1, speed = power × 3 blocks/tick.
Arrow damage = `ceil(speed × 2)`; a full draw is a critical hit and adds a random `0..floor(d/2)+2`.
Angles are degrees **above** the horizon (Minecraft's own pitch is negative upwards). Speeds are blocks/tick (×20 = blocks/s).
Water drag is only applied for the whole flight when you pass `water`; the calculator does not model entering water mid-flight.

## Install

Copy this folder to `src/plugins/projectile-motion/` in flying-squid and enable it:

```json
"plugins": { "projectile-motion": {} }
```

## Command

```
/projectile speed=3 pitch=45                  range, flight time, max height, impact speed, best angle, arrow damage
/projectile draw=20 distance=40 dy=5          pitch(es) that hit a target 40 blocks away and 5 above (bow drawn 20 ticks)
/projectile projectile=snowball distance=25   lowest speed that reaches it, plus the angles
```
Options: `projectile=` `speed=` `draw=` `pitch=` `distance=` `dy=` (target height relative to the launcher)
`height=` (launch height above the landing plane) `water` `gravity=` `drag=`. Alias `/pm`.

## API

`serv.projectileMotion`: `simulate`, `heightAt`, `solvePitch`, `solveSpeed`, `bestAngle`, `bowPower`, `bowSpeed`,
`drawTicksForSpeed`, `arrowDamage`, `calculate`, `format`, `PROJECTILES`. Also usable standalone: `require('./lib/physics')`.

## Tests

`node test/physics.test.js`
