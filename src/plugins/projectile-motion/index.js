'use strict'
// projectile-motion: a vanilla projectile motion calculator for flying-squid (Java Edition physics).
//   /projectile speed=3 pitch=45                       -> range, flight time, max height, impact speed
//   /projectile draw=20 distance=40 dy=5               -> pitch(es) needed (bow drawn 20 ticks)
//   /projectile projectile=snowball distance=25        -> lowest speed needed + angles
// API: serv.projectileMotion.{simulate, solvePitch, solveSpeed, bestAngle, bowSpeed, drawTicksForSpeed, arrowDamage, calculate, PROJECTILES}
const physics = require('./lib/physics')

const f = (n, d = 2) => (n === null || n === undefined) ? 'n/a' : Number(n).toFixed(d)

function parseArgs (text) {
  const out = {}
  for (const tok of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    const [k, v] = tok.split('=')
    if (v === undefined) { out[k] = true; continue }
    out[k] = isNaN(Number(v)) ? v : Number(v)
  }
  return out
}

// One entry point that returns structured results for either direction of the calculator.
function calculate (a) {
  const base = { projectile: a.projectile || 'arrow', water: !!a.water, height: a.height || 0 }
  if (a.gravity !== undefined) base.gravity = a.gravity
  if (a.drag !== undefined) base.drag = a.drag
  let speed = a.speed
  if (speed === undefined && a.draw !== undefined) speed = physics.bowSpeed(a.draw)
  const result = { input: { ...base, speed } }

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
    for (const key of ['low', 'high']) {
      if (angles[key] !== null) {
        const h = physics.heightAt({ ...base, speed, pitch: angles[key] }, a.distance)
        result[key + 'Ticks'] = h && h.ticks
      }
    }
    return result
  }

  if (speed === undefined || a.pitch === undefined) throw new Error('give speed (or draw) and pitch, or distance')
  const sim = physics.simulate({ ...base, speed, pitch: a.pitch, targetY: a.dy !== undefined ? a.dy : -base.height })
  result.sim = sim
  result.best = physics.bestAngle({ ...base, speed, targetY: a.dy !== undefined ? a.dy : -base.height })
  if (base.projectile === 'arrow' && speed > 0) result.damage = physics.arrowDamage(speed)
  return result
}

function format (r) {
  const lines = []
  const i = r.input
  lines.push(`${i.projectile}${i.water ? ' (water)' : ''}: speed ${f(i.speed, 3)} b/t (${f(i.speed * 20, 1)} b/s)`)
  if (r.minSpeed !== undefined) {
    lines.push(r.minSpeed === null ? 'cannot reach that target at any speed' : `minimum speed ${f(r.minSpeed, 3)} b/t` + (i.projectile === 'arrow' ? (r.drawTicks ? `, bow draw >= ${r.drawTicks} ticks` : ', more than a full draw') : ''))
  }
  if (r.angles) {
    if (!r.angles.reachable) lines.push('target out of reach at this speed')
    else {
      lines.push(`low angle ${f(r.angles.low)} deg` + (r.lowTicks ? ` (${f(r.lowTicks, 1)} ticks)` : ''))
      if (r.angles.high !== null) lines.push(`high angle ${f(r.angles.high)} deg` + (r.highTicks ? ` (${f(r.highTicks, 1)} ticks)` : ''))
    }
  }
  if (r.sim) {
    const s = r.sim
    lines.push(s.landed ? `range ${f(s.range)} blocks, flight ${f(s.flightTicks, 1)} ticks (${f(s.flightSeconds)} s), impact speed ${f(s.impactSpeed, 3)} b/t` : 'does not come back down within the simulation limit')
    lines.push(`max height ${f(s.maxHeight)} blocks above the launch plane at tick ${s.apexTick} (${f(s.apexSeconds)} s)`)
    if (r.best) lines.push(`best angle for range: ${f(r.best.pitch)} deg -> ${f(r.best.range)} blocks`)
    if (r.damage) lines.push(`arrow damage ${r.damage.min}${r.damage.critical ? ` to ${r.damage.max} (crit)` : ''} (base 2)`)
  }
  return lines
}

module.exports.server = function (serv) {
  serv.projectileMotion = Object.assign({ calculate, format, parseArgs }, physics)

  serv.commands.add({
    base: 'projectile',
    aliases: ['pm'],
    info: 'Projectile motion calculator (vanilla physics)',
    usage: '/projectile [projectile=arrow|snowball|...] (speed=<b/t> | draw=<ticks>) (pitch=<deg up> | distance=<blocks>) [dy=<target height>] [height=<launch height>] [water] [gravity=] [drag=]',
    op: false,
    action (params) {
      const text = String(params || '').trim()
      if (!text || text === 'help') {
        return 'Usage: /projectile speed=3 pitch=45 | /projectile draw=20 distance=40 dy=5 | /projectile projectile=snowball distance=25. Projectiles: ' + Object.keys(physics.PROJECTILES).join(', ')
      }
      try {
        return format(calculate(parseArgs(text))).join('\n')
      } catch (e) {
        return 'projectile: ' + e.message
      }
    }
  })
}
