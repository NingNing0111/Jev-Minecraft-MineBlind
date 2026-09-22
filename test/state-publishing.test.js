const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Runtime } = require('../src/bot/runtime');
const { config } = require('../src/experiment/config');
const { extractHudState, extractState, refreshResourceScan } = require('../src/perception');
function botFixture() {
  const bot = new EventEmitter();
  bot.inventory = Object.assign(new EventEmitter(), { slots: [], items: () => [] });
  Object.assign(bot, { entity: { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), yaw: 0 },
    entities: {}, game: { dimension: 'overworld' }, health: 20, food: 20, quickbarSlot: 0,
    blockAt: () => null, clearControlStates() {}, stopDigging() {}, deactivateItem() {}, pathfinder: { setGoal() {} },
    findBlock() { throw new Error('HUD must not search blocks'); }, recipesFor() { throw new Error('HUD must not enumerate recipes'); } });
  return bot;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('HUD merges live fields without scanning and drops cross-dimension cached fields', () => {
  const bot = botFixture();
  const cached = { dimension: 'overworld', timestamp: 123, environment: { nearby_resources: [{ type: 'iron_ore' }] } };
  const state = extractHudState(bot, cached);
  assert.equal(state.observation_timestamp, 123);
  assert.equal(state.environment.nearby_resources.length, 1);
  bot.game.dimension = 'the_nether';
  assert.equal(extractHudState(bot, cached).environment.nearby_resources, undefined);
  assert.equal(extractHudState(bot, cached).observation_timestamp, null);
});
test('independent publisher stays live through blocked decision and pause, then stops', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineblind-publish-'));
  const bot = botFixture(); const messages = [];
  const r = new Runtime(bot, config({ EXPERIMENT_MODE: 'A', SAVE_DIR: root }), (event, data) => messages.push(data));
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  r.tick = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  t.after(async () => { release?.(); await r.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  r.start(); r.wake(); await started;
  bot.health = 7; bot.entity.position.x = 9;
  await wait(250);
  assert.equal(r.runningTick, true);
  assert.equal(messages.at(-1).state.player.hp, 7);
  assert.equal(messages.at(-1).state.player.position.x, 9);
  r.pause(); bot.health = 0;
  await wait(250);
  assert.equal(messages.at(-1).ai_paused, true);
  assert.equal(messages.at(-1).state.player.hp, 0);
  r.latestObservation = { dimension: 'overworld', timestamp: 123 };
  r.invalidate('death'); assert.equal(r.latestObservation, null);
  await r.stop(); const count = messages.length;
  release(); await wait(250);
  assert.equal(messages.length, count);
});
test('resource prewarming yields between block searches and populates synchronous cache', async () => {
  const bot = botFixture(); const names = Object.keys(require('../src/knowledge').ALL_SCANNABLE).slice(0, 3);
  bot.registry = { blocksByName: Object.fromEntries(names.map((name, id) => [name, { id }])), itemsByName: {} };
  let searches = 0; let yielded = false;
  bot.findBlock = () => { searches++; if (searches === 1) setImmediate(() => { yielded = true; }); else assert.equal(yielded, true); return null; };
  await refreshResourceScan(bot);
  assert.equal(searches, 3);
  extractState(bot); assert.equal(searches, 3);
  const controller = new AbortController(); controller.abort(); bot.game.dimension = 'the_end';
  await refreshResourceScan(bot, controller.signal); assert.equal(searches, 3);
});
