'use strict'
// Maps Hypixel's 1.8 numeric item id + damage to an item of the running server version.
// Built from minecraft-data (1.8 items + variations vs the target registry) with a small
// override table for items whose names changed in the 1.13 flattening.

const mc8 = require('minecraft-data')('1.8')

const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak']
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// legacy name -> list indexed by damage (or a function)
const VARIANTS = {
  wool: d => `${COLORS[d & 15]}_wool`,
  carpet: d => `${COLORS[d & 15]}_carpet`,
  stained_glass: d => `${COLORS[d & 15]}_stained_glass`,
  stained_glass_pane: d => `${COLORS[d & 15]}_stained_glass_pane`,
  stained_hardened_clay: d => `${COLORS[d & 15]}_terracotta`,
  banner: d => `${COLORS[15 - (d & 15)]}_banner`,
  planks: d => `${WOODS[d % 6]}_planks`,
  sapling: d => `${WOODS[d % 6]}_sapling`,
  leaves: d => `${WOODS[d & 3]}_leaves`,
  leaves2: d => `${WOODS[4 + (d & 1)]}_leaves`,
  log: d => `${WOODS[d & 3]}_log`,
  log2: d => `${WOODS[4 + (d & 1)]}_log`,
  wooden_slab: d => `${WOODS[d % 6]}_slab`,
  dye: ['ink_sac', 'red_dye', 'green_dye', 'cocoa_beans', 'lapis_lazuli', 'purple_dye', 'cyan_dye', 'light_gray_dye',
    'gray_dye', 'pink_dye', 'lime_dye', 'yellow_dye', 'light_blue_dye', 'magenta_dye', 'orange_dye', 'bone_meal'],
  skull: ['skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'player_head', 'creeper_head'],
  coal: ['coal', 'charcoal'],
  golden_apple: ['golden_apple', 'enchanted_golden_apple'],
  fish: ['cod', 'salmon', 'tropical_fish', 'pufferfish'],
  cooked_fish: ['cooked_cod', 'cooked_salmon'],
  stone: ['stone', 'granite', 'polished_granite', 'diorite', 'polished_diorite', 'andesite', 'polished_andesite'],
  dirt: ['dirt', 'coarse_dirt', 'podzol'],
  sand: ['sand', 'red_sand'],
  sponge: ['sponge', 'wet_sponge'],
  sandstone: ['sandstone', 'chiseled_sandstone', 'cut_sandstone'],
  red_sandstone: ['red_sandstone', 'chiseled_red_sandstone', 'cut_red_sandstone'],
  stonebrick: ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks'],
  monster_egg: ['infested_stone', 'infested_cobblestone', 'infested_stone_bricks', 'infested_mossy_stone_bricks',
    'infested_cracked_stone_bricks', 'infested_chiseled_stone_bricks'],
  stone_slab: ['stone_slab', 'sandstone_slab', 'oak_slab', 'cobblestone_slab', 'brick_slab', 'stone_brick_slab',
    'nether_brick_slab', 'quartz_slab'],
  quartz_block: ['quartz_block', 'chiseled_quartz_block', 'quartz_pillar'],
  prismarine: ['prismarine', 'prismarine_bricks', 'dark_prismarine'],
  cobblestone_wall: ['cobblestone_wall', 'mossy_cobblestone_wall'],
  anvil: ['anvil', 'chipped_anvil', 'damaged_anvil'],
  tallgrass: ['dead_bush', 'short_grass', 'fern'],
  double_plant: ['sunflower', 'lilac', 'tall_grass', 'large_fern', 'rose_bush', 'peony'],
  red_flower: ['poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip',
    'pink_tulip', 'oxeye_daisy'],
  spawn_egg: d => `${SPAWN_EGGS[d] || 'pig'}_spawn_egg`
}

const SPAWN_EGGS = {
  50: 'creeper',
  51: 'skeleton',
  52: 'spider',
  54: 'zombie',
  55: 'slime',
  56: 'ghast',
  57: 'zombified_piglin',
  58: 'enderman',
  59: 'cave_spider',
  60: 'silverfish',
  61: 'blaze',
  62: 'magma_cube',
  65: 'bat',
  66: 'witch',
  67: 'endermite',
  68: 'guardian',
  90: 'pig',
  91: 'sheep',
  92: 'cow',
  93: 'chicken',
  94: 'squid',
  95: 'wolf',
  96: 'mooshroom',
  98: 'ocelot',
  100: 'horse',
  101: 'rabbit',
  120: 'villager'
}

// legacy name -> modern name where the name itself changed
const RENAMES = {
  reeds: 'sugar_cane',
  speckled_melon: 'glistering_melon_slice',
  netherbrick: 'nether_brick',
  hardened_clay: 'terracotta',
  lit_pumpkin: 'jack_o_lantern',
  web: 'cobweb',
  waterlily: 'lily_pad',
  snow_layer: 'snow',
  snow: 'snow_block',
  sign: 'oak_sign',
  boat: 'oak_boat',
  wooden_door: 'oak_door',
  trapdoor: 'oak_trapdoor',
  wooden_pressure_plate: 'oak_pressure_plate',
  wooden_button: 'oak_button',
  fence: 'oak_fence',
  fence_gate: 'oak_fence_gate',
  bed: 'red_bed',
  golden_rail: 'powered_rail',
  slime: 'slime_block',
  yellow_flower: 'dandelion',
  deadbush: 'dead_bush',
  brick_block: 'bricks',
  melon_block: 'melon',
  mushroom_stew: 'mushroom_stew',
  gunpowder: 'gunpowder',
  fireworks: 'firework_rocket',
  firework_charge: 'firework_star',
  fire_charge: 'fire_charge',
  carrot_on_a_stick: 'carrot_on_a_stick',
  record_13: 'music_disc_13',
  record_cat: 'music_disc_cat',
  record_blocks: 'music_disc_blocks',
  record_chirp: 'music_disc_chirp',
  record_far: 'music_disc_far',
  record_mall: 'music_disc_mall',
  record_mellohi: 'music_disc_mellohi',
  record_stal: 'music_disc_stal',
  record_strad: 'music_disc_strad',
  record_ward: 'music_disc_ward',
  record_11: 'music_disc_11',
  record_wait: 'music_disc_wait',
  golden_sword: 'golden_sword',
  wooden_sword: 'wooden_sword',
  ender_eye: 'ender_eye',
  cooked_porkchop: 'cooked_porkchop',
  porkchop: 'porkchop',
  chicken: 'chicken',
  beef: 'beef',
  skull: 'player_head',
  redstone_lamp: 'redstone_lamp',
  lit_redstone_lamp: 'redstone_lamp',
  command_block: 'command_block',
  end_portal_frame: 'end_portal_frame',
  stone_stairs: 'cobblestone_stairs',
  stone_brick_stairs: 'stone_brick_stairs',
  double_stone_slab: 'stone_slab',
  wool: 'white_wool'
}

// Bukkit-style material names used by the Hypixel items resource -> modern names.
const MATERIAL_RENAMES = {
  SKULL_ITEM: 'player_head',
  INK_SACK: 'ink_sac',
  SULPHUR: 'gunpowder',
  EYE_OF_ENDER: 'ender_eye',
  EXP_BOTTLE: 'experience_bottle',
  FIREBALL: 'fire_charge',
  WORKBENCH: 'crafting_table',
  SEEDS: 'wheat_seeds',
  MELON: 'melon_slice',
  MELON_BLOCK: 'melon',
  MUSHROOM_SOUP: 'mushroom_stew',
  BOOK_AND_QUILL: 'writable_book',
  CARROT_ITEM: 'carrot',
  POTATO_ITEM: 'potato',
  NETHER_STALK: 'nether_wart',
  SNOW_BALL: 'snowball',
  PORK: 'porkchop',
  GRILLED_PORK: 'cooked_porkchop',
  RAW_CHICKEN: 'chicken',
  RAW_BEEF: 'beef',
  RAW_FISH: 'cod',
  SMOOTH_BRICK: 'stone_bricks',
  LOG: 'oak_log',
  LOG_2: 'acacia_log',
  WOOD: 'oak_planks',
  IRON_FENCE: 'iron_bars',
  THIN_GLASS: 'glass_pane',
  STAINED_GLASS_PANE: 'white_stained_glass_pane',
  STAINED_CLAY: 'terracotta',
  HARD_CLAY: 'terracotta',
  GOLD_RECORD: 'music_disc_13',
  SIGN: 'oak_sign',
  WOOD_DOOR: 'oak_door',
  LEASH: 'lead',
  REDSTONE_COMPARATOR: 'comparator',
  DIODE: 'repeater',
  FIREWORK: 'firework_rocket',
  FIREWORK_CHARGE: 'firework_star',
  EMPTY_MAP: 'map',
  MAP: 'filled_map',
  EXPLOSIVE_MINECART: 'tnt_minecart',
  STORAGE_MINECART: 'chest_minecart',
  POWERED_MINECART: 'furnace_minecart',
  COMMAND: 'command_block',
  CAULDRON_ITEM: 'cauldron',
  BREWING_STAND_ITEM: 'brewing_stand',
  FLOWER_POT_ITEM: 'flower_pot',
  BED: 'red_bed',
  BANNER: 'white_banner',
  ENCHANTED_BOOK: 'enchanted_book',
  NAME_TAG: 'name_tag'
}

function createLegacyResolver (registry) {
  const byDisplay = new Map()
  for (const it of registry.itemsArray) {
    const k = norm(it.displayName)
    if (!byDisplay.has(k)) byDisplay.set(k, it.name)
  }
  const exists = n => n && registry.itemsByName[n] ? n : null

  function variantName (legacy, damage) {
    const v = VARIANTS[legacy]
    if (!v) return null
    return typeof v === 'function' ? v(damage) : (v[damage] || v[0])
  }

  // Returns a modern item name or null.
  function resolve (legacyId, damage = 0) {
    const legacy = mc8.items[legacyId]
    if (!legacy) return null
    const name = exists(variantName(legacy.name, damage))
    if (name) return name
    if (RENAMES[legacy.name] && exists(RENAMES[legacy.name])) return RENAMES[legacy.name]
    if (exists(legacy.name)) return legacy.name
    const variation = (legacy.variations || []).find(v => v.metadata === damage)
    for (const dn of [variation && variation.displayName, legacy.displayName]) {
      if (dn && byDisplay.has(norm(dn))) return byDisplay.get(norm(dn))
    }
    // gold_* / wooden_* tool prefixes changed names in 1.13
    const m = legacy.name.match(/^(gold|wood)en?_(.+)$/)
    if (m) return exists(`${m[1] === 'gold' ? 'golden' : 'wooden'}_${m[2]}`)
    return null
  }

  // Bukkit-style material name (Hypixel resources) -> modern name or null.
  function resolveMaterial (material, durability = 0) {
    if (!material) return null
    if (material === 'INK_SACK') return exists(VARIANTS.dye[durability] || 'ink_sac')
    const lower = material.toLowerCase()
    const legacyEntry = Object.values(mc8.items).find(i => i.name === lower)
    if (legacyEntry) return resolve(legacyEntry.id, durability)
    if (MATERIAL_RENAMES[material]) return exists(MATERIAL_RENAMES[material])
    const pre = lower.replace(/^gold_/, 'golden_').replace(/^wood_/, 'wooden_')
    return exists(pre)
  }

  return { resolve, resolveMaterial }
}

module.exports = { createLegacyResolver, mc8 }
