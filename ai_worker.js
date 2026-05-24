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
  const failoverErrors = [];

  function safeExit(payload, exitCode = 0) {
    if (typeof process.send === 'function') {
      let exited = false;
      const done = () => {
        if (!exited) {
          exited = true;
          process.exit(exitCode);
        }
      };
      process.send(payload, done);
      setTimeout(done, 200);
    } else {
      process.exit(exitCode);
    }
  }

  function pickRandomKey(attemptedKeys = new Set()) {
    const activeKeys = Object.values(localRegistry).filter(k => !attemptedKeys.has(k.key));
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
    'Qwen/Qwen2.5-72B-Instruct'
  ];

  const openrouterModels = [
    process.env.LLM_MODEL || 'openrouter/free',
    'openrouter/free'
  ];

  const groqModels = [
    process.env.LLM_MODEL || 'mixtral-8x7b-32768',
    'mixtral-8x7b-32768'
  ];

  const delay = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });

  async function tryModel(url, apiKey, model, abortSignal, attempt = 1) {
    try {
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

        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) {
            error.retryAfter = parsed;
          }
        }
        throw error;
      }

      const responseJson = await response.json();
      const content = responseJson?.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('Empty AI response content');
      }
      return { content, model };
    } catch (err) {
      const isTransient = err.status === 429 || [500, 502, 503, 504].includes(err.status);
      const isAborted = abortSignal?.aborted || err.name === 'AbortError';

      if (isTransient && !isAborted && attempt < 3) {
        let waitTime = attempt * 2000;
        if (err.status === 429) {
          // Extra backoff and random jitter for HTTP 429 Rate Limit to prevent synchronized retries
          waitTime = attempt * 3000 + Math.floor(Math.random() * 2000);
        }
        if (err.retryAfter) {
          waitTime = Math.min(err.retryAfter * 1000, 10000);
        }
        console.warn(`[AI Worker] Model ${model} encountered transient error (${err.status}). Retrying attempt ${attempt + 1}/3 after ${waitTime}ms...`);
        
        await delay(waitTime, abortSignal);
        return tryModel(url, apiKey, model, abortSignal, attempt + 1);
      }
      throw err;
    }
  }

  // Configuration for parallel racing
  const PARALLEL_BATCH_SIZE = 3;
  const PER_MODEL_TIMEOUT = 20000;

  const totalKeysCount = Object.keys(localRegistry).length;
  if (totalKeysCount === 0) {
    safeExit({
      status: 'error',
      error: 'No API keys configured.',
      apiKeysRoundRobin: localRoundRobin
    }, 1);
  }

  let attempts = 0;
  const maxKeyAttempts = totalKeysCount;
  const attemptedKeys = new Set();

  while (attempts < maxKeyAttempts) {
    attempts++;
    
    const activeKeys = Object.values(localRegistry);
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

      const racePromises = batch.map(async (model, idx) => {
        const controller = controllers[idx];
        const timeoutId = setTimeout(() => controller.abort(), PER_MODEL_TIMEOUT);
        timeouts.push(timeoutId);

        if (idx > 0) {
          // Stagger the calls to avoid concurrent/rate limit 429 errors (especially on free tiers)
          await delay(idx * 1000, controller.signal);
        }

        return tryModel(url, activeApiKey, model, controller.signal)
          .then(result => {
            controllers.forEach((c, i) => { if (i !== idx) c.abort(); });
            timeouts.forEach(t => clearTimeout(t));
            return result;
          })
          .catch(err => {
            clearTimeout(timeouts[idx]);
            
            if (err.status) {
              const isKeyError = [401, 402, 403].includes(err.status);
              const isQuotaMsg = /quota|exhausted|insufficient|credit|balance|daily limit|monthly limit/i.test(err.responseText || '');
              if (isKeyError || isQuotaMsg) {
                keyExhausted = true;
                controllers.forEach(c => c.abort());
                timeouts.forEach(t => clearTimeout(t));
                if (typeof process.send === 'function') {
                  process.send({
                    status: 'key_exhausted',
                    key: activeApiKey
                  });
                }
              }
            }
            throw err;
          });
      });

      try {
        const winner = await Promise.any(racePromises);
        safeExit({
          status: 'success',
          content: winner.content,
          model: winner.model,
          provider,
          apiKeysRoundRobin: localRoundRobin
        }, 0);
      } catch (aggregateErr) {
        timeouts.forEach(t => clearTimeout(t));
        controllers.forEach(c => c.abort());
        
        const errMessages = (aggregateErr.errors || []).map(e => e.message || String(e)).join(' | ');
        const failMsg = `Key ${activeApiKey.substring(0, 8)}... failed with errors: ${errMessages}`;
        console.warn(`[AI Worker] ${failMsg}. Failing over to another key.`);
        failoverErrors.push(failMsg);
        break;
      }
    }
  }

  if (failoverErrors.length === 0) {
    failoverErrors.push("No active keys were available to try.");
  }

  safeExit({
    status: 'error',
    error: `AI Query failed after maximum key failover attempts. Details: ${failoverErrors.join(' || ')}`,
    apiKeysRoundRobin: localRoundRobin
  }, 0);
});
