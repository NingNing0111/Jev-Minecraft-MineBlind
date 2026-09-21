const { createOpenAI } = require('@ai-sdk/openai');

// Keep the default Mastra model router; custom gateways use Responses explicitly.
function createAgentModel(config, { fetch } = {}) {
  if (config.provider !== 'openai-responses') return config.model;
  if (!config.apiKey) throw new Error('AGENT_API_KEY is required for openai-responses');
  return createOpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    ...(fetch ? { fetch } : {}),
  }).responses(config.model);
}

module.exports = { createAgentModel };
