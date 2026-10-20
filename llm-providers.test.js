const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDERS,
  normalizeProviderId,
  detectProviderFromKey,
  getProvider,
  getModelsForProvider,
  getEnvVarForProvider,
  loadAllApiKeys
} = require('./llm-providers');

test('PROVIDERS contains all required free providers from awesome-free-llm-apis', () => {
  const expected = [
    'openrouter',
    'groq',
    'gemini',
    'mistral',
    'cohere',
    'nvidia',
    'zhipu',
    'ovh',
    'kilo',
    'siliconflow',
    'llm7',
    'modelscope',
    'huggingface'
  ];
  for (const id of expected) {
    assert.ok(PROVIDERS[id], `Missing provider: ${id}`);
    assert.ok(PROVIDERS[id].url, `Provider ${id} must have a base url`);
    assert.ok(Array.isArray(PROVIDERS[id].freeModels) && PROVIDERS[id].freeModels.length > 0, `Provider ${id} must have free models`);
    assert.equal(typeof PROVIDERS[id].buildPayload, 'function', `Provider ${id} must have buildPayload`);
    assert.equal(typeof PROVIDERS[id].extractContent, 'function', `Provider ${id} must have extractContent`);
  }
});

test('detectProviderFromKey correctly identifies provider prefixes', () => {
  assert.equal(detectProviderFromKey('sk-or-v1-abcdef123456'), 'openrouter');
  assert.equal(detectProviderFromKey('gsk_1234567890abcdef'), 'groq');
  assert.equal(detectProviderFromKey('AIzaSyD-12345abcdef'), 'gemini');
  assert.equal(detectProviderFromKey('nvapi-987654321fedcba'), 'nvidia');
  assert.equal(detectProviderFromKey('hf_abcdef1234567890'), 'huggingface');
  assert.equal(detectProviderFromKey('llm7-mykey12345'), 'llm7');
  assert.equal(detectProviderFromKey('unknown_key_format'), null);
});

test('normalizeProviderId resolves aliases', () => {
  assert.equal(normalizeProviderId('open-router'), 'openrouter');
  assert.equal(normalizeProviderId('google'), 'gemini');
  assert.equal(normalizeProviderId('google-gemini'), 'gemini');
  assert.equal(normalizeProviderId('hf'), 'huggingface');
  assert.equal(normalizeProviderId('zai'), 'zhipu');
  assert.equal(normalizeProviderId('nim'), 'nvidia');
  assert.equal(normalizeProviderId('GROQ'), 'groq');
});

test('getModelsForProvider includes user override model first', () => {
  const mockEnv = {
    LLM_MODEL: 'custom/openrouter-model',
    GEMINI_MODEL: 'custom/gemini-model',
    GROQ_MODEL: 'custom/groq-model'
  };

  const orModels = getModelsForProvider('openrouter', mockEnv);
  assert.equal(orModels[0], 'custom/openrouter-model');
  assert.ok(orModels.includes('openrouter/free'));

  const geminiModels = getModelsForProvider('gemini', mockEnv);
  assert.equal(geminiModels[0], 'custom/gemini-model');
  assert.ok(geminiModels.includes('gemini-2.5-flash'));

  const groqModels = getModelsForProvider('groq', mockEnv);
  assert.equal(groqModels[0], 'custom/groq-model');
  assert.ok(groqModels.includes('llama-3.3-70b-versatile'));
});

test('loadAllApiKeys loads from individual provider env vars and generic LLM_API_KEYS with auto-detection', () => {
  const mockEnv = {
    GEMINI_API_KEYS: 'AIzaSyKey1, AIzaSyKey2',
    GROQ_API_KEYS: 'gsk_key1',
    LLM_API_KEYS: 'sk-or-v1-orKey1, gsk_detectedGroqKey, genericKeyWithoutPrefix',
    LLM_PROVIDER: 'mistral',
    HF_TOKENS: 'hf_token1, hf_token2'
  };
  const exhausted = new Set(['hf_token2']);

  const registry = loadAllApiKeys(mockEnv, exhausted);

  assert.equal(registry['AIzaSyKey1'].provider, 'gemini');
  assert.equal(registry['AIzaSyKey2'].provider, 'gemini');
  assert.equal(registry['gsk_key1'].provider, 'groq');
  assert.equal(registry['sk-or-v1-orKey1'].provider, 'openrouter');
  assert.equal(registry['gsk_detectedGroqKey'].provider, 'groq');
  assert.equal(registry['genericKeyWithoutPrefix'].provider, 'mistral');
  assert.equal(registry['hf_token1'].provider, 'huggingface');
  assert.equal(registry['hf_token2'], undefined); // exhausted
});

test('extractContent handles both standard OpenAI format and Cohere v2 format', () => {
  const openAiJson = {
    choices: [
      { message: { content: 'Hello from OpenAI/Gemini/Groq!' } }
    ]
  };
  assert.equal(getProvider('openrouter').extractContent(openAiJson), 'Hello from OpenAI/Gemini/Groq!');
  assert.equal(getProvider('gemini').extractContent(openAiJson), 'Hello from OpenAI/Gemini/Groq!');

  const cohereJson = {
    message: {
      content: [
        { type: 'text', text: 'Hello from Cohere!' }
      ]
    }
  };
  assert.equal(getProvider('cohere').extractContent(cohereJson), 'Hello from Cohere!');
});

test('headers include Bearer authorization and OpenRouter include custom identification headers', () => {
  const orHeaders = getProvider('openrouter').headers('sk-test');
  assert.equal(orHeaders['Authorization'], 'Bearer sk-test');
  assert.ok(orHeaders['HTTP-Referer']);
  assert.ok(orHeaders['X-Title']);

  const groqHeaders = getProvider('groq').headers('gsk_test');
  assert.equal(groqHeaders['Authorization'], 'Bearer gsk_test');
});

test('buildPayload formats messages and sets max_tokens properly', () => {
  const msgs = [{ role: 'user', content: 'test' }];
  const payload = getProvider('gemini').buildPayload('gemini-2.5-flash', msgs, 250);
  assert.equal(payload.model, 'gemini-2.5-flash');
  assert.deepEqual(payload.messages, msgs);
  assert.equal(payload.max_tokens, 250);
});

test('loadAllApiKeys ignores placeholder tokens', () => {
  const mockEnv = {
    HF_TOKENS: 'hf_your_token_here_1, hf_valid_token',
    LLM_API_KEYS: 'sk-or-your_api_key_here, sk-or-v1-valid_key'
  };
  const registry = loadAllApiKeys(mockEnv);
  assert.equal(registry['hf_your_token_here_1'], undefined);
  assert.ok(registry['hf_valid_token']);
  assert.equal(registry['sk-or-your_api_key_here'], undefined);
  assert.ok(registry['sk-or-v1-valid_key']);
});

test('getEnvVarForProvider returns the corresponding environment variable', () => {
  assert.equal(getEnvVarForProvider('openrouter'), 'OPENROUTER_API_KEYS');
  assert.equal(getEnvVarForProvider('groq'), 'GROQ_API_KEYS');
  assert.equal(getEnvVarForProvider('gemini'), 'GEMINI_API_KEYS');
  assert.equal(getEnvVarForProvider('mistral'), 'MISTRAL_API_KEYS');
  assert.equal(getEnvVarForProvider('huggingface'), 'HF_TOKENS');
});

test('loadAllApiKeys injects zero-key anonymous providers first when USE_FREE_ANONYMOUS_FIRST is not false', () => {
  const envWithAnonymous = {
    OPENROUTER_API_KEYS: 'sk-or-v1-my-key'
  };
  const registry = loadAllApiKeys(envWithAnonymous);

  assert.ok(registry['ovh:anonymous'], 'ovh:anonymous should be registered');
  assert.equal(registry['ovh:anonymous'].provider, 'ovh');
  assert.equal(registry['ovh:anonymous'].isAnonymous, true);

  // Kilo and LLM7 are excluded from the default zero-key pool to prevent rate-limit blocks and reasoning leaks
  assert.equal(registry['kilo:anonymous'], undefined);
  assert.equal(registry['llm7:anonymous'], undefined);

  assert.ok(registry['sk-or-v1-my-key'], 'OpenRouter key should also be registered as fallback');
});

test('loadAllApiKeys respects USE_FREE_ANONYMOUS_FIRST=false and respects exhausted keys', () => {
  const envDisabled = {
    USE_FREE_ANONYMOUS_FIRST: 'false',
    OPENROUTER_API_KEYS: 'sk-or-v1-my-key'
  };
  const registryDisabled = loadAllApiKeys(envDisabled);
  assert.equal(registryDisabled['ovh:anonymous'], undefined);
  assert.ok(registryDisabled['sk-or-v1-my-key']);

  // Test exhaustion
  const exhausted = new Set(['ovh:anonymous']);
  const registryExhausted = loadAllApiKeys({}, exhausted);
  assert.equal(registryExhausted['ovh:anonymous'], undefined);
});

