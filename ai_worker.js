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
  const rawRegistry = apiKeysRegistry || {};

  // Validate registry entries before using them
  const localRegistry = {};
  for (const [k, v] of Object.entries(rawRegistry)) {
    if (v && typeof v.key === 'string' && typeof v.provider === 'string') {
      localRegistry[k] = v;
    }
  }

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

    // Separate by provider priority:
    // Priority 0: Zero-key anonymous free providers (OVHcloud, LLM7.io, Kilo Code)
    const zeroKeyPool = activeKeys.filter(k => k.isAnonymous || (k.key && k.key.endsWith(':anonymous')));
    // Priority 1: Cloud API keys (OpenRouter, Groq, Gemini, Mistral, etc.)
    const cloudKeyPool = activeKeys.filter(k => !zeroKeyPool.includes(k) && k.provider !== 'huggingface');
    // Priority 2: Hugging Face keys
    const hfKeyPool = activeKeys.filter(k => k.provider === 'huggingface');

    // Pick from Zero-key free models FIRST as requested!
    let pool = zeroKeyPool;
    if (pool.length === 0) {
      pool = cloudKeyPool.length > 0 ? cloudKeyPool : hfKeyPool;
    }

    if (pool.length === 0) {
      return null;
    }

    // Unbiased random selection (avoids modulo bias from compound offset)
    const index = Math.floor(Math.random() * pool.length);
    return pool[index];
  }

  const { getProvider, getModelsForProvider } = require('./llm-providers');

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

  async function tryModel(providerConfig, apiKey, model, abortSignal, attempt = 1) {
    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMessage }
      ];
      const requestPayload = providerConfig.buildPayload(model, messages, 500);
      const headers = providerConfig.headers(apiKey);

      const response = await fetch(providerConfig.url, {
        signal: abortSignal,
        method: 'POST',
        headers,
        body: JSON.stringify(requestPayload)
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

      let responseJson;
      try {
        responseJson = await response.json();
      } catch {
        throw new Error(`Non-JSON response: HTTP ${response.status}`);
      }
      let content = providerConfig.extractContent(responseJson);
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('Empty AI response content');
      }
      const trimmed = content.trim();
      if (trimmed.includes('"type":"reasoning.encrypted"') || trimmed.startsWith('{"type":"reasoning')) {
        throw new Error('Model returned encrypted reasoning tokens instead of assistant message');
      }
      return { content: trimmed, model };
    } catch (err) {
      const isRateLimited = err.status === 429;
      const isBlockedKey = isRateLimited && (localRegistry[apiKey]?.isAnonymous || (err.retryAfter && err.retryAfter > 15));
      const isTransient = ([500, 502, 503, 504].includes(err.status) || (isRateLimited && !isBlockedKey)) && !isBlockedKey;
      const isAborted = abortSignal?.aborted || err.name === 'AbortError';

      if (isTransient && !isAborted && attempt < 3) {
        let waitTime = attempt * 2000;
        if (err.status === 429) {
          // Extra backoff and random jitter for HTTP 429 Rate Limit to prevent synchronized retries
          waitTime = attempt * 2000 + Math.floor(Math.random() * 1500);
        }
        if (err.retryAfter) {
          waitTime = Math.min(err.retryAfter * 1000, 10000);
        }
        console.warn(`[AI Worker] Model ${model} encountered transient error (${err.status}). Retrying attempt ${attempt + 1}/3 after ${waitTime}ms...`);
        
        await delay(waitTime, abortSignal);
        return tryModel(providerConfig, apiKey, model, abortSignal, attempt + 1);
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
    const providerConfig = getProvider(provider);
    const authKey = keyObj.apiKey || (String(activeApiKey).endsWith(':anonymous') ? 'anonymous' : activeApiKey);
    
    attemptedKeys.add(activeApiKey);
    
    let models = getModelsForProvider(provider, process.env);
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

        return tryModel(providerConfig, authKey, model, controller.signal)
          .then(result => {
            controllers.forEach((c, i) => { if (i !== idx) c.abort(); });
            timeouts.forEach(t => clearTimeout(t));
            return result;
          })
          .catch(err => {
            clearTimeout(timeouts[idx]);
            
            if (err.status) {
              const isKeyError = [401, 402, 403].includes(err.status);
              const isRateLimitedKey = err.status === 429 && (localRegistry[activeApiKey]?.isAnonymous || (err.retryAfter && err.retryAfter > 15));
              const isQuotaMsg = /quota|exhausted|insufficient|credit|balance|daily limit|monthly limit/i.test(err.responseText || '');
              if (isKeyError || isRateLimitedKey || isQuotaMsg) {
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
