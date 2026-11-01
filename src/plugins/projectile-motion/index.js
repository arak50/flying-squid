'use strict'
// projectile-motion: a vanilla projectile motion calculator for flying-squid (Java Edition physics).
//   /projectile speed=3 pitch=45                       idealised: you give the launch speed and angle
//   /projectile draw=20 distance=40 dy=5               pitch(es) needed (bow drawn 20 ticks)
//   /projectile projectile=snowball distance=25        lowest speed needed + angles
//   /projectile projectile=splash_potion pitch=10 vanilla   vanilla launch: projectile speed + pitch offset
// API: serv.projectileMotion.{simulate, trajectory, step, resolve, launchVelocity, velocityFromAngles, collision,
//   simulateMany, solvePitch, solveSpeed, bestAngle, bowSpeed, bowPower, bowCritical, drawTicksForSpeed, arrowDamage,
//   calculate, format, PROJECTILES}
const physics = require('./lib/physics')

const f = (n, d = 2) => (n === null || n === undefined) ? 'n/a' : Number(n).toFixed(d)

function parseWater (v) {
  if (v === undefined || v === false) return undefined
  if (v === true) return true
  // water=10-18,25-30 : inclusive tick ranges (tick 0 = the first simulated tick)
  return String(v).split(',').map(r => r.split('-').map(Number)).filter(r => r.length === 2 && !r.some(isNaN))
}

function parseArgs (text) {
  const out = {}
  for (const tok of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    const [k, v] = tok.split('=')
    if (v === undefined) { out[k] = true; continue }
    out[k] = isNaN(Number(v)) ? v : Number(v)
  }
  if (out.water !== undefined) out.water = parseWater(out.water)
  return out
}

// One entry point that returns structured results for either direction of the calculator.
function calculate (a) {
  const name = a.projectile || 'arrow'
  const profile = physics.PROJECTILES[name]
  const base = { projectile: name }
  for (const k of ['gravity', 'drag', 'dragH', 'dragV', 'tickOrder']) if (a[k] !== undefined) base[k] = a[k]
  if (a.water !== undefined) base.inWater = a.water
  const height = a.height || 0
  const vanilla = !!a.vanilla
  const offset = vanilla && profile && profile.launch ? profile.launch.pitchOffset : 0

  let speed = a.speed
  if (speed === undefined && a.draw !== undefined) speed = physics.bowSpeed(a.draw)
  if (speed === undefined && vanilla && profile && profile.launch && profile.launch.speed) speed = profile.launch.speed
  const critical = a.critical !== undefined ? !!a.critical : (a.draw !== undefined && physics.bowCritical(a.draw))
  const result = { input: { ...base, speed, height, vanilla, pitchOffset: offset }, critical }

  if (a.distance !== undefined) {
    const dy = a.dy || 0
    if (speed === undefined) {
      speed = physics.solveSpeed({ ...base, distance: a.distance, dy })
      result.minSpeed = speed
      result.drawTicks = speed === null ? null : physics.drawTicksForSpeed(speed)
      if (speed === null) return result
    }
    const angles = physics.solvePitch({ ...base, speed, distance: a.distance, dy })
    result.input.speed = speed
    result.angles = angles
    result.lookAngles = {
      low: angles.low === null ? null : angles.low - offset,
      high: angles.high === null ? null : angles.high - offset
    }
    for (const key of ['low', 'high']) {
      if (angles[key] !== null) {
        const h = physics.heightAt({ ...base, speed, pitch: angles[key] }, a.distance)
        result[key + 'Ticks'] = h && h.ticks
      }
    }
    return result
  }

  if (a.pitch === undefined || (speed === undefined)) throw new Error('give speed (or draw, or vanilla for a throwable) and pitch, or distance')
  const playerVelocity = (a.pvx !== undefined || a.pvy !== undefined || a.pvz !== undefined) ? { x: a.pvx || 0, y: a.pvy || 0, z: a.pvz || 0 } : undefined
  const aim = { yaw: a.yaw || 0, pitch: a.pitch, playerVelocity, onGround: a.ground !== 0 && a.ground !== false }
  const sim = {
    ...base,
    height,
    targetY: a.dy !== undefined ? height + a.dy : 0 // dy is relative to the launcher; default target plane is the ground
  }
  if (vanilla) {
    sim.velocity = physics.launchVelocity({ projectile: name, speed, ...aim })
    result.launch = sim.velocity
  } else {
    Object.assign(sim, { speed, ...aim })
  }
  result.sim = physics.simulate(sim)
  if (!playerVelocity) result.best = physics.bestAngle({ ...base, speed, height, targetY: sim.targetY })
  if (name === 'arrow' || name === 'spectral_arrow') {
    const at = result.sim.impactSpeed !== null ? result.sim.impactSpeed : speed
    result.damage = physics.arrowDamage(at, { power: a.power || 0, critical })
  }
  return result
}

function format (r) {
  const lines = []
  const i = r.input
  const water = i.inWater === true ? ' (always in water)' : (i.inWater ? ' (partly in water)' : '')
  lines.push(`${i.projectile}${water}: speed ${f(i.speed, 3)} b/t (${f(i.speed * 20, 1)} b/s)`)
  if (r.minSpeed !== undefined) {
    lines.push(r.minSpeed === null ? 'cannot reach that target at any speed' : `minimum speed ${f(r.minSpeed, 3)} b/t` + (i.projectile === 'arrow' ? (r.drawTicks ? `, bow draw >= ${r.drawTicks} ticks` : ', more than a full draw') : ''))
  }
  if (r.angles) {
    if (!r.angles.reachable) lines.push('target out of reach at this speed')
    else {
      const look = (k) => i.pitchOffset ? ` (look ${f(r.lookAngles[k])} deg; the throw adds ${f(i.pitchOffset, 0)} deg up)` : ''
      lines.push(`low angle ${f(r.angles.low)} deg` + look('low') + (r.lowTicks ? ` (${f(r.lowTicks, 1)} ticks)` : ''))
      if (r.angles.high !== null) lines.push(`high angle ${f(r.angles.high)} deg` + look('high') + (r.highTicks ? ` (${f(r.highTicks, 1)} ticks)` : ''))
    }
  }
  if (r.launch) lines.push(`launch velocity (${f(r.launch.x, 3)}, ${f(r.launch.y, 3)}, ${f(r.launch.z, 3)}) b/t, actual pitch ${f(r.launch.pitch)} deg`)
  if (r.sim) {
    const s = r.sim
    lines.push(s.landed ? `range ${f(s.range)} blocks, flight ${f(s.flightTicks, 1)} ticks (${f(s.flightSeconds)} s), impact speed ${f(s.impactSpeed, 3)} b/t` : 'does not come back down within the simulation limit')
    lines.push(`max height ${f(s.maxHeight)} blocks above the launch plane at tick ${s.apexTick} (${f(s.apexSeconds)} s)`)
    if (r.best) lines.push(`best angle for range: ${f(r.best.pitch)} deg${i.pitchOffset ? ` (look ${f(r.best.pitch - i.pitchOffset)} deg)` : ''} -> ${f(r.best.range)} blocks`)
    if (r.damage) {
      const d = r.damage
      lines.push(`arrow damage ${d.min}${d.critical ? ` to ${d.max} (critical)` : ''} at the impact speed (base ${d.base}${d.powerBonus ? ` + Power ${f(d.powerBonus, 1)}` : ''}; armour not modelled)`)
    }
  }
  const prof = physics.PROJECTILES[i.projectile]
  if (prof && prof.verified === false) lines.push('note: constants for ' + i.projectile + ' are not yet verified against the 26.1 source')
  if (prof && prof.approximate) lines.push('note: ' + i.projectile + ' is a simplified model')
  return lines
}

module.exports.server = function (serv) {
  serv.projectileMotion = Object.assign({ calculate, format, parseArgs }, physics)

  serv.commands.add({
    base: 'projectile',
    aliases: ['pm'],
    info: 'Projectile motion calculator (vanilla physics)',
    usage: '/projectile [projectile=arrow|snowball|...] (speed=<b/t> | draw=<ticks> | vanilla) (pitch=<deg up> | distance=<blocks>) [dy=<target height>] [height=<launch height>] [yaw=] [pvx= pvy= pvz=] [ground=0] [power=] [water | water=<from>-<to>,...] [gravity=] [drag=] [dragH= dragV=]',
    op: false,
    action (params) {
      const text = String(params || '').trim()
      if (!text || text === 'help') {
        return 'Usage: /projectile speed=3 pitch=45 | /projectile draw=20 distance=40 dy=5 | /projectile projectile=snowball distance=25 | /projectile projectile=splash_potion pitch=10 vanilla. Projectiles: ' + Object.keys(physics.PROJECTILES).join(', ')
      }
      try {
        return format(calculate(parseArgs(text))).join('\n')
      } catch (e) {
        return 'projectile: ' + e.message
      }
    }
  })
}

module.exports.calculate = calculate
module.exports.format = format
module.exports.parseArgs = parseArgs
