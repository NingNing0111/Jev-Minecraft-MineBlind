/**
 * knowledge.js — MobBook & BlockBook
 * 数据来源: minecraft-data (硬数值) + 设计文档预置行为描述
 * 严禁使用 LLM 幻觉编造数据
 */

const minecraftData = require('minecraft-data');
const md = minecraftData('1.20.1');

// ─── MobBook ──────────────────────────────────────────────────────────────────
const MOB_BOOK = {
  creeper: {
    type: 'creeper',
    displayName: 'Creeper',
    speed: 0.2,
    hp: 20,
    mechanics: '距离小于 3 格时停下并开始嘶嘶作响，1.5秒后爆炸。爆炸无视防御且破坏方块。如果玩家离开其视线或距离大于 7 格，会停止计时。',
    weakness: '盾牌可以完全格挡爆炸伤害；或者采用拉扯（Hit and Run）战术。',
    threat_level: 'HIGH',
    safe_distance: 7,
  },
  skeleton: {
    type: 'skeleton',
    displayName: 'Skeleton',
    speed: 0.25,
    hp: 20,
    mechanics: '使用弓箭远程攻击。在 15 格内会锁定玩家。当玩家靠近时它会尝试左右平移（Strafe）或后退。',
    weakness: '利用方块卡视野逼迫它靠近，或持盾靠近。在开阔地带请左右横走躲避箭矢。',
    threat_level: 'MEDIUM',
    safe_distance: 15,
  },
  zombie: {
    type: 'zombie',
    displayName: 'Zombie',
    speed: 0.23,
    hp: 20,
    mechanics: '缓慢近战怪物，白天会着火。群体聚集时危险。',
    weakness: '速度较慢，保持距离跳劈即可。白天在室外引导至阳光下。',
    threat_level: 'LOW',
    safe_distance: 3,
  },
  spider: {
    type: 'spider',
    displayName: 'Spider',
    speed: 0.3,
    hp: 16,
    mechanics: '速度较快，可以攀爬墙壁，跳跃距离较大。夜间或暗处会主动攻击。',
    weakness: '在其跳跃时举盾，或拉高到它无法爬上的平台。',
    threat_level: 'MEDIUM',
    safe_distance: 4,
  },
  enderman: {
    type: 'enderman',
    displayName: 'Enderman',
    speed: 0.3,
    hp: 40,
    height: 2.9,
    mechanics: '瞬移近战怪物。当玩家看着它的眼睛或攻击它时会被激怒。免疫弓箭等远程伤害。接触水会受到伤害并瞬移。',
    weakness: '身高接近 3 格，可在头顶 2 格高处放置方块搭建庇护所；或在脚下放水。',
    threat_level: 'HIGH',
    safe_distance: 5,
  },
  witch: {
    type: 'witch',
    displayName: 'Witch',
    speed: 0.25,
    hp: 26,
    mechanics: '远程投掷药水，可以投掷毒药、减速药水、虚弱药水。自身可以喝药水治疗。',
    weakness: '靠近进行近战攻击打断其药水施法，或使用盾牌格挡药水瓶。',
    threat_level: 'MEDIUM',
    safe_distance: 10,
  },
  cave_spider: {
    type: 'cave_spider',
    displayName: 'Cave Spider',
    speed: 0.3,
    hp: 12,
    mechanics: '小型蜘蛛，体型小可以穿过狭小空间。攻击会附带毒素效果。',
    weakness: '体型小但脆，跳劈优先。注意携带牛奶桶解毒。',
    threat_level: 'MEDIUM',
    safe_distance: 3,
  },
  blaze: {
    type: 'blaze',
    displayName: 'Blaze',
    speed: 0.23,
    hp: 20,
    mechanics: '飞行怪物，发射火球。在下界要塞中大量出现，可以设置玩家着火。',
    weakness: '雪球可以快速击杀，或用弓箭在远处射击。',
    threat_level: 'HIGH',
    safe_distance: 12,
  },
};

// ─── BlockBook ────────────────────────────────────────────────────────────────
const BLOCK_BOOK = {};

// 从 minecraft-data 中提取爆炸抗性
const interestingBlocks = [
  'cobblestone', 'stone', 'dirt', 'sand', 'gravel', 'wood',
  'obsidian', 'bedrock', 'iron_block', 'gold_block', 'diamond_block',
  'glass', 'leaves', 'log', 'planks', 'water', 'lava'
];

for (const blockName of interestingBlocks) {
  const blockData = md.blocksByName[blockName];
  if (blockData) {
    BLOCK_BOOK[blockName] = {
      id: blockData.id,
      displayName: blockData.displayName,
      blast_resistance: blockData.hardness ?? 0,
      notes: getBlockNote(blockName),
    };
  }
}

function getBlockNote(name) {
  const notes = {
    cobblestone: '防爆能力强，苦力怕和恶魂无法炸毁。适合临时防御工事。',
    stone: '防爆能力强，比圆石稍硬。',
    dirt: '极脆，会被苦力怕轻易炸毁。不要用来防御。',
    sand: '受重力影响会掉落，且抗爆性差。',
    gravel: '受重力影响，抗爆性差。',
    wood: '可燃，抗爆性一般。',
    obsidian: '最高防爆，黑曜石墙可抵御任何爆炸。但开采极慢。',
    bedrock: '无法破坏，绝对安全。',
    iron_block: '高防爆，优良建材。',
    gold_block: '防爆性一般，主要作为资源。',
    diamond_block: '防爆性好，贵重。',
    glass: '防爆性极差，一爆即碎。',
    leaves: '无防爆，主要用于减速落地。',
    log: '可燃，但比板材硬。',
    planks: '可燃，抗爆性差。',
    water: '可以减弱爆炸伤害，防止着火蔓延。',
    lava: '对生物造成持续伤害，但自身不爆。',
  };
  return notes[name] || '无特殊备注。';
}

/**
 * 根据威胁列表查找 MobBook 条目
 * @param {string[]} mobTypes 
 * @returns {object}
 */
function getMobEntries(mobTypes) {
  const entries = {};
  for (const t of mobTypes) {
    const key = t.toLowerCase().replace(/ /g, '_');
    if (MOB_BOOK[key]) entries[t] = MOB_BOOK[key];
  }
  return entries;
}

module.exports = { MOB_BOOK, BLOCK_BOOK, getMobEntries };
