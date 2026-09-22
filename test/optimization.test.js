const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { CircuitBreaker, providerFailure } = require('../src/jev/circuit-breaker');
const { planningKey, failureClass } = require('../src/bot/planning-policy');
const { ActionGuard } = require('../src/skills/action-guard');
const { SkillExecutor } = require('../src/skills/executor');
const { collect } = require('../src/skills/collect');

test('provider circuit distinguishes billing, timeout, throttling and recovery', () => {
  let now = 1; const c = new CircuitBreaker(() => now);
  c.fail({ code: 'ETIMEDOUT' }); assert.equal(c.allowed(), false);
  assert.equal(c.snapshot().category, 'provider_timeout');
  now += 10000; assert.equal(c.allowed(), true);
  c.fail({ response: { status: 429 } }); assert.equal(c.retryAt, now + 20000);
  c.success(); assert.equal(c.allowed(), true);
  c.fail({ response: { status: 402 } }); now += 100000000;
  assert.equal(c.allowed(), false); assert.equal(c.snapshot().requiresIntervention, true);
  assert.equal(providerFailure({ statusCode: 401 }).category, 'provider_configuration');
});
test('planning evidence ignores clocks and jitter but notices inventory and region changes', () => {
  const o = { dimension: 'overworld', inventory: { coal: 3 }, player: { hp: 20, position: { x: 1, y: 40, z: 1 } } };
  const key = planningKey(o, { target: 'coal' });
  o.timestamp = 999; o.player.position.x = 1.7;
  assert.equal(planningKey(o, { target: 'coal' }), key);
  o.inventory.coal++; assert.notEqual(planningKey(o, { target: 'coal' }), key);
  o.inventory.coal--; o.player.position.x = 20;
  assert.notEqual(planningKey(o, { target: 'coal' }), key);
  assert.equal(failureClass('PICKUP_UNCONFIRMED'), 'local_execution');
  assert.equal(failureClass('MISSING_TOOL'), 'strategic_prerequisite');
});
test('concrete block memory survives movement and quantity changes, expires or responds to terrain', () => {
  let now = 1, state = 1;
  const block = { position: new Vec3(3,40,2), type: 1 };
  const bot = { game: { dimension: 'overworld' }, entity: { position: new Vec3(0,40,0) },
    inventory: { items: () => [] }, blockAt: () => ({ stateId: state }) };
  const guard = new ActionGuard(bot, () => now);
  guard.failBlock(block, { code: 'NO_PATH' }); bot.entity.position.x += 3;
  assert.equal(guard.checkBlock(block), false);
  now += 30000; assert.equal(guard.checkBlock(block), true);
  guard.failBlock(block, { code: 'NO_PATH' }); state++;
  assert.equal(guard.checkBlock(block), true);
});
test('bounded path probe rejects exhausted/timeout/noPath without starting movement', async () => {
  for (const [status, code] of [['partial','PATH_BUDGET'],['timeout','PATH_BUDGET'],['noPath','NO_PATH']]) {
    let moved = false, closed = false;
    const bot = { entity: { position: new Vec3(0,40,0) }, pathfinder: { movements: {},
      getPathFromTo: function* (_m,_p,_g,opts) { assert.equal(opts.tickTimeout, 50); try { yield { result: { status } }; } finally { closed = true; } },
      goto: async () => { moved = true; } } };
    await assert.rejects(new SkillExecutor(bot).move({}, {}), { code });
    assert.equal(moved, false); assert.equal(closed, true);
  }
});
test('path probe resumes partial slices, yields to event loop, then starts movement', async () => {
  let moved = false, closed = false, yielded = false, slices = 0;
  const bot = { entity: { position: new Vec3(0,40,0) }, pathfinder: { movements: {},
    getPathFromTo: function* (_m,_p,_g,opts) {
      assert.equal(opts.timeout, 1000); assert.equal(opts.searchRadius, 32);
      try {
        slices++; setImmediate(() => { yielded = true; });
        yield { result: { status: 'partial' } };
        assert.equal(yielded, true);
        slices++; yield { result: { status: 'partial' } };
        slices++; yield { result: { status: 'success' } };
      } finally { closed = true; }
    }, goto: async () => { assert.equal(closed, true); moved = true; } } };
  await new SkillExecutor(bot).move({}, {});
  assert.equal(slices, 3); assert.equal(moved, true); assert.equal(closed, true);
});
test('path probe bounds indefinitely partial generators', async () => {
  let slices = 0, closed = false, moved = false;
  const bot = { entity: { position: new Vec3(0,40,0) }, pathfinder: { movements: {},
    getPathFromTo: function* () {
      try { while (true) { slices++; yield { result: { status: 'partial' } }; } }
      finally { closed = true; }
    }, goto: async () => { moved = true; } } };
  await assert.rejects(new SkillExecutor(bot).move({}, {}), { code: 'PATH_BUDGET' });
  assert.ok(slices > 0 && slices <= 20); assert.equal(closed, true); assert.equal(moved, false);
});
test('path probe cancellation closes generator and never starts movement', async () => {
  const task = {}; let closed = false, moved = false, slices = 0;
  const bot = { entity: { position: new Vec3(0,40,0) }, pathfinder: { movements: {},
    getPathFromTo: function* () {
      try {
        slices++; setImmediate(() => { task.cancelled = true; });
        yield { result: { status: 'partial' } };
        slices++; yield { result: { status: 'success' } };
      } finally { closed = true; }
    }, goto: async () => { moved = true; } } };
  await assert.rejects(new SkillExecutor(bot).move(task, {}), { code: 'CANCELLED' });
  assert.equal(slices, 1); assert.equal(closed, true); assert.equal(moved, false);
});
test('collection tries another concrete block after local path failure and chooses harvestable tool', async () => {
  let items = [{ type: 9, count: 1 }], equipped, digPosition, failures = 0;
  const blocks = [1,2].map(x => ({ position: new Vec3(x,40,0), type: 1, name: 'coal_ore', canHarvest: type => type === 9 }));
  const bot = { registry: { blocksByName: { coal_ore: { id: 1, drops: [2] } } }, inventory: { items: () => items },
    pathfinder: { bestHarvestTool: () => ({ type: 8 }) },
    findBlocks: () => blocks.map(b => b.position), blockAt: p => blocks[p.x - 1], canDigBlock: b => b.position.x === 2,
    equip: async item => { equipped = item.type; }, lookAt: async () => {},
    dig: async b => { digPosition = b.position.x; items.push({ type: 2, count: 1 }); } };
  const executor = { bot, check: () => {}, step: async (_t, fn) => fn(),
    guard: { checkBlock: () => true, failBlock: () => failures++ },
    move: async () => { throw Object.assign(new Error('no path'), { code: 'NO_PATH' }); } };
  const result = await collect(executor, { params: { target: 'coal_ore' } });
  assert.equal(equipped, 9); assert.equal(digPosition, 2); assert.equal(failures, 1); assert.equal(result.collected, 1);
});

test('runtime local failures do not abort planners; three failures escalate once via queue', () => {
  const { Runtime } = require('../src/bot/runtime');
  const { EventQueue } = require('../src/bot/events');
  const controller = new AbortController();
  const r = { working: { add() {} }, saveSystem: { log() {} }, actionGuard: { fail: () => ({ retryAt: 99 }) },
    events: new EventQueue(), controller, epoch: 4, localFailures: 0, save() {}, wake() {} };
  const e = { type: 'skill_failed', skill: 'MINE_RESOURCE', code: 'NO_PATH' };
  Runtime.prototype.skillResult.call(r, e); assert.equal(r.events.has('goal_failed'), false);
  Runtime.prototype.skillResult.call(r, e); Runtime.prototype.skillResult.call(r, e);
  assert.equal(r.events.has('goal_failed'), true); assert.equal(controller.signal.aborted, false); assert.equal(r.epoch, 4);
});

test('successful unchanged-state replan is suppressed until evidence or cooldown changes', async () => {
  const { Runtime } = require('../src/bot/runtime');
  let calls = 0, goal = null;
  const r = { planner: { plan: async () => { calls++; return { plan: {}, usage: { totalTokens: 12 } }; } },
    nextAgent: 0, agentCircuit: new CircuitBreaker(), planningAttempts: new Map(),
    manager: { current: () => goal, lastProgress: Date.now(), setPlan() { goal = { id: 'new', target: 'coal' }; } },
    config: { stagnationMs: 1000, agentCooldownMs: 1 }, run: { agentCalled() {}, data: { tokens: 0 } },
    world: { decisionContext: () => ({}) }, actionGuard: { context: () => [] }, saveSystem: { log() {} },
    controller: new AbortController(), epoch: 1, executor: { cancel() {} }, arbiter: {}, save() {} };
  const o = { inventory: { coal: 3 } };
  assert.equal(await Runtime.prototype.replan.call(r, 'goal_failed', o, 1), true);
  r.nextAgent = 0; goal.id = 'cosmetic-new-id';
  assert.equal(await Runtime.prototype.replan.call(r, 'goal_failed', o, 1), false);
  assert.equal(calls, 1);
  o.inventory.coal++;
  assert.equal(await Runtime.prototype.replan.call(r, 'goal_failed', o, 1), true);
  assert.equal(calls, 2); assert.equal(r.run.data.tokens, 24);
});
