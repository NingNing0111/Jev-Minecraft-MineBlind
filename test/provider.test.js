const { test } = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../src/experiment/config');
const { createAgentModel } = require('../src/agent/model');
const { createPlanner } = require('../src/agent/planner');
const custom = (extra = {}) => config({ AGENT_PROVIDER: 'openai-responses', AGENT_API_KEY: 'offline-test-key', ...extra });

test('provider defaults, validation, and non-serialized credentials', () => {
  assert.equal(createAgentModel(config({})), 'openai/gpt-4.1');
  const c = custom();
  assert.equal(c.baseURL, 'https://ai-gateway.pgthinker.me/v1');
  assert.equal(c.model, 'gemini-3.8-flash-high');
  assert.equal(JSON.stringify(c).includes('offline-test-key'), false);
  assert.equal(custom({ AGENT_BASE_URL: 'https://example.test/v1/' }).baseURL, 'https://example.test/v1');
  assert.throws(() => config({ AGENT_PROVIDER: 'unknown' }), /AGENT_PROVIDER/);
  for (const url of ['not a url', 'file:///tmp/key', 'https://user:secret@example.test', 'https://example.test?key=secret']) {
    assert.throws(() => custom({ AGENT_BASE_URL: url }), /AGENT_BASE_URL/);
  }
  assert.throws(() => createAgentModel(custom({ AGENT_API_KEY: '' })), /AGENT_API_KEY/);
});

test('Responses adapter sends exact model, auth, schema and tools to /responses offline', async () => {
  let requests = 0;
  const model = createAgentModel(custom(), { fetch: async (url, init) => {
    requests++;
    assert.equal(String(url), 'https://ai-gateway.pgthinker.me/v1/responses');
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer offline-test-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gemini-3.8-flash-high');
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.tools[0].name, 'minecraftKnowledge');
    return Response.json({ id: 'resp_offline', created_at: 1, model: body.model,
      output: [{ id: 'msg_offline', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  } });
  const result = await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Plan' }] }],
    responseFormat: { type: 'json', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
    tools: [{ type: 'function', name: 'minecraftKnowledge', description: 'Offline test', inputSchema: { type: 'object', properties: {} } }],
  });
  assert.equal(requests, 1);
  assert.equal(result.content[0].text, '{"ok":true}');
});

test('Chat adapter sends exact model, credentials and schema to /chat/completions', async () => {
  const c = custom({ AGENT_PROVIDER: 'openai-chat' });
  assert.equal(c.model, 'gemini-3.8-flash-high');
  const model = createAgentModel(c, { fetch: async (url, init) => {
    assert.equal(String(url), 'https://ai-gateway.pgthinker.me/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer offline-test-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, c.model);
    assert.equal(body.response_format.type, 'json_schema');
    return Response.json({ id: 'chat_test', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  } });
  const result = await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Plan' }] }],
    responseFormat: { type: 'json', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
  });
  assert.equal(result.content[0].text, '{"ok":true}');
  const planner = createPlanner(c, null, { fetch: () => { throw new Error('Unexpected network'); } });
  assert.equal((await planner.agent.getModel()).provider, 'openai.chat');
});

test('Mastra accepts the custom Responses model without any network call', async () => {
  const planner = createPlanner(custom(), null, { fetch: () => { throw new Error('Unexpected network call'); } });
  const model = await planner.agent.getModel();
  assert.equal(model.modelId, 'gemini-3.8-flash-high');
  assert.equal(model.provider, 'openai.responses');
});
