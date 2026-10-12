/**
 * skyblock-profile — loads the joining player's SkyBlock profile from the Hypixel API.
 *
 *   player.skyblock = { state: 'loading'|'ready'|'unavailable', ready: Promise, summary, source, memberUuid }
 *   player.on('skyblockLoaded', (summary) => ...)
 *   serv.skyblock.buildSummary(resp, uuid)
 *
 * Needs the `hypixel-api` plugin. Load order in config/settings.json does not matter.
 */
const { buildSummary } = require('./lib/summary')

module.exports.server = function (serv, options) {
  serv.skyblock = { buildSummary, lib: { skills: require('./lib/skills'), pets: require('./lib/pets'), calendar: require('./lib/calendar'), format: require('./lib/format') } }
}

module.exports.player = function (player, serv) {
  const sb = player.skyblock = { state: 'loading', summary: null, source: null, memberUuid: null }
  sb.ready = new Promise(resolve => {
    // start as soon as the player object exists (before login finishes) so data is ready by the first menu open
    player.once('asap', async () => {
      const uuid = player._client.uuid
      try {
        if (!serv.hypixel) throw new Error('hypixel-api plugin is not enabled')
        const got = await serv.hypixel.getSkyblockProfiles(uuid)
        if (!got) throw new Error('no profile data (no API key and no sample)')
        const tables = await serv.hypixel.getSkillTables().catch(() => null)
        const summary = buildSummary(got.response, got.memberUuid, { skillTables: tables || {} })
        if (!summary) throw new Error('player has no SkyBlock profile')
        Object.assign(sb, { state: 'ready', summary, source: got.source, memberUuid: got.memberUuid, actingAs: !!got.actingAs, skillTables: tables })
        serv.info?.(`[skyblock-profile] ${player._client.username}: ${summary.profile.name} · SB ${summary.sbLevel.level} · skill avg ${summary.skillAverage.toFixed(1)} · source ${got.source}${got.actingAs ? ' (showing sample member ' + got.memberUuid + ')' : ''}`)
        player.emit('skyblockLoaded', summary)
      } catch (e) {
        sb.state = 'unavailable'; sb.error = e.message
        serv.info?.(`[skyblock-profile] ${player._client.username}: ${e.message}`)
      }
      resolve(sb)
    })
  })
}
