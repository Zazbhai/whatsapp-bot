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

// Auto-detect Chrome/Chromium executable path across platforms
function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
       `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
       `${process.env.LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`]
    : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try { return require('puppeteer').executablePath(); } catch {}
  return null;
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const multer = require('multer');
const crypto = require('crypto');

// Server configuration
const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Create required directories if they don't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Multer storage configuration for manual file sending
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Multi-Instance Memory Registries
const activeClients = {}; // slug -> client instance
const clientStates = {};  // slug -> { status, qrCodeData, info, systemLogs, stats }

const tokensFilePath = path.join(dataDir, 'tokens.json');

function loadActiveTokens() {
  try {
    if (fs.existsSync(tokensFilePath)) {
      const data = fs.readFileSync(tokensFilePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load active tokens:', err);
  }
  return {};
}

function saveActiveTokens(tokens) {
  try {
    fs.writeFileSync(tokensFilePath, JSON.stringify(tokens, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to save active tokens:', err);
    return false;
  }
}

// Instances Persistent Database
const instancesFilePath = path.join(dataDir, 'instances.json');

function loadInstances() {
  try {
    if (fs.existsSync(instancesFilePath)) {
      const data = fs.readFileSync(instancesFilePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load instances database:', err);
  }
  return [];
}

function saveInstances(instances) {
  try {
    fs.writeFileSync(instancesFilePath, JSON.stringify(instances, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to save instances database:', err);
    return false;
  }
}

// Bootstrap default bot instance if empty
let instancesList = loadInstances();
if (instancesList.length === 0) {
  console.log('[SYSTEM] No bot instances found. Bootstrapping "primary" bot...');
  const defaultInstance = {
    id: 'inst_' + Date.now(),
    name: 'Primary Bot',
    slug: 'primary',
    aiEnabled: false,
    aiSystemPrompt: 'You are a multilingual assistant. Respond in the same language the user writes in. Keep replies under 2 sentences. Be concise. You remember our past conversation — use it for context.',
    createdAt: new Date().toISOString()
  };
  instancesList.push(defaultInstance);
  saveInstances(instancesList);
}

// Helper to add logs to specific bot instance
function logInstanceEvent(slug, type, message) {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, type, message };
  
  if (!clientStates[slug]) {
    clientStates[slug] = {
      status: 'disconnected',
      qrCodeData: null,
      info: null,
      systemLogs: [],
      stats: { sent: 0, received: 0, replies: 0 }
    };
  }
  
  clientStates[slug].systemLogs.push(logEntry);
  if (clientStates[slug].systemLogs.length > 200) {
    clientStates[slug].systemLogs.shift();
  }
  
  console.log(`[BOT:${slug.toUpperCase()}] [${timestamp}] [${type.toUpperCase()}] ${message}`);
  
  // Emit exclusively to this instance's Socket.io room
  io.to(`instance_${slug}`).emit('log', logEntry);
}

// Shared rules path for all instances
const globalRulesFilePath = path.join(dataDir, 'rules.json');

const defaultRulesTemplate = [
  { "id": "rule_1", "trigger": "hi", "matchType": "contains", "reply": "Hello! 👋 I am your automated assistant. Type *menu* to see my commands!", "enabled": true },
  { "id": "rule_2", "trigger": "menu", "matchType": "exact", "reply": "🤖 *Auto Bot Menu* 🤖\n\n*1. info* - Check instance specifications\n*2. hours* - Operating schedules", "enabled": true },
  { "id": "rule_3", "trigger": "info", "matchType": "exact", "reply": "🤖 *WhatsApp Bot Instance*\n\nThis browser sandbox engine is completely isolated from other platform bots.", "enabled": true },
  { "id": "rule_4", "trigger": "hours", "matchType": "contains", "reply": "⏰ *Operating Hours*\n\n📅 Mon - Sat: 9:00 AM - 9:00 PM\n📅 Sun: Closed", "enabled": true },
  { "id": "rule_stop_ok", "trigger": "ok", "matchType": "exact", "skipReply": true, "enabled": true },
  { "id": "rule_stop_okay", "trigger": "okay", "matchType": "exact", "skipReply": true, "enabled": true },
  { "id": "rule_stop_thik", "trigger": "thik hai", "matchType": "exact", "skipReply": true, "enabled": true },
  { "id": "rule_stop_bye", "trigger": "bye", "matchType": "exact", "skipReply": true, "enabled": true },
  { "id": "rule_stop_goodbye", "trigger": "goodbye", "matchType": "exact", "skipReply": true, "enabled": true },
  { "id": "rule_stop_thanks", "trigger": "thanks", "matchType": "exact", "skipReply": true, "enabled": true },
  { "id": "rule_stop_thankyou", "trigger": "thank you", "matchType": "exact", "skipReply": true, "enabled": true }
];

function loadInstanceRules(slug) {
  try {
    if (fs.existsSync(globalRulesFilePath)) {
      const data = fs.readFileSync(globalRulesFilePath, 'utf8');
      return JSON.parse(data);
    } else {
      // Premium Migration Check: If rules_primary.json exists, copy it to rules.json to preserve user's data!
      const legacyPath = path.join(dataDir, 'rules_primary.json');
      if (fs.existsSync(legacyPath)) {
        try {
          const legacyData = fs.readFileSync(legacyPath, 'utf8');
          fs.writeFileSync(globalRulesFilePath, legacyData, 'utf8');
          return JSON.parse(legacyData);
        } catch (migErr) {
          console.error('Failed to migrate legacy rules:', migErr);
        }
      }
      
      fs.writeFileSync(globalRulesFilePath, JSON.stringify(defaultRulesTemplate, null, 2), 'utf8');
      return defaultRulesTemplate;
    }
  } catch (err) {
    console.error(`Failed to load global rules:`, err.message);
  }
  return [];
}

function saveInstanceRules(slug, rules) {
  // Overloaded to accept rules as first parameter if only one argument is provided
  let targetRules = rules;
  if (Array.isArray(slug)) {
    targetRules = slug;
  }
  try {
    fs.writeFileSync(globalRulesFilePath, JSON.stringify(targetRules, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`Failed to save global rules:`, err.message);
    return false;
  }
}

// =============================================================
// APK CACHE SYSTEM (Memory + Disk Persistence)
// =============================================================
const latestApkCache = {}; // slug -> { mimetype, data, filename, uploadedBy, uploadedAt }

function getApkCachePath(slug) {
  return path.join(dataDir, `latest_apk_${slug}.json`);
}

function persistApkCache(slug, apkData) {
  try {
    const filePath = getApkCachePath(slug);
    fs.writeFileSync(filePath, JSON.stringify(apkData, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[SYSTEM] Failed to persist APK cache for ${slug}:`, err);
    return false;
  }
}

function loadApkCache(slug) {
  try {
    const filePath = getApkCachePath(slug);
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const apkData = JSON.parse(fileContent);
      latestApkCache[slug] = apkData;
      return true;
    }
  } catch (err) {
    console.error(`[SYSTEM] Failed to load APK cache for ${slug}:`, err);
  }
  return false;
}

// =============================================================
// USER MEMORY — per-user conversation history per instance
// =============================================================
const memoryFilePath = path.join(dataDir, 'memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(memoryFilePath)) {
      return JSON.parse(fs.readFileSync(memoryFilePath, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load memory:', err);
  }
  return {};
}

function saveMemory(memory) {
  try {
    fs.writeFileSync(memoryFilePath, JSON.stringify(memory, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save memory:', err);
  }
}

function getConversationHistory(slug, senderNumber) {
  const memory = loadMemory();
  const key = `${slug}:${senderNumber}`;
  return memory[key] || [];
}

function addToMemory(slug, senderNumber, role, content) {
  const memory = loadMemory();
  const key = `${slug}:${senderNumber}`;
  if (!memory[key]) memory[key] = [];
  memory[key].push({ role, content, timestamp: Date.now() });
  // Keep last 20 messages (10 exchanges) to limit context
  if (memory[key].length > 20) {
    memory[key] = memory[key].slice(-20);
  }
  saveMemory(memory);
}

// =============================================================
// AI CONCURRENCY LIMITER — max 2 simultaneous AI calls per instance
// Prevents OpenRouter free-tier rate-limiting under load
// =============================================================
const AI_MAX_CONCURRENT = 2;
const AI_REQUEST_TIMEOUT = 25000; // 25s per model attempt
const aiSemaphores = {};

function acquireAISlot(slug) {
  if (!aiSemaphores[slug]) aiSemaphores[slug] = { count: 0, queue: [] };
  const s = aiSemaphores[slug];
  if (s.count < AI_MAX_CONCURRENT) {
    s.count++;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    s.queue.push(() => { s.count++; resolve(); });
  });
}

function releaseAISlot(slug) {
  const s = aiSemaphores[slug];
  if (!s) return;
  if (s.queue.length > 0) {
    const next = s.queue.shift();
    next();
  } else {
    s.count--;
  }
}

// Native Open-Source LLM Requester — with fallback model chain + 429 retry handling
async function generateAIResponse(slug, userMessage, history = []) {
  const provider = process.env.LLM_PROVIDER || 'openrouter';
  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    logInstanceEvent(slug, 'error', 'AI Responder triggered but LLM_API_KEY is missing in .env!');
    return null;
  }

  const list = loadInstances();
  const inst = list.find(i => i.slug === slug);
  const systemPrompt = inst && inst.aiSystemPrompt
    ? inst.aiSystemPrompt
    : 'You are a helpful customer assistant. Be polite and brief.';

  // Build URL + model fallback chain per provider
  let url, modelChain;
  if (provider === 'groq') {
    url = 'https://api.groq.com/openai/v1/chat/completions';
    modelChain = [
      process.env.LLM_MODEL || 'llama3-8b-8192',
      'gemma2-9b-it',
      'gemma-7b-it'
    ];
  } else {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    modelChain = [
      process.env.LLM_MODEL || 'openrouter/free',
      'openrouter/free',
      'openai/gpt-oss-120b:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'qwen/qwen3-next-80b-a3b-instruct:free',
      'meta-llama/llama-3.3-70b-instruct:free'
    ];
  }
  // Deduplicate in case LLM_MODEL is already a fallback
  modelChain = [...new Set(modelChain)];

  for (let i = 0; i < modelChain.length; i++) {
    const model = modelChain[i];
    try {
      logInstanceEvent(slug, 'system', `AI query -> ${model}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT);

      let response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
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
      } finally {
        clearTimeout(timeoutId);
      }

      // 429 Rate Limited — skip to next model immediately (no waiting)
      if (response.status === 429) {
        logInstanceEvent(slug, 'system', `"${model}" rate-limited. Trying next model...`);
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        logInstanceEvent(slug, 'error', `AI [${model}] HTTP ${response.status}: ${errText.substring(0, 150)}`);
        continue; // try next model
      }

      const responseJson = await response.json();
      const content = responseJson?.choices?.[0]?.message?.content?.trim();
      if (content) {
        logInstanceEvent(slug, 'system', `AI replied via "${model}"`);
        return content;
      }
    } catch (err) {
      logInstanceEvent(slug, 'error', `AI network error [${model}]: ${err.message}`);
      continue;
    }
  }

  logInstanceEvent(slug, 'error', 'All AI models exhausted. No reply sent.');
  return null;
}

// Initialize active WhatsApp Client for a Bot Instance
function initInstanceClient(slug) {
  if (activeClients[slug]) {
    return activeClients[slug];
  }

  // Load cached APK from disk to memory
  loadApkCache(slug);

  logInstanceEvent(slug, 'system', `Initializing isolated Puppeteer browser sandbox...`);

  // Setup state tracker
  if (!clientStates[slug]) {
    clientStates[slug] = {
      status: 'disconnected',
      qrCodeData: null,
      info: null,
      systemLogs: [],
      stats: { sent: 0, received: 0, replies: 0 }
    };
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `session_${slug}`,
      dataPath: path.join(__dirname, '.wwebjs_auth')
    }),
    puppeteer: {
      executablePath: findChrome(),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
        '--hide-scrollbars',
        '--disable-field-trial-config'
      ]
    },
    puppeteerTimeout: 90000
  });

  client.on('qr', async (qr) => {
    clientStates[slug].status = 'qr_ready';
    clientStates[slug].qrCodeData = qr;
    
    io.to(`instance_${slug}`).emit('status', { 
      status: clientStates[slug].status, 
      qr: true,
      stats: clientStates[slug].stats
    });
    
    logInstanceEvent(slug, 'whatsapp', 'New QR Code generated. Ready for linking.');
    
    console.log(`\n--- QR CODE FOR BOT: ${slug.toUpperCase()} ---`);
    qrcodeTerminal.generate(qr, { small: true });
    
    try {
      const qrImageBase64 = await qrcode.toDataURL(qr);
      io.to(`instance_${slug}`).emit('qr_code', qrImageBase64);
    } catch (err) {
      logInstanceEvent(slug, 'error', `Failed to render QR Base64: ${err.message}`);
    }
  });

  client.on('loading_screen', (percent, message) => {
    clientStates[slug].status = 'connecting';
    io.to(`instance_${slug}`).emit('status', { 
      status: clientStates[slug].status, 
      message, 
      progress: percent,
      stats: clientStates[slug].stats
    });
    logInstanceEvent(slug, 'whatsapp', `Loading WhatsApp Web core: ${percent}% - ${message}`);
  });

  client.on('authenticated', () => {
    clientStates[slug].status = 'authenticated';
    clientStates[slug].qrCodeData = null;
    io.to(`instance_${slug}`).emit('status', { 
      status: clientStates[slug].status,
      stats: clientStates[slug].stats
    });
    logInstanceEvent(slug, 'whatsapp', 'Session authenticated successfully!');
  });

  client.on('auth_failure', (msg) => {
    clientStates[slug].status = 'disconnected';
    io.to(`instance_${slug}`).emit('status', { 
      status: clientStates[slug].status, 
      error: msg,
      stats: clientStates[slug].stats
    });
    logInstanceEvent(slug, 'error', `Authentication failed: ${msg}`);
  });

  client.on('ready', async () => {
    clientStates[slug].status = 'ready';
    const info = client.info;
    
    clientStates[slug].info = {
      pushname: info.pushname,
      wid: info.wid._serialized,
      platform: info.platform
    };
    
    io.to(`instance_${slug}`).emit('status', { 
      status: clientStates[slug].status, 
      info: clientStates[slug].info,
      stats: clientStates[slug].stats
    });
    logInstanceEvent(slug, 'whatsapp', `Active & online! Logged in as: ${info.pushname} (${info.wid.user})`);
  });

  client.on('disconnected', (reason) => {
    clientStates[slug].status = 'disconnected';
    clientStates[slug].info = null;
    io.to(`instance_${slug}`).emit('status', { 
      status: clientStates[slug].status,
      stats: clientStates[slug].stats
    });
    logInstanceEvent(slug, 'whatsapp', `Session closed. Reason: ${reason}`);
    
    delete activeClients[slug];
  });

  client.on('message', async (msg) => {
    if (msg.fromMe) return;

    // Detect and Cache APK Uploads in WhatsApp Group Chats
    if (msg.hasMedia) {
      try {
        if (msg.from && msg.from.endsWith('@g.us')) {
          const media = await msg.downloadMedia();
          if (media && media.filename && media.filename.toLowerCase().endsWith('.apk')) {
            logInstanceEvent(slug, 'system', `Group APK upload detected: "${media.filename}"`);
            
            latestApkCache[slug] = {
              mimetype: media.mimetype,
              data: media.data,
              filename: media.filename,
              uploadedBy: msg._data.notifyName || 'Unknown Contact',
              uploadedAt: new Date().toISOString()
            };
            
            persistApkCache(slug, latestApkCache[slug]);
            
            // Auto-send confirmation response to the group
            await msg.reply(`✅ *Latest APK Received & Cached!*\n\nOriginal Name: \`${media.filename}\`\nSize: \`${(media.data.length * 0.75 / 1024 / 1024).toFixed(2)} MB\`\n\nUsers can now request this APK by replying with *apk*.`);
            logInstanceEvent(slug, 'system', `APK saved to memory & disk. Auto-reply sent to group.`);
            
            // Notify active dashboard sockets that a new APK is cached
            io.to(`instance_${slug}`).emit('apk_cached', {
              filename: media.filename,
              uploadedBy: latestApkCache[slug].uploadedBy,
              uploadedAt: latestApkCache[slug].uploadedAt,
              size: `${(media.data.length * 0.75 / 1024 / 1024).toFixed(2)} MB`
            });
          }
        }
      } catch (err) {
        logInstanceEvent(slug, 'error', `Failed to process APK group upload: ${err.message}`);
      }
    }

    // Return early if message contains no text content (e.g. captionless images/documents)
    if (!msg.body) return;

    const senderName = msg._data.notifyName || 'Unknown Contact';
    const senderNumber = msg.from.split('@')[0];
    
    clientStates[slug].stats.received++;
    io.to(`instance_${slug}`).emit('stat_increment', 'received');
    logInstanceEvent(slug, 'receive', `From "${senderName}" (+${senderNumber}): "${msg.body}"`);

    const rules = loadInstanceRules(slug);
    const incomingText = msg.body.toLowerCase().trim();
    
    // Check for built-in APK request keyword commands
    if (incomingText === 'apk' || incomingText === 'get apk' || incomingText === 'download apk' || incomingText === 'latest apk') {
      logInstanceEvent(slug, 'system', `APK request keyword match from +${senderNumber}`);
      try {
        const apk = latestApkCache[slug];
        if (apk && apk.data) {
          const chat = await msg.getChat();
          await chat.sendStateTyping();
          
          logInstanceEvent(slug, 'system', `Transmitting latest cached APK to +${senderNumber}: "${apk.filename}"...`);
          const media = new MessageMedia(apk.mimetype, apk.data, apk.filename);
          await msg.reply(media);
          
          logInstanceEvent(slug, 'send', `Successfully dispatched APK file "${apk.filename}" to +${senderNumber}`);
          
          clientStates[slug].stats.replies++;
          io.to(`instance_${slug}`).emit('stat_increment', 'replies');
        } else {
          await msg.reply("❌ *No APK File Available*\n\nNo APK has been uploaded to the WhatsApp group yet. Please upload the latest APK to the group first!");
          logInstanceEvent(slug, 'send', `Replied to +${senderNumber} that no APK is available.`);
        }
      } catch (err) {
        logInstanceEvent(slug, 'error', `Failed to send APK file to +${senderNumber}: ${err.message}`);
      }
      return; // Stop execution to bypass auto-responders & AI fallback
    }

    let ruleMatched = false;

    for (const rule of rules) {
      if (!rule.enabled) continue;

      let isMatch = false;
      const triggerText = rule.trigger.toLowerCase().trim();

      if (rule.matchType === 'exact' && incomingText === triggerText) {
        isMatch = true;
      } else if (rule.matchType === 'contains' && incomingText.includes(triggerText)) {
        isMatch = true;
      } else if (rule.matchType === 'starts_with' && incomingText.startsWith(triggerText)) {
        isMatch = true;
      } else if (rule.matchType === 'regex') {
        try {
          const regex = new RegExp(rule.trigger, 'i');
          isMatch = regex.test(msg.body);
        } catch (err) {
          logInstanceEvent(slug, 'error', `Invalid Regex pattern "${rule.trigger}": ${err.message}`);
        }
      }

      if (isMatch) {
        ruleMatched = true;

        // skipReply: conversation-ending signals — log and stop, no reply sent
        if (rule.skipReply) {
          logInstanceEvent(slug, 'system', `Stop signal "${rule.trigger}" — skipping AI reply.`);
          break;
        }

        logInstanceEvent(slug, 'system', `Rule match: "${rule.trigger}" -> Sending auto-reply...`);

        // Randomized human-reply typing delay
        const delay = Math.floor(Math.random() * 2000) + 1000;
        
        const sendReply = async () => {
          if (rule.format === 'buttons' && rule.buttons && rule.buttons.length > 0) {
            const menuButtons = new Buttons(rule.reply, rule.buttons.map(b => ({ body: b.body, id: b.id })));
            await msg.reply(menuButtons);
          } else {
            await msg.reply(rule.reply);
          }
        };

        try {
          const chat = await msg.getChat();
          await chat.sendStateTyping();

          setTimeout(async () => {
            try {
              await sendReply();
              logInstanceEvent(slug, 'send', `Replied to +${senderNumber}: "${rule.reply.replace(/\n/g, ' ')}"`);
              
              clientStates[slug].stats.replies++;
              io.to(`instance_${slug}`).emit('stat_increment', 'replies');
            } catch (replyErr) {
              logInstanceEvent(slug, 'error', `Auto-reply dispatch failed: ${replyErr.message}`);
            }
          }, delay);
        } catch (chatErr) {
          logInstanceEvent(slug, 'error', `Typing simulator failure: ${chatErr.message}`);
          await sendReply();
          clientStates[slug].stats.replies++;
          io.to(`instance_${slug}`).emit('stat_increment', 'replies');
        }
        break;
      }
    }

    // AI Smart Auto-Responder Fallback
    if (!ruleMatched) {
      const list = loadInstances();
      const inst = list.find(i => i.slug === slug);
      
      if (inst && inst.aiEnabled && process.env.LLM_API_KEY) {
        logInstanceEvent(slug, 'system', `No static keyword matched. Querying AI Core Agent...`);
        
        // Load past conversation for context (before storing current message)
        const history = getConversationHistory(slug, senderNumber)
          .filter(m => m.role !== 'system')
          .slice(-10)
          .map(m => ({ role: m.role, content: m.content }));
        
        // Acquire AI concurrency slot (max 2 simultaneous per instance)
        await acquireAISlot(slug);
        try {
          const chat = await msg.getChat();
          await chat.sendStateTyping();
          
          const aiResponse = await generateAIResponse(slug, msg.body, history);
          if (aiResponse) {
            await msg.reply(aiResponse);
            logInstanceEvent(slug, 'send', `AI Smart Reply to +${senderNumber}: "${aiResponse.replace(/\n/g, ' ')}"`);
            
            // Store both user message and reply in memory
            addToMemory(slug, senderNumber, 'user', msg.body);
            addToMemory(slug, senderNumber, 'assistant', aiResponse);
            
            clientStates[slug].stats.replies++;
            io.to(`instance_${slug}`).emit('stat_increment', 'replies');
          } else {
            logInstanceEvent(slug, 'system', `AI Core returned an empty response. No reply dispatched.`);
          }
        } catch (err) {
          logInstanceEvent(slug, 'error', `AI Auto-responder routine failed: ${err.message}`);
        } finally {
          releaseAISlot(slug);
        }
      }
    }
  });

  try {
    client.initialize();
    activeClients[slug] = client;
  } catch (err) {
    logInstanceEvent(slug, 'error', `Engine bootstrap failed: ${err.message}`);
  }

  return client;
}

// Start all provisioned browser clients on boot
instancesList.forEach(inst => {
  initInstanceClient(inst.slug);
});

// Single-User Session Token Authenticator
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Session token missing' });
  }

  const activeTokens = loadActiveTokens();
  const session = activeTokens[token];
  if (!session) {
    return res.status(403).json({ error: 'Session expired. Please log in again.' });
  }

  // Security session expiration: 30 days
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - session.createdAt > thirtyDays) {
    delete activeTokens[token];
    saveActiveTokens(activeTokens);
    return res.status(403).json({ error: 'Session expired. Please log in again.' });
  }

  req.username = session.username;
  next();
}

// Middleware to verify and fetch active instance parameter
function requireInstance(req, res, next) {
  const slug = req.query.instance || req.headers['x-instance'];
  if (!slug) {
    return res.status(400).json({ error: 'Required Bot Instance identifier parameter is missing.' });
  }

  const list = loadInstances();
  const exists = list.some(inst => inst.slug === slug);
  if (!exists) {
    return res.status(404).json({ error: `Bot instance "${slug}" does not exist.` });
  }

  req.instanceSlug = slug;
  next();
}

// Clean phone parser
function formatPhoneNumber(number) {
  let cleaned = number.replace(/\D/g, ''); 
  if (!cleaned.endsWith('@c.us') && !cleaned.endsWith('@g.us')) {
    cleaned = `${cleaned}@c.us`;
  }
  return cleaned;
}

// =============================================================
// EXPRESS REST API ENDPOINTS
// =============================================================

// Single Administrator login (Valids 100% against .env)
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const envUsername = (process.env.SUPER_ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const envPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin';

  if (username.trim().toLowerCase() !== envUsername || password !== envPassword) {
    return res.status(401).json({ error: 'Invalid administrator credentials.' });
  }

  const token = 'token_' + crypto.randomBytes(32).toString('hex');
  const activeTokens = loadActiveTokens();
  activeTokens[token] = {
    username: envUsername,
    createdAt: Date.now()
  };
  saveActiveTokens(activeTokens);

  res.json({ token, username: envUsername, role: 'admin' });
});

// INSTANCES CONTROLLER
app.get('/api/instances', authenticateToken, (req, res) => {
  const list = loadInstances();
  const states = list.map(inst => {
    const state = clientStates[inst.slug] || { status: 'disconnected' };
    return {
      ...inst,
      status: state.status
    };
  });
  res.json(states);
});

app.post('/api/instances', authenticateToken, (req, res) => {
  const { name, slug } = req.body;
  if (!name || !slug) {
    return res.status(400).json({ error: 'Friendly Name and Unique Slug are required.' });
  }

  const normalizedSlug = slug.trim().toLowerCase().replace(/[^a-z0-9\-]/g, '');
  if (normalizedSlug.length < 3) {
    return res.status(400).json({ error: 'Unique Slug must be at least 3 alphanumeric characters.' });
  }

  const list = loadInstances();
  if (list.find(inst => inst.slug === normalizedSlug)) {
    return res.status(409).json({ error: `An instance with identifier "${normalizedSlug}" already exists.` });
  }

  const newInstance = {
    id: 'inst_' + Date.now(),
    name: name.trim(),
    slug: normalizedSlug,
    createdAt: new Date().toISOString()
  };

  list.push(newInstance);
  if (saveInstances(list)) {
    // Spin up browser engine immediately in the background
    initInstanceClient(normalizedSlug);
    res.status(201).json(newInstance);
  } else {
    res.status(500).json({ error: 'Failed to create instance in database.' });
  }
});

app.put('/api/instances/:slug', authenticateToken, (req, res) => {
  const slug = req.params.slug.trim().toLowerCase();
  const { name, aiEnabled, aiSystemPrompt } = req.body;

  const list = loadInstances();
  const index = list.findIndex(inst => inst.slug === slug);
  if (index === -1) {
    return res.status(404).json({ error: 'Bot instance not found.' });
  }

  if (name !== undefined) list[index].name = name.trim();
  if (aiEnabled !== undefined) list[index].aiEnabled = !!aiEnabled;
  if (aiSystemPrompt !== undefined) list[index].aiSystemPrompt = aiSystemPrompt.trim();

  if (saveInstances(list)) {
    res.json(list[index]);
  } else {
    res.status(500).json({ error: 'Failed to save changes in database.' });
  }
});

app.delete('/api/instances/:slug', authenticateToken, async (req, res) => {
  const slug = req.params.slug.trim().toLowerCase();
  
  // Guarantee at least one bot instance remains
  const list = loadInstances();
  if (list.length <= 1) {
    return res.status(400).json({ error: 'You must keep at least one active WhatsApp bot instance!' });
  }

  const index = list.findIndex(inst => inst.slug === slug);
  if (index === -1) {
    return res.status(404).json({ error: 'Instance not found.' });
  }

  console.log(`[SYSTEM CONTROL] Deleting active WhatsApp Engine: ${slug.toUpperCase()}`);

  // 1. Destroy dynamic puppeteer container
  const client = activeClients[slug];
  if (client) {
    try {
      await client.destroy();
    } catch (err) {
      console.error(`Failed to destroy client ${slug}:`, err);
    }
    delete activeClients[slug];
  }
  delete clientStates[slug];

  // 2. Wipes active browser session cache
  const authPath = path.join(__dirname, '.wwebjs_auth', `session_session_${slug}`);
  if (fs.existsSync(authPath)) {
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
    } catch (rmErr) {
      console.error(`Lock conflict on directory session_${slug}`);
    }
  }

  list.splice(index, 1);
  if (saveInstances(list)) {
    res.json({ message: 'WhatsApp engine and active cache wiped successfully.' });
  } else {
    res.status(500).json({ error: 'Failed to save instances database.' });
  }
});

// SELECTED INSTANCE CONTROLS
app.get('/api/status', authenticateToken, requireInstance, (req, res) => {
  const slug = req.instanceSlug;
  const state = clientStates[slug] || {
    status: 'disconnected',
    info: null,
    systemLogs: [],
    stats: { sent: 0, received: 0, replies: 0 }
  };
  
  const list = loadInstances();
  const inst = list.find(i => i.slug === slug);

  res.json({
    status: state.status,
    info: state.info,
    logs: state.systemLogs,
    stats: state.stats,
    rules: loadInstanceRules(slug),
    aiEnabled: inst ? !!inst.aiEnabled : false,
    aiSystemPrompt: inst ? inst.aiSystemPrompt : 'You are a multilingual assistant. Respond in the same language the user writes in. Keep replies under 2 sentences. Be concise.'
  });
});

app.get('/api/rules', authenticateToken, requireInstance, (req, res) => {
  res.json(loadInstanceRules(req.instanceSlug));
});

app.post('/api/rules', authenticateToken, requireInstance, (req, res) => {
  const slug = req.instanceSlug;
  const { trigger, matchType, reply, enabled, format, buttons, skipReply } = req.body;
  if (!trigger || !matchType || !reply) {
    return res.status(400).json({ error: 'Missing required rules parameters' });
  }

  const rules = loadInstanceRules(slug);
  const newRule = {
    id: 'rule_' + Date.now(),
    trigger,
    matchType,
    reply,
    enabled: enabled !== undefined ? enabled : true
  };
  if (format) newRule.format = format;
  if (buttons) newRule.buttons = buttons;
  if (skipReply !== undefined) newRule.skipReply = skipReply;
  rules.push(newRule);
  
  if (saveInstanceRules(slug, rules)) {
    res.status(201).json(newRule);
  } else {
    res.status(500).json({ error: 'Failed to write new rule' });
  }
});

app.put('/api/rules/:id', authenticateToken, requireInstance, (req, res) => {
  const slug = req.instanceSlug;
  const { id } = req.params;
  const { trigger, matchType, reply, enabled, format, buttons, skipReply } = req.body;
  
  let rules = loadInstanceRules(slug);
  const index = rules.findIndex(r => r.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Rule not found' });
  }

  rules[index] = {
    ...rules[index],
    trigger: trigger !== undefined ? trigger : rules[index].trigger,
    matchType: matchType !== undefined ? matchType : rules[index].matchType,
    reply: reply !== undefined ? reply : rules[index].reply,
    enabled: enabled !== undefined ? enabled : rules[index].enabled
  };
  if (format !== undefined) rules[index].format = format;
  if (buttons !== undefined) rules[index].buttons = buttons;
  if (skipReply !== undefined) rules[index].skipReply = skipReply;

  if (saveInstanceRules(slug, rules)) {
    res.json(rules[index]);
  } else {
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

app.delete('/api/rules/:id', authenticateToken, requireInstance, (req, res) => {
  const slug = req.instanceSlug;
  const { id } = req.params;
  let rules = loadInstanceRules(slug);
  const filtered = rules.filter(r => r.id !== id);
  
  if (rules.length === filtered.length) {
    return res.status(404).json({ error: 'Rule not found' });
  }

  if (saveInstanceRules(slug, filtered)) {
    res.json({ message: 'Rule deleted successfully' });
  } else {
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

app.post('/api/send-message', authenticateToken, requireInstance, async (req, res) => {
  const slug = req.instanceSlug;
  const { number, message } = req.body;
  
  if (!number || !message) {
    return res.status(400).json({ error: 'Number and message body are required' });
  }

  const state = clientStates[slug];
  const client = activeClients[slug];

  if (!state || state.status !== 'ready' || !client) {
    return res.status(503).json({ error: 'WhatsApp client is not ready. Scan the QR code first.' });
  }

  const formattedNum = formatPhoneNumber(number);
  logInstanceEvent(slug, 'system', `Transmitting manual broadcast to ${formattedNum}...`);

  try {
    const isRegistered = await client.isRegisteredUser(formattedNum);
    if (!isRegistered) {
      logInstanceEvent(slug, 'error', `Media failed: +${formattedNum.split('@')[0]} is not on WhatsApp.`);
      return res.status(400).json({ error: 'The provided number is not registered on WhatsApp.' });
    }

    await client.sendMessage(formattedNum, message);
    logInstanceEvent(slug, 'send', `Manual send to ${formattedNum}: "${message}"`);
    
    state.stats.sent++;
    io.to(`instance_${slug}`).emit('stat_increment', 'sent');
    
    res.json({ success: true, message: 'Message sent successfully' });
  } catch (err) {
    logInstanceEvent(slug, 'error', `Manual send error: ${err.message}`);
    res.status(500).json({ error: `Internal error: ${err.message}` });
  }
});

app.post('/api/send-file', authenticateToken, requireInstance, upload.single('file'), async (req, res) => {
  const slug = req.instanceSlug;
  const { number, caption } = req.body;
  const file = req.file;

  if (!number || !file) {
    if (file) fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'Number and file are required' });
  }

  const state = clientStates[slug];
  const client = activeClients[slug];

  if (!state || state.status !== 'ready' || !client) {
    fs.unlinkSync(file.path);
    return res.status(503).json({ error: 'WhatsApp client is not ready. Scan the QR code first.' });
  }

  const formattedNum = formatPhoneNumber(number);
  logInstanceEvent(slug, 'system', `Transmitting file broadcast to ${formattedNum} (${file.originalname})...`);

  try {
    const isRegistered = await client.isRegisteredUser(formattedNum);
    if (!isRegistered) {
      fs.unlinkSync(file.path);
      logInstanceEvent(slug, 'error', `Media failed: +${formattedNum.split('@')[0]} is not on WhatsApp.`);
      return res.status(400).json({ error: 'The provided number is not registered on WhatsApp.' });
    }

    const media = MessageMedia.fromFilePath(file.path);
    await client.sendMessage(formattedNum, media, { caption: caption || '' });
    logInstanceEvent(slug, 'send', `Media sent successfully: "${file.originalname}"`);

    state.stats.sent++;
    io.to(`instance_${slug}`).emit('stat_increment', 'sent');

    fs.unlinkSync(file.path);
    res.json({ success: true, message: 'File sent successfully' });
  } catch (err) {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    logInstanceEvent(slug, 'error', `Media send error: ${err.message}`);
    res.status(500).json({ error: `Internal error: ${err.message}` });
  }
});

// GET latest APK status
app.get('/api/apk/status', authenticateToken, requireInstance, (req, res) => {
  const slug = req.instanceSlug;
  const apk = latestApkCache[slug];
  if (apk && apk.data) {
    res.json({
      cached: true,
      filename: apk.filename,
      uploadedBy: apk.uploadedBy || 'Unknown Contact',
      uploadedAt: apk.uploadedAt || 'Unknown Time',
      size: `${(apk.data.length * 0.75 / 1024 / 1024).toFixed(2)} MB`
    });
  } else {
    res.json({ cached: false });
  }
});

// POST to clear APK cache
app.post('/api/apk/clear', authenticateToken, requireInstance, (req, res) => {
  const slug = req.instanceSlug;
  delete latestApkCache[slug];
  
  const cachePath = getApkCachePath(slug);
  if (fs.existsSync(cachePath)) {
    try {
      fs.unlinkSync(cachePath);
    } catch (err) {
      console.error(`[SYSTEM] Failed to delete cache file: ${err.message}`);
    }
  }
  
  logInstanceEvent(slug, 'system', 'APK cache cleared by administrator.');
  
  // Notify active dashboard sockets that APK cache has been cleared
  io.to(`instance_${slug}`).emit('apk_cleared');
  
  res.json({ success: true, message: 'APK cache cleared successfully.' });
});

// GET to download APK
app.get('/api/apk/download', authenticateToken, requireInstance, (req, res) => {
  const slug = req.instanceSlug;
  const apk = latestApkCache[slug];
  if (apk && apk.data) {
    const fileBuffer = Buffer.from(apk.data, 'base64');
    res.setHeader('Content-Type', apk.mimetype || 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${apk.filename || 'app.apk'}"`);
    res.send(fileBuffer);
  } else {
    res.status(404).json({ error: 'No APK cached for this instance.' });
  }
});

// Logout specific WhatsApp Bot instance
app.post('/api/logout', authenticateToken, requireInstance, async (req, res) => {
  const slug = req.instanceSlug;
  logInstanceEvent(slug, 'system', 'Shutting down WhatsApp browser session...');

  try {
    const client = activeClients[slug];
    if (client && clientStates[slug].status !== 'disconnected') {
      await client.logout();
    }
    
    const authPath = path.join(__dirname, '.wwebjs_auth', `session_session_${slug}`);
    if (fs.existsSync(authPath)) {
      setTimeout(() => {
        try {
          fs.rmSync(authPath, { recursive: true, force: true });
          logInstanceEvent(slug, 'system', 'Wiped local session cache directories.');
        } catch (rmErr) {
          logInstanceEvent(slug, 'error', `Folder wipe lock conflict: delete '.wwebjs_auth/session_session_${slug}' manually.`);
        }
      }, 2000);
    }

    if (clientStates[slug]) {
      clientStates[slug].status = 'disconnected';
      clientStates[slug].info = null;
      clientStates[slug].qrCodeData = null;
      
      io.to(`instance_${slug}`).emit('status', { 
        status: clientStates[slug].status,
        stats: clientStates[slug].stats
      });
    }

    delete activeClients[slug];
    res.json({ success: true, message: 'WhatsApp session disconnected. Ready for linking.' });
  } catch (err) {
    logInstanceEvent(slug, 'error', `WhatsApp disconnect failed: ${err.message}`);
    res.status(500).json({ error: `WhatsApp disconnect failed: ${err.message}` });
  }
});

// =============================================================
// SOCKET.IO REAL-TIME ROUTING
// =============================================================
io.on('connection', (socket) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  const activeTokens = loadActiveTokens();
  const session = activeTokens[token];
  const username = session ? session.username : null;
  
  if (!username) {
    socket.disconnect(true);
    return;
  }

  console.log(`[SOCKET] Administrator linked. Channel: ${socket.id}`);

  // Join designated Bot Instance room
  socket.on('join_instance', (slug) => {
    // Leave other instance rooms first
    for (const room of socket.rooms) {
      if (room.startsWith('instance_') && room !== `instance_${slug}`) {
        socket.leave(room);
      }
    }

    socket.join(`instance_${slug}`);
    console.log(`[SOCKET] Linked to room: "instance_${slug}"`);

    // Ensure state buffer exists
    if (!clientStates[slug]) {
      clientStates[slug] = {
        status: 'disconnected',
        qrCodeData: null,
        info: null,
        systemLogs: [],
        stats: { sent: 0, received: 0, replies: 0 }
      };
    }

    // Auto initialize if not active
    if (!activeClients[slug]) {
      initInstanceClient(slug);
    }

    // Instantly transmit latest status metrics and historical log stream
    socket.emit('status', {
      status: clientStates[slug].status,
      info: clientStates[slug].info,
      qr: clientStates[slug].qrCodeData !== null,
      stats: clientStates[slug].stats
    });

    if (clientStates[slug].qrCodeData && clientStates[slug].status === 'qr_ready') {
      qrcode.toDataURL(clientStates[slug].qrCodeData).then(url => {
        socket.emit('qr_code', url);
      }).catch(err => {});
    }

    socket.emit('logs_history', clientStates[slug].systemLogs);
  });

  socket.on('disconnect', () => {
    console.log(`[SOCKET] Admin channel disconnected: ${socket.id}`);
  });
});

// Run server
server.listen(PORT, () => {
  console.log(`\n=============================================================`);
  console.log(`🤖 MULTI-INSTANCE WHATSAPP AUTOMATION BOT HUB IS ONLINE!`);
  console.log(`🌐 Dashboard Portal Interface: http://localhost:${PORT}`);
  console.log(`=============================================================\n`);
});

// =============================================================
// GRACEFUL SHUTDOWN — Destroy all Puppeteer clients on exit
// Prevents orphaned chrome.exe processes holding session locks
// =============================================================
async function gracefulShutdown(signal) {
  console.log(`\n[SYSTEM] ${signal} received. Shutting down all WhatsApp engines gracefully...`);
  
  const slugs = Object.keys(activeClients);
  await Promise.allSettled(slugs.map(async (slug) => {
    try {
      console.log(`[SYSTEM] Destroying engine: ${slug.toUpperCase()}`);
      await activeClients[slug].destroy();
    } catch (err) {
      console.error(`[SYSTEM] Failed to destroy ${slug}: ${err.message}`);
    }
  }));
  
  console.log('[SYSTEM] All engines shut down. Exiting.');
  process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
