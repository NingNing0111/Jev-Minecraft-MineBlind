const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventQueue } = require('../src/bot/events');
const { Runtime } = require('../src/bot/runtime');
const { config } = require('../src/experiment/config');
function runtime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineblind-events-'));
  const bot = new EventEmitter(); bot.inventory = new EventEmitter();
  bot.clearControlStates = () => {}; bot.stopDigging = () => {};
  bot.deactivateItem = () => {}; bot.pathfinder = { setGoal() {} };
  const r = new Runtime(bot, config({ EXPERIMENT_MODE: 'A', SAVE_DIR: root }));
  t.after(async () => { await r.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return r;
}
test('event queue coalesces storms, prioritizes lifecycle and preserves newer revisions', () => {
  const q = new EventQueue(3);
  const old = q.push('failure');
  for (let i = 0; i < 1000; i++) q.push('failure');
  q.acknowledge(old); assert.equal(q.peek().count, 1001);
  q.push('stagnation'); q.push('inventory'); q.push('death', { priority: 0 });
  assert.equal(q.items.size, 3); assert.equal(q.peek().type, 'death');
  const death = q.peek(); q.acknowledge(death); assert.equal(q.has('death'), false);
});
test('death, pause and skill failure discard in-flight planner results', async t => {
  for (const change of [r => r.invalidate('death'), r => r.pause(),
    r => r.skillResult({ type: 'skill_failed', skill: 'MINE_BLOCK', result: {} })]) {
    const r = runtime(t); let resolve;
    r.planner = { plan: () => new Promise(done => { resolve = done; }) };
    const pending = r.replan('startup', {}, r.epoch);
    change(r); resolve({ plan: { goals: [] }, usage: {} });
    assert.equal(await pending, false); assert.equal(r.plan, null);
  }
});
test('lifecycle supersedes stale events and cancelled planning is not a provider error', async t => {
  const r = runtime(t); let reject;
  r.planner = { plan: () => new Promise((_, fail) => { reject = fail; }) };
  const pending = r.replan('startup', {}, r.epoch);
  r.invalidate('dimension_change'); reject(new Error('aborted'));
  assert.equal(await pending, false);
  assert.equal(r.run.data.agentErrors, 0);
  assert.equal(r.events.items.size, 1);
  assert.equal(r.events.peek().type, 'dimension_change');
});
test('ungated mode throttles failures and same-tick help with bounded backoff', async t => {
  const r = runtime(t); r.config.gate = false;
  let calls = 0;
  r.planner = { plan: async () => { calls++; throw new Error('provider unavailable'); } };
  assert.equal(await r.replan('startup', {}, r.epoch), false);
  assert.equal(await r.replan('GOAL_UNACTIONABLE', {}, r.epoch, {}), false);
  assert.equal(calls, 1);
  assert.equal(r.agentError, 'provider unavailable');
  assert.ok(r.nextAgent > Date.now());
  r.nextAgent = 0;
  const before = Date.now();
  await r.replan('startup', {}, r.epoch);
  assert.equal(calls, 2);
  assert.ok(r.nextAgent >= before + r.config.agentCooldownMs * 2);
  assert.equal(r.events.has('startup'), true);
});

test('event wakeups coalesce, never overlap ticks, and listeners detach on stop', async t => {
  const r = runtime(t); r.config.decisionMs = 10000;
  let calls = 0; let release;
  r.tick = async () => { calls++; await new Promise(done => { release = done; }); };
  r.start(); r.start();
  assert.equal(r.bot.listenerCount('health'), 1);
  r.bot.inventory.emit('updateSlot');
  const first = r.timer;
  for (let i = 0; i < 100; i++) r.bot.inventory.emit('updateSlot');
  assert.equal(r.timer, first);
  await new Promise(done => setTimeout(done, 90));
  assert.equal(calls, 1);
  r.wake(); r.wake(); assert.equal(r.timer, null);
  release();
  await new Promise(done => setImmediate(done));
  assert.ok(r.timer);
  await r.stop();
  assert.equal(r.bot.listenerCount('health'), 0);
  assert.equal(r.bot.inventory.listenerCount('updateSlot'), 0);
  await new Promise(done => setTimeout(done, 70));
  assert.equal(calls, 1);
});
