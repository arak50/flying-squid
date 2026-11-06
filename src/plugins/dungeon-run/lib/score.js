'use strict'
/**
 * Dungeon Score (Team Score) = Skill + Explore + Speed + Bonus, as in Skyblocker's DungeonScore.java.
 *
 *   Skill    20 + clamp(floor(80 * completed / total) - 10 * unfinished puzzles - (2 * deaths - spirit), 0, 80)
 *   Explore  floor(60 * completed / total)  +  floor(40 * min(req, secrets %) / req)      req = floor's secret requirement
 *   Speed    100 until the floor's time limit, then drops in five bands (see timeScore)
 *   Bonus    min(5, crypts) + 2 mimic (F6/F7/M6/M7; also when every secret is found) + 1 prince + 1 bat + 10 EZPZ (mayor Paul)
 *   Entrance each of Skill, Explore, Speed is multiplied by 0.7 and rounded, the bonus is added as is.
 *
 * `completed` is the tab list's "Completed Rooms" (a room the party has cleared). `secretsPercent` is the tab's
 * "Secrets Found: 28.6%". The capture's final "Team Score: 155 (C)" comes out of exactly this (test: real-run).
 * Pure function of its inputs, so the sidebar can recompute it at any moment.
 */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 0 = Entrance -> "E"; otherwise F<n> or M<n>. */
const floorKey = (floor, master) => floor === 0 ? 'E' : `${master ? 'M' : 'F'}${floor}`

function timeScore (elapsed, limit) {
  if (elapsed < limit) return 100
  const past = (elapsed - limit) / limit * 100
  if (past < 20) return 100 - Math.floor(past / 2)
  if (past < 40) return 100 - Math.floor(10 + (past - 20) / 4)
  if (past < 50) return 100 - Math.floor(15 + (past - 40) / 5)
  if (past < 60) return 100 - Math.floor(17 + (past - 50) / 6)
  return clamp(100 - Math.floor(18 + 2 / 3 + (past - 60) / 7), 0, 100)
}

/**
 * @param s { floor, master, totalRooms, completedRooms, extraCompletedRooms?, secretsPercent, incompletePuzzles, deaths,
 *            spiritPet, elapsedSeconds, crypts, mimicKilled, princeKilled, batKilled, ezpz }
 */
function compute (s, cfg) {
  const c = cfg.score
  const key = floorKey(s.floor, s.master)
  const req = c.floors[key] || { secrets: 100, time: 600 }
  const done = (s.completedRooms || 0) + (s.extraCompletedRooms || 0)
  const frac = s.totalRooms > 0 ? done / s.totalRooms : 0
  const deathPenalty = (s.deaths || 0) * c.deathPenalty - (s.spiritPet && s.deaths ? 1 : 0)

  const skill = c.skillBase + clamp(clamp(Math.floor(c.skillRoomsMax * frac), 0, c.skillRoomsMax) - c.puzzlePenalty * (s.incompletePuzzles || 0) - deathPenalty, 0, c.skillRoomsMax)
  const roomsPart = clamp(Math.floor(c.exploreRoomsMax * frac), 0, c.exploreRoomsMax)
  const pct = s.secretsPercent || 0
  const secretsPart = clamp(Math.floor(c.exploreSecretsMax * Math.min(req.secrets, pct) / req.secrets), 0, c.exploreSecretsMax)
  const explore = roomsPart + secretsPart
  const speed = timeScore(s.elapsedSeconds || 0, req.time)

  const hasMimics = c.bonus.mimicFloors.includes(key)
  const mimic = hasMimics && (s.mimicKilled || pct >= 100) ? c.bonus.mimic : 0
  const bonus = clamp(s.crypts || 0, 0, c.bonus.cryptsMax) + mimic + (s.princeKilled ? c.bonus.prince : 0) + (s.batKilled ? c.bonus.bat : 0) + (s.ezpz ? c.bonus.ezpz : 0)

  const m = key === 'E' ? v => Math.round(v * c.entranceMultiplier) : v => v
  const parts = { skill: m(skill), explore: m(explore), speed: m(speed), bonus }
  const total = parts.skill + parts.explore + parts.speed + parts.bonus
  const rank = (c.ranks.find(([, min]) => total >= min) || c.ranks[c.ranks.length - 1])[0]
  return { ...parts, total, rank, floorKey: key }
}

module.exports = { compute, timeScore, floorKey }
