/**
 * skyblock-personalize — swaps the sniffed player's numbers in the menus for the joining player's
 * (skills, skill average, SkyBlock level, selected pet, profile name/count, calendar, cookie, skin).
 * Needs: skyblock-menu, skyblock-profile, hypixel-api.
 * config: { "captureUuid": "<uuid of the player the sniff was recorded from>" }
 */
const { install } = require('./lib/patchers')

module.exports.server = function (serv, options) {
  const cfg = Object.assign({ captureUuid: '88e266f9f6dd41028bda58e009ab1c3c' }, this.settings || {})
  if (!serv.skyblockMenu) return serv.err?.('[skyblock-personalize] enable the skyblock-menu plugin first (list it before this one)')
  install(serv.skyblockMenu, { captureUuid: cfg.captureUuid, log: serv.info?.bind(serv) })
}
