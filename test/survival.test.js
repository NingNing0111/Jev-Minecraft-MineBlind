const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { survivalGoal, safeFood } = require('../src/survival');
const { GoalManager } = require('../src/goal/manager');
const { actionOptions } = require('../src/jev/action-options');
const { decide } = require('../src/jev/client');
const { CircuitBreaker } = require('../src/jev/circuit-breaker');
const { reflex } = require('../src/bot/arbiter');
const observation = () => ({ player: { hp: 1, hunger: 0, velocity: { y: 0 } }, inventory: {},
  threat_scan: [], environment: { exploration: { destination: { position: { x: 1, y: 48, z: 2 } } },
    nearby_resources: [{ type: 'iron_ore', can_harvest: true }],
    nearby_crops: [{ type: 'sugar_cane', drop_item: 'sugar_cane', can_harvest: true }],
    nearby_animals: [{ type: 'salmon' }] } });
test('1 HP / zero hunger overrides ore goals without fleeing or chasing underwater fish', () => {
  const o = observation(), manager = new GoalManager();
  manager.goals = [{ id: 'iron', objective: 'ACQUIRE', target: 'raw_iron', amount: 1 }];
  const goal = manager.tactical(o);
  assert.equal(goal.skill, 'EXPLORE_AREA'); assert.equal(goal.target, 'food');
  assert.deepEqual(Object.keys(actionOptions({ goal, observation: o })), ['EXPLORE_AREA']);
  o.environment.exploration.destination = null;
  assert.deepEqual(actionOptions({ goal, observation: o }), {});
});
test('safe food then craftable food then edible crop; threats take priority', () => {
  const o = observation(); o.inventory = { rotten_flesh: 4, bread: 1 };
  assert.equal(survivalGoal(o).target, 'bread'); assert.equal(survivalGoal(o).skill, 'EAT');
  o.threat_scan = [{ distance: 3, position: { x: 0, y: 48, z: 0 } }];
  assert.equal(survivalGoal(o).skill, 'FLEE');
  o.threat_scan = []; o.inventory = {}; o.equipment = { immediately_craftable: [{ name: 'bread' }] };
  assert.equal(survivalGoal(o).skill, 'CRAFT_ITEM');
  o.equipment = {}; o.environment.nearby_crops.push({ type: 'carrots', drop_item: 'carrot', can_harvest: true });
  assert.equal(survivalGoal(o).target, 'carrots');
  for (const name of ['sugar_cane', 'raw_mutton', 'pufferfish', 'chicken']) assert.equal(safeFood(name), false);
  assert.equal(safeFood('mutton'), true);
});
test('known food container binds its actual coordinate and content field', () => {
  const o = observation(); const position = { x: 2, y: 48, z: 2 };
  o.environment.known_containers = [{ position, contents: [{ name: 'bread', count: 2 }] }];
  assert.deepEqual(survivalGoal(o).position, position);
  assert.equal(survivalGoal(o).skill, 'LOOT_CONTAINER');
});
test('full hunger does not loop consume; low HP alone does not trigger flee', () => {
  const o = observation(); o.player.hunger = 20;
  assert.equal(survivalGoal(o), null);
  assert.equal(reflex({ inventory: { items: () => [{ name: 'bread' }] } }, o), null);
});
test('selector refusal cannot turn executable survival action into waiting', async t => {
  const key = process.env.JEV_API_KEY, post = axios.post;
  t.after(() => { axios.post = post; if (key === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = key; });
  process.env.JEV_API_KEY = 'offline-test';
  axios.post = async () => ({ data: { answers: { skill: { choice: 'REQUEST_AGENT' } } } });
  const o = observation();
  const decision = await decide({ observation: o, goal: survivalGoal(o), workingMemory: [] }, undefined, {}, new CircuitBreaker());
  assert.equal(decision.skill, 'EXPLORE_AREA'); assert.equal(decision.source, 'local');
});
