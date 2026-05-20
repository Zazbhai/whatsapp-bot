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

// In-memory active tokens cache
let activeTokensCache = null;

function loadActiveTokens() {
  if (activeTokensCache) {
    return activeTokensCache;
  }
  try {
    if (fs.existsSync(tokensFilePath)) {
      const data = fs.readFileSync(tokensFilePath, 'utf8');
      activeTokensCache = JSON.parse(data);
      return activeTokensCache;
    }
  } catch (err) {
    console.error('Failed to load active tokens:', err);
  }
  activeTokensCache = {};
  return activeTokensCache;
}

function saveActiveTokens(tokens) {
  activeTokensCache = tokens;
  try {
    // Write asynchronously to prevent event-loop blockings!
    fs.promises.writeFile(tokensFilePath, JSON.stringify(tokens, null, 2), 'utf8')
      .catch(err => console.error('[SYSTEM] Async tokens write failed:', err));
    return true;
  } catch (err) {
    console.error('Failed to save active tokens:', err);
    return false;
  }
}

// Instances Persistent Database
const instancesFilePath = path.join(dataDir, 'instances.json');

// In-memory instances cache to avoid blocking disk reads during heavy concurrency
let instancesCache = null;

function loadInstances() {
  if (instancesCache) {
    return instancesCache;
  }
  try {
    if (fs.existsSync(instancesFilePath)) {
      const data = fs.readFileSync(instancesFilePath, 'utf8');
      instancesCache = JSON.parse(data);
      return instancesCache;
    }
  } catch (err) {
    console.error('Failed to load instances database:', err);
  }
  instancesCache = [];
  return instancesCache;
}

function saveInstances(instances) {
  instancesCache = instances;
  try {
    // Write asynchronously to prevent thread blocking!
    fs.promises.writeFile(instancesFilePath, JSON.stringify(instances, null, 2), 'utf8')
      .catch(err => console.error('[SYSTEM] Async instances write failed:', err));
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
    aiSystemPrompt: '',
    aiProcessReply: '',
    aiApkInstructions: '',
    aiApkPreamble: '',
    aiSmartApkEnabled: true,
    createdAt: new Date().toISOString()
  };
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

// In-memory rules cache to eliminate blockings on every WhatsApp message received
const rulesCache = {};

function loadInstanceRules(slug) {
  if (rulesCache[slug]) {
    return rulesCache[slug];
  }
  try {
    if (fs.existsSync(globalRulesFilePath)) {
      const data = fs.readFileSync(globalRulesFilePath, 'utf8');
      const parsed = JSON.parse(data);
      rulesCache[slug] = parsed;
      return parsed;
    } else {
      // Premium Migration Check: If rules_primary.json exists, copy it to rules.json to preserve user's data!
      const legacyPath = path.join(dataDir, 'rules_primary.json');
      if (fs.existsSync(legacyPath)) {
        try {
          const legacyData = fs.readFileSync(legacyPath, 'utf8');
          fs.writeFileSync(globalRulesFilePath, legacyData, 'utf8');
          const parsed = JSON.parse(legacyData);
          rulesCache[slug] = parsed;
          return parsed;
        } catch (migErr) {
          console.error('Failed to migrate legacy rules:', migErr);
        }
      }
      
      fs.writeFileSync(globalRulesFilePath, JSON.stringify(defaultRulesTemplate, null, 2), 'utf8');
      rulesCache[slug] = defaultRulesTemplate;
      return defaultRulesTemplate;
    }
  } catch (err) {
    console.error(`Failed to load global rules:`, err.message);
  }
  return [];
}

function saveInstanceRules(slug, rules) {
  let targetRules = rules;
  let targetSlug = slug;
  if (Array.isArray(slug)) {
    targetRules = slug;
    targetSlug = 'primary';
  }
  
  rulesCache[targetSlug] = targetRules;
  try {
    // Write asynchronously to prevent blocking the event loop!
    fs.promises.writeFile(globalRulesFilePath, JSON.stringify(targetRules, null, 2), 'utf8')
      .catch(err => console.error(`[SYSTEM] Async rules write failed:`, err));
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

function getRawApkPath(slug) {
  return path.join(dataDir, `latest_apk_${slug}.apk`);
}

function persistApkCache(slug, apkData) {
  try {
    const filePath = getApkCachePath(slug);
    fs.writeFileSync(filePath, JSON.stringify(apkData, null, 2), 'utf8');
    
    // Also save raw binary APK to disk for high-performance streaming
    if (apkData && apkData.data) {
      const rawPath = getRawApkPath(slug);
      const buffer = Buffer.from(apkData.data, 'base64');
      fs.writeFileSync(rawPath, buffer);
    }
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
      apkData.filename = 'istore.apk';
      latestApkCache[slug] = apkData;
      
      // Self-heal: ensure raw binary APK file exists on disk
      const rawPath = getRawApkPath(slug);
      if (!fs.existsSync(rawPath) && apkData.data) {
        const buffer = Buffer.from(apkData.data, 'base64');
        fs.writeFileSync(rawPath, buffer);
      }
      return true;
    }
  } catch (err) {
    console.error(`[SYSTEM] Failed to load APK cache for ${slug}:`, err);
  }
  return false;
}

// =============================================================
// IGNORED USERS — Bot ignore list (replaces unstable WhatsApp blocking)
// =============================================================
const ignoredUsersFilePath = path.join(dataDir, 'ignored_users.json');

function loadIgnoredUsers() {
  try {
    if (fs.existsSync(ignoredUsersFilePath)) {
      return JSON.parse(fs.readFileSync(ignoredUsersFilePath, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load ignored users:', err);
  }
  return [];
}

function saveIgnoredUser(number) {
  try {
    const list = loadIgnoredUsers();
    if (!list.includes(number)) {
      list.push(number);
      fs.writeFileSync(ignoredUsersFilePath, JSON.stringify(list, null, 2));
    }
  } catch (err) {
    console.error('Failed to save ignored user:', err);
  }
}

// =============================================================
// SPAM DETECTION — Auto-mute repeat spammers for 10 minutes
// =============================================================
// Configurable thresholds
const SPAM_MSG_LIMIT    = 5;          // messages within the window before flagging as spam
const SPAM_WINDOW_MS    = 30 * 1000;  // 30-second rolling window
const SPAM_COOLDOWN_MS  = 10 * 60 * 1000; // 10-minute mute duration

// In-memory per-instance tracking (cleared on restart — intentional, lightweight)
// spamTracker[slug][number] = [timestamp, timestamp, ...]
const spamTracker  = {};
// spamCooldowns[slug][number] = cooldownUntilTimestamp
const spamCooldowns = {};

function isSpamCoolingDown(slug, number) {
  const until = (spamCooldowns[slug] || {})[number];
  return until && Date.now() < until;
}

function recordSpamMessage(slug, number) {
  if (!spamTracker[slug])   spamTracker[slug]   = {};
  if (!spamCooldowns[slug]) spamCooldowns[slug] = {};

  const now = Date.now();
  const windowStart = now - SPAM_WINDOW_MS;

  // Keep only timestamps within the rolling window
  const timestamps = (spamTracker[slug][number] || []).filter(t => t > windowStart);
  timestamps.push(now);
  spamTracker[slug][number] = timestamps;

  if (timestamps.length >= SPAM_MSG_LIMIT) {
    // Activate cooldown
    spamCooldowns[slug][number] = now + SPAM_COOLDOWN_MS;
    spamTracker[slug][number] = []; // Reset after triggering
    return true; // Spam threshold crossed
  }
  return false; // Not yet spamming
}

function clearSpamCooldown(slug, number) {
  if (spamCooldowns[slug]) delete spamCooldowns[slug][number];
  if (spamTracker[slug])   delete spamTracker[slug][number];
}

// =============================================================================
// USER MEMORY — per-user conversation history per instance
// =============================================================
const memoryFilePath = path.join(dataDir, 'memory.json');

// In-memory caching database + debounced non-blocking write throttle
let conversationMemory = null;
let pendingMemoryWriteTimeout = null;

function loadMemory() {
  if (conversationMemory) {
    return conversationMemory;
  }
  try {
    if (fs.existsSync(memoryFilePath)) {
      const data = fs.readFileSync(memoryFilePath, 'utf8');
      conversationMemory = JSON.parse(data);
      return conversationMemory;
    }
  } catch (err) {
    console.error('Failed to load memory:', err);
  }
  conversationMemory = {};
  return conversationMemory;
}

function saveMemory(memory) {
  conversationMemory = memory;
  if (pendingMemoryWriteTimeout) return;
  
  // Throttle physical disk updates to once every 2 seconds under high-volume multi-user concurrency
  pendingMemoryWriteTimeout = setTimeout(() => {
    pendingMemoryWriteTimeout = null;
    fs.promises.writeFile(memoryFilePath, JSON.stringify(conversationMemory, null, 2), 'utf8')
      .catch(err => console.error('[SYSTEM] Async memory persist failed:', err));
  }, 2000);
}

// =============================================================
// DAILY ANALYTICS — unique users responded to per 24 hours
// =============================================================
let analyticsCache = {};
let pendingAnalyticsWriteTimeouts = {};

function loadAnalytics(slug) {
  if (analyticsCache[slug]) {
    return analyticsCache[slug];
  }
  const analyticsFile = path.join(dataDir, `analytics_${slug}.json`);
  try {
    if (fs.existsSync(analyticsFile)) {
      const data = fs.readFileSync(analyticsFile, 'utf8');
      analyticsCache[slug] = JSON.parse(data);
      return analyticsCache[slug];
    }
  } catch (err) {
    console.error(`Failed to load analytics for ${slug}:`, err);
  }
  analyticsCache[slug] = [];
  return analyticsCache[slug];
}

function saveAnalytics(slug, data) {
  analyticsCache[slug] = data;
  if (pendingAnalyticsWriteTimeouts[slug]) return;
  
  pendingAnalyticsWriteTimeouts[slug] = setTimeout(() => {
    delete pendingAnalyticsWriteTimeouts[slug];
    const analyticsFile = path.join(dataDir, `analytics_${slug}.json`);
    fs.promises.writeFile(analyticsFile, JSON.stringify(analyticsCache[slug], null, 2), 'utf8')
      .catch(err => console.error(`[SYSTEM] Async analytics write failed for ${slug}:`, err));
  }, 2000);
}

function recordUserResponse(slug, senderNumber) {
  try {
    const list = loadAnalytics(slug);
    list.push({
      timestamp: Date.now(),
      senderNumber
    });
    
    // Keep only last 7 days of entries to prevent file bloating
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const cleanList = list.filter(entry => entry.timestamp > sevenDaysAgo);
    
    saveAnalytics(slug, cleanList);
  } catch (err) {
    console.error('[SYSTEM] recordUserResponse error:', err.message);
  }
}

function generateDailyReport(slug) {
  try {
    const list = loadAnalytics(slug);
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;
    
    // Filter entries from last 24 hours
    const recentEntries = list.filter(entry => entry.timestamp > last24h);
    const repliesCount = recentEntries.length;
    
    // Count unique users and their message frequency
    const userCounts = {};
    recentEntries.forEach(entry => {
      userCounts[entry.senderNumber] = (userCounts[entry.senderNumber] || 0) + 1;
    });
    
    const uniqueUsersCount = Object.keys(userCounts).length;
    
    let details = '';
    if (uniqueUsersCount === 0) {
      details = 'No users handled in this period.';
    } else {
      details = Object.entries(userCounts)
        .map(([num, count]) => `• +${num}: ${count} reply/replies`)
        .join('\n');
    }
    
    return {
      uniqueUsersCount,
      repliesCount,
      details
    };
  } catch (err) {
    console.error(`[SYSTEM] Error generating report for ${slug}:`, err.message);
    return { uniqueUsersCount: 0, repliesCount: 0, details: `Error: ${err.message}` };
  }
}

async function sendDailyReportToAdmin(slug) {
  const listConfig = loadInstances();
  const instConfig = listConfig.find(i => i.slug === slug);
  if (!instConfig || !instConfig.adminForwardNumber) {
    const errMsg = 'Admin WhatsApp number is not configured.';
    logInstanceEvent(slug, 'system', `Daily report failed: ${errMsg}`);
    throw new Error(errMsg);
  }
  
  const client = activeClients[slug];
  if (!client || !clientStates[slug] || (clientStates[slug].status !== 'ready' && clientStates[slug].status !== 'connected')) {
    const errMsg = 'WhatsApp client is not connected.';
    logInstanceEvent(slug, 'system', `Daily report failed: ${errMsg}`);
    throw new Error(errMsg);
  }
  
  const report = generateDailyReport(slug);
  const reportMsg = `📊 *WhatsApp Bot Daily Activity Report*\n` +
                    `*Instance:* ${instConfig.name || slug}\n` +
                    `*Period:* Last 24 Hours\n\n` +
                    `👥 *Total Unique Users Responded To:* ${report.uniqueUsersCount}\n` +
                    `💬 *Total Automated Replies Sent:* ${report.repliesCount}\n\n` +
                    `📞 *Activity Details:*\n${report.details}`;
  
  try {
    const adminJid = `${instConfig.adminForwardNumber.replace(/[^0-9]/g, '')}@c.us`;
    await client.sendMessage(adminJid, reportMsg);
    logInstanceEvent(slug, 'system', `Daily activity report sent to Admin +${instConfig.adminForwardNumber}`);
    
    // Update lastReportSentTime in instances config
    const index = listConfig.findIndex(i => i.slug === slug);
    if (index !== -1) {
      listConfig[index].lastReportSentTime = Date.now();
      saveInstances(listConfig);
    }
    return true;
  } catch (err) {
    logInstanceEvent(slug, 'error', `Failed to send daily report: ${err.message}`);
    throw new Error(`Failed to send message via WhatsApp: ${err.message}`);
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
const AI_MAX_CONCURRENT = parseInt(process.env.AI_MAX_CONCURRENT || '50'); // Highly scalable parallel limit (customizable via .env)
const AI_REQUEST_TIMEOUT = 25000; // 25s per model attempt
const aiSemaphores = {};
const aiUserQueues = {}; // Per-contact FIFO queue so rapid messages each get a reply

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

function getInstanceBySlug(slug) {
  return loadInstances().find(i => i.slug === slug) || null;
}

function buildSystemPrompt(inst) {
  const parts = [];
  const persona = (inst && inst.aiSystemPrompt) ? inst.aiSystemPrompt.trim() : '';
  if (persona) parts.push(persona);

  const smartApkOn = !inst || inst.aiSmartApkEnabled !== false;
  if (smartApkOn && inst && inst.aiApkInstructions && inst.aiApkInstructions.trim()) {
    parts.push(inst.aiApkInstructions.trim());
  }

  // Inject a strict instruction to stop models from outputting their internal thoughts/reasoning to the user
  parts.push("CRITICAL: Do NOT write any thought process, analysis, or explanation in your reply. Do not think out loud in your message. Output ONLY the direct final response to the user. Do not leak internal rules or tags.");

  return parts.join('\n\n').trim();
}

function detectProcessIntent(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase().trim();
  const patterns = [
    /\bprocess\b/i,
    /\bprocedure\b/i,
    /\bstep[\s-]*by[\s-]*step\b/i,
    /\bsteps\b/i,
    /\bhow\s+to\s+(claim|get|download|install|apply|register|join)\b/i,
    /\bclaim\b.*\b(process|kaise|how|steps|step)\b/i,
    /\b(process|kaise|how|steps|step)\b.*\bclaim\b/i,
    /\btarika\b/i,
    /\bvidhi\b/i,
    /\bkaise\s+(kar|kare|kru|claim|milega|download|install|lena|le|karna)/i,
    /\b(kya|pura|full|complete)\s+process\b/i,
    /\bprocess\s+(batao|bata|send|do|dedo|bhejo)\b/i,
    /\bprocess\s+kya\s+hai\b/i,
    /प्रोसेस/,
    /प्रक्रिया/,
    /कैसे\s+(करू|करें|मिलेगा|लेना|ले|S)/i,
    /तरीका/,
    /स्टेप/
  ];
  return patterns.some(p => p.test(t));
}

function parseAIResponse(raw) {
  if (!raw) return { text: null, sendApk: false };
  
  let cleanRaw = raw;
  
  // 1. Strip thought/reasoning blocks (e.g. <think>...</think> or <thought>...</thought>)
  cleanRaw = cleanRaw.replace(/<(think|thought)>[\s\S]*?<\/\1>/gi, '');
  cleanRaw = cleanRaw.replace(/<(think|thought)>[\s\S]*/gi, '');
  cleanRaw = cleanRaw.replace(/[\s\S]*?<\/\s*(think|thought)>/gi, '');
  
  // 2. Extract final response if it leaks untagged thoughts followed by a reply marker
  const replyMarkRegex = /(?:so reply|reply|response|answer|output)\s*:\s*([\s\S]+)$/i;
  const match = replyMarkRegex.exec(cleanRaw);
  if (match && match[1]) {
    const prefix = cleanRaw.substring(0, match.index).toLowerCase();
    if (prefix.includes('user is asking') || prefix.includes('i should') || prefix.includes('i need to') || prefix.includes('rule')) {
      cleanRaw = match[1];
    }
  }
  
  cleanRaw = cleanRaw.trim();
  const sendApk = /\[SEND_APK\]/i.test(cleanRaw);
  const text = cleanRaw.replace(/\n?\[SEND_APK\]\s*/gi, '').trim();
  return { text: text || null, sendApk };
}

function detectApkIntent(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase().trim();
  const patterns = [
    /\bapk\b/i,
    /\b(app|application)\b.*\b(link|download|send|dedo|bhejo|chahiye|milega|do)\b/i,
    /\b(link|download|send|dedo|bhejo|chahiye)\b.*\b(app|application|apk)\b/i,
    /\bdownload\b.*\b(app|apk)\b/i,
    /\binstall\b.*\b(app|apk)?\b/i,
    /\bapp\b.*\b(install|download|link)\b/i,
    /\bget\b.*\b(app|apk)\b/i,
    /\b(want|need|chahiye|dedo|bhej|send)\b.*\b(app|apk)\b/i,
    /ऐप\s*(भेज|दो|लिंक|डाउनलोड|चाहिए)/i,
    /(भेज|दो|send).*(ऐप|apk)/i,
    /डाउनलोड.*(ऐप|apk)/i
  ];
  return patterns.some(p => p.test(t));
}

async function sendCachedApkReply(slug, msg, senderNumber) {
  const apk = latestApkCache[slug];
  if (!apk || !apk.data) {
    logInstanceEvent(slug, 'system', `Smart APK requested but cache is empty for +${senderNumber}`);
    try {
      await msg.reply("❌ App file isn't ready yet — please wait a moment, sir! 🙏");
      clientStates[slug].stats.replies++;
      io.to(`instance_${slug}`).emit('stat_increment', 'replies');
      recordUserResponse(slug, senderNumber);
    } catch {}
    return false;
  }

  try {
    const chat = await msg.getChat();
    await chat.sendStateTyping();
    await new Promise(resolve => setTimeout(resolve, 1500));
    const media = new MessageMedia(apk.mimetype, apk.data, apk.filename);
    await msg.reply(media);
    logInstanceEvent(slug, 'send', `Smart APK dispatched to +${senderNumber}: "${apk.filename}"`);
    clientStates[slug].stats.replies++;
    io.to(`instance_${slug}`).emit('stat_increment', 'replies');
    recordUserResponse(slug, senderNumber);
    return true;
  } catch (err) {
    logInstanceEvent(slug, 'error', `Smart APK send failed for +${senderNumber}: ${err.message}`);
    return false;
  }
}

const pendingDebounces = {};

function enqueueAIReply(slug, senderNumber, msg) {
  const userLockKey = `${slug}:${senderNumber}`;
  
  if (!pendingDebounces[userLockKey]) {
    pendingDebounces[userLockKey] = {
      messages: []
    };
  }
  
  pendingDebounces[userLockKey].messages.push(msg);
  
  if (pendingDebounces[userLockKey].timer) {
    clearTimeout(pendingDebounces[userLockKey].timer);
  }
  
  pendingDebounces[userLockKey].timer = setTimeout(() => {
    const data = pendingDebounces[userLockKey];
    delete pendingDebounces[userLockKey];
    
    if (!data || data.messages.length === 0) return;
    
    const targetMsg = data.messages[0];
    if (data.messages.length > 1) {
      const combinedBody = data.messages.map(m => m.body).filter(Boolean).join('\n');
      targetMsg.body = combinedBody;
    }
    
    if (!aiUserQueues[userLockKey]) {
      aiUserQueues[userLockKey] = { processing: false, queue: [] };
    }
    aiUserQueues[userLockKey].queue.push(targetMsg);
    processAIUserQueue(userLockKey).catch(err => {
      logInstanceEvent(slug, 'error', `AI user queue processor failed: ${err.message}`);
    });
  }, 2000);
}

async function processAIUserQueue(userLockKey) {
  const q = aiUserQueues[userLockKey];
  if (!q || q.processing || q.queue.length === 0) return;

  const [slug, senderNumber] = userLockKey.split(':');
  q.processing = true;

  while (q.queue.length > 0) {
    const msg = q.queue.shift();
    const inst = getInstanceBySlug(slug);
    const smartApkOn = !inst || inst.aiSmartApkEnabled !== false;

    const processReply = inst && inst.aiProcessReply ? inst.aiProcessReply.trim() : '';
    if (processReply && detectProcessIntent(msg.body)) {
      logInstanceEvent(slug, 'system', `Process/steps request detected — sending configured process reply to +${senderNumber}`);
      try {
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        await new Promise(resolve => setTimeout(resolve, 1500));
        await msg.reply(processReply);
        logInstanceEvent(slug, 'send', `Process reply sent to +${senderNumber}`);
        addToMemory(slug, senderNumber, 'user', msg.body);
        addToMemory(slug, senderNumber, 'assistant', processReply);
        clientStates[slug].stats.replies++;
        io.to(`instance_${slug}`).emit('stat_increment', 'replies');
        recordUserResponse(slug, senderNumber);
      } catch (err) {
        logInstanceEvent(slug, 'error', `Process reply failed for +${senderNumber}: ${err.message}`);
      }
      continue;
    }

    logInstanceEvent(slug, 'system', `No static keyword matched. Querying AI Core Agent...`);

    let history = [];
    try {
      const chat = await msg.getChat();
      const rawMessages = await chat.fetchMessages({ limit: 12 });
      history = rawMessages
        .filter(m => m.id._serialized !== msg.id._serialized && m.body)
        .map(m => ({
          role: m.fromMe ? 'assistant' : 'user',
          content: m.body
        }));
      logInstanceEvent(slug, 'system', `Retrieved ${history.length} messages from actual WhatsApp chat history.`);
    } catch (err) {
      logInstanceEvent(slug, 'error', `Failed to fetch actual chat history: ${err.message}. Falling back to in-memory history.`);
      history = getConversationHistory(slug, senderNumber)
        .filter(m => m.role !== 'system')
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }));
    }

    await acquireAISlot(slug);
    try {
      const aiResult = await generateAIResponse(slug, msg.body, history);
      const shouldSendApk = smartApkOn && aiResult && (aiResult.sendApk || detectApkIntent(msg.body));
      let replyText = aiResult?.text || null;

      if (shouldSendApk && !replyText) {
        const preamble = inst && inst.aiApkPreamble ? inst.aiApkPreamble.trim() : '';
        replyText = preamble || null;
      }

      if (replyText) {
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        await new Promise(resolve => setTimeout(resolve, 1500));

        await msg.reply(replyText);
        logInstanceEvent(slug, 'send', `AI Smart Reply to +${senderNumber}: "${replyText.replace(/\n/g, ' ')}"`);

        addToMemory(slug, senderNumber, 'user', msg.body);
        addToMemory(slug, senderNumber, 'assistant', replyText);

        clientStates[slug].stats.replies++;
        io.to(`instance_${slug}`).emit('stat_increment', 'replies');
        recordUserResponse(slug, senderNumber);
      } else if (!shouldSendApk) {
        logInstanceEvent(slug, 'system', `AI Core returned an empty response. No reply dispatched.`);
      }

      if (shouldSendApk) {
        if (aiResult?.sendApk) {
          logInstanceEvent(slug, 'system', `AI tagged [SEND_APK] — attaching app file for +${senderNumber}`);
        } else {
          logInstanceEvent(slug, 'system', `App intent detected — attaching APK for +${senderNumber}`);
        }
        await sendCachedApkReply(slug, msg, senderNumber);
      }
    } catch (err) {
      logInstanceEvent(slug, 'error', `AI Auto-responder routine failed: ${err.message}`);
    } finally {
      releaseAISlot(slug);
    }
  }

  q.processing = false;
  if (q.queue.length === 0) {
    delete aiUserQueues[userLockKey];
  } else {
    processAIUserQueue(userLockKey).catch(err => {
      logInstanceEvent(slug, 'error', `AI user queue processor failed: ${err.message}`);
    });
  }
}

// =============================================================
// CONCURRENT API KEY REGISTRY WITH FAILOVER & COOLDOWN (Hugging Face + OpenRouter + Groq)
// =============================================================
const cooldownsFilePath = path.join(dataDir, 'cooldowns.json');

function loadCooldowns() {
  try {
    if (fs.existsSync(cooldownsFilePath)) {
      return JSON.parse(fs.readFileSync(cooldownsFilePath, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load cooldowns:', err);
  }
  return {};
}

function saveCooldowns(cooldowns) {
  try {
    fs.writeFileSync(cooldownsFilePath, JSON.stringify(cooldowns, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save cooldowns:', err);
  }
}

// Global registry of all keys: keyString -> { provider, key, busy, cooldownUntil }
let apiKeysRegistry = {};
const pendingKeyRequests = [];

function initApiKeysRegistry() {
  const cooldowns = loadCooldowns();
  const now = Date.now();
  
  // Clean up expired cooldowns
  for (const k in cooldowns) {
    if (cooldowns[k] < now) {
      delete cooldowns[k];
    }
  }
  saveCooldowns(cooldowns);

  apiKeysRegistry = {};

  // 1. Load HuggingFace keys
  const hfKeysStr = process.env.HF_TOKENS || process.env.HF_TOKEN || '';
  const hfKeys = hfKeysStr.split(/[\s,;]+/).map(k => k.trim()).filter(Boolean);
  hfKeys.forEach(key => {
    apiKeysRegistry[key] = {
      provider: 'huggingface',
      key,
      busy: false,
      cooldownUntil: cooldowns[key] || 0
    };
  });

  // 2. Load OpenRouter/Groq keys
  const orKeysStr = process.env.LLM_API_KEYS || process.env.LLM_API_KEY || '';
  const orKeys = orKeysStr.split(/[\s,;]+/).map(k => k.trim()).filter(Boolean);
  const provider = process.env.LLM_PROVIDER || 'openrouter';
  orKeys.forEach(key => {
    apiKeysRegistry[key] = {
      provider,
      key,
      busy: false,
      cooldownUntil: cooldowns[key] || 0
    };
  });
}

function initApiKeysRegistryIfEmpty() {
  if (Object.keys(apiKeysRegistry).length === 0) {
    initApiKeysRegistry();
  }
}

// Initialize the API keys registry on startup
initApiKeysRegistry();

function putKeyOnCooldown(keyString) {
  const cooldowns = loadCooldowns();
  const cooldownUntil = Date.now() + 24 * 60 * 60 * 1000; // 24 hours cooldown
  cooldowns[keyString] = cooldownUntil;
  saveCooldowns(cooldowns);
  
  if (apiKeysRegistry[keyString]) {
    apiKeysRegistry[keyString].cooldownUntil = cooldownUntil;
  }
}

function reserveApiKey(attemptedKeys = new Set()) {
  const now = Date.now();
  initApiKeysRegistryIfEmpty();
  
  // Filter active keys that have not been attempted in this request
  const activeKeys = Object.values(apiKeysRegistry).filter(k => k.cooldownUntil < now && !attemptedKeys.has(k.key));
  
  // Find non-busy available keys
  const availableKeys = activeKeys.filter(k => !k.busy);
  if (availableKeys.length === 0) {
    return null;
  }
  
  // Priority 1: Other (OpenRouter, Groq)
  const otherKey = availableKeys.find(k => k.provider !== 'huggingface');
  if (otherKey) {
    otherKey.busy = true;
    return otherKey;
  }
  
  // Priority 2: Hugging Face (HF)
  const hfKey = availableKeys.find(k => k.provider === 'huggingface');
  if (hfKey) {
    hfKey.busy = true;
    return hfKey;
  }
  
  return null;
}

function acquireApiKey(attemptedKeys) {
  const key = reserveApiKey(attemptedKeys);
  if (key) {
    return Promise.resolve(key);
  }
  return new Promise(resolve => {
    pendingKeyRequests.push({ resolve, attemptedKeys });
  });
}

function releaseApiKey(keyObj) {
  if (keyObj) {
    keyObj.busy = false;
  }
  
  if (pendingKeyRequests.length > 0) {
    let foundIndex = -1;
    for (let i = 0; i < pendingKeyRequests.length; i++) {
      const req = pendingKeyRequests[i];
      const nextKey = reserveApiKey(req.attemptedKeys);
      if (nextKey) {
        foundIndex = i;
        req.resolve(nextKey);
        break;
      }
    }
    if (foundIndex !== -1) {
      pendingKeyRequests.splice(foundIndex, 1);
    }
  }
}

// Native LLM Requester with global concurrency key load balancing, Hugging Face priority, and 24-hr cooldown
async function generateAIResponse(slug, userMessage, history = []) {
  const inst = getInstanceBySlug(slug);
  const systemPrompt = buildSystemPrompt(inst);
  if (!systemPrompt) {
    logInstanceEvent(slug, 'error', 'AI enabled but persona is empty — set AI Persona in the dashboard.');
    return null;
  }

  // Fallback model chains
  const hfModels = [
    process.env.HF_MODEL || 'deepseek-ai/DeepSeek-V3',
    'deepseek-ai/DeepSeek-V3',
    'meta-llama/Llama-3.3-70B-Instruct',
    'Qwen/Qwen2.5-72B-Instruct'
  ];

  const openrouterModels = [
    process.env.LLM_MODEL || 'openrouter/free',
    'openrouter/free',
    'openai/gpt-oss-120b:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
    'meta-llama/llama-3.3-70b-instruct:free'
  ];

  const groqModels = [
    process.env.LLM_MODEL || 'llama3-8b-8192',
    'gemma2-9b-it',
    'gemma-7b-it'
  ];

  // Initialize registry if needed
  initApiKeysRegistryIfEmpty();

  const totalKeysCount = Object.keys(apiKeysRegistry).length;
  if (totalKeysCount === 0) {
    logInstanceEvent(slug, 'error', 'AI Responder triggered but no API keys (HF_TOKEN or LLM_API_KEYS) are configured in .env!');
    return null;
  }

  let attempts = 0;
  const maxAttempts = Math.max(totalKeysCount * 2, 10);
  const attemptedKeys = new Set();

  while (attempts < maxAttempts) {
    attempts++;
    
    // Check if we have already attempted all active keys
    const now = Date.now();
    const activeKeys = Object.values(apiKeysRegistry).filter(k => k.cooldownUntil < now);
    const untriedKeys = activeKeys.filter(k => !attemptedKeys.has(k.key));
    if (untriedKeys.length === 0) {
      logInstanceEvent(slug, 'system', 'All available active LLM keys have been attempted and failed for this request.');
      break;
    }

    // Acquire key from pool (waits/queues if all are busy or cooldowned)
    const keyObj = await acquireApiKey(attemptedKeys);
    const activeApiKey = keyObj.key;
    const provider = keyObj.provider;
    const maskedKey = activeApiKey.substring(0, 8) + '...' + activeApiKey.substring(activeApiKey.length - 4);
    
    // Track that we are attempting this key in this request
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

    let success = false;
    let content = null;

    for (const model of models) {
      try {
        logInstanceEvent(slug, 'system', `AI query [${provider}] -> ${model} using key ${maskedKey}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT);

        const response = await fetch(url, {
          signal: controller.signal,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeApiKey}`
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

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errText = await response.text();
          logInstanceEvent(slug, 'error', `AI Query failed on [${provider}] (${response.status}) using ${model}: ${errText.substring(0, 120)}`);
          
          const isKeyError = response.status === 400 || response.status === 401 || response.status === 403 || response.status === 429 || response.status === 402;
          const isQuotaMsg = /quota|limit|exhausted|insufficient|credit|balance/i.test(errText);
          
          if (isKeyError || isQuotaMsg) {
            logInstanceEvent(slug, 'system', `Key ${maskedKey} has encountered a fatal key/quota error. Cooldown triggered for 24 hours.`);
            putKeyOnCooldown(activeApiKey);
            break; // Break model loop to switch to next key
          }
          continue; // Try next model on this key
        }

        const responseJson = await response.json();
        content = responseJson?.choices?.[0]?.message?.content?.trim();
        if (content) {
          logInstanceEvent(slug, 'system', `AI replied via "${model}" [using ${provider}]`);
          success = true;
          break; // Exit model loop
        }
      } catch (err) {
        logInstanceEvent(slug, 'error', `AI query error on [${provider}] [${model}]: ${err.message}`);
        continue;
      }
    }

    releaseApiKey(keyObj);

    if (success && content) {
      return parseAIResponse(content);
    }

    // Check if we have any active non-cooldown keys remaining at all
    const nowCheck = Date.now();
    const activeKeysCount = Object.values(apiKeysRegistry).filter(k => k.cooldownUntil < nowCheck).length;
    if (activeKeysCount === 0) {
      logInstanceEvent(slug, 'error', 'All configured LLM keys are currently on a 24-hour cooldown. No active keys available.');
      return null;
    }
  }

  logInstanceEvent(slug, 'error', 'AI Query failed after maximum key failover attempts.');
  return null;
}

// Voice Note Transcription engine — uses a local, free, offline Python-based SpeechRecognition script
// No API keys or external subscription/billing tokens are required!
async function transcribeAudio(slug, media) {
  const { exec } = require('child_process');
  
  // 1. Try Hugging Face Whisper API first if key is available
  initApiKeysRegistryIfEmpty();
  const now = Date.now();
  const hfKeys = Object.values(apiKeysRegistry).filter(k => k.provider === 'huggingface' && k.cooldownUntil < now);
  
  if (hfKeys.length > 0) {
    const selectedKeyObj = hfKeys[0];
    const selectedKey = selectedKeyObj.key;
    
    try {
      logInstanceEvent(slug, 'system', `Hugging Face token available. Requesting OpenAI Whisper-Large-V3-Turbo API...`);
      const modelUrl = 'https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo';
      
      const response = await fetch(modelUrl, {
        headers: { 
          Authorization: `Bearer ${selectedKey}`,
          'Content-Type': media.mimetype || 'audio/ogg'
        },
        method: 'POST',
        body: Buffer.from(media.data, 'base64')
      });

      if (response.ok) {
        const result = await response.json();
        if (result && result.text) {
          logInstanceEvent(slug, 'system', `Hugging Face Whisper API transcription completed successfully!`);
          return result.text.trim();
        }
      } else {
        const errorText = await response.text();
        logInstanceEvent(slug, 'system', `Hugging Face Whisper API returned error status ${response.status}: ${errorText}`);
        
        // Put key on cooldown if rate-limited or unauthorized
        if (response.status === 429 || response.status === 401 || response.status === 403) {
          putKeyOnCooldown(selectedKey);
          logInstanceEvent(slug, 'system', `Hugging Face token put on 24h cooldown due to API response.`);
        }
      }
    } catch (hfErr) {
      logInstanceEvent(slug, 'system', `Failed to transcribe using Hugging Face Whisper API: ${hfErr.message}`);
    }
    
    logInstanceEvent(slug, 'system', `Hugging Face Whisper API failed. Falling back to local offline Google engine...`);
  } else {
    logInstanceEvent(slug, 'system', `No active Hugging Face tokens available. Using local offline Google engine...`);
  }

  // 2. Fallback to Local Offline Python-based Google Speech Engine
  let format = 'ogg';
  if (media.mimetype) {
    const mainMime = media.mimetype.split(';')[0].toLowerCase();
    if (mainMime.includes('wav')) format = 'wav';
    else if (mainMime.includes('mp3')) format = 'mp3';
    else if (mainMime.includes('aac')) format = 'aac';
    else if (mainMime.includes('m4a')) format = 'm4a';
    else if (mainMime.includes('webm')) format = 'webm';
    else if (mainMime.includes('ogg')) format = 'ogg';
  }

  // Create a unique temporary audio file in data directory
  const tempId = Math.random().toString(36).substring(7);
  const tempFile = path.join(dataDir, `temp_transcribe_${slug}_${tempId}.${format}`);
  
  try {
    logInstanceEvent(slug, 'system', `Saving voice note buffer to temporary file: "${path.basename(tempFile)}"`);
    fs.writeFileSync(tempFile, Buffer.from(media.data, 'base64'));

    logInstanceEvent(slug, 'system', `Executing local Python offline SpeechRecognition script...`);
    
    const transcription = await new Promise((resolve, reject) => {
      // Support Python execution dynamically (configured in .env, falling back to process defaults)
      const pythonCmd = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
      const cmd = `${pythonCmd} transcribe.py "${tempFile}"`;
      
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr.trim() || error.message));
        }
        resolve(stdout.trim());
      });
    });

    if (transcription) {
      logInstanceEvent(slug, 'system', `Local offline Google transcription completed successfully!`);
      return transcription;
    } else {
      logInstanceEvent(slug, 'system', `Local transcription returned empty text (audio might be silent or unclear).`);
      return null;
    }
  } catch (err) {
    logInstanceEvent(slug, 'error', `Local offline transcription failed: ${err.message}`);
    return null;
  } finally {
    // Force cleanup of temporary files to prevent disk leakages
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (cleanupErr) {
        console.error(`[SYSTEM] Failed to clean up temp transcribe file: ${cleanupErr.message}`);
      }
    }
  }
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
        '--disable-field-trial-config',
        '--js-flags=--max-old-space-size=128' // Crucial RAM tuner: Limits V8 engine memory heap in headless Chrome renderers (saves gigabytes of RAM on 8GB VPS!)
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

    // Check if user is in the bot's ignore list
    const senderNumber = msg.from.split('@')[0];
    const ignoredList = loadIgnoredUsers();
    if (ignoredList.includes(senderNumber)) {
      logInstanceEvent(slug, 'system', `Ignored message from blacklisted/ignored user: +${senderNumber}`);
      try {
        const chat = await msg.getChat();
        await chat.delete();
      } catch (err) {
        logInstanceEvent(slug, 'error', `Failed to auto-delete chat for ignored user +${senderNumber}: ${err.message}`);
      }
      return; // Ignore and halt completely!
    }

    // ── SPAM DETECTION ──────────────────────────────────────────────────────
    // If user is currently in a spam cooldown → silently ignore the message
    if (isSpamCoolingDown(slug, senderNumber)) {
      logInstanceEvent(slug, 'system', `⏳ Spam cooldown active for +${senderNumber}. Message silently ignored.`);
      return;
    }

    // Record this message and check if threshold crossed
    const justTriggeredSpam = recordSpamMessage(slug, senderNumber);
    if (justTriggeredSpam) {
      logInstanceEvent(slug, 'system', `🚫 Spam detected from +${senderNumber}. Sending warning and muting for 10 minutes.`);
      try {
        const spamWarning = `⚠️ You've been sending too many messages too quickly.\n\nPlease wait *10 minutes* before sending more messages. Our system has temporarily paused replies to your number.`;
        await msg.reply(spamWarning);
      } catch (err) {
        logInstanceEvent(slug, 'error', `Failed to send spam warning to +${senderNumber}: ${err.message}`);
      }
      return; // Stop processing this message
    }
    // ────────────────────────────────────────────────────────────────────────

    // Auto-Ignore and Delete User on Specific Trigger Text
    const listConfig = loadInstances();
    const instConfig = listConfig.find(i => i.slug === slug);
    if (instConfig && instConfig.blockTriggerText && msg.body) {
      const triggerClean = instConfig.blockTriggerText.trim().toLowerCase();
      const incomingClean = msg.body.trim().toLowerCase();
      if (triggerClean && incomingClean === triggerClean) {
        const senderNumber = msg.from.split('@')[0];
        logInstanceEvent(slug, 'system', `🚨 Trigger matched block phrase: "${msg.body}". Adding user +${senderNumber} to ignore list and deleting chat...`);
        try {
          saveIgnoredUser(senderNumber);
          const chat = await msg.getChat();
          await chat.delete();
          logInstanceEvent(slug, 'system', `🚨 Successfully added user +${senderNumber} to ignore list and deleted chat.`);
        } catch (err) {
          logInstanceEvent(slug, 'error', `Failed to ignore/delete chat for user +${senderNumber}: ${err.message}`);
        }
        return; // Halted completely
      }
    }

    // Detect and Cache APK Uploads in Any Chat (Group or Direct Messages)
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          const isApk = (media.filename && media.filename.toLowerCase().endsWith('.apk')) || 
                        (media.mimetype && media.mimetype === 'application/vnd.android.package-archive');
          
          if (isApk) {
            const originalFilename = media.filename || 'latest_application.apk';
            const resolvedFilename = 'istore.apk';
            
            // Security: Verify group/chat name against .env restrictions before caching
            const allowedGroupsStr = process.env.ALLOWED_APK_GROUPS || '';
            const allowedGroups = allowedGroupsStr.split(',').map(g => g.trim()).filter(Boolean);
            
            if (allowedGroups.length > 0) {
              const chat = await msg.getChat();
              const chatName = chat.name || '';
              const isAllowed = allowedGroups.some(g => g.toLowerCase() === chatName.toLowerCase());
              
              if (!isAllowed) {
                logInstanceEvent(slug, 'error', `Blocked unauthorized APK upload ("${originalFilename}") from chat: "${chatName}"`);
                return;
              }
            }
            
            logInstanceEvent(slug, 'system', `APK upload detected: "${originalFilename}" -> Auto-renamed to "${resolvedFilename}"`);
            
            latestApkCache[slug] = {
              mimetype: media.mimetype || 'application/vnd.android.package-archive',
              data: media.data,
              filename: resolvedFilename,
              uploadedBy: msg._data.notifyName || 'Unknown Contact',
              uploadedAt: new Date().toISOString()
            };
            
            persistApkCache(slug, latestApkCache[slug]);
            
            // Auto-send confirmation response to the chat
            await msg.reply(`✅ *Latest APK Received & Cached!*\n\nOriginal Name: \`${originalFilename}\`\nSaved As: \`${resolvedFilename}\`\nSize: \`${(media.data.length * 0.75 / 1024 / 1024).toFixed(2)} MB\`\n\nUsers can now request this APK by replying with *apk* or triggering matching auto-reply rules!`);
            logInstanceEvent(slug, 'system', `APK saved to memory & disk. Auto-reply sent.`);
            
            // Notify active dashboard sockets that a new APK is cached
            io.to(`instance_${slug}`).emit('apk_cached', {
              filename: resolvedFilename,
              uploadedBy: latestApkCache[slug].uploadedBy,
              uploadedAt: latestApkCache[slug].uploadedAt,
              size: `${(media.data.length * 0.75 / 1024 / 1024).toFixed(2)} MB`
            });
          }
        }
      } catch (err) {
        logInstanceEvent(slug, 'error', `Failed to process APK upload: ${err.message}`);
      }
    }

    // Auto-forward incoming images to Admin if configured
    if (msg.hasMedia && msg.type === 'image') {
      if (instConfig && instConfig.adminForwardNumber) {
        try {
          const senderNumber = msg.from.split('@')[0];
          logInstanceEvent(slug, 'system', `Image received from +${senderNumber}. Forwarding to Admin +${instConfig.adminForwardNumber}...`);
          const media = await msg.downloadMedia();
          if (media && media.data) {
            const caption = `📸 *Image Received*\n*From:* +${senderNumber}\n*Message:* ${msg.body || 'No caption'}`;
            await client.sendMessage(`${instConfig.adminForwardNumber.replace(/[^0-9]/g, '')}@c.us`, media, { caption });
            logInstanceEvent(slug, 'system', `Image successfully forwarded to Admin +${instConfig.adminForwardNumber}.`);
          }
        } catch (err) {
          logInstanceEvent(slug, 'error', `Failed to forward image to Admin: ${err.message}`);
        }
      }
      return; // Ignore image captions completely; do not trigger AI or rules
    }

    // Auto-transcribe voice and audio messages to text
    let isVoiceNote = false;
    let transcribedText = '';
    
    if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
      const senderNumber = msg.from.split('@')[0];
      try {
        logInstanceEvent(slug, 'system', `Voice note received from +${senderNumber}. Commencing local offline auto-transcription...`);
        const media = await msg.downloadMedia();
        if (media && media.data) {
          transcribedText = await transcribeAudio(slug, media);
          if (transcribedText) {
            msg.body = transcribedText;
            isVoiceNote = true;
          } else {
            logInstanceEvent(slug, 'error', `Local offline transcription returned empty text for +${senderNumber}.`);
          }
        }
      } catch (err) {
        logInstanceEvent(slug, 'error', `Voice note transcription failed: ${err.message}`);
      }
    }

    // Return early if message contains no text content (e.g. captionless images/documents)
    if (!msg.body) return;

    const senderName = msg._data.notifyName || 'Unknown Contact';
    
    clientStates[slug].stats.received++;
    io.to(`instance_${slug}`).emit('stat_increment', 'received');
    
    const logTag = isVoiceNote ? ' [🎙️ Voice Note]' : '';
    logInstanceEvent(slug, 'receive', `From "${senderName}" (+${senderNumber})${logTag}: "${msg.body}"`);

    const rules = loadInstanceRules(slug);
    const incomingText = msg.body.toLowerCase().trim();
    
    const listForAi = loadInstances();
    const instForAi = listForAi.find(i => i.slug === slug);
    const aiHandlesApk = instForAi && instForAi.aiEnabled && (process.env.LLM_API_KEYS || process.env.LLM_API_KEY || process.env.HF_TOKENS || process.env.HF_TOKEN);

    // Fast APK keyword path (skipped when AI is on — AI sends APK with persona reply)
    const isApkKeyword = incomingText === 'apk' || incomingText === 'get apk' || incomingText === 'download apk' || incomingText === 'latest apk';
    if (isApkKeyword && !aiHandlesApk) {
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
          recordUserResponse(slug, senderNumber);
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
          // Parse all text replies (supporting both array and string split by |||)
          let textReplies = [];
          if (Array.isArray(rule.replies)) {
            textReplies = rule.replies;
          } else if (rule.reply) {
            textReplies = rule.reply.split('|||').map(r => r.trim()).filter(Boolean);
          } else {
            textReplies = [];
          }

          // Shuffled Mode (Random Selection): Select exactly ONE reply from the list!
          if (rule.replyMode === 'random' && textReplies.length > 0) {
            const originalLength = textReplies.length;
            const randomIndex = Math.floor(Math.random() * originalLength);
            const chosenText = textReplies[randomIndex];
            textReplies = [chosenText]; // Override array to only send the chosen one!
            logInstanceEvent(slug, 'system', `Shuffled Multi-Reply: Randomly selected reply #${randomIndex + 1} of ${originalLength}`);
          }

          // Send each text reply sequentially
          for (let i = 0; i < textReplies.length; i++) {
            let replyText = textReplies[i];
            
            // Re-simulate typing delay before each sequential message
            try {
              const chat = await msg.getChat();
              await chat.sendStateTyping();
            } catch {}
            
            // Small stagger delay between sequential text replies
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 1500));
            }

            if (rule.format === 'buttons' && rule.buttons && rule.buttons.length > 0 && i === textReplies.length - 1) {
              const menuButtons = new Buttons(replyText, rule.buttons.map(b => ({ body: b.body, id: b.id })));
              await msg.reply(menuButtons);
            } else {
              await msg.reply(replyText);
            }

            logInstanceEvent(slug, 'send', `Replied sequentially [${i + 1}/${textReplies.length}] to +${senderNumber}: "${replyText.substring(0, 80)}"`);
            
            clientStates[slug].stats.replies++;
            io.to(`instance_${slug}`).emit('stat_increment', 'replies');
            recordUserResponse(slug, senderNumber);
          }

          // If sendApk option is active, automatically send the cached APK file next!
          if (rule.sendApk) {
            const apk = latestApkCache[slug];
            if (apk && apk.data) {
              try {
                const chat = await msg.getChat();
                await chat.sendStateTyping();
              } catch {}
              
              // Wait 1.5s before attaching APK
              await new Promise(resolve => setTimeout(resolve, 1500));

              logInstanceEvent(slug, 'system', `Auto-attaching APK file for rule "${rule.trigger}" to +${senderNumber}...`);
              const media = new MessageMedia(apk.mimetype, apk.data, apk.filename);
              await msg.reply(media);

              logInstanceEvent(slug, 'send', `Successfully dispatched APK file "${apk.filename}" for rule "${rule.trigger}" to +${senderNumber}`);
              
              clientStates[slug].stats.replies++;
              io.to(`instance_${slug}`).emit('stat_increment', 'replies');
              recordUserResponse(slug, senderNumber);
            } else {
              logInstanceEvent(slug, 'system', `Rule triggered APK attachment, but no APK is cached for instance "${slug}"`);
            }
          }
        };

        try {
          const chat = await msg.getChat();
          await chat.sendStateTyping();

          setTimeout(async () => {
            try {
              await sendReply();
            } catch (replyErr) {
              logInstanceEvent(slug, 'error', `Sequential auto-reply dispatch failed: ${replyErr.message}`);
            }
          }, delay);
        } catch (chatErr) {
          logInstanceEvent(slug, 'error', `Typing simulator failure: ${chatErr.message}`);
          await sendReply().catch(err => logInstanceEvent(slug, 'error', `Backup sequential dispatch failed: ${err.message}`));
        }
        break;
      }
    }

    // AI Smart Auto-Responder Fallback (includes smart APK delivery)
    if (!ruleMatched) {
      if (aiHandlesApk) {
        enqueueAIReply(slug, senderNumber, msg);
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
  const {
    name,
    aiEnabled,
    aiSystemPrompt,
    aiProcessReply,
    aiApkInstructions,
    aiApkPreamble,
    aiSmartApkEnabled,
    adminForwardNumber,
    blockTriggerText
  } = req.body;

  const list = loadInstances();
  const index = list.findIndex(inst => inst.slug === slug);
  if (index === -1) {
    return res.status(404).json({ error: 'Bot instance not found.' });
  }

  if (name !== undefined) list[index].name = name.trim();
  if (aiEnabled !== undefined) list[index].aiEnabled = !!aiEnabled;
  if (aiSystemPrompt !== undefined) list[index].aiSystemPrompt = aiSystemPrompt.trim();
  if (aiProcessReply !== undefined) list[index].aiProcessReply = aiProcessReply.trim();
  if (aiApkInstructions !== undefined) list[index].aiApkInstructions = aiApkInstructions.trim();
  if (aiApkPreamble !== undefined) list[index].aiApkPreamble = aiApkPreamble.trim();
  if (aiSmartApkEnabled !== undefined) list[index].aiSmartApkEnabled = !!aiSmartApkEnabled;
  if (adminForwardNumber !== undefined) list[index].adminForwardNumber = adminForwardNumber.trim();
  if (blockTriggerText !== undefined) list[index].blockTriggerText = blockTriggerText.trim();

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
    aiSystemPrompt: inst ? (inst.aiSystemPrompt || '') : '',
    aiProcessReply: inst ? (inst.aiProcessReply || '') : '',
    aiApkInstructions: inst ? (inst.aiApkInstructions || '') : '',
    aiApkPreamble: inst ? (inst.aiApkPreamble || '') : '',
    aiSmartApkEnabled: inst ? inst.aiSmartApkEnabled !== false : true,
    adminForwardNumber: inst && inst.adminForwardNumber ? inst.adminForwardNumber : '',
    blockTriggerText: inst && inst.blockTriggerText ? inst.blockTriggerText : '',
    downloadPort: process.env.APK_PORT || '3005'
  });
});

app.post('/api/instances/:slug/send-report', authenticateToken, async (req, res) => {
  const slug = req.params.slug.trim().toLowerCase();
  try {
    await sendDailyReportToAdmin(slug);
    res.json({ success: true, message: 'Activity report successfully sent to admin.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/rules', authenticateToken, requireInstance, (req, res) => {
  res.json(loadInstanceRules(req.instanceSlug));
});

app.post('/api/rules', authenticateToken, requireInstance, (req, res) => {
  const slug = req.instanceSlug;
  const { trigger, matchType, reply, enabled, format, buttons, skipReply, sendApk, replyMode } = req.body;
  const hasReply = (reply !== undefined && reply !== null && reply.trim() !== '');
  if (!trigger || !matchType || (!hasReply && !skipReply && !sendApk)) {
    return res.status(400).json({ error: 'Missing required rules parameters. A rule must have a text reply, have skip-reply enabled, or attach an APK.' });
  }

  const rules = loadInstanceRules(slug);
  const newRule = {
    id: 'rule_' + Date.now(),
    trigger,
    matchType,
    reply,
    enabled: enabled !== undefined ? enabled : true,
    sendApk: sendApk !== undefined ? !!sendApk : false,
    replyMode: replyMode || 'sequential'
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
  const { trigger, matchType, reply, enabled, format, buttons, skipReply, sendApk, replyMode } = req.body;
  
  let rules = loadInstanceRules(slug);
  const index = rules.findIndex(r => r.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Rule not found' });
  }

  const updatedRule = {
    ...rules[index],
    trigger: trigger !== undefined ? trigger : rules[index].trigger,
    matchType: matchType !== undefined ? matchType : rules[index].matchType,
    reply: reply !== undefined ? reply : rules[index].reply,
    enabled: enabled !== undefined ? enabled : rules[index].enabled,
    sendApk: sendApk !== undefined ? !!sendApk : rules[index].sendApk,
    replyMode: replyMode !== undefined ? replyMode : rules[index].replyMode
  };
  if (format !== undefined) updatedRule.format = format;
  if (buttons !== undefined) updatedRule.buttons = buttons;
  if (skipReply !== undefined) updatedRule.skipReply = skipReply;

  const hasReply = (updatedRule.reply !== undefined && updatedRule.reply !== null && updatedRule.reply.trim() !== '');
  if (!updatedRule.trigger || !updatedRule.matchType || (!hasReply && !updatedRule.skipReply && !updatedRule.sendApk)) {
    return res.status(400).json({ error: 'Missing required rules parameters. A rule must have a text reply, have skip-reply enabled, or attach an APK.' });
  }

  rules[index] = updatedRule;

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

app.delete('/api/memory', authenticateToken, requireInstance, (req, res) => {
  const slug = req.instanceSlug;
  const memory = loadMemory();
  
  let deletedCount = 0;
  for (const key of Object.keys(memory)) {
    if (key.startsWith(`${slug}:`)) {
      delete memory[key];
      deletedCount++;
    }
  }
  
  if (deletedCount > 0) {
    saveMemory(memory);
  }
  
  logInstanceEvent(slug, 'system', `AI conversational memory cache cleared successfully (${deletedCount} contacts deleted).`);
  res.json({ message: 'Conversation memory cleared successfully.', deletedCount });
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
      size: `${(apk.data.length * 0.75 / 1024 / 1024).toFixed(2)} MB`,
      downloadPort: process.env.APK_PORT || '3005'
    });
  } else {
    res.json({ cached: false, downloadPort: process.env.APK_PORT || '3005' });
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

  const rawPath = getRawApkPath(slug);
  if (fs.existsSync(rawPath)) {
    try {
      fs.unlinkSync(rawPath);
    } catch (err) {
      console.error(`[SYSTEM] Failed to delete raw APK file: ${err.message}`);
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

// Schedule checker for daily reports (runs every 10 minutes)
setInterval(() => {
  const list = loadInstances();
  const now = Date.now();
  
  list.forEach(inst => {
    if (inst.adminForwardNumber) {
      const lastSent = inst.lastReportSentTime || 0;
      const twentyFourHours = 24 * 60 * 60 * 1000;
      
      // If never sent, initialize lastReportSentTime to now (so first report is sent 24h from now)
      if (!lastSent) {
        const listConfig = loadInstances();
        const index = listConfig.findIndex(i => i.slug === inst.slug);
        if (index !== -1) {
          listConfig[index].lastReportSentTime = now;
          saveInstances(listConfig);
        }
        return;
      }
      
      // If sent more than 24 hours ago
      if (now - lastSent >= twentyFourHours) {
        sendDailyReportToAdmin(inst.slug).catch(err => {
          console.error(`[SYSTEM] Background daily report failed for ${inst.slug}:`, err.message);
        });
      }
    }
  });
}, 10 * 60 * 1000); // 10 minutes check interval

// Run server
server.listen(PORT, () => {
  console.log(`\n=============================================================`);
  console.log(`🤖 MULTI-INSTANCE WHATSAPP AUTOMATION BOT HUB IS ONLINE!`);
  console.log(`🌐 Dashboard Portal Interface: http://localhost:${PORT}`);
  console.log(`=============================================================\n`);

  // Check if FFmpeg is installed
  const { exec } = require('child_process');
  exec('ffmpeg -version', (err) => {
    if (err) {
      console.warn('\n⚠️  [WARN] FFmpeg was not found in the system PATH.');
      console.warn('   Voice-to-text audio transcription will not work unless FFmpeg is installed.');
      console.warn('   To fix this: install FFmpeg on your system and make sure it is in your system PATH.\n');
    }
  });
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
