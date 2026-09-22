const { createOpenAI } = require('@ai-sdk/openai');

// Keep the Mastra router; custom gateways explicitly select their supported API.
function createAgentModel(config, { fetch } = {}) {
  if (!['openai-responses', 'openai-chat'].includes(config.provider)) return config.model;
  if (!config.apiKey) throw new Error(`AGENT_API_KEY is required for ${config.provider}`);
  const provider = createOpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    ...(fetch ? { fetch } : {}),
  });
  return config.provider === 'openai-chat' ? provider.chat(config.model) : provider.responses(config.model);
}

module.exports = { createAgentModel };
