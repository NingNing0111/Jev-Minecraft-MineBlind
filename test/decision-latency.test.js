const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { CircuitBreaker } = require('../src/jev/circuit-breaker');
const { decide } = require('../src/jev/client');
const context = { goal: { skill: 'EXPLORE_AREA' }, observation: { environment: {
  exploration: { destination: { position: { x: 1, y: 64, z: 1 } } }
} }, workingMemory: [] };
const timed = result => assert.ok(Number.isFinite(result.latency) && result.latency >= 0);

test('all decision paths supply measured latency, including fallback and help', async t => {
  const key = process.env.JEV_API_KEY;
  const post = axios.post;
  t.after(() => { axios.post = post; if (key === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = key; });
  delete process.env.JEV_API_KEY;
  timed(await decide(context));
  const unactionable = { ...context, observation: {} };
  const localHelp = await decide(unactionable);
  assert.equal(localHelp.action, 'REQUEST_AGENT'); timed(localHelp);
  process.env.JEV_API_KEY = 'offline';
  for (const skill of ['EXPLORE_AREA', 'REQUEST_AGENT', 'INVALID', 'BUILD_PORTAL']) {
    axios.post = async () => ({ data: { answers: { skill: { choice: skill } } } });
    timed(await decide(context, undefined, {}, new CircuitBreaker()));
  }
  axios.post = async () => { await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('offline timeout'); };
  const failed = await decide(context);
  assert.equal(failed.source, 'local');
  assert.ok(failed.latency >= 10);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(decide(context, controller.signal), { name: 'AbortError' });
});
