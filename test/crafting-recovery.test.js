const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GoalManager } = require('../src/goal/manager');
const { SkillExecutor } = require('../src/skills/executor');
const { Vec3 } = require('vec3');

test('supplied table recipe does not recurse into a different wood variant', () => {
  const manager = new GoalManager();
  const bot = {
    registry: { itemsByName: { wooden_pickaxe: { id: 1 }, crafting_table: { id: 4 } },
      items: { 2: { name: 'oak_planks' }, 3: { name: 'spruce_planks' } }, blocksByName: { crafting_table: { id: 4 } } },
    findBlock: () => null,
    recipesFor: id => id === 4 ? [{}] : [],
    recipesAll: () => [{ requiresTable: true, delta: [{ id: 3, count: -3 }] },
      { requiresTable: true, delta: [{ id: 2, count: -3 }] }],
  };
  assert.equal(manager.acquire('wooden_pickaxe', 1, { oak_planks: 3 }, bot).target, 'crafting_table');
  assert.deepEqual(manager.acquire('wooden_pickaxe', 1, { oak_planks: 3, crafting_table: 1 }, bot),
    { skill: 'CRAFT_ITEM', target: 'wooden_pickaxe', amount: 1 });
});

test('crafting places carried table before using a table-only recipe', async () => {
  let placed = false, crafted = false;
  const bot = {
    entity: { position: new Vec3(0.5, 60, 0.5) },
    inventory: { items: () => [{ name: 'crafting_table' }] },
    registry: { itemsByName: { wooden_pickaxe: { id: 1 } }, blocksByName: { crafting_table: { id: 4 } } },
    findBlock: () => null,
    blockAt: p => ({ position: p, name: p.y < 60 ? 'stone' : placed ? 'crafting_table' : 'air', boundingBox: p.y < 60 ? 'block' : 'empty' }),
    recipesFor: (id, meta, amount, table) => table ? [{}] : [],
    equip: async () => {}, placeBlock: async () => { placed = true; },
    craft: async (recipe, amount, table) => { assert.equal(table.name, 'crafting_table'); crafted = true; },
  };
  const executor = new SkillExecutor(bot); executor.navigate = async () => {};
  await executor.execute({ skill: 'CRAFT_ITEM', params: { target: 'wooden_pickaxe' } });
  assert.equal(placed, true); assert.equal(crafted, true);
});
