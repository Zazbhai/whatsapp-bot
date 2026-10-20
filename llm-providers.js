// =============================================================
// LLM PROVIDERS REGISTRY & COMPATIBILITY LAYER
// Provides curated free LLM APIs with OpenAI compatibility,
// fallback chains, auto key detection, and failover capabilities.
// Ref: https://github.com/mnfst/awesome-free-llm-apis
// =============================================================

const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEYS',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyPrefixes: ['sk-or-'],
    priority: 1,
    freeModels: [
      'openrouter/free',
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'minimax/minimax-m3.1-flash:free'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://github.com/whatsapp-bot',
      'X-Title': 'WhatsApp SaaS Bot'
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens,
      reasoning: { exclude: true }
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  groq: {
    id: 'groq',
    name: 'Groq',
    envVar: 'GROQ_API_KEYS',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    keyPrefixes: ['gsk_'],
    priority: 1,
    freeModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'gemma2-9b-it',
      'qwen/qwen3.8-27b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'mixtral-8x7b-32768'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    envVar: 'GEMINI_API_KEYS',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyPrefixes: ['AIza'],
    priority: 1,
    freeModels: [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-3.5-flash'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    envVar: 'MISTRAL_API_KEYS',
    url: 'https://api.mistral.ai/v1/chat/completions',
    keyPrefixes: [],
    priority: 1,
    freeModels: [
      'mistral-small-latest',
      'codestral-latest',
      'open-mistral-7b',
      'open-mixtral-8x7b',
      'ministral-8b-2512',
      'mistral-medium-3-5'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  cohere: {
    id: 'cohere',
    name: 'Cohere',
    envVar: 'COHERE_API_KEYS',
    url: 'https://api.cohere.com/v2/chat',
    keyPrefixes: [],
    priority: 1,
    freeModels: [
      'command-r-08-2024',
      'command-r-plus-08-2024',
      'command-r7b-12-2024',
      'c4ai-aya-expanse-32b',
      'command-a-03-2025'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => {
      if (json?.choices?.[0]?.message?.content) {
        return json.choices[0].message.content;
      }
      if (json?.message?.content) {
        if (Array.isArray(json.message.content)) {
          return json.message.content.map(c => c.text || c).join('\n');
        }
        if (typeof json.message.content === 'string') {
          return json.message.content;
        }
      }
      return null;
    }
  },

  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    envVar: 'NVIDIA_API_KEYS',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    keyPrefixes: ['nvapi-'],
    priority: 1,
    freeModels: [
      'meta/llama-3.3-70b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'mistralai/mistral-large-2-instruct',
      'google/gemma-2-9b-it'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  zhipu: {
    id: 'zhipu',
    name: 'Zhipu AI (GLM)',
    envVar: 'ZHIPU_API_KEYS',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    keyPrefixes: [],
    priority: 1,
    freeModels: [
      'glm-4.7-flash',
      'glm-4.5-flash',
      'glm-4-flash'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  ovh: {
    id: 'ovh',
    name: 'OVHcloud AI Endpoints',
    envVar: 'OVH_API_KEYS',
    url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    keyPrefixes: [],
    priority: 0, // Top priority zero-key tier
    isAnonymous: true,
    freeModels: [
      'Meta-Llama-3_3-70B-Instruct',
      'Mistral-Nemo-Instruct-2407',
      'gpt-oss-120b',
      'gpt-oss-20b'
    ],
    headers: (key) => {
      const h = { 'Content-Type': 'application/json' };
      if (key && key !== 'anonymous' && !String(key).endsWith(':anonymous')) {
        h['Authorization'] = `Bearer ${key}`;
      }
      return h;
    },
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  kilo: {
    id: 'kilo',
    name: 'Kilo Code',
    envVar: 'KILO_API_KEYS',
    url: 'https://api.kilo.ai/api/gateway/chat/completions',
    keyPrefixes: [],
    priority: 1,
    freeModels: [
      'openrouter/free',
      'kilo-auto/free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'qwen/qwen3.8-27b:free'
    ],
    headers: (key) => {
      const h = { 'Content-Type': 'application/json' };
      if (key && key !== 'anonymous' && !String(key).endsWith(':anonymous')) {
        h['Authorization'] = `Bearer ${key}`;
      }
      return h;
    },
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  siliconflow: {
    id: 'siliconflow',
    name: 'SiliconFlow',
    envVar: 'SILICONFLOW_API_KEYS',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    keyPrefixes: [],
    priority: 1,
    freeModels: [
      'Qwen/Qwen2.5-7B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen3-8B'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  llm7: {
    id: 'llm7',
    name: 'LLM7.io',
    envVar: 'LLM7_API_KEYS',
    url: 'https://api.llm7.io/v1/chat/completions',
    keyPrefixes: ['llm7-'],
    priority: 0, // Top priority zero-key tier
    isAnonymous: true,
    freeModels: [
      'mistral-Nemo-Instruct-2407',
      'gpt-oss:20b'
    ],
    headers: (key) => {
      const h = { 'Content-Type': 'application/json' };
      if (key && key !== 'anonymous' && !String(key).endsWith(':anonymous')) {
        h['Authorization'] = `Bearer ${key}`;
      }
      return h;
    },
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  modelscope: {
    id: 'modelscope',
    name: 'ModelScope',
    envVar: 'MODELSCOPE_API_KEYS',
    url: 'https://api-inference.modelscope.cn/v1/chat/completions',
    keyPrefixes: [],
    priority: 1,
    freeModels: [
      'Qwen/Qwen2.5-72B-Instruct',
      'Qwen/Qwen3.5-27B'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  },

  huggingface: {
    id: 'huggingface',
    name: 'Hugging Face',
    envVar: 'HF_TOKENS',
    url: 'https://router.huggingface.co/v1/chat/completions',
    keyPrefixes: ['hf_'],
    priority: 2, // Secondary fallback tier
    freeModels: [
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Llama-3.1-8B-Instruct'
    ],
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    }),
    buildPayload: (model, messages, maxTokens = 500) => ({
      model,
      messages,
      max_tokens: maxTokens
    }),
    extractContent: (json) => json?.choices?.[0]?.message?.content
  }
};

// Aliases for friendly name lookup
const PROVIDER_ALIASES = {
  'ovhcloud': 'ovh',
  'open-router': 'openrouter',
  'google': 'gemini',
  'google-gemini': 'gemini',
  'geminiai': 'gemini',
  'hf': 'huggingface',
  'hugging-face': 'huggingface',
  'zai': 'zhipu',
  'bigmodel': 'zhipu',
  'nim': 'nvidia'
};

function normalizeProviderId(id) {
  if (!id || typeof id !== 'string') return 'openrouter';
  const clean = id.toLowerCase().trim();
  if (PROVIDERS[clean]) return clean;
  if (PROVIDER_ALIASES[clean]) return PROVIDER_ALIASES[clean];
  return clean;
}

function detectProviderFromKey(key) {
  if (!key || typeof key !== 'string') return null;
  const trimmed = key.trim();
  for (const provider of Object.values(PROVIDERS)) {
    for (const prefix of provider.keyPrefixes) {
      if (trimmed.startsWith(prefix)) {
        return provider.id;
      }
    }
  }
  return null;
}

function getProvider(id) {
  const norm = normalizeProviderId(id);
  return PROVIDERS[norm] || PROVIDERS.openrouter;
}

function getModelsForProvider(providerId, env = process.env) {
  const p = getProvider(providerId);
  const models = [];

  // 1. Check provider-specific model override in environment
  const envModelKey = `${p.id.toUpperCase()}_MODEL`;
  if (env[envModelKey]) {
    models.push(env[envModelKey]);
  }

  // 2. If provider is OpenRouter, check legacy/generic LLM_MODEL
  if (p.id === 'openrouter' && env.LLM_MODEL) {
    models.push(env.LLM_MODEL);
  }

  // 3. If provider is Hugging Face, check legacy HF_MODEL
  if (p.id === 'huggingface' && env.HF_MODEL) {
    models.push(env.HF_MODEL);
  }

  // 4. Append provider's curated free models
  models.push(...p.freeModels);

  // Return unique models
  return [...new Set(models.filter(Boolean))];
}

function getEnvVarForProvider(providerId) {
  const p = getProvider(providerId);
  return p.envVar;
}

function loadAllApiKeys(env = process.env, exhaustedKeys = new Set()) {
  const registry = {};

  // 0. Load zero-key anonymous free providers first (OVHcloud, LLM7.io)
  // These require NO API keys, NO signup, and are prioritized first as requested.
  // Can be disabled by setting USE_FREE_ANONYMOUS_FIRST=false in .env
  if (env.USE_FREE_ANONYMOUS_FIRST !== 'false') {
    const anonymousProviders = ['ovh'];
    for (const pId of anonymousProviders) {
      const regKey = `${pId}:anonymous`;
      if (!exhaustedKeys.has(regKey)) {
        registry[regKey] = {
          provider: pId,
          key: regKey,
          apiKey: 'anonymous',
          isAnonymous: true
        };
      }
    }
  }

  // Helper to register keys
  const registerKeys = (keysStr, providerId) => {
    if (!keysStr || typeof keysStr !== 'string') return;
    const keys = keysStr.split(/[\s,;]+/).map(k => k.trim()).filter(Boolean);
    keys.forEach(k => {
      // Skip dummy placeholder tokens
      if (k.includes('your_token_here') || k.includes('your_api_key_here')) return;
      if (!exhaustedKeys.has(k)) {
        registry[k] = {
          provider: providerId,
          key: k
        };
      }
    });
  };

  // 1. Load keys from each provider's dedicated environment variable
  for (const provider of Object.values(PROVIDERS)) {
    const rawVal = env[provider.envVar];
    if (rawVal) {
      registerKeys(rawVal, provider.id);
    }
  }

  // 2. Load keys from legacy/generic LLM_API_KEYS (and LLM_API_KEY)
  const genericLlmKeys = (env.LLM_API_KEYS || env.LLM_API_KEY || '').split(/[\s,;]+/).map(k => k.trim()).filter(Boolean);
  const defaultProvider = normalizeProviderId(env.LLM_PROVIDER || 'openrouter');

  genericLlmKeys.forEach(key => {
    if (key.includes('your_token_here') || key.includes('your_api_key_here')) return;
    if (exhaustedKeys.has(key)) return;

    // Detect provider from key prefix if possible, otherwise fall back to LLM_PROVIDER
    const detected = detectProviderFromKey(key) || defaultProvider;
    // Don't overwrite if already registered under a specific provider
    if (!registry[key]) {
      registry[key] = {
        provider: detected,
        key
      };
    }
  });

  // 3. Load keys from legacy HF_TOKEN (singular)
  if (env.HF_TOKEN && !env.HF_TOKENS) {
    registerKeys(env.HF_TOKEN, 'huggingface');
  }

  return registry;
}

module.exports = {
  PROVIDERS,
  normalizeProviderId,
  detectProviderFromKey,
  getProvider,
  getModelsForProvider,
  getEnvVarForProvider,
  loadAllApiKeys
};
