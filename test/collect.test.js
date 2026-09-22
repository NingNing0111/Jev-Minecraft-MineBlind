const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { collect } = require('../src/skills/collect');
function fixture(harvest = true) {
  const items = []; let moves = 0; let digs = 0;
  const block = { type: 1, name: 'oak_log', position: new Vec3(1, 1, 1), canHarvest: () => harvest };
  const bot = { registry: { blocksByName: { oak_log: { id: 1, drops: [2] } } }, inventory: { items: () => items },
    pathfinder: { bestHarvestTool: () => null }, blockAt: () => block, findBlock: () => block,
    canDigBlock: () => true, lookAt: async () => {}, dig: async () => { digs++; items.push({ type: 2, count: 1 }); } };
  const executor = { bot, check: () => {}, step: async (_, fn) => fn(), move: async () => { moves++; } };
  return { executor, task: { params: { target: 'oak_log', position: { x: 1, y: 1, z: 1 } } }, moves: () => moves, digs: () => digs };
}
test('reachable resource is dug without redundant pathfinding; success requires inventory delta', async () => {
  const f = fixture(); const result = await collect(f.executor, f.task);
  assert.equal(result.collected, 1); assert.equal(result.verified, 'inventory_delta'); assert.equal(f.moves(), 0);
});
test('tool requirement checked before movement or destruction', async () => {
  const f = fixture(false);
  await assert.rejects(collect(f.executor, f.task), { code: 'MISSING_TOOL' });
  assert.equal(f.moves(), 0); assert.equal(f.digs(), 0);
});
test('missing target is rejected rather than issuing an empty mining action', async () => {
  const f = fixture(); f.task.params.target = '';
  await assert.rejects(collect(f.executor, f.task), { code: 'INVALID_TARGET' });
});
