const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
function failure(message, code) { return Object.assign(new Error(message), { code }); }
const wait = () => new Promise(resolve => setTimeout(resolve, 200));

// Bounded local recovery; success is only an inventory delta, never a broken block.
async function collect(executor, task) {
  const b = executor.bot, p = task.params;
  const definition = b.registry.blocksByName[p.target];
  if (!definition) throw failure('Collection needs a registered block target', 'INVALID_TARGET');
  const dropIds = new Set((definition.drops || []).filter(Number.isInteger));
  if (!dropIds.size) throw failure('No known collectible drops for target', 'UNKNOWN_DROPS');
  const counts = () => b.inventory.items().filter(i => dropIds.has(i.type)).reduce((n, i) => n + i.count, 0);
  const before = counts();
  const positions = [];
  if (p.position) positions.push(new Vec3(p.position.x, p.position.y, p.position.z));
  if (b.findBlocks) positions.push(...b.findBlocks({ matching: definition.id, maxDistance: 24, count: 8 }));
  else { const block = b.findBlock({ matching: definition.id, maxDistance: 24 }); if (block) positions.push(block.position); }
  const seen = new Set();
  const candidates = positions.map(pos => b.blockAt(pos)).filter(block => {
    if (!block || block.type !== definition.id) return false;
    const key = block.position.toString();
    if (seen.has(key)) return false;
    seen.add(key); return !executor.guard || executor.guard.checkBlock(block);
  }).slice(0, 3);
  if (!candidates.length) throw failure('No unblocked collection target in loaded terrain', 'TARGET_GONE');
  let live, lastError;
  for (const block of candidates) {
    executor.check(task);
    // bestHarvestTool optimizes dig time, not harvest eligibility. Filter first.
    const best = b.pathfinder.bestHarvestTool(block);
    const tool = best && block.canHarvest(best.type) ? best
      : b.inventory.items().find(i => block.canHarvest(i.type));
    if (!tool && !block.canHarvest(b.heldItem?.type ?? null))
      throw failure('Required harvest tool missing', 'MISSING_TOOL');
    if (tool) await executor.step(task, () => b.equip(tool, 'hand'));
    try {
      if (!b.canDigBlock(block)) await executor.move(task, new goals.GoalLookAtBlock(block.position, b.world, { reach: 4.5 }));
      executor.check(task);
      live = b.blockAt(block.position);
      if (!live || live.type !== definition.id || !b.canDigBlock(live))
        throw failure('Target changed or remains outside digging reach', 'UNREACHABLE_TARGET');
      break;
    } catch (error) {
      executor.check(task);
      if (!['STUCK','NO_PATH','PATH_BUDGET','UNREACHABLE_TARGET'].includes(error.code)) throw error;
      executor.guard?.failBlock(block, error); live = null; lastError = error;
    }
  }
  if (!live) throw lastError;
  await executor.step(task, () => b.lookAt(live.position.offset(.5, .5, .5)));
  await executor.step(task, () => b.dig(live));
  const deadline = Date.now() + 8000;
  const attempted = new Set();
  while (Date.now() < deadline) {
    executor.check(task);
    if (counts() > before) return { mined: live.name, collected: counts() - before, verified: 'inventory_delta' };
    const drop = Object.values(b.entities || {}).find(e => {
      const item = typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : null;
      return item && dropIds.has(item.type) && !attempted.has(e.id) && e.position.distanceTo(live.position) < 6;
    });
    if (drop) {
      attempted.add(drop.id);
      try { await executor.navigate(task, drop.position, 1); }
      catch (error) {
        executor.check(task);
        if (!['STUCK','NO_PATH','PATH_BUDGET'].includes(error.code)) throw error;
      }
    } else await executor.step(task, wait);
  }
  throw failure('Block broken but no matching item entered inventory', 'PICKUP_UNCONFIRMED');
}
module.exports = { collect };
