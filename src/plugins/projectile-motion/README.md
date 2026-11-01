# projectile-motion (flying-squid plugin)

A projectile motion calculator and simulator using vanilla Java Edition physics, for flying-squid (target: 26.1).

> **Source note.** The minecraft.wiki calculator page and the 26.1 entity sources (javadoc mirrors) could not be fetched
> when this was written, so the physics is implemented from vanilla rules and checked by hand calculations in the tests,
> **not** against the 26.1 source. Each profile carries `verified: true|false`; anything `false` is flagged in the
> command output. Please check the `false` ones against the source before relying on them (see "Known unverified").

## Two modes

* **Idealised calculator** (default): you give launch speed + pitch (or a bow draw), the result is a deterministic
  trajectory with no inaccuracy and no collision.
* **Vanilla launch** (`vanilla` flag / `launchVelocity()`): the projectile's own launch speed and pitch offset, the shooter's
  velocity, optional seeded random inaccuracy, `collision()` against target boxes, `simulateMany()` for scatter.

## Physics

Each projectile has its own `tickOrder`; one tick applies the steps in that order:

| projectile | gravity | air drag H/V | water drag H/V | tick order | launch speed | pitch offset | verified |
|---|---|---|---|---|---|---|---|
| arrow, spectral arrow | 0.05 | 0.99 / 0.99 | 0.6 / 0.6 | position, drag, gravity | bow draw | 0 | yes |
| trident | 0.05 | 0.99 / 0.99 | 0.99 / 0.99 | position, drag, gravity | 2.5 | 0 | no |
| snowball, egg, ender pearl | 0.03 | 0.99 / 0.99 | 0.8 / 0.8 | gravity, drag, position | 1.5 | 0 | no |
| splash / lingering potion | 0.05 | 0.99 / 0.99 | 0.8 / 0.8 | gravity, drag, position | 0.5 | +20 up | no |
| experience bottle | 0.07 | 0.99 / 0.99 | 0.8 / 0.8 | gravity, drag, position | 0.7 | +20 up | no |
| fishing bobber (approx.) | 0.03 | 0.92 / 0.92 | 0.92 / 0.92 | position, gravity, drag | n/a | n/a | no |
| item, falling block, TNT (approx.) | 0.04 | 0.98 / 0.98 | 0.98 / 0.98 | gravity, position, drag | n/a | n/a | no |

`drag` is split into horizontal (x, z) and vertical (y) everywhere; override with `dragH` / `dragV`, `gravity`, `tickOrder`.
The order matters: for a throwable, gravity and drag are applied before the move, so the very first tick already moves
with the reduced velocity; for an arrow the first move uses the launch velocity unchanged.

Potions and bottles are thrown **20 degrees above** the look direction (Minecraft's own pitch offset is -20, and negative
pitch is up). In this plugin pitch is degrees above the horizon, so the offset is +20.
Yaw follows Minecraft: 0 faces +Z, positive turns towards -X.

Launch (`launchVelocity`): aim = look pitch + pitch offset; unit direction + spread; times speed; then the shooter's
horizontal velocity is added, and vertical velocity only when not on the ground. Random inaccuracy is off by default
(`random` or a fixed `spread` vector turns it on; the vanilla spread is triangular, `0.0172275 * inaccuracy` per axis).

Bow: power = `(t^2 + 2t) / 3`, `t = min(ticks, 20) / 20`, no shot below 0.1, speed = power x 3. A full draw is a
**critical** shot (explicit flag). Damage = `ceil(speed x baseDamage)` using the **speed at impact**; a critical adds a
random `0..floor(d/2)+2`; Power adds `0.5 x level + 0.5` to the base damage. Armour and other mitigation are not modelled.

Water: the old `water` flag still means "in water for the whole flight". `inWater` (API) takes a boolean, a list of
inclusive tick ranges, or a function `({tick, pos, vel}) => boolean`, so a projectile can enter and leave water; tick 0 is
the first simulated tick. The command accepts `water` or `water=5-20,30-40`.

Impact: the crossing of the target plane is interpolated inside the tick, and the reported impact speed is the velocity the
projectile moved with on that tick (before the next drag and gravity). Maximum height and best angle come from the tick
simulation, never from `v^2 sin(2a) / g`.

## Install

Copy this folder to `src/plugins/projectile-motion/` in flying-squid and enable it:

```json
"plugins": { "projectile-motion": {} }
```

## Command

```
/projectile speed=3 pitch=45                      range, flight time, max height, impact speed, best angle, damage
/projectile draw=20 distance=40 dy=5              pitch(es) that hit a target 40 blocks away and 5 above
/projectile projectile=snowball distance=25       lowest speed that reaches it, plus the angles
/projectile projectile=splash_potion pitch=10 vanilla     projectile launch speed + pitch offset (shows the look angle)
/projectile speed=3 pitch=30 water=5-20           in water during ticks 5 to 20
```
Options: `projectile=` `speed=` `draw=` `pitch=` `distance=` `dy=` (target height relative to the launcher; default target is the
ground) `height=` (launcher height above the ground) `yaw=` `pvx= pvy= pvz=` (shooter velocity, vanilla mode) `ground=0`
`power=` `critical=` `vanilla` `water` `gravity=` `drag=` `dragH=` `dragV=`. Alias `/pm`.

## API (`serv.projectileMotion`, or `require('./lib/physics')`)

Existing: `simulate`, `heightAt`, `solvePitch`, `solveSpeed`, `bestAngle`, `bowPower`, `bowSpeed`, `drawTicksForSpeed`,
`arrowDamage`, `calculate`, `format`, `PROJECTILES`.
New: `step` (one tick), `resolve` (physics parameters), `launchVelocity`, `velocityFromAngles`, `trajectory`, `collision`
(swept segment vs box, box inflated 0.3 like vanilla's entity hit test), `simulateMany` (seeded scatter + hit rate),
`bowCritical`.

Compatibility notes: `PROJECTILES[x].drag` / `waterDrag` are now `{h, v}` objects (they were numbers); path entries gain
`pos`, `vel`, `moveVel` (and `x` is still the horizontal distance); `arrowDamage(speed, {baseDamage, power, critical})`
no longer infers a critical hit from speed (the old `(speed, baseDamage, powerLevels)` call still works).
A bug fix: `height` with the default target previously aimed the target plane at `-height` below a launcher already
placed at `height`; the ground is now y = 0.

## Known unverified

* Throwable tick order (gravity, drag, position) and the thrown-item water drag 0.8: believed correct for 1.21.2+, not read from 26.1.
* Trident launch speed and water drag, potion / bottle gravity and speeds.
* Fishing bobber: drag 0.92 on all axes and its order. A wiki-derived review gave 0.99 horizontal / 0.92 vertical; use `dragH=0.99`
  to try that. Hooked, landed and in-water states are not modelled.
* item / falling block / TNT: simplified; ground friction, water behaviour and collisions are not modelled.

## Tests

`node test/physics.test.js` (39 tests: per-projectile ticks, launch, water, trajectory solvers, collision, scatter, bow, command).
