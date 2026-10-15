'use strict'
// SkyBlock level rewards. Level = floor(leveling.experience / 100).
// RECORDED on one account (level 307): Health +1,535 (= 5 per level) and Strength +61 (= 1 per 5 levels). Other level rewards
// are not recorded yet, so they are intentionally absent (see docs/skyblock/ARCHITECTURE.md §8).
module.exports = {
  id: 'sb_level',
  collect (ctx, push) {
    const xp = ctx.profile && ctx.profile.leveling && ctx.profile.leveling.experience
    if (!xp) return
    const level = Math.floor(xp / 100)
    push({ stat: 'health', amount: level * 5, group: 'sb_level', label: 'SkyBlock Level', category: 'SkyBlock Levels', level })
    push({ stat: 'strength', amount: Math.floor(level / 5), group: 'sb_level', label: 'SkyBlock Level', category: 'SkyBlock Levels', level })
  }
}
