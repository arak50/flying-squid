'use strict'
/**
 * Sidebar scoreboard + titles, written as raw packets (flying-squid has no scoreboard API).
 *
 * Every line is one score entry (`line0`, `line1` ...) of a single objective, shown in the sidebar slot with a custom
 * display text and the red numbers blanked out (number_format 0), like Hypixel does. Higher value = higher on screen.
 * Packet shapes are the 1.21.4 / 26.1 ones; test/dungeon-run.test.js serialises them with minecraft-protocol to prove it.
 */
const { componentToNbt } = require('../../dungeon-mobs/lib/nametag')

const OBJECTIVE = 'dungeon_run'
const text = (t, color = 'white') => componentToNbt({ text: t, color })

const COLORS = { 0: 'black', 1: 'dark_blue', 2: 'dark_green', 3: 'dark_aqua', 4: 'dark_red', 5: 'dark_purple', 6: 'gold', 7: 'gray', 8: 'dark_gray', 9: 'blue', a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white' }
/** "§aGreen §lbold" -> text component with one `extra` entry per colour run. A colour code resets bold / italic, like in the game. */
function legacy (str) {
  const extra = []
  let color = 'white'; let bold = false; let italic = false; let buf = ''
  const flush = () => { if (buf) extra.push({ text: buf, color, ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}) }); buf = '' }
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '§' && i + 1 < str.length) {
      const c = str[++i].toLowerCase()
      flush()
      if (COLORS[c]) { color = COLORS[c]; bold = false; italic = false } else if (c === 'l') bold = true
      else if (c === 'o') italic = true
      else if (c === 'r') { color = 'white'; bold = false; italic = false }
    } else buf += str[i]
  }
  flush()
  return extra.length ? { text: '', extra } : { text: '' } // the client rejects an empty `extra` list (blank sidebar lines)
}
const legacyNbt = str => componentToNbt(legacy(str))

function createSidebar () {
  const shown = new Map() // player -> how many lines are currently on screen
  const safe = (player, name, params) => { try { player._client.write(name, params) } catch (e) { /* client gone */ } }

  return {
    show (player, title) {
      safe(player, 'scoreboard_objective', { name: OBJECTIVE, action: 0, displayText: legacyNbt(title.includes('§') ? title : `§e§l${title}`), type: 0, number_format: 0 })
      safe(player, 'scoreboard_display_objective', { position: 1, name: OBJECTIVE })
      shown.set(player, 0)
    },
    update (player, lines) {
      if (!shown.has(player)) return
      lines.forEach((line, i) => safe(player, 'scoreboard_score', { itemName: `line${i}`, scoreName: OBJECTIVE, value: lines.length - i, display_name: legacyNbt(line), number_format: 0 }))
      for (let i = lines.length; i < shown.get(player); i++) safe(player, 'reset_score', { entity_name: `line${i}`, objective_name: OBJECTIVE })
      shown.set(player, lines.length)
    },
    hide (player) {
      if (!shown.has(player)) return
      safe(player, 'scoreboard_objective', { name: OBJECTIVE, action: 1 })
      shown.delete(player)
    },
    title (player, main, sub, { fadeIn = 5, stay = 30, fadeOut = 10 } = {}) {
      safe(player, 'set_title_time', { fadeIn, stay, fadeOut })
      if (sub) safe(player, 'set_title_subtitle', { text: text(sub, 'gray') })
      safe(player, 'set_title_text', { text: text(main, 'gold') })
    }
  }
}

module.exports = { createSidebar, OBJECTIVE, text, legacy, legacyNbt }
