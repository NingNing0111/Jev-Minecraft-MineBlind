const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { ActionGuard } = require('../src/skills/action-guard');
const { craftProbe, craft } = require('../src/skills/crafting');
function fixture() {
  const bot = {
    game: { dimension: 'overworld' }, entity: { position: new Vec3(.5,60,.5) },
    inventory: { items: () => [{ name: 'crafting_table', type: 4, count: 1 }, { name: 'oak_planks', type: 2, count: 3 }] },
    registry: { itemsByName: { wooden_pickaxe: { id: 1 } }, blocksByName: { crafting_table: { id: 4 } } },
    findBlock: () => null,
    blockAt: p => ({ position: p, name: p.y < 60 ? 'andesite' : 'cave_air', boundingBox: p.y < 60 ? 'block' : 'empty' }),
    recipesFor: (_id,_m,_n,table) => table ? [{}] : [],
    recipesAll: () => [{ requiresTable: true, delta: [{ id: 2, count: -3 }] }],
    canDigBlock: () => true, equip: async () => {},
  };
  return bot;
}
test('craft probe accepts cave air and checks actual supplied ingredients', () => {
  const b = fixture(); assert.equal(craftProbe(b, 'wooden_pickaxe').ok, true);
  b.recipesAll = () => [{ delta: [{ id: 3, count: -3 }] }];
  assert.equal(craftProbe(b, 'wooden_pickaxe').code, 'MISSING_INGREDIENTS');
});
test('narrow tunnel clears only one safe rock cell and verifies table placement', async () => {
  const b = fixture(); let cleared = false, placed = false, crafted = false;
  b.blockAt = p => ({ position: p, name: p.x === 1 && p.y === 60 && p.z === 0 && (cleared || placed)
    ? (placed ? 'crafting_table' : 'air') : 'andesite', boundingBox: 'block' });
  b.dig = async () => { cleared = true; };
  b.placeBlock = async () => { placed = true; };
  b.craft = async () => { crafted = true; };
  assert.equal(craftProbe(b, 'wooden_pickaxe').site.clear, true);
  await craft({ bot: b, step: async (_t, op) => op(), navigate: async () => {} }, { params: { target: 'wooden_pickaxe' } });
  assert.ok(cleared && placed && crafted);
});
test('no site in unsafe or unloaded cells; hand recipes do not require a table', () => {
  const b = fixture(); b.blockAt = () => null;
  assert.equal(craftProbe(b, 'wooden_pickaxe').code, 'NO_TABLE_SITE');
  b.blockAt = p => ({ position: p, name: 'gravel', boundingBox: 'block' });
  assert.equal(craftProbe(b, 'wooden_pickaxe').ok, false);
  b.recipesFor = () => [{}];
  assert.equal(craftProbe(b, 'wooden_pickaxe').ok, true);
});
test('failure backoff is bounded, action-specific and invalidated by local changes', () => {
  const b = fixture(); let now = 1000;
  const guard = new ActionGuard(b, () => now), params = { target: 'village' };
  guard.fail('SEARCH_STRUCTURE', params, { code: 'STUCK', error: 'stalled' });
  assert.equal(guard.check('SEARCH_STRUCTURE', params).cached, true);
  assert.equal(guard.check('SEARCH_STRUCTURE', { ...params, amount: 99 }).cached, true);
  assert.equal(guard.check('SEARCH_STRUCTURE', { target: 'stronghold' }).ok, true);
  now += 15000; assert.equal(guard.check('SEARCH_STRUCTURE', params).ok, true);
  const retry = guard.fail('SEARCH_STRUCTURE', params, { error: 'stalled' });
  assert.equal(retry.retryAt - now, 30000);
  b.entity.position.x += 1;
  assert.equal(guard.check('SEARCH_STRUCTURE', params).ok, true);
  b.entity.position.x -= 1;
  b.blockAt = p => ({ name: 'dirt', position: p });
  assert.equal(guard.check('SEARCH_STRUCTURE', params).ok, true);
  guard.success('SEARCH_STRUCTURE', params); assert.equal(guard.context().length, 0);
});

test('executor guard covers direct/fallback/resumed submissions without a failure storm', () => {
  const { SkillExecutor } = require('../src/skills/executor');
  const b = fixture(); b.blockAt = () => null;
  const guard = new ActionGuard(b); const events = [];
  const executor = new SkillExecutor(b, event => {
    events.push(event); guard.fail(event.skill, event.params, event);
  });
  executor.guard = guard;
  for (let i = 0; i < 100; i++) assert.equal(executor.start('CRAFT_ITEM', { target: 'wooden_pickaxe' }), false);
  assert.equal(events.length, 1); assert.equal(events[0].code, 'NO_TABLE_SITE');
  assert.equal(executor.busy, false);
});
