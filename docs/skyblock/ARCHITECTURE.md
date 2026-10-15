# SkyBlock simulator — backend architecture

Status: design + first backend milestone. Everything below is tagged

- **RECORDED** – seen in `statsmenupackets.txt` / `2026-10-12-15-43-01_sclogs.txt` (or derived from them and re-checked against the numbers in them)
- **API** – comes from the Hypixel API / resources files you supplied
- **UNVERIFIED** – not in any recording. The code does **not** guess these: it returns `{ ok:false, unverified:true }` and a recording is requested in §8.

## 1. Principles

1. **One source of truth.** A `ProfileState` per player owns every item and every number the game is computed from. Menus, commands, the stat engine and persistence read and write *it* and nothing else.
2. **Import once, then simulate.** First join (or `/sbreset`) fetches the Hypixel profile and converts it into a `ProfileState`. From then on the game runs on that state; the API is not consulted again.
3. **Calculation before display.** Stats, item rules and container rules are computed headlessly and tested against recordings; menus only *render* the result.
4. **Deterministic.** Same state + same inputs → same outputs. No wall-clock or random inside calculations (time and RNG are injected).
5. **Evidence over inference.** The recordings are the spec. Where they are silent the code refuses rather than guesses.

## 2. Layers

```
 Hypixel API ──┐                                    ┌── chat / sounds / scoreboard (UI side effects)
 resources     ▼                                    │
 items.json  hypixel-api ──snapshot──▶ skyblock-core ProfileState ◀── menus (skyblock-menu, later)
 skills.json   (fetch, cache,          (containers, rules,      │         click ⇒ service call ⇒ state change
 collections    decode, convert)        persistence)            ▼
                                                      skyblock-stats  (modifiers → totals → breakdown)
```

| Plugin | Owns | Does not do |
|---|---|---|
| `hypixel-api` | API key, HTTP + cache, `items`/`skills`/`collections` resources, 1.8-NBT decode, **1.8 → 26.1 item conversion** (neutral form), `fetchSnapshot()` | hold game state |
| `skyblock-core` | `ProfileState`, containers, equip/unequip rules, persistence, import/reset (`/sbreset`) | stat maths, rendering |
| `skyblock-stats` | modifier collection, stat totals, derived stats, breakdown data | rendering, item movement |
| `skyblock-profile` | read-only summary data (skills, pets, calendar) for display | state |
| `skyblock-ui` | **locked** 9×6 menu windows drawn from `ProfileState` + stats: SkyBlock Menu (star), Stats & Equipment, Your Stats Breakdown, `Stats ➜ X`, `X ➜ Flat Bonuses / Additive Buffs`; `/stats`, `/sbmenu`. Static texts/icons/layouts come from `data/ui-specs.json` (generated from the recordings) | state, stat maths |
| `skyblock-menu`, `skyblock-personalize` | the old byte-**replay** menus. **Superseded by `skyblock-ui` — do not load them together** (both claim the star, `/stats` and `window_click`) | — |

Load order in `settings.plugins` does not matter; plugins talk through `serv.hypixel`, `serv.skyblock.core`, `player.skyblock.profile` and events.

```json
"plugins": {
  "hypixel-api": { "key": "…" },
  "skyblock-core": { "dir": "skyblock-data/profiles" },
  "skyblock-stats": {},
  "skyblock-ui": {}
}
```

## 3. What the recordings establish

### 3.1 Protocol (RECORDED)
- Hypixel's SkyBlock server speaks protocol 775 (26.1). All 41,913 packets in both captures decode with `minecraft-protocol`/`minecraft-data` **after one fix**: `minecraft-data`'s `jukebox_playable` component layout (bool + holder) is wrong for 26.1 — Hypixel sends a single holder varint. Patched in `tools/capture.js`. (Only matters when *reading* captures or if the server ever sends music discs; the server does not send that component.)
- Menu contents are `open_window` followed by individual `set_slot` packets (and `window_items` for some opens); every click that changes anything **re-opens the menu as a new window id**, it does not patch slots. The player's inventory is part of the window (slots 54–89 in a 9×6 menu).

### 3.2 Equipment & armour (RECORDED)
Menu slots in `Stats & Equipment`:

| Necklace 10 | Helmet 11 |
|---|---|
| Cloak 19 | Chestplate 20 |
| Belt 28 | Leggings 29 |
| Gloves 37 | Boots 38 |

Empty slots show `Empty Equipment Slot` / `Empty Helmet Slot` / … (exact item definitions are in the capture).
Rules seen, replayed against your real sample in `test/recordedEquipment.test.js` (it reproduces slots 85, 72, 73, 74 exactly):
- **Unequip** (click the piece): moves to the **first empty inventory slot, hotbar 0–8 first, then main 9–35**.
- **Equip** (click the piece in the inventory part of the window): goes to the slot its type line names (`RARE GLOVES`, `EPIC BOOTS`, …).
- Each action → click sound, new window, stats recomputed.
- Equipment API order: `equipment_contents` = necklace, cloak, belt, gloves; armour API order = boots…helmet.

### 3.3 Stats: how Hypixel combines them (RECORDED, numbers re-derived)
Each stat is a list of **modifiers**. Pages: `<Stat> ➜ Flat Bonuses`, `<Stat> ➜ Additive Buffs`, 2-page lists, plus two per-player toggles (`Group By Category` = OFF, `Flatten Stats Menu` = ON in the capture).
A modifier line shows: icon, label, category, value, and "Modifier flattened from: <item>".

Verified against the recorded numbers (Defense 413.97, DR 80.5 %, EHP 17,842, True Defense DR 24.2 %, SB level Health 1,535):
```
total      = (Σ flat) × (1 + Σ additive%)           411.5 × 1.006 = 413.97
dmg reduct = D / (D + 100)                           413.97 / 513.97 = 80.5 %
EHP        = Health × (1 + Defense / 100)            3471.5 × 5.1397 = 17,842
true def   = TD / (TD + 100)                         32 / 132 = 24.2 %
SB level   = +5 Health per level, level = floor(xp/100)   307 × 5 = 1,535
```
Categories that appear (count in recording): Basic 50, Skill 20, Enchantment 21, Accessory Bag 19, Slayer 16, Potion Effect 12, Essence Shop 12, Exportation 12, Attribute 11, SkyBlock Levels 10, Bestiary 9, Innate 9, Uncategorized 9, Ability/Passive 5, Gemstone 4, Reforge 4, Attachment 4, Armor 8, Equipment 3, Item Ability (Passive) 2, HOTM 1, Consumable 1, Thaumaturgist Power 1. Kinds seen: **Flat**, **Additive**. (`tools/modifier-catalog.js` regenerates this.)

## 4. State model

```
ProfileState
  uuid, profileId, cuteName, source ('api'|'sample'|'store'), importedAt
  member            raw API member without inventory/loadout – skills, collections, bestiary, slayer, pets, … (read-only for now)
  containers        Map<name, Container>
  sets              { armor: {id → {HELMET…BOOTS}}, equipment: {id → {EQUIPMENT_SLOT_1..4}} }   ← API loadout.*
  loadouts          [{id, name, armor_set_id, equipment_set_id, pet, …}]
  settings          player UI settings (stat-menu toggles, …)
  events            'change' {container, index, reason}
```

| Container | Size | API source | Notes |
|---|---|---|---|
| `inventory` | 36 | `inv_contents` | **view on the player's window** (hotbar 0–8 = window 36–44) |
| `armor` | 4 | `inv_armor` | view on window slots 5–8 (helmet…boots) |
| `equipment` | 4 | `equipment_contents` | necklace, cloak, belt, gloves |
| `accessoryBag` | API length (101) | `bag_contents.talisman_bag` | capacity rules UNVERIFIED |
| `enderChest` | 180 = 4 pages × 45 | `ender_chest_contents` | page size RECORDED (6-row window) |
| `backpack:<n>` | per backpack | `backpack_contents[n]` | `Greater Backpack` = 36 slots RECORDED; others UNVERIFIED |
| `personalVault` 27, `potionBag` 45, `quiver` 45, `fishingBag` | | `personal_vault_contents`, `bag_contents.*` | |
| armour/equipment *sets*, loadouts | | `loadout.*` | recorded in the `Armor Sets / Equipment Sets / Loadouts` screens |

Not yet modelled as state (still in `member`): sacks, pets (list/active/xp), skills xp, collections, bestiary, slayer, essence, purse/bank, active effects.

### Item = neutral form
```js
{ type:'iron_sword', count, name:'§6…', lore:['§7…'], extra:{ id:'HYPERION', … }, skin:null, skinId:null, color:null, glint:false, unbreakable:false }
```
Version independent, JSON, what is persisted; `converter.build(neutral)` creates the 26.1 item (components `custom_name`, `lore`, `custom_data`, `profile`, `dyed_color`, `enchantment_glint_override`, `unbreakable`, `tooltip_display`). Conversion from Hypixel 1.8 data goes `1.8 NBT → neutral` using `minecraft-data` 1.8 items + variations matched against the running version (+ a small rename/flattening table) with the `items` resource as fallback; unmapped ids are logged on join.

### Persistence
`<dir>/<uuid>.json` (atomic write, debounced after every change and on disconnect). `/sbreset` deletes it and re-imports. Format is versioned (`version: 1`).

## 5. Stat engine plan

Target shape (what the recorded pages require):

```js
Modifier { stat, kind:'flat'|'additive', category, label, value, source:{ type, id, itemName? } }
total(stat) = Σ flat × (1 + Σ additive/100), then caps; derived = formulas in §3.3
```
Current engine (`skyblock-stats`) reads item **lore** (which already contains enchant/reforge/gem totals), accessories, power, tuning, effects. Baseline measured by `node tools/verify-stats.js` on your account:

> **15 of 75 recorded stats match** (Health 3,007.5 vs recorded 3,471.5 — the 464 gap is exactly the non-derivable sources in §8 #20; was 1,044 before skills + SkyBlock level). `tools/verify-modifiers.js` reproduces **34 of 65** recorded modifier rows (everything derivable: base/enchant/reforge/HPB/gem splits, skills, SkyBlock level, accessories). Missing sources: skills, SkyBlock level, bestiary, slayer, attributes, pets, essence shop, HOTM, potion levels, enchantment/reforge/gem *splitting*, newer stats (Attack Speed, Sweep, Hunting …).

Provider roadmap, each validated against the recorded breakdown pages before it ships:

| Category | Data | Status |
|---|---|---|
| Innate / SkyBlock Levels | base stats, `leveling.experience` | Health +5/level and Strength +1 per 5 levels reproduce the recording (one account); other level rewards UNVERIFIED |
| Skill | `skills.json` unlocks + member skill xp | **done, verified**: reproduces the recorded Farming 202 / Fishing 192 / Carpentry 34 Health and Mining 102 Defense |
| Basic / Enchantment / Reforge / Gemstone / Ability | item lore parentheses + `ExtraAttributes` | lore split is derivable; recompute-from-attributes needs rules (§8) |
| Accessory Bag + Thaumaturgist Power | bag items, magical power, tuning | needs accessory-bag recordings |
| Bestiary, Slayer, Attribute, HOTM, Essence Shop, Exportation, Potion | member data | values RECORDED per page; formulas not yet extracted |
| Pet | active pet + level | needs pet recordings |

## 6. Menu frontend (built: stats screens)
A menu is a factory `(ctx) → { title, items[54], click(info) }`; `click` returns `'reopen'` (new window id, RECORDED), `'close'`, or nothing (the window is re-sent and the cursor emptied, so **nothing in a menu can be moved by the client**). While a menu is open `player.skyblockMenu` is set, which makes the built-in inventory plugin ignore `window_click` (without it every menu click was applied to the real inventory — the "menu behaves like a chest" bug). Renderers must reproduce names/lore from state (not from the capture). The captured screens remain the **test oracle**: for the recorded account state a renderer's output must equal the recorded window. Screens in the recordings: SkyBlock Menu, Stats & Equipment, Your Stats Breakdown (+ per-stat Flat/Additive, grouped, 2-page), Active Effects, Pets/Autopet, Storage, Ender Chest (1–4), Backpacks, Loadouts, Armor Sets, Equipment Sets, Accessory Bag Thaumaturgy, Stats Tuning, Skills, Collections, SkyBlock Leveling, Bank, Fast Travel, Calendar, Settings (+subpages), Booster Cookie, Recipe Book, Catacombs, Heart of the Mountain / Forest.

### 6.1 Verified against the recordings (real account)
| Screen | Result (`tools/verify-menus.js`, `tools/verify-pages.js`, `test/recordedMenus.test.js`) |
|---|---|
| Stats & Equipment | **43 of 54 slots byte-identical** (type, name, lore, tooltip style, item model, texture): all 8 equipment/armour slots, star, filler, Go Back, Close. The 8 stat-category buttons have identical stat names/glyphs/order/strike-through; **only the numbers differ**. Not rendered: pet slot 47, SkyBlock Achievements 51 |
| Stats ➜ Defense | 51 of 54 identical; the rest are the flat/additive previews (missing sources) |
| Your Stats Breakdown | layout, titles, icons, derived lines (damage reduction, EHP, multipliers, …) identical in shape; values differ where sources are missing |
| Modifier pages | layout, paging, controls, row format identical; rows only for sources that exist (§5) |

Equipment lore rule (derived from the 4 recorded pieces, asserted by test): the menu shows the item without "Right-click to equip!", "This item can be reforged!" and the blank line between them.

## 7. Tooling (all read your recordings with the same protocol code the server uses)
`tools/capture.js` (decoder; compiles a private copy of the protocol so the `jukebox_playable` fix cannot leak into the server) · `timeline.js` · `nav-map.js` (click → next screen) · `dumpwin.js` / `rawwin.js <capture> <open#>` · `window-diff.js` · `modifier-catalog.js` · `modifiers.js` · `extract-ui-specs.js` and `extract-item-models.js` (regenerate `skyblock-ui/data/ui-specs.json` and `hypixel-api/data/item-models.json` from more recordings) · `verify-stats.js` · `verify-modifiers.js` · `verify-menus.js` · `verify-pages.js`.

## 8. Open questions — recordings needed (the code refuses or omits these today)

**Added with the menus**
16. Stat-category buttons strike through stats (`§7§m…`). The recording shows *which* stats, not *why* (Mining Fortune, Farming Fortune, Sweep… but not Mining Speed/Pristine). Record Stats & Equipment in other places (Dwarven Mines, Garden, a foraging island, a dungeon) so the rule can be derived. Today the recorded set is replayed.
17. Pets button (slot 47) and SkyBlock Achievements (51): not rendered. A recording with no active pet, and one after changing pet, plus the Pets menu.
18. `Show all stats: No` — what is hidden (zero-valued stats is assumed), and whether row order changes.
19. Group By Category **with** Flatten OFF, and what "Click to dig even deeper!" opens.
20. Modifier sources that are not derivable from the data supplied: Bestiary, Slayer, Attribute, Essence Shop, HOTM, Exportation, Potion Effects (incl. Jerry Candy), "Uncategorized" (Operator Chip), item **passives** (David's Cloak Passive, Gravity Talisman, Day Crystal — location/time dependent), Thaumaturgist Power (computed 23.34 vs recorded 224.08 Strength — formula wrong). For each: the rule, or a recording of the same stat before/after changing its input.
21. Active Effects: the count (35 recorded) comes from live effects the API snapshot does not contain.
22. Any click mode other than plain left/right (shift-click, drag, number keys, drops) in the menu windows.


**Equipment / armour**
1. Equip a piece onto an **occupied** slot (swap? error message?) — equipment and armour.
2. Click an item that is **not** equippable while the menu is open; click an empty slot.
3. Unequip with a **full inventory**.
4. Shift-click, number-key, drop and right-click on equipment slots.
5. Can any item go into the helmet slot (pumpkin, skulls)?

**Accessory bag / Storage**
6. The **Accessory Bag itself**: open, add/remove accessories, duplicate/family rejection, capacity/slot upgrades, how Magical Power changes.
7. Storage: put items into Ender Chest / backpacks (click, shift-click), change page, change icon, add/remove a backpack, locked pages, the messages shown.
8. Backpack sizes for the other tiers, Potion Bag / Quiver / Fishing Bag opening and rules.

**Sets / pets / effects**
9. Applying an Armor Set / Equipment Set / Loadout when slots are occupied or the inventory is full; saving and renaming one.
10. Pets: summon, despawn, held item, level/xp display and stat effect; Autopet rules.
11. Active effects: how durations count down and expire, stacking rules.

**Stats**
12. The Stats menu with a **different held item** (does the held weapon add to Strength/Damage?) and with a dungeon item.
13. Any stat page with a **Multiplicative** section (none seen) and the page opened with `Group By Category` ON.
14. One breakdown page for **every** category in §3.3 that was not opened (Accessory Bag, Pet, HOTM, Essence Shop…).

**Side effects**
15. Sound ids are protocol ids and can be replayed as recorded, but `minecraft-data`'s sound table does not line up with them (id 67 resolves to an armadillo sound), so the *meaning* of each id must come from the recording per action — a short capture with chat open while equipping/unequipping would confirm chat messages/titles.

## 9. Milestones
1. ✅ Import + conversion to 26.1 (done, tested).
2. ✅ `ProfileState`, containers, equip/unequip (recorded rules), persistence, `/sbreset` (done, tested; replay of the recorded sequence matches).
3. ✅ Modifier model + skills/SkyBlock-level providers; menus for the stats screens (this milestone). Gate: `verify-stats`, `verify-modifiers`, `verify-menus`, `verify-pages`.
4. Remaining stat sources (§8 #20) as recordings/data arrive.
5. Accessory bag + storage services and menus, then the remaining SkyBlock Menu sections (today they show their recorded items, static, with only Stats & Equipment wired).
