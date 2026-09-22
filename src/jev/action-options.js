// Bind each skill to its own observed target. Never reuse another skill's params.
function actionOptions(context) {
  const { goal, observation: o } = context;
  const env = o.environment || {};
  const options = {};
  // Survival is a constrained action set, not a suggestion ores can outrank.
  if (goal.survival) {
    if (goal.skill === 'EXPLORE_AREA') {
      if (env.exploration?.destination) options.EXPLORE_AREA = {
        ...goal, position: env.exploration.destination.position };
    } else options[goal.skill] = { ...goal };
    return options;
  }
  const params = { target: goal.target, amount: goal.amount, position: goal.position };
  if (goal.skill === 'EXPLORE_AREA' && env.exploration?.destination)
    options.EXPLORE_AREA = { target: goal.target || '', amount: 1, position: env.exploration.destination.position };
  if (goal.skill !== 'EXPLORE_AREA' && goal.target) options[goal.skill] = params;
  const failed = (context.workingMemory || []).filter(e => e.type === 'skill_failed' && Date.now() - e.timestamp < 30000);
  const resources = (env.nearby_resources || []).filter(r => r.can_harvest === true && !failed.some(e =>
    e.skill === 'MINE_RESOURCE' && e.params?.target === r.type && e.params?.position &&
    Math.hypot(e.params.position.x - r.position.x, e.params.position.y - r.position.y, e.params.position.z - r.position.z) < 2));
  const woodCount = Object.entries(o.inventory || {}).reduce((n, [name, count]) => n + (/_log$|_wood$|_stem$/.test(name) ? count : 0), 0);
  const resource = resources.find(r => r.type === goal.target || r.drop_item === goal.target)
    || (!goal.target ? resources.find(r => r.category === 'wood' && woodCount < 8) : null);
  if (resource) options.MINE_RESOURCE = { target: resource.type, amount: 1, position: resource.position };
  else if (goal.skill !== 'MINE_RESOURCE') delete options.MINE_RESOURCE;
  const craft = (o.equipment?.immediately_craftable || []).find(c => c.name === goal.target)
    || (!goal.target ? (o.equipment?.immediately_craftable || []).find(c => !(o.inventory?.[c.name] > 0)) : null);
  if (craft) options.CRAFT_ITEM = { target: craft.name, amount: 1 };
  const threat = (o.threat_scan || []).find(t => t.distance < 7);
  if (threat) options.FLEE = { position: threat.position };
  return options;
}
module.exports = { actionOptions };
