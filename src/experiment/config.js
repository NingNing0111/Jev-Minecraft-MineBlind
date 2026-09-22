const path = require('node:path');
const projectRoot = path.resolve(__dirname, '../..');
const MODES = {
  A: { agent: false, gate: false, web: false, memory: false },
  B: { agent: true, gate: false, web: false, memory: false },
  C: { agent: true, gate: true, web: false, memory: false },
  D: { agent: true, gate: true, web: true, memory: false },
  E: { agent: true, gate: true, web: true, memory: true },
};
function config(env = process.env) {
  const mode = env.EXPERIMENT_MODE || 'A';
  if (!MODES[mode]) throw new Error('EXPERIMENT_MODE must be A–E');
  const positive = (key, fallback) => {
    const n = Number(env[key] || fallback);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${key}`);
    return n;
  };
  const provider = env.AGENT_PROVIDER || 'mastra';
  if (!['mastra', 'openai-responses', 'openai-chat'].includes(provider)) throw new Error('AGENT_PROVIDER must be mastra, openai-responses or openai-chat');
  let baseURL;
  if (provider !== 'mastra') {
    baseURL = (env.AGENT_BASE_URL || 'https://ai-gateway.pgthinker.me/v1').replace(/\/+$/, '');
    let url;
    try { url = new URL(baseURL); } catch { throw new Error('Invalid AGENT_BASE_URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('AGENT_BASE_URL must be an HTTP(S) base URL without credentials, query or fragment');
    }
  }
  const result = { mode, ...MODES[mode], provider, baseURL,
    model: env.AGENT_MODEL || (provider !== 'mastra' ? 'gemini-3.8-flash-high' : 'openai/gpt-4.1'),
    decisionMs: positive('DECISION_INTERVAL_MS', 1000), stagnationMs: positive('STAGNATION_MS', 120000),
    saveMs: positive('SAVE_INTERVAL_MS', 300000), agentCooldownMs: positive('AGENT_COOLDOWN_MS', 30000),
    saveRoot: path.resolve(projectRoot, env.SAVE_DIR || 'data/saves'),
    knowledgeRoot: path.resolve(projectRoot, env.KNOWLEDGE_DIR || 'data/knowledge'),
    restore: env.RESTORE_SAVE || '', worldId: env.WORLD_ID || `${env.MC_HOST || 'localhost'}:${env.MC_PORT || 25565}` };
  // Do not serialize credentials when config is included in logs or snapshots.
  Object.defineProperty(result, 'apiKey', { value: env.AGENT_API_KEY || '', enumerable: false });
  return result;
}
module.exports = { config, MODES };
