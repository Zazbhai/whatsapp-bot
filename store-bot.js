/**
 * store-bot.js — Isolated Telegram Bot for Play Store APK Management (Port 3002)
 *
 * This bot is the ONLY entity authorised to push a new APK to the dedicated
 * Play Store server running on port 3002 (store-server.js).
 *
 * Features:
 *   • Receive an APK document → upload it instantly to port 3002 via the
 *     token-gated POST /api/store/apk/upload endpoint.
 *   • /start   — welcome + usage instructions
 *   • /status  — show which APK is currently live on port 3002
 *   • Admin-only guard: only STORE_BOT_ADMIN_IDS (or TELEGRAM_ADMIN_IDS) may
 *     interact with this bot.
 *   • Inline feedback: upload progress, success/error messages.
 *
 * Configuration (all from .env):
 *   STORE_BOT_TOKEN      — this bot's Telegram token
 *   STORE_APK_TOKEN      — secret bearer token shared with store-server.js
 *   STORE_BOT_ADMIN_IDS  — comma-separated Telegram user IDs allowed to use bot
 *   STORE_PORT           — port store-server listens on (default 3002)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── Load .env ───────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim().replace(/(^"|"$|^'|'$)/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  });
}

// ── Config ──────────────────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.STORE_BOT_TOKEN || '';
const STORE_TOKEN    = process.env.STORE_APK_TOKEN || '';
const STORE_PORT     = Number(process.env.STORE_PORT || 3002);
const STORE_HOST     = process.env.STORE_HOST || '127.0.0.1';
const STORE_BASE_URL = `http://${STORE_HOST}:${STORE_PORT}`;

// Admin IDs — fall back to main TELEGRAM_ADMIN_IDS if STORE_BOT_ADMIN_IDS is blank
const rawAdminIds =
  process.env.STORE_BOT_ADMIN_IDS ||
  process.env.TELEGRAM_ADMIN_IDS  ||
  '';
const ADMIN_IDS = new Set(
  rawAdminIds.split(',').map(s => s.trim()).filter(Boolean)
);

if (!BOT_TOKEN) {
  console.error('[STORE-BOT] STORE_BOT_TOKEN is not set in .env — exiting.');
  process.exit(1);
}
if (!STORE_TOKEN) {
  console.error('[STORE-BOT] STORE_APK_TOKEN is not set in .env — upload requests will be rejected by store-server.');
}

// ── Telegram API helpers ─────────────────────────────────────────────────────
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/** Generic HTTPS GET → parsed JSON */
function tgGet(method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `${TG_API}/${method}${qs ? '?' + qs : ''}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      });
    }).on('error', reject);
  });
}

/** Send a text message (supports HTML parse_mode) */
function tgSend(chatId, text, extra = {}) {
  return tgGet('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

/** Get Telegram file path object for a file_id */
function tgGetFile(fileId) {
  return tgGet('getFile', { file_id: fileId });
}

/** Download a file from Telegram CDN into a Buffer */
function downloadTgFile(filePath) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ── Store-server API helpers ─────────────────────────────────────────────────

/** POST multipart APK buffer to the store-server upload endpoint */
function uploadApkToStore(buffer, filename, version, notes) {
  return new Promise((resolve, reject) => {
    const boundary = `----StoreBotBoundary${Date.now()}`;
    const CRLF = '\r\n';

    const buildPart = (name, value) =>
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`;

    const filePart = Buffer.concat([
      Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="apk"; filename="${filename}"${CRLF}` +
        `Content-Type: application/vnd.android.package-archive${CRLF}${CRLF}`
      ),
      buffer,
      Buffer.from(CRLF)
    ]);

    const textParts = Buffer.from(
      buildPart('version', version || '') +
      buildPart('notes', notes || '') +
      `--${boundary}--${CRLF}`
    );

    const body = Buffer.concat([filePart, textParts]);

    const options = {
      hostname: STORE_HOST,
      port: STORE_PORT,
      path: '/api/store/apk/upload',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STORE_TOKEN}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch {
          resolve({ statusCode: res.statusCode, body: { raw: data } });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** GET /api/store/apk/info — check what APK is currently live */
function getStoreApkInfo() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: STORE_HOST,
      port: STORE_PORT,
      path: '/api/store/apk/info',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${STORE_TOKEN}` }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Admin guard ──────────────────────────────────────────────────────────────
function isAdmin(userId) {
  return ADMIN_IDS.size === 0 || ADMIN_IDS.has(String(userId));
}

// ── Message handlers ─────────────────────────────────────────────────────────

async function handleStart(msg) {
  const { chat, from } = msg;
  if (!isAdmin(from.id)) {
    return tgSend(chat.id, '⛔ You are not authorised to use this bot.');
  }
  await tgSend(chat.id,
    '📱 <b>Store APK Bot — Port 3002</b>\n\n' +
    'Send me any <b>.apk</b> file to instantly push it live on the Play Store page.\n\n' +
    '<b>Commands:</b>\n' +
    '• /start — Show this message\n' +
    '• /status — Check which APK is currently live\n\n' +
    '⚠️ Only admins can upload. APK is served exclusively on port 3002.'
  );
}

async function handleStatus(msg) {
  const { chat, from } = msg;
  if (!isAdmin(from.id)) {
    return tgSend(chat.id, '⛔ You are not authorised to use this bot.');
  }
  try {
    const info = await getStoreApkInfo();
    if (!info.cached) {
      return tgSend(chat.id, '📭 No APK is currently live on port 3002.\nSend me an APK file to publish one.');
    }
    await tgSend(chat.id,
      `✅ <b>Live APK on port 3002:</b>\n\n` +
      `📦 <b>File:</b> ${info.filename}\n` +
      `🔖 <b>Version:</b> ${info.version}\n` +
      `💾 <b>Size:</b> ${info.size}\n` +
      `📝 <b>Notes:</b> ${info.notes || '—'}\n` +
      `🕐 <b>Uploaded:</b> ${info.uploadedAt}\n` +
      `👤 <b>By:</b> ${info.uploadedBy}`
    );
  } catch (err) {
    await tgSend(chat.id, `❌ Could not reach store-server: <code>${err.message}</code>`);
  }
}

async function handleDocument(msg) {
  const { chat, from, document, caption } = msg;
  if (!isAdmin(from.id)) {
    return tgSend(chat.id, '⛔ You are not authorised to upload APKs.');
  }

  const filename = document.file_name || 'istore.apk';
  const isApk =
    filename.toLowerCase().endsWith('.apk') ||
    (document.mime_type && document.mime_type.includes('android'));

  if (!isApk) {
    return tgSend(chat.id, '⚠️ Please send a valid <b>.apk</b> file.');
  }

  // Size check — Telegram bots can only receive files ≤ 20 MB
  const maxBytes = 20 * 1024 * 1024;
  if (document.file_size && document.file_size > maxBytes) {
    return tgSend(chat.id,
      '⚠️ Telegram limits bot file downloads to <b>20 MB</b>.\n' +
      'The store-server also accepts direct HTTP uploads:\n' +
      '<code>curl -X POST http://localhost:3002/api/store/apk/upload \\\n' +
      '  -H "Authorization: Bearer $STORE_APK_TOKEN" \\\n' +
      '  -F "apk=@app.apk" -F "version=1.0"</code>'
    );
  }

  const statusMsg = await tgSend(chat.id, '⏳ Downloading APK from Telegram...');
  const statusMsgId = statusMsg.result && statusMsg.result.message_id;

  const editStatus = (text) => {
    if (!statusMsgId) return;
    return tgGet('editMessageText', {
      chat_id: chat.id,
      message_id: statusMsgId,
      text,
      parse_mode: 'HTML'
    });
  };

  try {
    // 1. Get file path from Telegram
    const fileInfo = await tgGetFile(document.file_id);
    if (!fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) {
      await editStatus('❌ Failed to retrieve file from Telegram servers.');
      return;
    }

    await editStatus('⏳ Downloading APK from Telegram... ✅\n⬆️ Uploading to store-server...');

    // 2. Download buffer from Telegram CDN
    const buffer = await downloadTgFile(fileInfo.result.file_path);

    if (buffer.length < 78) {
      await editStatus('❌ Downloaded file is too small to be a valid APK.');
      return;
    }

    // 3. Parse version / notes from caption (format: "1.2 optional notes here")
    let version = '';
    let notes = '';
    if (caption && caption.trim()) {
      const parts = caption.trim().split(/\s+/);
      version = parts[0] || '';
      notes = parts.slice(1).join(' ');
    }

    // 4. POST to store-server
    const result = await uploadApkToStore(buffer, filename, version, notes);

    if (result.statusCode === 200 && result.body.success) {
      const info = result.body;
      await editStatus(
        `✅ <b>APK published live on port 3002!</b>\n\n` +
        `📦 <b>File:</b> ${info.filename}\n` +
        `🔖 <b>Version:</b> ${info.version || '—'}\n` +
        `💾 <b>Size:</b> ${info.size}\n` +
        `🕐 <b>Published at:</b> ${info.uploadedAt}`
      );
    } else {
      const errMsg = (result.body && (result.body.error || result.body.raw)) || `HTTP ${result.statusCode}`;
      await editStatus(`❌ Upload rejected by store-server:\n<code>${errMsg}</code>`);
    }
  } catch (err) {
    console.error('[STORE-BOT] Upload error:', err.message);
    await editStatus(`❌ Error: <code>${err.message}</code>`);
  }
}

// ── Long polling ─────────────────────────────────────────────────────────────
let offset = 0;
let running = true;
let pollTimer = null;

async function poll() {
  if (!running) return;
  try {
    const data = await tgGet('getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: JSON.stringify(['message'])
    });

    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;

        const text = (msg.text || '').trim();
        if      (text.startsWith('/start'))  await handleStart(msg).catch(console.error);
        else if (text.startsWith('/status')) await handleStatus(msg).catch(console.error);
        else if (msg.document)               await handleDocument(msg).catch(console.error);
      }
    }
  } catch (err) {
    if (running) console.error('[STORE-BOT] Poll error:', err.message);
  }

  if (running) {
    pollTimer = setTimeout(poll, 100);
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────
console.log('🤖 Store APK Bot starting...');
console.log(`   Accepted admin IDs: ${ADMIN_IDS.size > 0 ? [...ADMIN_IDS].join(', ') : '(all — no restriction)'}`);
console.log(`   Store-server target: ${STORE_BASE_URL}`);

// Verify token by fetching bot info
tgGet('getMe').then((data) => {
  if (data.ok) {
    const me = data.result;
    console.log(`✅ Store Bot connected: @${me.username} (ID ${me.id})`);
  } else {
    console.error('[STORE-BOT] getMe failed — check STORE_BOT_TOKEN:', data);
  }
  poll();
}).catch((err) => {
  console.error('[STORE-BOT] Could not connect to Telegram:', err.message);
  poll(); // still start polling; will retry on next iteration
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[STORE-BOT] ${signal} received — shutting down.`);
  running = false;
  if (pollTimer) clearTimeout(pollTimer);
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

