/**
 * perception.js — 状态提取层
 * 每 200ms 将 3D 战况拍平成 State JSON，供 Jev 决策
 */

const { getMobEntries } = require('./knowledge');
const { Vec3 } = require('vec3');

// 扫描半径（格）
const SCAN_RADIUS = 20;

// 危险怪物类型列表
const HOSTILE_MOBS = new Set([
  'creeper', 'skeleton', 'zombie', 'spider', 'enderman',
  'witch', 'cave_spider', 'blaze', 'ghast', 'zombie_pigman',
  'pillager', 'vindicator', 'ravager', 'phantom', 'drowned',
  'husk', 'stray', 'wither_skeleton', 'slime', 'magma_cube',
]);

/**
 * 提取当前游戏状态为 JSON
 * @param {import('mineflayer').Bot} bot 
 * @returns {object} stateJSON
 */
function extractState(bot) {
  const player = extractPlayerState(bot);
  const environment = extractEnvironment(bot);
  const threatScan = extractThreats(bot);
  const mobTypes = threatScan.map(t => t.type);
  const knowledgeInjected = getMobEntries(mobTypes);

  return {
    player,
    inventory: bot.inventory.items().reduce((items, item) => { items[item.name] = (items[item.name] || 0) + item.count; return items; }, {}),
    dimension: String(bot.game?.dimension || 'overworld'),
    gameDay: Math.floor(Number(bot.time?.age || 0) / 24000),
    environment,
    threat_scan: threatScan,
    knowledge_injected: knowledgeInjected,
    timestamp: Date.now(),
  };
}

function extractPlayerState(bot) {
  const health = bot.health ?? 20;
  const food = bot.food ?? 20;
  const entity = bot.entity;

  const mainHandItem = bot.inventory.slots[bot.quickbarSlot + 36];
  const offHandItem = bot.inventory.slots[45]; // 副手槽位

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

function extractEnvironment(bot) {
  const pos = bot.entity.position;
  const yaw = bot.entity.yaw; // 朝向（弧度）

  // 前方向量（yaw: 0 = 南 +z, π/2 = 西 -x）
  const fwdX = -Math.sin(yaw);
  const fwdZ = Math.cos(yaw);

  const distFront = raycastDistance(bot, pos, fwdX, 0, fwdZ, 10);
  const distBack = raycastDistance(bot, pos, -fwdX, 0, -fwdZ, 10);
  const distLeft = raycastDistance(bot, pos, -fwdZ, 0, fwdX, 10);
  const distRight = raycastDistance(bot, pos, fwdZ, 0, -fwdX, 10);
  const ceilingClearance = raycastDistance(bot, pos, 0, 1, 0, 10);
  const depthBelow = raycastDistance(bot, pos, 0, -1, 0, 10);

  // 当前脚下方块
  const blockBelow = bot.blockAt(pos.offset(0, -1, 0));

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
  };
}

/**
 * 简单射线步进，返回遇到实体方块的格数
 */
function raycastDistance(bot, origin, dx, dy, dz, maxDist) {
  for (let i = 1; i <= maxDist; i++) {
    const checkPos = origin.offset(dx * i, dy * i, dz * i);
    const block = bot.blockAt(checkPos);
    if (block && block.boundingBox === 'block') {
      return i - 1;
    }
  }
  return maxDist;
}

function extractThreats(bot) {
  const threats = [];
  const myPos = bot.entity.position;
  const now = Date.now();

  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity) continue;
    if (entity.type !== 'mob') continue;

    const name = entity.name ? entity.name.toLowerCase() : '';
    if (!HOSTILE_MOBS.has(name)) continue;

    const dist = myPos.distanceTo(entity.position);
    if (dist > SCAN_RADIUS) continue;

    const yDiff = entity.position.y - myPos.y;

    // 视线检测（简化：如果距离近且无方块遮挡算有视线）
    const hasLOS = checkLOS(bot, myPos, entity.position);

    // 帧数估算到达（假设 20TPS，速度单位 格/tick）
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

    // 苦力怕特殊状态
    if (name === 'creeper') {
      threat.is_ignited = entity.metadata ? checkCreeperIgnited(entity) : false;
    }

    threats.push(threat);
  }

  // 按距离排序，最近的在前
  threats.sort((a, b) => a.distance - b.distance);
  return threats;
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
  // metadata[18] = fuse state (1 = ignited)
  try {
    return entity.metadata && entity.metadata[18] === 1;
  } catch {
    return false;
  }
}

module.exports = { extractState, HOSTILE_MOBS };
