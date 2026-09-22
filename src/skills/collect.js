const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

function failure(message, code) { return Object.assign(new Error(message), { code }); }
const wait = () => new Promise(resolve => setTimeout(resolve, 200));

// One bounded collection transaction. Success means inventory gained a database-listed drop.
async function collect(executor, task) {
  const b = executor.bot, p = task.params;
  const definition = b.registry.blocksByName[p.target];
  if (!definition) throw failure('Collection needs a registered block target', 'INVALID_TARGET');
  const dropIds = new Set((definition.drops || []).filter(Number.isInteger));
  if (!dropIds.size) throw failure('No known collectible drops for target', 'UNKNOWN_DROPS');
  const counts = () => b.inventory.items().filter(i => dropIds.has(i.type)).reduce((n, i) => n + i.count, 0);
  const before = counts();
  let block = p.position && b.blockAt(new Vec3(p.position.x, p.position.y, p.position.z));
  if (!block || block.type !== definition.id)
    block = b.findBlock({ matching: definition.id, maxDistance: 24 });
  if (!block) throw failure('No current collection target in loaded terrain', 'TARGET_GONE');
  const tool = b.pathfinder.bestHarvestTool(block);
  if (!block.canHarvest(tool?.type ?? b.heldItem?.type ?? null))
    throw failure('Required harvest tool missing', 'MISSING_TOOL');
  if (tool) await executor.step(task, () => b.equip(tool, 'hand'));
  // Already in reach: do not ask pathfinder to climb onto a tree just to dig it.
  if (!b.canDigBlock(block))
    await executor.move(task, new goals.GoalLookAtBlock(block.position, b.world, { reach: 4.5 }));
  executor.check(task);
  const live = b.blockAt(block.position);
  if (!live || live.type !== definition.id || !b.canDigBlock(live))
    throw failure('Target changed or remains outside digging reach', 'UNREACHABLE_TARGET');
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
      await executor.navigate(task, drop.position, 1);
    } else await executor.step(task, wait);
  }
  throw failure('Block broken but no matching item entered inventory', 'PICKUP_UNCONFIRMED');
}
module.exports = { collect };
