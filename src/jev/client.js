const axios = require('axios');
const SKILLS = ['EXPLORE_AREA','NAVIGATE_TO','MINE_RESOURCE','CRAFT_ITEM','FIGHT_MOB','FLEE','BUILD_PORTAL','SEARCH_STRUCTURE','LOOT_CONTAINER'];
async function decide(context, signal) {
  const fallback = () => ({ skill: context.goal.skill, params: { target: context.goal.target, amount: context.goal.amount }, source: 'local' });
  if (!process.env.JEV_API_KEY) return fallback();
  const criteria = Object.fromEntries(SKILLS.map(s => [s, `Use persistent skill ${s} when actionable for the tactical goal`]));
  criteria.REQUEST_AGENT = 'Only for GOAL_UNACTIONABLE or KNOWLEDGE_GAP, never elapsed time or stagnation';
  const start = Date.now();
  try {
    const { data } = await axios.post(process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone', {
      model: 'jev-latest', state: JSON.stringify(context), questions: {
        skill: { type: 'choice', instructions: 'Choose one skill. Parameters come from tactical goal; do not invent locations.', criteria },
        help_reason: { type: 'choice', instructions: 'If requesting help classify the reason.', criteria: {
          GOAL_UNACTIONABLE: 'No available executable skill', KNOWLEDGE_GAP: 'Missing semantic or Minecraft knowledge' } },
      },
    }, { headers: { Authorization: `Bearer ${process.env.JEV_API_KEY}` }, timeout: 5000, signal });
    const skill = data.answers?.skill?.choice;
    if (skill === 'REQUEST_AGENT') return { action: skill, reason: data.answers?.help_reason?.choice || 'GOAL_UNACTIONABLE', evidence: { goal: context.goal, lastActions: context.workingMemory.slice(-3) }, source: 'jev' };
    if (!SKILLS.includes(skill)) throw new Error('Invalid Jev skill');
    return { skill, params: { target: context.goal.target, amount: context.goal.amount }, source: 'jev', latency: Date.now()-start };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...fallback(), error: error.message };
  }
}
module.exports = { decide, SKILLS };
