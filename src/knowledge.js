/**
 * knowledge.js — MobBook & BlockBook
 * 数据来源: minecraft-data (硬数值) + 设计文档预置行为描述
 * 严禁使用 LLM 幻觉编造数据
 */

const minecraftData = require('minecraft-data');
const md = minecraftData('1.20.1');

// ─── 工具等级映射 ──────────────────────────────────────────────────────────────
const TOOL_TIER = {
  wooden_pickaxe: 0,
  golden_pickaxe: 0,
  stone_pickaxe: 1,
  iron_pickaxe: 2,
  diamond_pickaxe: 3,
  netherite_pickaxe: 4,
};
// tier → 代表性镐名（用于建议）
const TIER_PICKAXE = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];

// 需要熔炼才能使用的 drop
const NEEDS_SMELT_DROPS = new Set(['raw_iron', 'raw_gold', 'raw_copper']);

// ─── BlockBook — 动态从 minecraft-data 生成 ──────────────────────────────────

/**
 * 根据 harvestTools 字段推导最低 pickaxe tier
 */
function minPickaxeTier(block) {
  if (!block.harvestTools) return 0;
  const tierValues = Object.keys(block.harvestTools)
    .map(id => {
      const item = md.items[id];
      return item ? (TOOL_TIER[item.name] ?? 99) : 99;
    })
    .filter(t => t < 99);
  return tierValues.length ? Math.min(...tierValues) : 0;
}

/**
 * 从 drops 数组取第一个有意义的 drop item 名
 */
function primaryDrop(block) {
  for (const dropId of (block.drops || [])) {
    const item = md.items[dropId];
    if (item) return item.name;
  }
  return null;
}

/**
 * 资源价值分级
 */
function resourceValue(blockName, dropName) {
  if (['diamond', 'emerald', 'ancient_debris', 'end_portal_frame'].some(k => blockName.includes(k) || dropName === k)) return 'critical';
  if (['gold', 'iron', 'redstone', 'lapis', 'quartz', 'netherite'].some(k => blockName.includes(k) || (dropName && dropName.includes(k)))) return 'high';
  if (['coal', 'copper', 'log', 'wood'].some(k => blockName.includes(k))) return 'medium';
  return 'low';
}

// ── 矿石 ──
const ORE_BLOCKS = {};
{
  const oreNames = Object.keys(md.blocksByName).filter(n => n.includes('_ore') || n === 'ancient_debris');
  for (const name of oreNames) {
    const b = md.blocksByName[name];
    const drop = primaryDrop(b);
    const tier = minPickaxeTier(b);
    ORE_BLOCKS[name] = {
      id: b.id,
      block_name: name,
      display_name: b.displayName,
      drop_item: drop,
      needs_smelt: drop ? NEEDS_SMELT_DROPS.has(drop) : false,
      hardness: b.hardness,
      min_pickaxe_tier: tier,
      min_pickaxe: TIER_PICKAXE[tier] || 'wooden_pickaxe',
      harvest_tools: b.harvestTools
        ? Object.keys(b.harvestTools).map(id => md.items[id]?.name).filter(Boolean)
        : [],
      value: resourceValue(name, drop),
      scan_radius: name.includes('deepslate') || name === 'ancient_debris' ? 16 : 24,
      category: 'ore',
    };
  }
}

// ── 木材 ──
const WOOD_BLOCKS = {};
{
  const woodNames = Object.keys(md.blocksByName).filter(n =>
    n.endsWith('_log') || n.endsWith('_wood') || n === 'bamboo_block'
  );
  for (const name of woodNames) {
    const b = md.blocksByName[name];
    const drop = primaryDrop(b);
    WOOD_BLOCKS[name] = {
      id: b.id,
      block_name: name,
      display_name: b.displayName,
      drop_item: drop,
      needs_smelt: false,
      hardness: b.hardness,
      min_pickaxe_tier: null, // 徒手可采
      min_pickaxe: null,
      harvest_tools: [], // 斧子更快但徒手也行
      value: 'medium',
      scan_radius: 32,
      category: 'wood',
    };
  }
}

// ── 容器 ──
const CONTAINER_BLOCK_NAMES = ['chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker'];
const CONTAINER_BLOCKS = {};
{
  for (const name of CONTAINER_BLOCK_NAMES) {
    const b = md.blocksByName[name];
    if (b) {
      CONTAINER_BLOCKS[name] = {
        id: b.id,
        block_name: name,
        display_name: b.displayName,
        value: name.includes('chest') || name === 'barrel' ? 'high' : 'medium',
        scan_radius: 32,
        category: 'container',
      };
    }
  }
}

// ── 工作台 & 特殊结构标记 ──
const UTILITY_BLOCKS = {};
{
  const utilNames = ['crafting_table', 'enchanting_table', 'anvil', 'grindstone', 'loom',
    'bell', 'end_portal_frame', 'nether_bricks', 'nether_portal'];
  for (const name of utilNames) {
    const b = md.blocksByName[name];
    if (!b) continue;
    UTILITY_BLOCKS[name] = {
      id: b.id,
      block_name: name,
      display_name: b.displayName,
      value: ['end_portal_frame', 'nether_portal'].includes(name) ? 'critical'
        : ['crafting_table', 'enchanting_table', 'anvil'].includes(name) ? 'high' : 'medium',
      scan_radius: 32,
      category: 'utility',
    };
  }
}

// ── 农作物 ──
const CROP_BLOCK_NAMES = ['wheat', 'carrots', 'potatoes', 'beetroots', 'sugar_cane', 'melon', 'pumpkin',
  'sweet_berry_bush', 'cocoa', 'bamboo', 'cave_vines', 'glow_berries'];
const CROP_BLOCKS = {};
{
  for (const name of CROP_BLOCK_NAMES) {
    const b = md.blocksByName[name];
    if (!b) continue;
    const drop = primaryDrop(b);
    CROP_BLOCKS[name] = {
      id: b.id,
      block_name: name,
      display_name: b.displayName,
      drop_item: drop,
      value: 'medium',
      scan_radius: 32,
      category: 'crop',
    };
  }
}

// ── 所有可扫描方块（合并表，perception 层用）──
const ALL_SCANNABLE = {
  ...ORE_BLOCKS,
  ...WOOD_BLOCKS,
  ...CONTAINER_BLOCKS,
  ...UTILITY_BLOCKS,
  ...CROP_BLOCKS,
};

// ─── 装备数据库（动态从 minecraft-data 生成）────────────────────────────────

/**
 * 装备分级：材料 tier
 * leather < chainmail < iron < golden < diamond < netherite
 */
const MATERIAL_TIER = {
  leather: 0, chainmail: 1, iron: 2, golden: 1, diamond: 3, netherite: 4,
};

/**
 * 动态生成武器 / 护甲 / 工具数据库
 */
const EQUIPMENT_DB = {};
{
  const slots = ['helmet', 'chestplate', 'leggings', 'boots'];
  const weapons = ['sword', 'axe'];
  const tools = ['pickaxe', 'shovel', 'hoe'];
  const misc = ['bow', 'crossbow', 'shield', 'arrow', 'trident'];

  for (const [name, item] of Object.entries(md.itemsByName)) {
    const parts = name.split('_');
    const material = parts[0];
    const type = parts.slice(1).join('_');
    let category = null;
    if (slots.includes(type)) category = 'armor';
    else if (weapons.includes(type)) category = 'weapon';
    else if (tools.includes(type)) category = 'tool';
    else if (misc.includes(name)) category = 'misc';

    if (!category) continue;
    EQUIPMENT_DB[name] = {
      id: item.id,
      name,
      display_name: item.displayName,
      material,
      type,
      category,
      tier: MATERIAL_TIER[material] ?? 0,
    };
  }
}

// 护甲槽位映射
const ARMOR_SLOTS = { helmet: 5, chestplate: 6, leggings: 7, boots: 8 };

// ─── MobBook ──────────────────────────────────────────────────────────────────
const MOB_BOOK = {
  creeper: {
    type: 'creeper',
    displayName: 'Creeper',
    speed: 0.2, hp: 20,
    mechanics: '距离小于 3 格时停下并开始嘶嘶作响，1.5秒后爆炸。爆炸无视防御且破坏方块。如果玩家离开其视线或距离大于 7 格，会停止计时。',
    weakness: '盾牌可以完全格挡爆炸伤害；或者采用拉扯（Hit and Run）战术。',
    threat_level: 'HIGH', safe_distance: 7,
  },
  skeleton: {
    type: 'skeleton', displayName: 'Skeleton',
    speed: 0.25, hp: 20,
    mechanics: '使用弓箭远程攻击。在 15 格内会锁定玩家。当玩家靠近时它会尝试左右平移（Strafe）或后退。',
    weakness: '利用方块卡视野逼迫它靠近，或持盾靠近。在开阔地带请左右横走躲避箭矢。',
    threat_level: 'MEDIUM', safe_distance: 15,
  },
  zombie: {
    type: 'zombie', displayName: 'Zombie',
    speed: 0.23, hp: 20,
    mechanics: '缓慢近战怪物，白天会着火。群体聚集时危险。',
    weakness: '速度较慢，保持距离跳劈即可。白天在室外引导至阳光下。',
    threat_level: 'LOW', safe_distance: 3,
  },
  spider: {
    type: 'spider', displayName: 'Spider',
    speed: 0.3, hp: 16,
    mechanics: '速度较快，可以攀爬墙壁，跳跃距离较大。夜间或暗处会主动攻击。',
    weakness: '在其跳跃时举盾，或拉高到它无法爬上的平台。',
    threat_level: 'MEDIUM', safe_distance: 4,
  },
  enderman: {
    type: 'enderman', displayName: 'Enderman',
    speed: 0.3, hp: 40, height: 2.9,
    mechanics: '瞬移近战怪物。当玩家看着它的眼睛或攻击它时会被激怒。免疫弓箭等远程伤害。接触水会受到伤害并瞬移。',
    weakness: '身高接近 3 格，可在头顶 2 格高处放置方块搭建庇护所；或在脚下放水。',
    threat_level: 'HIGH', safe_distance: 5,
  },
  witch: {
    type: 'witch', displayName: 'Witch',
    speed: 0.25, hp: 26,
    mechanics: '远程投掷药水，可以投掷毒药、减速药水、虚弱药水。自身可以喝药水治疗。',
    weakness: '靠近进行近战攻击打断其药水施法，或使用盾牌格挡药水瓶。',
    threat_level: 'MEDIUM', safe_distance: 10,
  },
  cave_spider: {
    type: 'cave_spider', displayName: 'Cave Spider',
    speed: 0.3, hp: 12,
    mechanics: '小型蜘蛛，体型小可以穿过狭小空间。攻击会附带毒素效果。',
    weakness: '体型小但脆，跳劈优先。注意携带牛奶桶解毒。',
    threat_level: 'MEDIUM', safe_distance: 3,
  },
  blaze: {
    type: 'blaze', displayName: 'Blaze',
    speed: 0.23, hp: 20,
    mechanics: '飞行怪物，发射火球。在下界要塞中大量出现，可以设置玩家着火。',
    weakness: '雪球可以快速击杀，或用弓箭在远处射击。',
    threat_level: 'HIGH', safe_distance: 12,
  },
};

/**
 * 根据威胁列表查找 MobBook 条目
 */
function getMobEntries(mobTypes) {
  const entries = {};
  for (const t of mobTypes) {
    const key = t.toLowerCase().replace(/ /g, '_');
    if (MOB_BOOK[key]) entries[t] = MOB_BOOK[key];
  }
  return entries;
}

module.exports = {
  MOB_BOOK,
  EQUIPMENT_DB,
  ARMOR_SLOTS,
  MATERIAL_TIER,
  TIER_PICKAXE,
  TOOL_TIER,
  ORE_BLOCKS,
  WOOD_BLOCKS,
  CONTAINER_BLOCKS,
  UTILITY_BLOCKS,
  CROP_BLOCKS,
  ALL_SCANNABLE,
  CONTAINER_BLOCK_NAMES,
  getMobEntries,
};
