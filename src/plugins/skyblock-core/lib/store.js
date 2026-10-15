'use strict'
const fs = require('fs')
const path = require('path')
const { ProfileState, VERSION } = require('./profile')

/** One JSON file per player: <dir>/<uuid>.json. Items are stored in the neutral form (see convert.js). */
class FileStore {
  constructor (dir, conv) { this.dir = dir; this.conv = conv }
  file (uuid) { return path.join(this.dir, String(uuid).replace(/-/g, '') + '.json') }
  exists (uuid) { return fs.existsSync(this.file(uuid)) }
  save (profile) {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.file(profile.uuid) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(profile.toJSON(it => this.conv.neutralFromItem(it))))
    fs.renameSync(tmp, this.file(profile.uuid))
  }

  load (uuid) {
    if (!this.exists(uuid)) return null
    const json = JSON.parse(fs.readFileSync(this.file(uuid), 'utf8'))
    if (json.version !== VERSION) { // older item format: keep a copy and ask for a fresh import instead of loading degraded items
      fs.renameSync(this.file(uuid), this.file(uuid).replace(/\.json$/, `.v${json.version}.bak`))
      return null
    }
    return ProfileState.fromJSON(json, n => this.conv.build(n))
  }

  delete (uuid) { try { fs.unlinkSync(this.file(uuid)) } catch { /* none */ } }
}

module.exports = { FileStore }
