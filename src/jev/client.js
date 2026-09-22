const axios = require('axios');
const { actionOptions } = require('./action-options');
const { CircuitBreaker } = require('./circuit-breaker');
const defaultCircuit = new CircuitBreaker();
const SKILLS = ['EAT','EXPLORE_AREA','NAVIGATE_TO','MINE_RESOURCE','CRAFT_ITEM','FIGHT_MOB','FLEE','BUILD_PORTAL','SEARCH_STRUCTURE','LOOT_CONTAINER'];
async function decide(context, signal, trace = {}, circuit = defaultCircuit) {
  trace.input = context;
  const start = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - start));
  const options = actionOptions(context);
  const fallback = () => {
    const skill = options[context.goal.skill] ? context.goal.skill : Object.keys(options)[0];
    if (!skill) return { action: 'REQUEST_AGENT', reason: 'GOAL_UNACTIONABLE', source: 'local', latency: elapsed() };
    return { skill, params: options[skill], source: 'local', latency: elapsed() };
  };
  if (signal?.aborted) signal.throwIfAborted();
  if (!process.env.JEV_API_KEY) return fallback();
  if (!circuit.allowed()) {
    trace.provider = circuit.snapshot();
    return { ...fallback(), providerFailure: trace.provider };
  }
  const criteriaDescriptions = {
    EAT: 'Eat the bound safe food already in inventory to restore hunger.',
    EXPLORE_AREA: 'Navigate to exploration.destination to discover new terrain. Use only when no actionable resource/container is reachable.',
    NAVIGATE_TO: 'Move to an explicit goal.position coordinate. Requires goal.position to be set.',
    MINE_RESOURCE: 'Mine a nearby block. Check environment.nearby_resources: only pick entries where can_harvest=true; if can_harvest=false read harvest_hint to know which tool to craft first.',
    CRAFT_ITEM: 'Craft an item using inventory materials. Check equipment.immediately_craftable or equipment.upgrade_hint to decide what to craft.',
    FIGHT_MOB: 'Attack a visible mob. Use for DEFEAT_DRAGON or when combat is forced.',
    FLEE: 'Escape from immediate danger. Use when hp is low or a creeper is ignited within 4 blocks.',
    BUILD_PORTAL: 'Construct a Nether portal. Requires 14 obsidian + flint_and_steel.',
    SEARCH_STRUCTURE: 'Explore while watching for structure markers (bell=village, nether_bricks=fortress, end_portal_frame=stronghold).',
    LOOT_CONTAINER: 'Open a nearby chest/barrel. Prefer when environment.nearby_containers is non-empty and inventory has space. Check environment.known_containers to avoid re-looting empty containers.',
    REQUEST_AGENT: 'Only for GOAL_UNACTIONABLE (no executable skill available) or KNOWLEDGE_GAP (missing Minecraft knowledge). Never use for stuck/looping — handle those by switching skill.',
  };
  const criteria = Object.fromEntries(Object.keys(options).map(s => [s, `${criteriaDescriptions[s]} Bound parameters: ${JSON.stringify(options[s])}`]));
  criteria.REQUEST_AGENT = criteriaDescriptions.REQUEST_AGENT;
  const SKILL_INSTRUCTIONS = `You are the real-time tactical controller. Choose exactly one skill.

PRIORITY ORDER (top = highest priority):
1. FLEE — only away from an observed nearby threat. Low HP alone is NOT a reason to flee. When goal.survival=true, follow the bound survival action: eat/craft/collect food or explore safely for food; do not wait for healing at hunger < 18 or mine unrelated ores.
2. LOOT_CONTAINER — if environment.nearby_containers is non-empty AND environment.known_containers does not already show that container is empty.
3. MINE_RESOURCE — if environment.nearby_resources has an entry with can_harvest=true (value: critical or high preferred). For redstone/lapis/diamond/emerald check min_tool_tier ≤ equipment.best_pickaxe_tier.
4. CRAFT_ITEM — if equipment.upgrade_hint suggests a craftable item AND the materials are in inventory OR equipment.immediately_craftable is non-empty.
5. SEARCH_STRUCTURE / NAVIGATE_TO — if tactical goal is FIND_STRUCTURE and there is a known destination.
6. EXPLORE_AREA — default movement; follow exploration.destination. If exploration.stuck=true or exploration.looping=true, do NOT reuse the same area — the destination has already been rotated by the exploration engine; proceed to the new destination.
7. REQUEST_AGENT — ONLY if no skill above is actionable.

KEY RULES:
- nearby_resources[*].can_harvest=false means the bot lacks the required pickaxe tier; prefer CRAFT_ITEM for the missing tool instead.
- nearby_resources[*].needs_smelt=true means raw material must go through a furnace; MINE_RESOURCE still gets the raw drop, smelting is a separate step.
- equipment.best_pickaxe_tier drives harvest eligibility: coal/nether_quartz need tier≥0, iron/lapis/copper need tier≥1, gold/diamond/redstone/emerald need tier≥2, ancient_debris needs tier≥3.
- known_containers shows chest contents from previous opens; if item_count=0 it is empty — skip LOOT_CONTAINER for it.
- Parameters come from goal; NAVIGATE_TO requires goal.position. Do not invent coordinates.`;
  try {
    const request = {
      model: 'jev-latest', state: JSON.stringify(context), questions: {
        skill: { type: 'choice', instructions: SKILL_INSTRUCTIONS, criteria },
        help_reason: { type: 'choice', instructions: 'If requesting help classify the reason.', criteria: {
          GOAL_UNACTIONABLE: 'No available executable skill', KNOWLEDGE_GAP: 'Missing semantic or Minecraft knowledge' } },
      },
    };
    trace.request = request;
    const { data } = await axios.post(process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone', request,
      { headers: { Authorization: `Bearer ${process.env.JEV_API_KEY}` }, timeout: 5000, signal });
    trace.response = data;
    const skill = data.answers?.skill?.choice;
    if (skill !== 'REQUEST_AGENT' && !SKILLS.includes(skill)) throw new Error('Invalid Jev skill');
    circuit.success();
    // The survival policy already selected an executable, bounded action.
    // A model refusal must not replace it with indefinite waiting/replanning.
    if (skill === 'REQUEST_AGENT' && context.goal.survival && Object.keys(options).length) return fallback();
    if (skill === 'REQUEST_AGENT') return { action: skill, reason: data.answers?.help_reason?.choice || 'GOAL_UNACTIONABLE', evidence: { goal: context.goal, lastActions: context.workingMemory.slice(-3).map(({ type, skill, action, params, code, reason, timestamp }) => ({ type, skill, action, params, code, reason, timestamp })) }, source: 'jev', latency: elapsed() };
    if (!SKILLS.includes(skill)) throw new Error('Invalid Jev skill');
    if (!options[skill]) return fallback();
    return { skill, params: options[skill], source: 'jev', latency: elapsed() };
  } catch (error) {
    trace.error = { message: error.message, status: error.response?.status };
    if (signal?.aborted) throw error;
    trace.provider = circuit.fail(error);
    return { ...fallback(), error: error.message, providerFailure: trace.provider };
  }
}
module.exports = { decide, SKILLS };
