const fs = require('fs');
const path = require('path');

// Load environment variables manually from .env (bulletproof, zero native dependency install risks)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const delimiterIndex = trimmed.indexOf('=');
    if (delimiterIndex === -1) return;
    const key = trimmed.slice(0, delimiterIndex).trim();
    const val = trimmed.slice(delimiterIndex + 1).trim().replace(/(^"|"$|^'|'$)/g, '');
    if (key) {
      process.env[key] = val;
    }
  });
}

process.on('message', async (data) => {
  const { systemPrompt, userMessage, history, apiKeysRegistry, apiKeysRoundRobin } = data;
  
  // Local copies of state
  let localRoundRobin = apiKeysRoundRobin || 0;
  const localRegistry = JSON.parse(JSON.stringify(apiKeysRegistry || {}));
  const cooldownKeys = [];
  
  function putKeyOnCooldown(keyString) {
    const cooldownUntil = Date.now() + 24 * 60 * 60 * 1000; // 24 hours cooldown
    if (localRegistry[keyString]) {
      localRegistry[keyString].cooldownUntil = cooldownUntil;
    }
    cooldownKeys.push(keyString);
  }

  function pickRandomKey(attemptedKeys = new Set()) {
    const now = Date.now();
    const activeKeys = Object.values(localRegistry).filter(k => k.cooldownUntil < now && !attemptedKeys.has(k.key));
    if (activeKeys.length === 0) {
      return null;
    }
    
    // Separate by provider priority
    const otherKeys = activeKeys.filter(k => k.provider !== 'huggingface');
    const hfKeys = activeKeys.filter(k => k.provider === 'huggingface');
    
    // Pick from OpenRouter/Groq first (priority), then HuggingFace
    const pool = otherKeys.length > 0 ? otherKeys : hfKeys;
    
    // Round-robin with random jitter: ensures different users hitting simultaneously get different keys
    const offset = localRoundRobin + Math.floor(Math.random() * pool.length);
    const index = offset % pool.length;
    localRoundRobin = (localRoundRobin + 1) % 1000000;
    
    return pool[index];
  }

  const hfModels = [
    process.env.HF_MODEL || 'deepseek-ai/DeepSeek-V4-Flash:novita',
    'deepseek-ai/DeepSeek-V4-Flash:novita',
    'meta-llama/Llama-3.3-70B-Instruct',
    'Qwen/Qwen2.5-72B-Instruct'
  ];

  const openrouterModels = [
    process.env.LLM_MODEL || 'openai/gpt-oss-120b:free',
    'openai/gpt-oss-120b:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'openrouter/free'
  ];

  const groqModels = [
    process.env.LLM_MODEL || 'llama3-8b-8192',
    'gemma2-9b-it',
    'gemma-7b-it'
  ];

  async function tryModel(url, apiKey, model, abortSignal) {
    const response = await fetch(url, {
      signal: abortSignal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: userMessage }
        ],
        max_tokens: 300
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      const error = new Error(`HTTP ${response.status}: ${errText.substring(0, 120)}`);
      error.status = response.status;
      error.responseText = errText;
      throw error;
    }

    const responseJson = await response.json();
    const content = responseJson?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('Empty AI response content');
    }
    return { content, model };
  }

  // Configuration for parallel racing
  const PARALLEL_BATCH_SIZE = 3;
  const PER_MODEL_TIMEOUT = 20000;

  const totalKeysCount = Object.keys(localRegistry).length;
  if (totalKeysCount === 0) {
    process.send({
      status: 'error',
      error: 'No API keys configured.',
      cooldownKeys,
      apiKeysRoundRobin: localRoundRobin
    });
    process.exit(1);
  }

  let attempts = 0;
  const maxKeyAttempts = Math.min(totalKeysCount, 5);
  const attemptedKeys = new Set();

  while (attempts < maxKeyAttempts) {
    attempts++;
    
    const now = Date.now();
    const activeKeys = Object.values(localRegistry).filter(k => k.cooldownUntil < now);
    const untriedKeys = activeKeys.filter(k => !attemptedKeys.has(k.key));
    if (untriedKeys.length === 0) {
      break;
    }

    const keyObj = pickRandomKey(attemptedKeys);
    if (!keyObj) {
      break;
    }
    const activeApiKey = keyObj.key;
    const provider = keyObj.provider;
    
    attemptedKeys.add(activeApiKey);
    
    let models = [];
    let url = '';
    if (provider === 'huggingface') {
      url = 'https://router.huggingface.co/v1/chat/completions';
      models = hfModels;
    } else if (provider === 'groq') {
      url = 'https://api.groq.com/openai/v1/chat/completions';
      models = groqModels;
    } else {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      models = openrouterModels;
    }
    models = [...new Set(models)];

    let keyExhausted = false;

    for (let batchStart = 0; batchStart < models.length && !keyExhausted; batchStart += PARALLEL_BATCH_SIZE) {
      const batch = models.slice(batchStart, batchStart + PARALLEL_BATCH_SIZE);
      
      const controllers = batch.map(() => new AbortController());
      const timeouts = [];

      const racePromises = batch.map((model, idx) => {
        const controller = controllers[idx];
        const timeoutId = setTimeout(() => controller.abort(), PER_MODEL_TIMEOUT);
        timeouts.push(timeoutId);

        return tryModel(url, activeApiKey, model, controller.signal)
          .then(result => {
            controllers.forEach((c, i) => { if (i !== idx) c.abort(); });
            timeouts.forEach(t => clearTimeout(t));
            return result;
          })
          .catch(err => {
            clearTimeout(timeouts[idx]);
            
            if (err.status) {
              const isKeyError = [400, 401, 402, 403, 429].includes(err.status);
              const isQuotaMsg = /quota|limit|exhausted|insufficient|credit|balance/i.test(err.responseText || '');
              if (isKeyError || isQuotaMsg) {
                putKeyOnCooldown(activeApiKey);
                keyExhausted = true;
                controllers.forEach(c => c.abort());
                timeouts.forEach(t => clearTimeout(t));
              }
            }
            throw err;
          });
      });

      try {
        const winner = await Promise.any(racePromises);
        process.send({
          status: 'success',
          content: winner.content,
          model: winner.model,
          provider,
          cooldownKeys,
          apiKeysRoundRobin: localRoundRobin
        });
        process.exit(0);
      } catch (aggregateErr) {
        timeouts.forEach(t => clearTimeout(t));
        controllers.forEach(c => c.abort());
        if (keyExhausted) {
          break;
        }
      }
    }
  }

  process.send({
    status: 'error',
    error: 'AI Query failed after maximum key failover attempts.',
    cooldownKeys,
    apiKeysRoundRobin: localRoundRobin
  });
  process.exit(0);
});
