/**
 * jev.js — TypeSafe.ai (Jev) HTTP 客户端
 * 使用 /v1/systemone 端点，type:choice 原生结构
 * 每 200ms 向 Jev 发起请求，返回 12 大意图之一
 */

const axios = require('axios');

const JEV_API_KEY = process.env.JEV_API_KEY || '';

// 12 个核心意图
const VALID_INTENTS = [
  'Melee_Engage',
  'Hit_and_Run',
  'Retreat_Sprint',
  'Strafe_Dodge',
  'Shield_Block',
  'Pillar_Up',
  'Block_Off_LOS',
  'Dig_Hole_Hide',
  'Bucket_Water',
  'Eat_Food',
  'Navigate_Away',
  'Idle',
];

const INTENT_DESCRIPTIONS = {
  Melee_Engage: '接敌跳劈。冲向最近威胁并执行跳跃暴击。适合：有近战武器、威胁距离 < 8 格、血量 > 8。',
  Hit_and_Run: '拉扯打法。靠近砍一刀，转身跑 2 秒。适合：对付苦力怕（保持 > 3 格距离）。',
  Retreat_Sprint: '战略撤退。不看怪物，转身 180 度全速奔跑。适合：血量 < 6 或被多个威胁包围。',
  Strafe_Dodge: '平移躲避。横向（A/D）走位躲避骷髅箭矢。适合：面对弓箭手且有足够空间。',
  Shield_Block: '原地举盾。对准威胁，按住右键。适合：有盾牌且面对苦力怕爆炸或箭矢。',
  Pillar_Up: '垫脚升高。跳跃并在脚下连放 3 格高方块。适合：有方块材料、面对地面近战怪。',
  Block_Off_LOS: '卡视野掩体。在自身与远程怪物之间放置方块墙。适合：有方块材料、面对骷髅/女巫。',
  Dig_Hole_Hide: '挖坑自埋。向下挖 3 格并封顶（濒死保命）。适合：血量 < 4、有挖掘工具。',
  Bucket_Water: '脚下放水。减速近战怪或驱赶末影人。适合：有水桶、面对末影人或群僵尸。',
  Eat_Food: '进食。切换食物并按住右键。适合：饥饿 < 14 且当前无即时威胁（距离 > 6 格）。',
  Navigate_Away: '寻路避让。利用底层寻路引擎走到安全距离。适合：需要绕路规避但不需要全速逃跑。',
  Idle: '观察待机。不执行任何动作。适合：当前无威胁或等待计划。',
};

// 构建 Jev systemone 请求体
function buildJevRequest(stateJSON) {
  // state 是给 Jev 看的上下文文本
  const stateText = buildStatePrompt(stateJSON);

  // 意图选项 criteria map
  const intentCriteria = {};
  for (const intent of VALID_INTENTS) {
    intentCriteria[intent] = INTENT_DESCRIPTIONS[intent];
  }

  // 同时问两个问题：意图选择 + 紧迫度评分
  return {
    model: 'jev-latest',
    state: stateText,
    questions: {
      combat_intent: {
        type: 'choice',
        instructions: '根据当前 Minecraft 战斗状态，选择最优的战术意图。优先保命，其次反击，最后效率。',
        criteria: intentCriteria,
      },
      is_emergency: {
        type: 'noul',
        instructions: '当前情况是否紧急危险（玩家血量极低或面临即死威胁）？',
      },
    },
  };
}

function buildStatePrompt(stateJSON) {
  const { player, environment, threat_scan, knowledge_injected } = stateJSON;
  const threats = threat_scan || [];

  let prompt = `== 玩家状态 ==
生命值: ${player.hp}/${player.max_hp} | 饱食度: ${player.hunger}/${player.max_hunger}
主手: ${player.main_hand} | 副手: ${player.off_hand}
在水中: ${player.is_in_water} | 着火: ${player.is_on_fire}

== 环境 ==
前方墙距: ${environment.distance_to_wall_front}格 | 后方: ${environment.distance_to_wall_back}格
头顶空间: ${environment.ceiling_clearance}格 | 脚下深度: ${environment.depth_below}格
脚下方块: ${environment.block_below} | 可起跳: ${environment.can_jump}

== 威胁雷达 (${threats.length} 个威胁) ==`;

  if (threats.length === 0) {
    prompt += '\n无威胁目标。';
  } else {
    for (const t of threats.slice(0, 5)) {
      prompt += `\n- ${t.type}: 距离=${t.distance}格, 视线=${t.has_line_of_sight}`;
      if (t.is_ignited) prompt += ', ⚠️已点燃';
      if (t.frames_to_reach_me < 20) prompt += `, 约${t.frames_to_reach_me}帧后到达`;
    }
  }

  if (knowledge_injected && Object.keys(knowledge_injected).length > 0) {
    prompt += '\n\n== 怪物图鉴 ==';
    for (const [name, mob] of Object.entries(knowledge_injected)) {
      prompt += `\n[${name}] ${mob.mechanics} 弱点: ${mob.weakness}`;
    }
  }

  return prompt;
}

/**
 * 向 Jev 请求决策意图
 * @param {object} stateJSON
 * @returns {Promise<{intent: string, reason: string, latency: number, confidence?: number}>}
 */
async function requestIntent(stateJSON) {
  const startTime = Date.now();

  if (!JEV_API_KEY) {
    return localFallback(stateJSON, Date.now() - startTime);
  }

  try {
    const requestBody = buildJevRequest(stateJSON);

    const response = await axios.post(
      'https://api.typesafe.ai/v1/systemone',
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${JEV_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );

    const latency = Date.now() - startTime;
    const answers = response.data.answers;

    if (!answers || !answers.combat_intent) {
      console.warn('[Jev] 响应结构异常，回退到本地规则');
      return localFallback(stateJSON, latency);
    }

    const intentAnswer = answers.combat_intent;
    const emergencyAnswer = answers.is_emergency;

    const intent = intentAnswer.choice;
    const confidence = intentAnswer.confidence;
    const isEmergency = emergencyAnswer ? emergencyAnswer.noul > 0.7 : false;

    if (!VALID_INTENTS.includes(intent)) {
      console.warn(`[Jev] 无效意图: ${intent}，回退`);
      return localFallback(stateJSON, latency);
    }

    // 紧急情况且 Jev 选了非撤退意图时，本地规则覆盖
    if (isEmergency && !['Retreat_Sprint', 'Dig_Hole_Hide', 'Shield_Block'].includes(intent)) {
      const localResult = localFallback(stateJSON, latency);
      if (['Retreat_Sprint', 'Dig_Hole_Hide'].includes(localResult.intent)) {
        return {
          ...localResult,
          reason: `[紧急覆盖] ${localResult.reason}`,
          source: 'jev+local',
        };
      }
    }

    const reason = buildReason(intent, stateJSON, confidence);

    return {
      intent,
      reason,
      latency,
      confidence,
      source: 'jev',
    };
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error(`[Jev] API 请求失败 (${latency}ms): ${err.message}`);
    return localFallback(stateJSON, latency);
  }
}

function buildReason(intent, state, confidence) {
  const threats = state.threat_scan || [];
  const nearest = threats[0];
  const hp = state.player.hp;
  const confStr = confidence !== undefined ? ` (置信度${Math.round(confidence * 100)}%)` : '';

  const reasonMap = {
    Melee_Engage: nearest ? `向${nearest.type}发起跳劈${confStr}` : `接近战斗${confStr}`,
    Hit_and_Run: nearest ? `对${nearest.type}实施拉扯打法${confStr}` : `拉扯战术${confStr}`,
    Retreat_Sprint: `HP=${hp}，紧急撤退${confStr}`,
    Strafe_Dodge: nearest ? `横向躲避${nearest.type}${confStr}` : `平移躲避${confStr}`,
    Shield_Block: nearest ? `举盾格挡${nearest.type}${confStr}` : `举盾待机${confStr}`,
    Pillar_Up: `垫高获取地形优势${confStr}`,
    Block_Off_LOS: nearest ? `卡断${nearest.type}视线${confStr}` : `放置掩体${confStr}`,
    Dig_Hole_Hide: `HP=${hp}濒死，挖坑保命${confStr}`,
    Bucket_Water: nearest ? `放水应对${nearest.type}${confStr}` : `放水减速${confStr}`,
    Eat_Food: `饱食度${state.player.hunger}，进食回复${confStr}`,
    Navigate_Away: nearest ? `绕路远离${nearest.type}${confStr}` : `寻路规避${confStr}`,
    Idle: `无威胁，观察待机${confStr}`,
  };

  return reasonMap[intent] || intent;
}

/**
 * 本地规则引擎回退（API 不可用时）
 */
function localFallback(stateJSON, latency = 0) {
  const { player, threat_scan } = stateJSON;
  const threats = threat_scan || [];
  const nearestThreat = threats[0];

  if (player.hp < 4) {
    return { intent: 'Dig_Hole_Hide', reason: '濒死，挖坑保命', latency, source: 'local' };
  }
  if (player.is_on_fire) {
    return { intent: 'Bucket_Water', reason: '玩家着火，放水灭火', latency, source: 'local' };
  }
  if (!nearestThreat) {
    if (player.hunger < 14) {
      return { intent: 'Eat_Food', reason: '无威胁，补充饱食度', latency, source: 'local' };
    }
    return { intent: 'Idle', reason: '无威胁，待机观察', latency, source: 'local' };
  }

  const dist = nearestThreat.distance;
  const mobType = (nearestThreat.type || '').toLowerCase();

  if (mobType === 'creeper' && nearestThreat.is_ignited && dist < 7) {
    return { intent: 'Retreat_Sprint', reason: '苦力怕点燃，紧急撤退', latency, source: 'local' };
  }
  if (player.hp < 8 && dist < 10) {
    return { intent: 'Retreat_Sprint', reason: '血量不足，撤退回血', latency, source: 'local' };
  }
  if (player.hunger < 10 && dist > 6) {
    return { intent: 'Eat_Food', reason: '饥饿严重，及时进食', latency, source: 'local' };
  }
  if ((mobType === 'skeleton' || mobType === 'witch') && dist > 5) {
    return { intent: 'Strafe_Dodge', reason: '远程怪，横向躲避', latency, source: 'local' };
  }
  if (mobType === 'enderman' && dist < 6) {
    return { intent: 'Bucket_Water', reason: '末影人靠近，放水驱赶', latency, source: 'local' };
  }
  if (mobType === 'creeper' && dist < 5) {
    return { intent: 'Hit_and_Run', reason: '苦力怕近身，拉扯打法', latency, source: 'local' };
  }
  if (dist < 8) {
    return { intent: 'Melee_Engage', reason: '威胁在近战范围，接敌跳劈', latency, source: 'local' };
  }
  return { intent: 'Navigate_Away', reason: '威胁在中距离，寻路接近', latency, source: 'local' };
}

module.exports = { requestIntent, VALID_INTENTS, INTENT_DESCRIPTIONS };
