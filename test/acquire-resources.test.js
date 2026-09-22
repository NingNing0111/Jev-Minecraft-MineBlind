const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GoalManager } = require('../src/goal/manager');
function bot(visible) {
  return {
    registry: { itemsByName: { raw_iron: { id: 1 }, raw_iron_block: { id: 2 } },
      items: { 1: { name: 'raw_iron' }, 2: { name: 'raw_iron_block' } },
      blocksByName: { crafting_table: { id: 3 }, iron_ore: { id: 4 }, deepslate_iron_ore: { id: 5 } } },
    findBlock: ({ matching }) => matching === visible ? { name: 'ore' } : null,
    recipesFor: () => [],
    recipesAll: id => [{ delta: [{ id: id === 1 ? 2 : 1, count: -1 }] }],
  };
}
test('visible iron ore wins over raw iron storage-block recipe recursion', () => {
  const action = new GoalManager().acquire('raw_iron', 3, {}, bot(4));
  assert.deepEqual(action, { skill: 'MINE_RESOURCE', target: 'iron_ore', amount: 3 });
});
test('deepslate ores are acquisition candidates', () => {
  assert.equal(new GoalManager().acquire('raw_iron', 3, {}, bot(5)).target, 'deepslate_iron_ore');
});
test('absent ore searches for requested resource, not an unavailable storage block', () => {
  assert.deepEqual(new GoalManager().acquire('raw_iron', 3, {}, bot(-1)),
    { skill: 'EXPLORE_AREA', target: 'raw_iron', amount: 3 });
});
