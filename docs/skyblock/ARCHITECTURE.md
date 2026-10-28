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
| `skyblock-resourcepack` | the only setting is the pack's **URL** (default: Hypixel's SkyBlock pack). It downloads the pack once to get the SHA-1 the packet needs (cached per URL in `skyblock-data/resourcepack/`) and sends Add Resource Pack (forced, with prompt) to every player on join; `/resourcepack` re-sends. Items carry the Hypixel pack's `item_model` / `tooltip_style` ids, so the pack is what makes them render | state |
| `skyblock-menu`, `skyblock-personalize` | the old byte-**replay** menus. **Superseded by `skyblock-ui` — do not load them together** (both claim the star, `/stats` and `window_click`) | — |

Load order in `settings.plugins` does not matter; plugins talk through `serv.hypixel`, `serv.skyblock.core`, `player.skyblock.profile` and events.

```json
"plugins": {
  "hypixel-api": { "key": "…" },
  "skyblock-core": { "dir": "skyblock-data/profiles" },
  "skyblock-stats": {},
  "skyblock-ui": {},
  "skyblock-resourcepack": { "url": "https://resourcepacks.hypixel.net/SkyBlock/b9f0ff91-1baa-48d1-b122-29ca9f810f14/84.zip" }
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

### 3.4 Built-in inventory plugin — fixes this project depends on (RECORDED protocol, vanilla semantics)
`src/lib/plugins/inventory.js` was written for 1.8 and is corrected for 26.1:
- **Equipment slot ids** in `entity_equipment` are version dependent (1.8: boots 1 … head 4; 1.9+: main 0, **off hand 1**, boots 2, legs 3, chest 4, head 5). The old table put boots in the off hand and shifted every other piece.
- **Held item**: the hotbar lives at window slots 36–44 (the old code used the hotbar number as a window slot, overwriting the armour mapping for hotbar slots 5–8) and `heldItem` is read-only in prismarine-entity (it is `equipment[0]`), so the held item is set through `setEquipment(0, …)`.
- **Click modes**: shift-click and number keys were skipped (and `prismarine-windows` needs `click.item`, which current packets do not carry — now taken from the server's own inventory); drag and double-click are unimplemented upstream (`src/lib/windowClicks.js`). Anything that cannot be applied re-sends the whole inventory (`player.resyncInventory()`), so the client can never silently differ from the server — the cause of "inventory reverts when a menu opens".

### 3.4 Fixes made to the built-in inventory plugin (`src/lib/plugins/inventory.js`)
- Equipment slot ids were the 1.8 table (boots = 1). On 1.9+ slot 1 is the **off hand** (main 0, off 1, boots 2, legs 3, chest 4, head 5), so boots showed in the off hand and armour pieces were shifted. Now version-aware.
- The held item used the window slot number (0-8) instead of the hotbar (36-44) and broadcast a stale `heldItem`. `player.heldItem` is a read-only getter of `equipment[0]` (prismarine-entity), so the held item is kept via `setEquipment(0, …)`.
- Shift-click and number-key clicks were skipped, and `prismarine-windows` needs `click.item` (not present in current packets) to apply them; drag and double click are unimplemented there (`src/lib/windowClicks.js` adds them). Any click that cannot be applied now re-sends the whole inventory (`player.resyncInventory()`), so the client can never drift from the server's state.

- **Component loss:** `prismarine-windows` builds new stacks with `new Item(type, count, metadata, nbt)` when a click splits a stack or places one item, dropping name, lore and custom data (a right-clicked star became a plain nether star). Stacks made by a click now inherit the components of the stack they came from.
- **Offhand is disabled** (recorded: every inventory window Hypixel sends has slot 45 empty): the swap key (`block_dig` status 6), clicks on slot 45, number-key 40 and drags over slot 45 are cancelled and the client re-synced; nothing can fill the slot.
- **SkyBlock Menu star:** clicking it in the inventory screen opens the menu and never picks it up (recorded: empty cursor + `open_window "SkyBlock Menu"`). It cannot be moved by any click mode (only left/right clicks were recorded; the other modes just keep it in place).
- **Entity metadata was never sent on 1.20.2+** (`sendMetadata` returned early), so sneaking and sprinting never reached other players. It now is, sprint/crouch are one flags byte, and crouching also sets the pose (metadata 6 = 5).
- Recorded and not yet reproduced: shift-clicking armour in the inventory screen equips it (Hypixel answers with `set_slot` for both slots, then a full re-sync).

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
| Attribute | `attributes.stacks` + NEU shard files (§10) | **done, verified**: 32 of 32 distinct recorded Attribute rows (incl. additive, per-unique-rarity, per-digit and Echo boosts), with conditions evaluated against a context |
| Bestiary, Slayer, HOTM/HOTF, Essence Shop, Exportation, Potion | member data | values RECORDED per page; formulas not yet extracted — see §10 for what NEU does and does not hold |
| Pet | active pet + level | pet **levels** verified (97/97, §10); pet stats per level (NEU `petnums.json`) not yet used; needs a Pets-menu recording of the stat effect |

## 6. Menu frontend (built: stats screens)
A menu is a factory `(ctx) → { title, items[54], click(info) }`; `click` returns `'reopen'` (new window id, RECORDED), `'close'`, or nothing (the window is re-sent and the cursor emptied, so **nothing in a menu can be moved by the client**). While a menu is open `player.skyblockMenu` is set, which makes the built-in inventory plugin ignore `window_click` (without it every menu click was applied to the real inventory — the "menu behaves like a chest" bug). Renderers must reproduce names/lore from state (not from the capture). The captured screens remain the **test oracle**: for the recorded account state a renderer's output must equal the recorded window. Screens in the recordings: SkyBlock Menu, Stats & Equipment, Your Stats Breakdown (+ per-stat Flat/Additive, grouped, 2-page), Active Effects, Pets/Autopet, Storage, Ender Chest (1–4), Backpacks, Loadouts, Armor Sets, Equipment Sets, Accessory Bag Thaumaturgy, Stats Tuning, Skills, Collections, SkyBlock Leveling, Bank, Fast Travel, Calendar, Settings (+subpages), Booster Cookie, Recipe Book, Catacombs, Heart of the Mountain / Forest.

### 6.2 Storage (menuspackets2.txt)
`Storage`, `Ender Chest (n/N)` and `<Backpack> (Slot #n)`, reachable from the SkyBlock Menu (Storage), `/storage`, `/enderchest [n]`, `/backpack [n]`. Verified against the recording: **Storage 54/54 slots identical**, ender chest page 2 53/53, backpack pages 38/38 and 44/45 — the only differences are weapon lore lines Hypixel re-renders from live stats (ability damage). Windows are **not always six rows**: a 36-slot backpack is a 5-row window (control row + its slots; the player inventory follows at `size`), so the window manager supports any row count. Navigation controls (First/Previous only after page 1, Next/Last only before the last page) and the "Locked Page" / "Backpack Slot N" items are reproduced. **View-only**: the recording has navigation clicks only, so moving items in or out, changing a page icon and removing a backpack are deliberately not implemented.

### 6.1 Verified against the recordings (real account)
| Screen | Result (`tools/verify-menus.js`, `tools/verify-pages.js`, `test/recordedMenus.test.js`) |
|---|---|
| Stats & Equipment | **43 of 54 slots byte-identical** (type, name, lore, tooltip style, item model, texture): all 8 equipment/armour slots, star, filler, Go Back, Close. The 8 stat-category buttons have identical stat names/glyphs/order/strike-through; **only the numbers differ**. Not rendered: pet slot 47, SkyBlock Achievements 51 |
| Stats ➜ Defense | 51 of 54 identical; the rest are the flat/additive previews (missing sources) |
| Your Stats Breakdown | layout, titles, icons, derived lines (damage reduction, EHP, multipliers, …) identical in shape; values differ where sources are missing |
| Modifier pages | layout, paging, controls, row format identical; rows only for sources that exist (§5) |

Slot 2 of Stats & Equipment shows **the item in your hand**, exactly as it is in the inventory (recorded with the star and with a sword; 27/27 lore lines identical). Stats from the held item count (see §8 #12).

Equipment lore rule (derived from the 4 recorded pieces, asserted by test): the menu shows the item without "Right-click to equip!", "This item can be reforged!" and the blank line between them.

## 7. Tooling (all read your recordings with the same protocol code the server uses)
`tools/capture.js` (decoder; compiles a private copy of the protocol so the `jukebox_playable` fix cannot leak into the server) · `timeline.js` · `nav-map.js` (click → next screen) · `dumpwin.js` / `rawwin.js <capture> <open#>` · `window-diff.js` · `modifier-catalog.js` · `modifiers.js` · `extract-ui-specs.js` and `extract-item-models.js` (regenerate `skyblock-ui/data/ui-specs.json` and `hypixel-api/data/item-models.json` from more recordings) · `verify-stats.js` · `verify-modifiers.js` · `verify-menus.js` · `verify-pages.js`.

## 8. Open questions — recordings needed (the code refuses or omits these today)

**Added with the storage / pets / loadouts recordings**
23. **Ender chest window size.** Pages 1-3 are 6-row windows (page 3 holds only 23 items), but the empty page 4 is a **2-row** window. The API has no per-page size, so the rule is unknown; all pages are 6 rows today (page 4 therefore differs). Record an ender chest with items only on page 4, and one with a half-full last page.
24. **Context differs between recordings.** (Evidence found with the NEU data, `node tools/contexts.js`:) the 31 Attribute rows of `menuspackets2` are reproduced exactly only when the player is at **night and NOT on a Foraging Island**; the held-item recording is **on a Foraging Island** (Forest Strength "while on Foraging Islands" appears there only). The first two recordings contain too few conditional rows to tell. Stats context is therefore `{ time, island }` (default night / none, configurable); deriving it from the world (time of day, island type) is not done. **Strike-through differs between recordings.** `statsmenupackets` / `sclogs` strike the mining, farming and foraging fortune stats; `menuspackets2` and the held-item recording strike none. The scoreboard cannot be read from the packets. Tell me where you stood in each (or record Stats & Equipment at 3+ places); until then `"skyblock-ui": { "strikeFrom": "<recording file name>" }` picks a recorded set, default = the latest (none).
25. **Pets** (`Pets`, `Choose Pet`, `Autopet`, `Exp Sharing`) and the **Pet line of Loadouts** need pet levels (`[Lvl 100]`) and, for the pet items, stats/abilities per type and level. None of that is in the API or the resources supplied (the API gives only type, tier, exp and held item). Needed: the pet leveling table per rarity and the per-type pet stats/lore data (the NEU-REPO `constants/pets.json` / `petnums.json` kind of data). Not guessed.
26. **Loadouts / Armor Sets / Equipment Sets**: the screens and the Ready ⇄ Equipped slot state are recorded and every line except the pet line comes from the API (`loadout.armor`, `loadout.equipment`, `loadouts[].armor_set_id / equipment_set_id / name / pet / favoredBait`), but the recording shows **no inventory change** when a set is equipped, so what happens to the worn armour and equipment is unknown. Record: equip a set / loadout and then open the inventory (or press Stats & Equipment) before and after.
27. **Stats & Equipment slot 2 with an empty hand**: never recorded (stays empty).
28. **Moving items in storage** (ender chest, backpacks, sacks, bags): not in the recording.
29. Weapon lore is re-rendered by Hypixel from live stats (ability damage lines); no formula available, so those lines show the imported text.

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
12. The Stats menu with a **different held item** — today any held item with stats counts unless it is armour, equipment, an accessory or a pet (the recordings contain no stat page with a held weapon or tool, so this is **unverified**; every recorded page has the SkyBlock Menu star in hand). Record it holding a sword, a pickaxe, an axe, a fishing rod, a bow and nothing; also Hypixel-specific inventory behaviour (shift-click into armour/equipment slots, number-key swaps) if it differs from vanilla: only swords (`weapon` role) add their stats when held today; whether tools, bows, rods and other items do is not in the recordings (no recorded stat page lists a held item). Record the Stats menu holding a sword, a pickaxe, an axe, a fishing rod, a bow and nothing. Originally: (does the held weapon add to Strength/Damage?) and with a dungeon item.
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


## 10. NotEnoughUpdates-REPO files (data the simulator reads)

Source: the community NotEnoughUpdates-REPO (MIT licence, notice kept in `src/plugins/skyblock-stats/data/neu/LICENSE`). The 9,000-file repo is **not** shipped: `node tools/extract-neu.js <path to the repo>` reduces what is used to a few JSON files in `src/plugins/skyblock-stats/data/neu/` (re-run it to update; `meta.json` there lists every NEU file read). A NEU file counts as *in use* only if code reads its data **and** it reproduces something Hypixel was recorded showing.

### In use

| NEU file | Provides | Read by | Verified against the recordings |
|---|---|---|---|
| `constants/attribute_shards.json` (325 attributes) | attribute list, rarity, family, per-rarity level thresholds (`attribute_levelling`) | `lib/providers/attributes.js` via `data/neu/attributes.json` | **32 of 32** distinct recorded Attribute modifier rows reproduced (`node tools/verify-neu.js Attribute attributes`) |
| `items/ATTRIBUTE_SHARD_*;1.json` (325 files) | what each attribute grants per level (flat `+N Stat`, additive `Your X is increased by +N%`), its condition (night/day, island type, against mobs / pests / activities) and special rules (per unique rarity owned, per digit of a collection, Echo boosts) — parsed from the shard lore | same | same; level 4 from 20 stacks (+8 Health), Unlimited Fortitude 0.6 %, Unity is Strength 7.8, Helix Collector 70, Tracking 5.3 |
| `constants/pets.json` | `pet_levels`, `pet_rarity_offset`, `custom_pet_leveling`, `id_to_display_name` | `lib/pets.js` (`petLevel`, `petName`) via `data/neu/pets.json` | **97 of 97** recorded pets get their recorded `[Lvl N]`. No menu consumes it yet (Pets / Loadouts are not built; §8 #25-26) |

Attribute conditions: `during the night/day` and `while on <X> Islands` are checked against `ctx.context` (`time`, `island`); any other condition (`against <mobs>` — which is why the Resistance attributes add nothing to Defense, as recorded — `on Pests`, `if …`, `while <activity>`) is not modelled and the effect is not counted.

### Inspected, not used yet (nothing reads them; nothing here is verified)

| NEU file | What it holds | Could feed |
|---|---|---|
| `constants/petnums.json` | per-pet-type stat numbers by level (88 pets) | Pet stat modifiers; Pets menu lore |
| `constants/leveling.json` | skill XP tables and caps, `slayer_xp` thresholds, slayer names | slayer **level** from slayer XP. The **stat reward per slayer level is not in it** (nor in `bonuses.json`), so Slayer modifiers remain open |
| `constants/bonuses.json` | `pet_rewards` (pet score → Magic Find), `pet_value`, `bonus_stats` | Pet Score magic find |
| `constants/sblevels.json` | SkyBlock level tasks/XP categories and colours | not the per-level stat rewards (those are still the two recorded relations in §5) |
| `constants/bestiary.json` | brackets and mob lists | Bestiary level; how it becomes the recorded +Health is not in it |
| `constants/essenceshops.json`, `constants/hotmlayout.json` | essence shop perks, HotM layout | Essence Shop / HOTM modifiers (needs the player's perk levels from the API and a check against the recorded rows) |
| `constants/reforges.json`, `reforgestones.json`, `gemstones.json`, `enchants.json` | reforge stats per rarity, gemstone stats, enchant lists | recomputing items instead of reading their imported lore (needed once items can change) |
| `constants/misc.json` | `base_stats`, `tier_colors`, `item_types`, `slayer_cost`, … | base (Innate) stats; rarity colours |
| `constants/resource_pack.json` | `item_models` removed/renamed lists (both empty today) | keeping recorded `item_model` ids current |
| `items/*.json` (8,937 files) | item definitions: lore, NBT, internal names | item stat sources beyond the attribute shards; pet items |

### Not relevant to what is built
`itemsOverlay/`, `mobs/`, `mining/` and the `constants` files for fairy souls, garden, museum, calendar, islands, zones, trophy fish, bazaar, skymart, hoppity, rift guide, weight, rng score, dyes, george, abiphone, animated skulls, carnival, parents, legacy rainbow names, glacite waypoints, sacks.

### What the NEU data settled
- Pet levels, Attributes: done above.
- It does **not** contain Slayer stat rewards, the SkyBlock-level stat rewards or the Bestiary-to-stat rule — those still need recordings (§8 #20).
