/**
 * perception.js — 状态提取层
 * 每 200ms 将 3D 战况拍平成 State JSON，供 Jev 决策
 *
 * 资源扫描完全来自 knowledge.js（minecraft-data 驱动），不写死任何方块列表。
 */

const {
  getMobEntries,
  ALL_SCANNABLE,
  EQUIPMENT_DB,
  TIER_PICKAXE,
} = require('./knowledge');

// 威胁扫描半径（格）
const SCAN_RADIUS = 20;
// 被动生物扫描半径
const PASSIVE_SCAN_RADIUS = 24;

// 危险怪物类型列表（从 minecraft-data hostile 实体派生，补充常见变种）
const HOSTILE_MOBS = new Set([
  'creeper', 'skeleton', 'zombie', 'spider', 'enderman',
  'witch', 'cave_spider', 'blaze', 'ghast', 'zombie_pigman',
  'pillager', 'vindicator', 'ravager', 'phantom', 'drowned',
  'husk', 'stray', 'wither_skeleton', 'slime', 'magma_cube',
  'elder_guardian', 'guardian', 'endermite', 'silverfish',
  'vex', 'evoker', 'zoglin', 'hoglin', 'piglin_brute', 'warden',
]);

// 被动生物（食物来源）
const PASSIVE_MOBS = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit',
  'salmon', 'cod', 'squid', 'mooshroom', 'turtle',
]);

// 价值排序权重
const VALUE_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

// 重量级扫描缓存 3 秒（资源、装备、动物）
const SCAN_CACHE_MS = 3000;
const _scanCache = new WeakMap(); // per-bot

function getScanCache(bot) {
  if (!_scanCache.has(bot)) _scanCache.set(bot, { ts: 0, resources: [], containers: [], crops: [], animals: [], equipment: null, invKey: '' });
  return _scanCache.get(bot);
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────
function extractState(bot, containerMemory = null) {
  const player = extractPlayerState(bot);
  const inventory = bot.inventory.items().reduce((acc, item) => {
    acc[item.name] = (acc[item.name] || 0) + item.count;
    return acc;
  }, {});
  const environment = extractEnvironment(bot, inventory, containerMemory);
  const equipment = extractEquipmentStatus(bot, inventory);
  const threatScan = extractThreats(bot);
  const mobTypes = threatScan.map(t => t.type);
  const knowledgeInjected = getMobEntries(mobTypes);

  return {
    player,
    inventory,
    equipment_slots: require('./equipment-slots').extractEquipmentSlots(bot),
    equipment,
    dimension: String(bot.game?.dimension || 'overworld'),
    gameDay: Math.floor(Number(bot.time?.age || 0) / 24000),
    environment,
    threat_scan: threatScan,
    knowledge_injected: knowledgeInjected,
    timestamp: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 玩家状态
// ─────────────────────────────────────────────────────────────────────────────
function extractPlayerState(bot) {
  const health = bot.health ?? 20;
  const food = bot.food ?? 20;
  const entity = bot.entity;
  const mainHandItem = bot.inventory.slots[bot.quickbarSlot + 36];
  const offHandItem = bot.inventory.slots[45];

  return {
    hp: Math.round(health * 10) / 10,
    max_hp: 20,
    hunger: Math.round(food),
    max_hunger: 20,
    main_hand: mainHandItem ? mainHandItem.name : 'fist',
    off_hand: offHandItem ? offHandItem.name : 'empty',
    is_in_water: entity ? entity.isInWater : false,
    is_on_fire: entity ? entity.onFire : false,
    velocity: entity ? {
      x: Math.round(entity.velocity.x * 100) / 100,
      y: Math.round(entity.velocity.y * 100) / 100,
      z: Math.round(entity.velocity.z * 100) / 100,
    } : { x: 0, y: 0, z: 0 },
    position: entity ? {
      x: Math.round(entity.position.x * 10) / 10,
      y: Math.round(entity.position.y * 10) / 10,
      z: Math.round(entity.position.z * 10) / 10,
    } : { x: 0, y: 0, z: 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 环境状态
// ─────────────────────────────────────────────────────────────────────────────
function extractEnvironment(bot, inventory, containerMemory) {
  const pos = bot.entity.position;
  const yaw = bot.entity.yaw;
  const fwdX = -Math.sin(yaw);
  const fwdZ = Math.cos(yaw);

  const distFront = raycastDistance(bot, pos, fwdX, 0, fwdZ, 10);
  const distBack  = raycastDistance(bot, pos, -fwdX, 0, -fwdZ, 10);
  const distLeft  = raycastDistance(bot, pos, -fwdZ, 0, fwdX, 10);
  const distRight = raycastDistance(bot, pos, fwdZ, 0, -fwdX, 10);
  const ceilingClearance = raycastDistance(bot, pos, 0, 1, 0, 10);
  const depthBelow = raycastDistance(bot, pos, 0, -1, 0, 10);
  const blockBelow = bot.blockAt(pos.offset(0, -1, 0));

  // 重量扫描用缓存（3s TTL）；Runtime 在调用前分片预热，physics/HUD 不执行扫描
  const cache = getScanCache(bot);
  const now = Date.now();
  const invKey = Object.keys(inventory).sort().join(',');
  if (now - cache.ts >= SCAN_CACHE_MS || cache.dimension !== bot.game?.dimension) {
    cache.dimension = bot.game?.dimension;
    const scanned = scanNearbyResources(bot, pos, inventory);
    cache.resources = scanned.resources;
    cache.containers = scanned.containers;
    cache.crops = scanned.crops;
    cache.animals = scanNearbyAnimals(bot, pos);
    cache.ts = Date.now();
    cache.invKey = invKey;
  } else if (invKey !== cache.invKey) {
    // 库存变化时重算 can_harvest 字段（不重新 findBlock）
    const pickTier = bestPickaxeTier(inventory);
    cache.resources = cache.resources.map(r => r.min_tool_tier !== undefined ? {
      ...r,
      can_harvest: pickTier >= (r.min_tool_tier ?? 0),
      harvest_hint: pickTier >= (r.min_tool_tier ?? 0)
        ? (r.needs_smelt ? `mine then smelt → ${r.drop_item}` : `mine directly → ${r.drop_item}`)
        : `need ${r.min_tool} (tier ${r.min_tool_tier}), current best tier: ${pickTier}`,
    } : r);
    cache.invKey = invKey;
  }

  // 已知容器（开过箱的快照）
  const known_containers = containerMemory ? containerMemory.nearby(pos, 48, String(bot.game?.dimension || 'overworld')) : [];

  return {
    distance_to_wall_front: distFront,
    distance_to_wall_back: distBack,
    distance_to_wall_left: distLeft,
    distance_to_wall_right: distRight,
    ceiling_clearance: ceilingClearance,
    depth_below: depthBelow,
    can_jump: bot.entity.onGround,
    block_below: blockBelow ? blockBelow.name : 'void',
    time_of_day: bot.time ? bot.time.timeOfDay : 0,
    is_raining: bot.isRaining ?? false,
    nearby_resources: cache.resources,
    nearby_containers: cache.containers,
    nearby_crops: cache.crops,
    nearby_animals: cache.animals,
    known_containers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 资源扫描（完全由 knowledge.js ALL_SCANNABLE 驱动，不硬编码方块列表）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 推断当前持有的最强镐 tier
 */
function bestPickaxeTier(inventory) {
  let best = -1;
  for (let t = TIER_PICKAXE.length - 1; t >= 0; t--) {
    if (inventory[TIER_PICKAXE[t]] > 0) { best = t; break; }
  }
  return best; // -1 = 无镐
}

function scanNearbyResources(bot, pos, inventory) {
  const scan = resourceScan(bot, pos, inventory);
  let step;
  do { step = scan.next(); } while (!step.done);
  return step.value;
}

// Yield between block types so resource discovery does not monopolize the
// event loop for the entire registry. A single Mineflayer findBlock is still synchronous.
function* resourceScan(bot, pos, inventory) {
  const resources = [];
  const containers = [];
  const crops = [];

  const pickTier = bestPickaxeTier(inventory);

  for (const [blockName, meta] of Object.entries(ALL_SCANNABLE)) {
    const blockDef = bot.registry.blocksByName[blockName];
    if (!blockDef) continue;

    const block = bot.findBlock({ matching: blockDef.id, maxDistance: meta.scan_radius });
    yield;
    if (!block) continue;

    const dist = Math.round(pos.distanceTo(block.position) * 10) / 10;
    const bPos = {
      x: Math.round(block.position.x * 10) / 10,
      y: Math.round(block.position.y * 10) / 10,
      z: Math.round(block.position.z * 10) / 10,
    };

    const base = {
      type: blockName,
      display: meta.display_name,
      value: meta.value,
      distance: dist,
      position: bPos,
      category: meta.category,
    };

    if (meta.category === 'ore') {
      // 判断能否采收
      const minTier = meta.min_pickaxe_tier ?? 0;
      const canHarvest = pickTier >= minTier;
      resources.push({
        ...base,
        drop_item: meta.drop_item,
        needs_smelt: meta.needs_smelt,
        min_tool: meta.min_pickaxe || 'wooden_pickaxe',
        min_tool_tier: minTier,
        can_harvest: canHarvest,
        harvest_hint: canHarvest
          ? (meta.needs_smelt ? `mine then smelt in furnace → ${meta.drop_item}` : `mine directly → ${meta.drop_item}`)
          : `need ${meta.min_pickaxe} (tier ${minTier}), current best tier: ${pickTier}`,
      });
    } else if (meta.category === 'wood') {
      resources.push({
        ...base,
        drop_item: meta.drop_item || blockName,
        can_harvest: true, // 徒手可砍
        harvest_hint: 'chop with axe or fist',
      });
    } else if (meta.category === 'container') {
      containers.push({ ...base });
    } else if (meta.category === 'utility') {
      resources.push({ ...base });
    } else if (meta.category === 'crop') {
      crops.push({
        ...base,
        drop_item: meta.drop_item,
        can_harvest: true,
      });
    }
  }

  // 按 value 再按距离排序，截取最多条数
  const sortFn = (a, b) => (VALUE_ORDER[a.value] - VALUE_ORDER[b.value]) || (a.distance - b.distance);
  resources.sort(sortFn);
  containers.sort(sortFn);
  crops.sort(sortFn);

  return {
    resources: resources.slice(0, 12),
    containers: containers.slice(0, 6),
    crops: crops.slice(0, 6),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 被动生物扫描（食物来源）
// ─────────────────────────────────────────────────────────────────────────────
function scanNearbyAnimals(bot, pos) {
  const found = [];
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity) continue;
    const name = entity.name ? entity.name.toLowerCase() : '';
    if (!PASSIVE_MOBS.has(name)) continue;
    const dist = pos.distanceTo(entity.position);
    if (dist > PASSIVE_SCAN_RADIUS) continue;
    found.push({
      type: name,
      distance: Math.round(dist * 10) / 10,
      position: {
        x: Math.round(entity.position.x * 10) / 10,
        y: Math.round(entity.position.y * 10) / 10,
        z: Math.round(entity.position.z * 10) / 10,
      },
    });
  }
  found.sort((a, b) => a.distance - b.distance);
  return found.slice(0, 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// 装备状态 & 合成建议
// ─────────────────────────────────────────────────────────────────────────────
function extractEquipmentStatus(bot, inventory) {
  // 装备状态缓存：只有库存变化时才重算 recipesFor
  const cache = getScanCache(bot);
  const invKey = JSON.stringify([Object.entries(inventory).sort(),
    bot.inventory.slots.slice(5, 9).map(i => i?.name), bot.game?.dimension]);
  if (cache.equipment && cache.equipmentKey === invKey && Date.now() - cache.equipmentAt < SCAN_CACHE_MS) return cache.equipment;

  const armorSlots = { helmet: 5, chestplate: 6, leggings: 7, boots: 8 };
  const worn = {};
  let armorTierSum = 0;
  let armorPieces = 0;
  for (const [slot, idx] of Object.entries(armorSlots)) {
    const item = bot.inventory.slots[idx];
    if (item) {
      const meta = EQUIPMENT_DB[item.name];
      worn[slot] = { name: item.name, tier: meta?.tier ?? 0 };
      armorTierSum += meta?.tier ?? 0;
      armorPieces++;
    } else {
      worn[slot] = null;
    }
  }

  // 最强武器（sword 优先，其次 axe）
  let bestWeapon = null;
  for (const item of bot.inventory.items()) {
    const meta = EQUIPMENT_DB[item.name];
    if (!meta || meta.category !== 'weapon') continue;
    if (!bestWeapon || meta.tier > (EQUIPMENT_DB[bestWeapon]?.tier ?? -1)) bestWeapon = item.name;
  }

  // 最强镑
  let bestPickaxe = null;
  let bestPickTier = -1;
  for (const item of bot.inventory.items()) {
    const meta = EQUIPMENT_DB[item.name];
    if (!meta || meta.type !== 'pickaxe') continue;
    if (meta.tier > bestPickTier) { bestPickTier = meta.tier; bestPickaxe = item.name; }
  }

  // 可立即合成的装备（recipesFor 较慢，库存变化才重算）
  const craftable = [];
  const tableId = bot.registry.blocksByName.crafting_table?.id;
  const table = tableId !== undefined ? bot.findBlock({ matching: tableId, maxDistance: 16 }) : null;
  for (const [name, meta] of Object.entries(EQUIPMENT_DB)) {
    if (meta.category === 'misc') continue;
    const itemDef = bot.registry.itemsByName[name];
    if (!itemDef) continue;
    const recipes = bot.recipesFor(itemDef.id, null, 1, table);
    if (recipes.length > 0) craftable.push({ name, category: meta.category, tier: meta.tier });
  }
  craftable.sort((a, b) => b.tier - a.tier);

  // 建议下一件装备
  let upgrade_hint = null;
  if (!bestPickaxe) {
    upgrade_hint = 'craft wooden_pickaxe immediately (no pickaxe available)';
  } else if (bestPickTier < 2 && (inventory['iron_ingot'] || 0) >= 3) {
    upgrade_hint = 'craft iron_pickaxe (iron available)';
  } else if (armorPieces < 4) {
    const missing = Object.entries(worn).filter(([, v]) => !v).map(([k]) => k);
    upgrade_hint = `craft missing armor: ${missing.join(', ')}`;
  } else {
    const topCraftable = craftable.find(c => c.category !== 'tool');
    if (topCraftable) upgrade_hint = `craft ${topCraftable.name} (tier ${topCraftable.tier})`;
  }

  const result = {
    worn_armor: worn,
    armor_coverage: armorPieces,
    armor_avg_tier: armorPieces ? Math.round(armorTierSum / armorPieces * 10) / 10 : 0,
    best_weapon: bestWeapon,
    best_weapon_tier: bestWeapon ? (EQUIPMENT_DB[bestWeapon]?.tier ?? 0) : -1,
    best_pickaxe: bestPickaxe,
    best_pickaxe_tier: bestPickTier,
    immediately_craftable: craftable.slice(0, 6),
    upgrade_hint,
  };
  cache.equipment = result;
  cache.equipmentKey = invKey;
  cache.equipmentAt = Date.now();
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 威胁扫描
// ─────────────────────────────────────────────────────────────────────────────
function extractThreats(bot) {
  const threats = [];
  const myPos = bot.entity.position;

  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity) continue;
    if (entity.type !== 'mob') continue;
    const name = entity.name ? entity.name.toLowerCase() : '';
    if (!HOSTILE_MOBS.has(name)) continue;
    const dist = myPos.distanceTo(entity.position);
    if (dist > SCAN_RADIUS) continue;

    const yDiff = entity.position.y - myPos.y;
    const hasLOS = checkLOS(bot, myPos, entity.position);
    const mobSpeed = getMobSpeed(name);
    const ticksToReach = mobSpeed > 0 ? Math.round(dist / mobSpeed) : 9999;

    const threat = {
      id: entity.id,
      type: entity.name || 'unknown',
      distance: Math.round(dist * 10) / 10,
      y_diff: Math.round(yDiff * 10) / 10,
      has_line_of_sight: hasLOS,
      frames_to_reach_me: ticksToReach,
      position: {
        x: Math.round(entity.position.x * 10) / 10,
        y: Math.round(entity.position.y * 10) / 10,
        z: Math.round(entity.position.z * 10) / 10,
      },
    };
    if (name === 'creeper') {
      threat.is_ignited = entity.metadata ? checkCreeperIgnited(entity) : false;
    }
    threats.push(threat);
  }

  threats.sort((a, b) => a.distance - b.distance);
  return threats;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────
function raycastDistance(bot, origin, dx, dy, dz, maxDist) {
  for (let i = 1; i <= maxDist; i++) {
    const checkPos = origin.offset(dx * i, dy * i, dz * i);
    const block = bot.blockAt(checkPos);
    if (block && block.boundingBox === 'block') return i - 1;
  }
  return maxDist;
}

function checkLOS(bot, from, to) {
  const dir = to.minus(from).normalize();
  const dist = from.distanceTo(to);
  for (let d = 1; d < dist; d += 0.5) {
    const checkPos = from.offset(dir.x * d, dir.y * d, dir.z * d);
    const block = bot.blockAt(checkPos);
    if (block && block.boundingBox === 'block') return false;
  }
  return true;
}

function getMobSpeed(name) {
  const speeds = {
    creeper: 0.2, skeleton: 0.25, zombie: 0.23, spider: 0.3,
    enderman: 0.3, witch: 0.25, cave_spider: 0.3, blaze: 0.23,
  };
  return speeds[name] || 0.2;
}

function checkCreeperIgnited(entity) {
  try { return entity.metadata && entity.metadata[18] === 1; }
  catch { return false; }
}

/**
 * 轻量观察（专用于 physics/reflex 路径）
 * 只计算 player + threat_scan + inventory + environment(depth_below only) + dimension
 * 不调用任何 findBlock 或 recipesFor
 */
function extractLightState(bot) {
  const player = extractPlayerState(bot);
  const inventory = bot.inventory.items().reduce((acc, item) => {
    acc[item.name] = (acc[item.name] || 0) + item.count;
    return acc;
  }, {});
  const pos = bot.entity.position;
  const depthBelow = raycastDistance(bot, pos, 0, -1, 0, 10);
  const threatScan = extractThreats(bot);
  return {
    player,
    inventory,
    dimension: String(bot.game?.dimension || 'overworld'),
    environment: { depth_below: depthBelow },
    threat_scan: threatScan,
  };
}

async function refreshResourceScan(bot, signal) {
  const cache = getScanCache(bot);
  const dimension = bot.game?.dimension;
  if (signal?.aborted) return;
  if (cache.dimension === dimension && Date.now() - cache.ts < SCAN_CACHE_MS) return;
  const pos = bot.entity.position.clone();
  const inventory = bot.inventory.items().reduce((acc, item) => {
    acc[item.name] = (acc[item.name] || 0) + item.count;
    return acc;
  }, {});
  const scan = resourceScan(bot, pos, inventory);
  let step;
  do {
    await new Promise(resolve => setImmediate(resolve));
    if (signal?.aborted || bot.game?.dimension !== dimension) return;
    step = scan.next();
  } while (!step.done);
  Object.assign(cache, step.value, { dimension, ts: Date.now(),
    invKey: Object.keys(inventory).sort().join(','), animals: scanNearbyAnimals(bot, pos) });
}

// HUD observations never run resource searches or recipe enumeration. Expensive
// fields are explicitly dated and discarded across dimension/lifecycle changes.
function extractHudState(bot, cached = null) {
  const live = extractLightState(bot);
  const previous = cached?.dimension === live.dimension ? cached : null;
  return {
    ...previous, ...live,
    equipment_slots: require('./equipment-slots').extractEquipmentSlots(bot),
    gameDay: Math.floor(Number(bot.time?.age || 0) / 24000),
    environment: { ...previous?.environment, ...live.environment,
      time_of_day: bot.time?.timeOfDay || 0, is_raining: bot.isRaining ?? false },
    timestamp: Date.now(),
    observation_timestamp: previous?.timestamp ?? null,
  };
}

module.exports = { extractState, extractLightState, extractHudState, refreshResourceScan, HOSTILE_MOBS };
