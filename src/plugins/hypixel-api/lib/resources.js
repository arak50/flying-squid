'use strict'
// Public (keyless) Hypixel SkyBlock resources with memory + disk cache.
//   /v2/resources/skyblock/items | skills | collections

const fs = require('fs')
const path = require('path')

const TTL = 24 * 3600e3

function createResources ({ http, cacheDir, log }) {
  const mem = new Map()

  async function load (name) {
    if (mem.has(name)) return mem.get(name)
    const p = (async () => {
      const file = path.join(cacheDir, `${name}.json`)
      let body = null
      let stale = null
      try {
        const st = fs.statSync(file)
        stale = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Date.now() - st.mtimeMs < TTL) body = stale
      } catch { /* no cache */ }
      if (!body) {
        try {
          body = await http(`/v2/resources/skyblock/${name}`, { auth: false })
          fs.mkdirSync(cacheDir, { recursive: true })
          fs.writeFileSync(file, JSON.stringify(body))
        } catch (e) {
          log(`${name} resource unavailable (${e.message})${stale ? '; using stale cache' : ''}`)
          body = stale
        }
      }
      return body
    })()
    mem.set(name, p)
    p.then(v => { if (!v) mem.delete(name) })
    return p
  }

  async function getItems () {
    const body = await load('items')
    if (!body || !body.items) return null
    const byId = new Map(body.items.map(i => [i.id, i]))
    return { list: body.items, byId, lastUpdated: body.lastUpdated }
  }

  // { SKILL: [xpForLevel1, xpForLevel2, ...] } — same shape skyblock-profile already used.
  async function getSkillTables () {
    const body = await load('skills')
    if (!body || !body.skills) return null
    const out = {}
    for (const [id, sk] of Object.entries(body.skills)) {
      const lv = sk.levels || []
      out[id] = lv.map((l, i) => l.totalExpRequired - (i ? lv[i - 1].totalExpRequired : 0))
    }
    return out
  }

  const getSkills = async () => (await load('skills'))?.skills || null

  // { FARMING: { name, items: { WHEAT: { name, maxTiers, tiers: [{tier, amountRequired, unlocks}] } } } }
  const getCollections = async () => (await load('collections'))?.collections || null

  return { getItems, getSkills, getSkillTables, getCollections }
}

module.exports = { createResources }
