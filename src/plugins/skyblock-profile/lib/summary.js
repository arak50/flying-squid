// Turns a /v2/skyblock/profiles response into the handful of values the menus need.
const { computeSkills } = require('./skills')
const { petLevel, effectiveTier, COLOR } = require('./pets')
const { titleCase } = require('./format')

const MAX_PROFILES = 3

function pickProfile (resp, memberUuid) {
  const list = (resp?.profiles || []).filter(p => p.members?.[memberUuid])
  return list.find(p => p.selected) || list[0] || null
}

function activePet (member) {
  const pets = member.pets_data?.pets || []
  const p = pets.find(x => x.active)
  if (!p) return null
  const tier = effectiveTier(p)
  const lv = petLevel(p.exp || 0, tier, p.type)
  return { type: p.type, name: titleCase(p.type), tier, color: COLOR[tier], exp: p.exp || 0, skin: p.skin || null, heldItem: p.heldItem || null, ...lv }
}

/**
 * @param resp         API response ({ profiles: [...] })
 * @param memberUuid   dash-less uuid of the player whose data to read
 * @param extra        { skillTables, now }
 */
function buildSummary (resp, memberUuid, extra = {}) {
  const profile = pickProfile(resp, memberUuid)
  if (!profile) return null
  const m = profile.members[memberUuid]
  const { skills, average } = computeSkills(m, extra.skillTables || {})
  const sbxp = m.leveling?.experience || 0
  return {
    memberUuid,
    profile: { id: profile.profile_id, name: profile.cute_name, gameMode: profile.game_mode || 'normal', count: (resp.profiles || []).filter(p => p.members?.[memberUuid]).length, max: MAX_PROFILES },
    skills,
    skillAverage: average,
    sbLevel: { level: Math.floor(sbxp / 100), into: sbxp % 100, per: 100, total: sbxp },
    pet: activePet(m),
    purse: m.currencies?.coin_purse ?? null,
    motes: m.currencies?.motes_purse ?? null,
    essence: Object.fromEntries(Object.entries(m.currencies?.essence || {}).map(([k, v]) => [k, v.current])),
    cookieActive: !!m.profile?.cookie_buff_active,
    fairySouls: { collected: m.fairy_soul?.total_collected ?? 0, unspent: m.fairy_soul?.unspent_souls ?? 0 },
    raw: m // for plugins that want more (inventory NBT, collections, ...)
  }
}

module.exports = { buildSummary, pickProfile, activePet, MAX_PROFILES }
