// Render hooks: replace the values captured for the sniffed player with the joining player's own.
// Every patcher only touches lines it can derive from the API; everything else stays as captured.
const nbt = require('../../skyblock-menu/lib/nbt')
const { seg, line, blank, segsOf, textOf, setText, getText, loreOf, findLine } = nbt
const { fmt, abbr, pct } = require('../../skyblock-profile/lib/format')
const { calendar } = require('../../skyblock-profile/lib/calendar')

const BAR = 25
const barSegs = (frac, colors) => {
  const g = Math.max(0, Math.min(BAR, Math.round(frac * BAR)))
  return [seg(' '.repeat(g), colors[0], { bold: 1, strikethrough: 1 }), seg(' '.repeat(BAR - g), colors[1], { bold: 1, strikethrough: 1 })]
}
const progressBarLine = (frac, into, need) => line([...barSegs(frac, ['dark_green', 'white']), seg(' '), seg(fmt(into), 'yellow'), seg('/', 'gold'), seg(abbr(need), 'yellow')])
const progressLines = (lv) => [line([seg(`Progress to Level ${lv.nextLevel}: `, 'gray'), seg(pct(lv.progress), 'yellow')]), progressBarLine(lv.progress, lv.into, lv.need)]

// replace lore[i..j) with new lines but keep the old ones if the visible text is identical (keeps raw bytes)
function replaceLines (lore, i, j, fresh) {
  const same = fresh.length === j - i && fresh.every((l, k) => textOf(l) === textOf(lore[i + k]))
  if (!same) lore.splice(i, j - i, ...fresh)
}
const setLast = (ln, text) => { const s = segsOf(ln); if (getText(s[s.length - 1]) !== text) setText(s[s.length - 1], text) }
const setLabelled = (lore, re, text) => { const i = findLine(lore, re); if (i >= 0) setLast(lore[i], text); return i }

const SKILL_NAMES = { Combat: 'COMBAT', Farming: 'FARMING', Fishing: 'FISHING', Mining: 'MINING', Foraging: 'FORAGING', Enchanting: 'ENCHANTING', Alchemy: 'ALCHEMY', Carpentry: 'CARPENTRY', Taming: 'TAMING', Hunting: 'HUNTING', Runecrafting: 'RUNECRAFTING', Social: 'SOCIAL' }

function install (engine, { captureUuid, log }) {
  const ctxOf = (player) => { const sb = player.skyblock; return sb && sb.state === 'ready' ? sb.summary : null }
  const isCapture = (s) => s.memberUuid === String(captureUuid || '').replace(/-/g, '')

  engine.addHook(async (view, { player, screenId }) => {
    const S = ctxOf(player)
    if (!S) return
    const cap = isCapture(S)
    const cal = calendar()

    // --- skin on any head that shows the sniffed player ---
    for (let i = 0; i < view.topCount; i++) {
      const it = view.item(i)
      const prof = it && it.itemCount && nbt.getComp(it, 'profile')
      if (prof && prof.data.uuid && prof.data.uuid.replace(/-/g, '') === String(captureUuid).replace(/-/g, '') && !cap && player._client.profile) {
        view.edit(i, (x) => {
          const p = nbt.getComp(x, 'profile')
          p.data = { type: 'complete', uuid: player._client.uuid, name: player._client.username, properties: (player._client.profile.properties || []).map(q => ({ name: q.name, value: q.value, signature: q.signature })), skinPatch: {} }
        })
      }
    }

    // --- main SkyBlock menu ---
    if (screenId === 'skyblock_menu') {
      view.edit(19, (it) => patchAvgLine(it, S))
      view.edit(22, (it) => patchLevelItem(loreOf(it), S))
      view.edit(24, (it) => patchCalendar(loreOf(it), cal))
      view.edit(30, (it) => patchPet(loreOf(it), S))
      view.edit(48, (it) => { const l = loreOf(it); const i = findLine(l, /^Profiles:/); if (i >= 0) { const s = segsOf(l[i]); setText(s[2], String(S.profile.count)); setText(s[4], String(S.profile.max)) } setLabelled(l, /^Playing on:/, S.profile.name) })
      view.edit(51, (it) => {
        const l = loreOf(it); const i = findLine(l, /^Status:/)
        if (i >= 0) { const s = segsOf(l[i]); const want = S.cookieActive ? ['Active!', 'green'] : ['Not active!', 'red']; setText(s[2], want[0]); s[2].color = nbt.str(want[1]) }
        if (!cap) setLabelled(l, /^Bits Available:/, '?')
      })
      if (!cap) view.edit(13, (it) => maskStats(loreOf(it)))
    }

    // --- Your Skills ---
    if (screenId === 'your_skills') {
      view.edit(4, (it) => { patchAvgLine(it, S) })
      for (let i = 0; i < view.topCount; i++) {
        const m = /^(\w+) (\d+)$/.exec(view.name(i))
        const key = m && SKILL_NAMES[m[1]]
        if (key && S.skills[key]?.level != null) view.edit(i, (it) => patchSkillItem(it, m[1], S.skills[key]))
      }
    }

    // --- SkyBlock Leveling ---
    if (screenId === 'skyblock_leveling') {
      view.edit(4, (it) => {
        const l = loreOf(it)
        let i = findLine(l, /^Your level:/); if (i >= 0) setText(segsOf(l[i]).slice(-1)[0], String(S.sbLevel.level))
        i = findLine(l, /^You have:/); if (i >= 0) setText(segsOf(l[i]).slice(-1)[0], fmt(S.sbLevel.total, 0) + ' XP')
        if (!cap) {
          const r = findLine(l, /^Global Ranking:/); if (r >= 0) l.splice(r, 3)
          const c = findLine(l, /^You have completed/); if (c >= 0) for (const sg of segsOf(l[c])) if (/%/.test(getText(sg))) setText(sg, '?%')
        }
      })
      for (let k = 0; k < 5; k++) {
        view.edit(19 + k, (it) => {
          const n = nbt.nameNbt(it); const s = segsOf(n); setText(s[0], `Level ${S.sbLevel.level + k}`)
          if (k === 1) patchLevelBar(loreOf(it), S)
        })
      }
    }

    // --- Pets (selected pet header) ---
    if (screenId === 'pets') view.edit(4, (it) => patchPet(loreOf(it), S))
  })

  function patchAvgLine (it, S) {
    const l = loreOf(it); const i = findLine(l, /Skill Avg\./); if (i < 0) return
    const avg = S.skillAverage.toFixed(1).replace(/\.0$/, '')
    for (const sg of segsOf(l[i])) if (/^[\d.]+ Skill Avg\./.test(getText(sg))) setText(sg, getText(sg).replace(/^[\d.]+/, avg))
  }

  function patchLevelBar (l, S) {
    const i = findLine(l, /\d+\/\d+ XP/); if (i < 0) return
    const s = segsOf(l[i]); const spaces = s.filter(x => /^ +$/.test(getText(x)))
    const g = Math.round(S.sbLevel.into / S.sbLevel.per * BAR)
    if (spaces[0]) setText(spaces[0], ' '.repeat(g)); if (spaces[1]) setText(spaces[1], ' '.repeat(BAR - g))
    const num = s.find(x => /^\d+$/.test(getText(x))); if (num) setText(num, String(S.sbLevel.into))
  }

  function patchLevelItem (l, S) {
    let i = findLine(l, /^Your SkyBlock Level:/)
    if (i >= 0) { const num = segsOf(l[i]).find(x => /^\d+$/.test(getText(x))); setText(num, String(S.sbLevel.level)) }
    i = findLine(l, /^Progress to Level/)
    if (i >= 0) setText(segsOf(l[i])[0], `Progress to Level ${S.sbLevel.level + 1}:`)
    patchLevelBar(l, S)
  }

  function patchCalendar (l, cal) {
    setLabelled(l, /^Date:/, cal.date)
    const a = findLine(l, /^Active Event:/)
    if (cal.active) { setLabelled(l, /^Active Event:/, cal.active.text); setLabelled(l, /^Ends in:/, cal.active.endsInText) } else if (a >= 0) l.splice(a, 3)
    if (cal.next) { setLabelled(l, /^Next Event:/, cal.next.text); setLabelled(l, /^Starting in:/, cal.next.startsInText) }
  }

  function patchPet (l, S) {
    const i = findLine(l, /^Selected pet:/); if (i < 0) return
    const end = findLine(l, /^Also accessible/, i); if (end < 0) return
    const p = S.pet
    const fresh = []
    if (!p) fresh.push(line([seg('Selected pet: ', 'gray'), seg('None', 'red')]))
    else {
      fresh.push(line([seg('Selected pet: ', 'gray'), seg(p.name, p.color), ...(p.skin ? [seg(' ✦', 'dark_purple')] : [])]))
      fresh.push(blank())
      if (p.maxed) fresh.push(line([seg('MAX LEVEL', 'aqua', { bold: 1 })]), line([seg('▸ ' + fmt(p.exp, 0) + ' XP', 'dark_gray')]))
      else fresh.push(...progressLines(p))
    }
    fresh.push(blank())
    replaceLines(l, i, end, fresh)
  }

  function maskStats (l) {
    for (let i = 0; i < l.length; i++) {
      const t = textOf(l[i])
      if (/^(Speed|Strength|Defense|Crit Damage|Crit Chance|Health|Intelligence) /.test(t.trim())) { const s = segsOf(l[i]); setText(s[s.length - 1], '?') }
    }
  }

  function patchSkillItem (it, label, lv) {
    setText(segsOf(nbt.nameNbt(it))[0], `${label} ${lv.level}`)
    const l = loreOf(it)
    const i = findLine(l, /^(Progress to Level|Max Skill level)/); if (i < 0) return
    const oldNext = /Level (\d+)/.exec(textOf(l[i]))
    const wasMax = /^Max Skill/.test(textOf(l[i]))
    const fresh = lv.maxed
      ? [line([seg('Max Skill level reached!', 'dark_gray')]), line([seg(' '.repeat(20), lv.xp >= 0 ? 'gold' : 'yellow', { bold: 1, strikethrough: 1 }), seg(' '), seg(fmt(lv.xp), 'gold')])]
      : progressLines(lv)
    // original maxed bars are yellow, keep that colour
    if (lv.maxed) segsOf(fresh[1])[1].color = nbt.str('yellow')
    const same = wasMax === lv.maxed && fresh.every((f, k) => textOf(f) === textOf(l[i + k]))
    if (same) return
    // level changed: the captured reward block (for another level) would be wrong -> drop it
    const rw = findLine(l, /Rewards?:$/, i)
    const click = findLine(l, /^Click to view/, i)
    const stale = !(!wasMax && !lv.maxed && oldNext && +oldNext[1] === lv.nextLevel)
    if (rw >= 0 && click > rw && stale) l.splice(rw - 1, click - rw)
    const barEnd = i + 2
    l.splice(i, barEnd - i, ...fresh)
  }
}

module.exports = { install }
