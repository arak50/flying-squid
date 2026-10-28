'use strict'
// Storage, Ender Chest (n/N) and <Backpack> (Slot #n) — layout, texts and navigation from menuspackets2.txt.
//
//   Storage        ender chest header 4; page chests 9-17 (unlocked pages, then "Locked Page" up to 9); backpacks header 22;
//                  backpack slots 27-44 (the backpack items from the profile, renamed "Backpack Slot N"); Go Back 48; Close 49
//   Ender Chest    row 0: Close 0, Back 1, glass 2-4, « First 5, ← Previous 6, Next → 7, Last » 8 (no First/Previous on page 1, no
//                  Next/Last on the last page); the page's 45 items at 9-53
//   Backpack       same row 0 across the backpack slots; the backpack's items at 9..(9+size-1), rows below empty
//
// NOT recorded, therefore not implemented: moving items into or out of these windows (the recording has navigation only),
// "Right-click to change icon" and "Right-click to remove". Clicks on stored items do nothing.
const PAGE_SIZE = 45
const MAX_PAGES = 9 // pages shown in the Storage window (recorded: 4 unlocked + 5 "Locked Page")
const strip = s => String(s).replace(/§./g, '')

function controls (ctx, items, page, pages) {
  const { specs, build } = ctx
  const c = specs.storage.controls
  items[0] = build(c.close)
  items[1] = build(c.back)
  for (const i of [2, 3, 4]) items[i] = build(c.glass)
  const first = page === 1; const last = page === pages
  items[5] = build(first ? c.glass : c.first)
  items[6] = build(first ? c.glass : c.previous)
  items[7] = build(last ? c.glass : c.next)
  items[8] = build(last ? c.glass : c.last)
}

function navClick (ctx, slot, page, pages, open) {
  if (slot === 0) return 'close'
  if (slot === 1) { ctx.ui.open(storage); return }
  if (slot === 5 && page > 1) ctx.ui.open(cx => open(cx, 1))
  if (slot === 6 && page > 1) ctx.ui.open(cx => open(cx, page - 1))
  if (slot === 7 && page < pages) ctx.ui.open(cx => open(cx, page + 1))
  if (slot === 8 && page < pages) ctx.ui.open(cx => open(cx, pages))
}

const enderPages = ctx => Math.max(1, Math.ceil(ctx.profile.container('enderChest').size / PAGE_SIZE))
const backpackSlots = ctx => [...ctx.profile.containers.keys()].filter(k => /^backpack:\d+$/.test(k)).map(k => +k.split(':')[1]).sort((a, b) => a - b)

// ---- Storage ----------------------------------------------------------------------------------------------------------
function storage (ctx) {
  const { specs, build, conv } = ctx
  const tpl = specs.storage.window
  const items = new Array(54).fill(null)
  for (const [slot, n] of Object.entries(tpl)) items[+slot] = build(n)

  const pages = enderPages(ctx)
  for (let i = 0; i < MAX_PAGES; i++) {
    const slot = 9 + i
    if (i < pages) items[slot] = build({ ...tpl[9], count: i + 1, name: `§aEnder Chest Page ${i + 1}`, lore: tpl[9].lore.map(l => l.replace(/\/enderchest \d+/, `/enderchest ${i + 1}`)) })
    else items[slot] = build(tpl[13]) // Locked Page
  }

  // the backpack slots 27-44 show the backpack items of the profile
  const bps = backpackSlots(ctx)
  for (let i = 0; i < 18; i++) items[27 + i] = null
  bps.forEach((key, i) => {
    if (i >= 18) return
    const iconItem = ctx.profile.has('backpackIcon:' + key) ? ctx.profile.container('backpackIcon:' + key).get(0) : null
    const size = ctx.profile.container('backpack:' + key).size
    if (!iconItem) return
    const icon = conv.neutralFromItem(iconItem)
    items[27 + i] = build({
      ...icon,
      count: i + 1,
      name: `§6Backpack Slot ${i + 1}`,
      lore: [icon.name, `§7This backpack has §a${size}§7 slots.`, '', `§8Also accessible via /backpack ${i + 1}`, '', '§eLeft-click to open!', '§eRight-click to remove!']
    })
  })
  return {
    title: 'Storage',
    items,
    click ({ slot, area, button }) {
      if (area !== 'menu') return
      if (slot === 49) return 'close'
      if (slot === 48) { ctx.ui.open(require('./skyblockMenu')); return }
      if (slot >= 9 && slot < 9 + pages && button === 0) ctx.ui.open(cx => enderChest(cx, slot - 8))
      if (slot >= 27 && slot < 27 + Math.min(18, bps.length) && button === 0) ctx.ui.open(cx => backpack(cx, slot - 26))
    }
  }
}

// ---- Ender Chest (n/N) --------------------------------------------------------------------------------------------------
function enderChest (ctx, page = 1) {
  const pages = enderPages(ctx)
  page = Math.min(Math.max(1, page), pages)
  const items = new Array(54).fill(null)
  controls(ctx, items, page, pages)
  const box = ctx.profile.container('enderChest')
  for (let i = 0; i < PAGE_SIZE; i++) { const it = box.get((page - 1) * PAGE_SIZE + i); if (it) items[9 + i] = it }
  return {
    title: `Ender Chest (${page}/${pages})`,
    items,
    click: ({ slot, area }) => (area === 'menu' ? navClick(ctx, slot, page, pages, enderChest) : undefined)
  }
}

// ---- <Backpack> (Slot #n) -----------------------------------------------------------------------------------------------
function backpack (ctx, n = 1) {
  const keys = backpackSlots(ctx)
  const pages = keys.length
  n = Math.min(Math.max(1, n), pages)
  const key = keys[n - 1]
  const box = ctx.profile.container('backpack:' + key)
  // control row + the backpack's own slots (recorded: a 36-slot Greater Backpack is a 5-row window; other sizes not recorded)
  const rows = Math.ceil(box.size / 9) + 1
  const items = new Array(rows * 9).fill(null)
  controls(ctx, items, n, pages)
  for (let i = 0; i < box.size; i++) { const it = box.get(i); if (it) items[9 + i] = it }
  const iconItem = ctx.profile.has('backpackIcon:' + key) ? ctx.profile.container('backpackIcon:' + key).get(0) : null
  const name = iconItem ? strip(ctx.conv.neutralFromItem(iconItem).name || 'Backpack') : 'Backpack'
  return {
    title: `${name} (Slot #${n})`,
    rows,
    items,
    click: ({ slot, area }) => (area === 'menu' ? navClick(ctx, slot, n, pages, backpack) : undefined)
  }
}

module.exports = storage
module.exports.storage = storage
module.exports.enderChest = enderChest
module.exports.backpack = backpack
