/**
 * reflex.js — 小脑反射执行层
 * 将 Jev 返回的意图翻译为底层 Mineflayer 键鼠操作
 */

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');

// 意图执行状态
let currentIntent = null;
let intentStartTime = 0;
let pillarHeight = 0;
let pillarBaseY = 0;
let hitAndRunPhase = 'hit'; // 'hit' | 'run'
let hitAndRunTimer = 0;

/**
 * 初始化反射层，注册 physicsTick 监听
 * @param {import('mineflayer').Bot} bot
 * @param {function(): object} getLatestState 
 * @param {function(): {intent: string, reason: string}} getLatestDecision
 * @param {import('socket.io').Server} io
 */
function initReflex(bot, getLatestState, getLatestDecision, io) {
  // 本能反射 — 不经过 Jev
  bot.on('physicsTick', () => {
    const state = getLatestState();
    if (!state) return;

    // 本能 1: 在水中时取消跳跃（避免在水面乱动）
    if (state.player.is_in_water) {
      bot.setControlState('jump', false);
    }

    // 本能 2: 着火时自动放水（如果有水桶）
    if (state.player.is_on_fire) {
      tryPlaceWater(bot);
    }

    // 执行当前意图
    const decision = getLatestDecision();
    if (decision) {
      executeIntent(bot, decision.intent, state, io);
    }
  });
}

/**
 * 执行意图
 * @param {import('mineflayer').Bot} bot
 * @param {string} intent
 * @param {object} state 
 * @param {import('socket.io').Server} io
 */
function executeIntent(bot, intent, state, io) {
  if (intent !== currentIntent) {
    // 意图切换，重置状态
    onIntentChange(bot, intent);
  }

  const threats = state.threat_scan || [];
  const nearestThreat = threats[0];
  const targetEntity = nearestThreat
    ? bot.entities[nearestThreat.id] || findEntityByType(bot, nearestThreat.type)
    : null;

  switch (intent) {
    case 'Melee_Engage':
      executeMeleeEngage(bot, targetEntity);
      break;
    case 'Hit_and_Run':
      executeHitAndRun(bot, targetEntity);
      break;
    case 'Retreat_Sprint':
      executeRetreatSprint(bot, targetEntity);
      break;
    case 'Strafe_Dodge':
      executeStrafeDecoy(bot, targetEntity);
      break;
    case 'Shield_Block':
      executeShieldBlock(bot, targetEntity);
      break;
    case 'Pillar_Up':
      executePillarUp(bot, state);
      break;
    case 'Block_Off_LOS':
      executeBlockOffLOS(bot, targetEntity);
      break;
    case 'Dig_Hole_Hide':
      executeDigHoleHide(bot);
      break;
    case 'Bucket_Water':
      executeBucketWater(bot);
      break;
    case 'Eat_Food':
      executeEatFood(bot);
      break;
    case 'Navigate_Away':
      executeNavigateAway(bot, targetEntity);
      break;
    case 'Idle':
    default:
      executeIdle(bot);
      break;
  }
}

function onIntentChange(bot, newIntent) {
  // 清理旧意图的控制状态
  bot.clearControlStates();
  bot.deactivateItem();

  currentIntent = newIntent;
  intentStartTime = Date.now();
  pillarHeight = 0;
  hitAndRunPhase = 'hit';
  hitAndRunTimer = Date.now();
}

// ─── 意图实现 ─────────────────────────────────────────────────────────────────

function executeMeleeEngage(bot, target) {
  if (!target) return;
  const dist = bot.entity.position.distanceTo(target.position);

  bot.lookAt(target.position.offset(0, target.height / 2, 0));

  if (dist > 3) {
    // 向目标冲锋
    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);
  } else {
    bot.setControlState('sprint', false);
    // 在近战范围内：跳劈
    if (bot.entity.onGround) {
      bot.setControlState('jump', true);
    }
    // 攻击
    bot.attack(target);
  }
}

function executeHitAndRun(bot, target) {
  if (!target) return;
  const dist = bot.entity.position.distanceTo(target.position);
  const now = Date.now();
  const elapsed = now - hitAndRunTimer;

  if (hitAndRunPhase === 'hit') {
    bot.lookAt(target.position.offset(0, target.height / 2, 0));
    if (dist > 2.5) {
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
    } else {
      bot.attack(target);
      hitAndRunPhase = 'run';
      hitAndRunTimer = now;
    }
  } else if (hitAndRunPhase === 'run') {
    // 跑 1.5 秒后再次靠近
    if (elapsed < 1500) {
      const away = bot.entity.position.minus(target.position).normalize();
      bot.lookAt(bot.entity.position.plus(away));
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
    } else {
      hitAndRunPhase = 'hit';
      hitAndRunTimer = now;
    }
  }
}

function executeRetreatSprint(bot, target) {
  if (target) {
    // 背对目标
    const away = bot.entity.position.minus(target.position).normalize();
    bot.look(Math.atan2(-away.x, -away.z), 0);
  }
  bot.setControlState('sprint', true);
  bot.setControlState('forward', true);
  bot.setControlState('jump', false);
}

function executeStrafeDecoy(bot, target) {
  if (!target) return;
  bot.lookAt(target.position.offset(0, target.height / 2, 0));

  // 每 40 tick (~2s) 切换横走方向
  const tick = Math.floor((Date.now() - intentStartTime) / 400);
  if (tick % 2 === 0) {
    bot.setControlState('left', true);
    bot.setControlState('right', false);
  } else {
    bot.setControlState('left', false);
    bot.setControlState('right', true);
  }
}

function executeShieldBlock(bot, target) {
  if (target) {
    bot.lookAt(target.position.offset(0, target.height / 2, 0));
  }
  bot.setControlState('sprint', false);
  bot.setControlState('forward', false);
  // 激活副手（盾牌）
  bot.activateItem(true);
}

function executePillarUp(bot, state) {
  const currentY = bot.entity.position.y;

  if (pillarBaseY === 0) pillarBaseY = currentY;

  const risen = currentY - pillarBaseY;

  if (risen < 3) {
    // 低头放方块
    bot.look(bot.entity.yaw, Math.PI / 2); // 俯视
    bot.setControlState('jump', true);

    // 在起跳上升阶段放方块
    if (bot.entity.velocity.y > 0 && bot.entity.velocity.y < 0.3) {
      const blockBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));
      if (blockBelow) {
        const buildingBlock = findBuildingBlock(bot);
        if (buildingBlock) {
          bot.equip(buildingBlock, 'hand').then(() => {
            bot.placeBlock(blockBelow, new Vec3(0, 1, 0)).catch(() => {});
          }).catch(() => {});
        }
      }
    }
  } else {
    // 已到达目标高度，停止跳跃
    bot.setControlState('jump', false);
    pillarHeight = risen;
  }
}

function executeBlockOffLOS(bot, target) {
  if (!target) return;
  bot.lookAt(target.position.offset(0, target.height / 2, 0));

  // 在自身和目标之间放置方块
  const myPos = bot.entity.position;
  const dir = target.position.minus(myPos).normalize();
  const placePos = myPos.offset(dir.x * 1.5, 0, dir.z * 1.5);
  const refBlock = bot.blockAt(placePos.offset(0, -1, 0));

  if (refBlock) {
    const buildingBlock = findBuildingBlock(bot);
    if (buildingBlock) {
      bot.equip(buildingBlock, 'hand').then(() => {
        bot.placeBlock(refBlock, new Vec3(0, 1, 0)).catch(() => {});
      }).catch(() => {});
    }
  }
}

function executeDigHoleHide(bot) {
  const pos = bot.entity.position;
  const blockBelow = bot.blockAt(pos.offset(0, -1, 0));

  // 向下挖 3 格
  if (blockBelow && blockBelow.name !== 'air') {
    bot.look(bot.entity.yaw, Math.PI / 2); // 俯视
    bot.dig(blockBelow).catch(() => {});
  }
}

function executeBucketWater(bot) {
  // 找水桶
  const waterBucket = bot.inventory.items().find(i => i.name === 'water_bucket');
  if (waterBucket) {
    bot.equip(waterBucket, 'hand').then(() => {
      const blockBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));
      if (blockBelow) {
        bot.placeBlock(blockBelow, new Vec3(0, 1, 0)).catch(() => {});
      }
    }).catch(() => {});
  }
}

function executeEatFood(bot) {
  // 找食物（优先级: 金苹果 > 熟食 > 面包）
  const foodPriority = [
    'golden_apple', 'enchanted_golden_apple',
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken',
    'bread', 'apple', 'carrot', 'potato',
  ];

  let food = null;
  for (const foodName of foodPriority) {
    food = bot.inventory.items().find(i => i.name === foodName);
    if (food) break;
  }

  if (food) {
    bot.equip(food, 'hand').then(() => {
      bot.activateItem();
    }).catch(() => {});
  }
}

function executeNavigateAway(bot, target) {
  if (!target) return;
  const myPos = bot.entity.position;
  const awayDir = myPos.minus(target.position).normalize();
  const safePos = myPos.offset(awayDir.x * 8, 0, awayDir.z * 8);

  if (bot.pathfinder) {
    try {
      const goal = new goals.GoalNear(safePos.x, safePos.y, safePos.z, 2);
      bot.pathfinder.setGoal(goal);
    } catch {
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
    }
  } else {
    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);
  }
}

function executeIdle(bot) {
  bot.clearControlStates();
  bot.deactivateItem();
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function findBuildingBlock(bot) {
  const buildBlocks = ['cobblestone', 'stone', 'dirt', 'sand', 'gravel', 'planks'];
  for (const name of buildBlocks) {
    const item = bot.inventory.items().find(i => i.name === name);
    if (item) return item;
  }
  return null;
}

function findEntityByType(bot, typeName) {
  if (!typeName) return null;
  for (const entity of Object.values(bot.entities)) {
    if (entity && entity.name && entity.name.toLowerCase() === typeName.toLowerCase()) {
      return entity;
    }
  }
  return null;
}

function tryPlaceWater(bot) {
  const waterBucket = bot.inventory.items().find(i => i.name === 'water_bucket');
  if (!waterBucket) return;
  bot.equip(waterBucket, 'hand').then(() => {
    bot.activateItem();
  }).catch(() => {});
}

module.exports = { initReflex };
