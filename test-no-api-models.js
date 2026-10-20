// =============================================================
// ZERO-KEY LLM TEST BENCHMARK
// Tests anonymous free LLM APIs that require NO API key & NO signup.
// Reference: https://github.com/mnfst/awesome-free-llm-apis
// Run with: node test-no-api-models.js
// =============================================================

const NO_API_PROVIDERS = [
  {
    name: 'OVHcloud AI Endpoints (Recommended Free Tier)',
    url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    models: [
      'Meta-Llama-3_3-70B-Instruct',
      'Mistral-Nemo-Instruct-2407',
      'gpt-oss-120b',
      'gpt-oss-20b'
    ],
    headers: {
      'Content-Type': 'application/json'
    },
    buildPayload: (model, messages) => ({
      model,
      messages,
      max_tokens: 150
    })
  },
  {
    name: 'LLM7.io (Ultra Fast Anonymous Gateway)',
    url: 'https://api.llm7.io/v1/chat/completions',
    models: [
      'mistral-Nemo-Instruct-2407',
      'gpt-oss:20b'
    ],
    headers: {
      'Content-Type': 'application/json'
    },
    buildPayload: (model, messages) => ({
      model,
      messages,
      max_tokens: 150
    })
  },
  {
    name: 'Kilo Code (Free Router - Note: Leaks reasoning / encrypted tokens)',
    url: 'https://api.kilo.ai/api/gateway/chat/completions',
    models: [
      'openrouter/free',
      'kilo-auto/free'
    ],
    headers: {
      'Content-Type': 'application/json'
    },
    buildPayload: (model, messages) => ({
      model,
      messages,
      max_tokens: 150
    })
  },
  {
    name: 'Local Ollama (Self-Hosted / Offline)',
    url: 'http://localhost:11434/v1/chat/completions',
    models: [
      'llama3.2',
      'qwen2.5:7b',
      'deepseek-r1:8b'
    ],
    headers: {
      'Content-Type': 'application/json'
    },
    buildPayload: (model, messages) => ({
      model,
      messages,
      max_tokens: 150
    }),
    isOptional: true
  }
];

const TEST_PROMPTS = [
  {
    title: 'Hindi/Hinglish Customer Query',
    system: 'You are a friendly customer assistant for an online shop. Reply briefly and politely in Hindi/Hinglish in 1-2 sentences.',
    user: 'Bhaiya order kab tak deliver hoga?'
  },
  {
    title: 'App Download Inquiry',
    system: 'You are a WhatsApp assistant. Tell user how to download the app.',
    user: 'Where can I download your Android APK?'
  }
];

function cleanAIOutput(raw) {
  if (!raw) return '';
  let str = typeof raw === 'string' ? raw : (typeof raw?.text === 'string' ? raw.text : JSON.stringify(raw));
  // Reject encrypted reasoning tokens
  if (str.includes('"type":"reasoning.encrypted"') || str.startsWith('{"type":"reasoning')) {
    return '❌ [POOR QUALITY] Model emitted encrypted reasoning tokens instead of an assistant reply';
  }
  // Strip thought tags
  str = str.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, '');
  str = str.replace(/<(think|thought|reasoning)>[\s\S]*$/gi, '');
  str = str.replace(/\[(think|thought|reasoning)\][\s\S]*?\[\/\1\]/gi, '');
  // Strip Thinking Process headers
  str = str.replace(/^(?:\*{0,2}(?:Thinking\s+Process|Thought\s+Process|Thinking|Thought)\*{0,2}\s*:?[\s\S]*?\n\s*\n)+/i, '');
  // Detect leaked chain-of-thought scratchpad
  if (/^(?:We need (?:to )?respond|User asks|User is asking|I should respond|Need perhaps)/i.test(str.trim())) {
    return `❌ [POOR QUALITY: Leaked reasoning scratchpad] "${str.trim()}"`;
  }
  return str.trim();
}

async function queryModel(provider, model, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000); // 20s max timeout

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ];

  const startTime = Date.now();
  try {
    const res = await fetch(provider.url, {
      signal: controller.signal,
      method: 'POST',
      headers: provider.headers,
      body: JSON.stringify(provider.buildPayload(model, messages))
    });

    clearTimeout(timeout);
    const duration = Date.now() - startTime;

    if (!res.ok) {
      const errText = await res.text();
      return {
        ok: false,
        status: res.status,
        duration,
        error: `HTTP ${res.status}: ${errText.substring(0, 100)}`
      };
    }

    const data = await res.json();
    let content = data?.choices?.[0]?.message?.content;
    
    // In case model returns empty content and dumps reasoning details
    if (!content && data?.choices?.[0]?.message?.reasoning_details) {
      return {
        ok: false,
        status: 'BAD_OUTPUT',
        duration,
        error: 'Model exhausted tokens on encrypted reasoning without generating text'
      };
    }

    if (typeof content !== 'string') {
      if (Array.isArray(content)) {
        content = content.map(c => typeof c === 'string' ? c : (c?.text || JSON.stringify(c))).join(' ');
      } else if (typeof content === 'object' && content !== null) {
        content = content.text || JSON.stringify(content);
      } else {
        content = String(content || '');
      }
    }

    return {
      ok: true,
      status: res.status,
      duration,
      reply: cleanAIOutput(content || '')
    };
  } catch (err) {
    clearTimeout(timeout);
    const duration = Date.now() - startTime;
    return {
      ok: false,
      status: 'ERR',
      duration,
      error: err.name === 'AbortError' ? 'Timeout (20s)' : err.message
    };
  }
}

async function runBenchmark() {
  console.log('='.repeat(70));
  console.log('🚀 ZERO-KEY / NO-API-KEY LLM TEST BENCHMARK');
  console.log('Testing models that require ZERO API keys and ZERO signup.');
  console.log('='.repeat(70));
  console.log();

  const results = [];

  for (const provider of NO_API_PROVIDERS) {
    console.log(`\n📦 Provider: ${provider.name}`);
    console.log(`🌐 Endpoint: ${provider.url}`);
    console.log('-'.repeat(70));

    let providerResponded = false;

    for (const model of provider.models) {
      process.stdout.write(`  ⏳ Testing model [${model}]... `);

      const testPrompt = TEST_PROMPTS[0];
      const result = await queryModel(provider, model, testPrompt);

      if (result.ok && result.reply) {
        providerResponded = true;
        console.log(`✅ SUCCESS (${result.duration}ms)`);
        console.log(`     💬 Output: "${result.reply.substring(0, 120)}${result.reply.length > 120 ? '...' : ''}"`);
        results.push({
          provider: provider.name,
          model,
          status: 'SUCCESS',
          latency: `${result.duration}ms`,
          preview: result.reply.substring(0, 60)
        });
      } else if (result.ok && !result.reply) {
        console.log(`⚠️ Empty reply (${result.duration}ms)`);
        results.push({
          provider: provider.name,
          model,
          status: 'EMPTY',
          latency: `${result.duration}ms`,
          preview: '-'
        });
      } else {
        if (provider.isOptional && (result.error.includes('ECONNREFUSED') || result.error.includes('Failed to fetch'))) {
          console.log(`⚪ Not running locally (${result.error})`);
        } else {
          console.log(`❌ FAILED (${result.status}) - ${result.error}`);
        }
        results.push({
          provider: provider.name,
          model,
          status: result.status,
          latency: `${result.duration}ms`,
          preview: result.error
        });
      }

      // Small delay between tests to respect rate limits
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  console.log();
  console.log('='.repeat(70));
  console.log('📊 SUMMARY TABLE:');
  console.log('='.repeat(70));
  console.table(results);
}

runBenchmark().catch(err => {
  console.error('Benchmark crashed:', err);
});
