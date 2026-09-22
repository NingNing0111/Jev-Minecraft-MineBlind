const { Vec3 } = require('vec3');
const { recoveryCandidates } = require('./local-recovery');
const { needsFood } = require('../survival');
function recoveryAction(bot, guard, observation, attempts = 0) {
  for (const resource of (needsFood(observation) ? [] : observation.environment?.nearby_resources || [])) {
    if (!resource.can_harvest || !resource.position || resource.category === 'utility') continue;
    const block = bot.blockAt(new Vec3(resource.position.x,resource.position.y,resource.position.z));
    const params = { target: resource.type, position: resource.position, amount: 1 };
    if (block?.name === resource.type && bot.canDigBlock(block) && guard.checkBlock(block) && guard.check('MINE_RESOURCE', params).ok)
      return { skill: 'MINE_RESOURCE', params, source: 'local_recovery', latency: 0 };
  }
  const params = { target: needsFood(observation) ? 'food' : '', amount: 1, localRecovery: true };
  if (!guard.check('EXPLORE_AREA', params).ok) return null;
  if (observation.environment?.exploration?.destination || (attempts < 3 && recoveryCandidates(bot).some(c => c.blocks.every(b => guard.checkBlock(b)))))
    return { skill: 'EXPLORE_AREA', params, source: 'local_recovery', latency: 0 };
  return null;
}
module.exports = { recoveryAction };
