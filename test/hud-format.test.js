const test = require('node:test');
const assert = require('node:assert/strict');
const hud = require('../public/hud-format');
test('all runtime skills have labels and no question-mark fallback', () => {
  for (const s of ['EXPLORE_AREA','NAVIGATE_TO','MINE_RESOURCE','CRAFT_ITEM','FIGHT_MOB','FLEE','BUILD_PORTAL','SEARCH_STRUCTURE','LOOT_CONTAINER','EAT','WATER','REQUEST_AGENT','Idle']) {
    assert.notEqual(hud.action(s).label, s); assert.notEqual(hud.action(s).icon, '❓');
  }
});
test('missing latency and source never produce undefined or pretend to be Jev', () => {
  for (const v of [undefined, null, NaN, Infinity, -1]) assert.equal(hud.latency(v), '未提供');
  assert.equal(hud.latency(0), '0 ms'); assert.equal(hud.source(undefined), '来源未提供');
});
test('logs explain targets even without legacy reason/hp', () => {
  assert.equal(hud.detail({params:{target:'oak_log'}}), '目标：oak_log');
  assert.equal(hud.detail({params:{position:{x:1,y:2,z:3}}}), '前往 1, 2, 3');
  assert.equal(hud.detail({}), '');
});
