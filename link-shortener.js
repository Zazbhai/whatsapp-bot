'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHORT_HOSTS = new Set([
  'tinyurl.com', 'is.gd', 'v.gd', 'bit.ly', 't.co', 'cutt.ly',
  'goo.gl', 'rb.gy', 'rebrand.ly', 'shorturl.at', 'clck.ru', 'da.gd'
]);

// In-memory cache: longUrl -> { shortUrl, provider, code, createdAt }
const cache = new Map();
// Reverse lookup: code -> longUrl
const codeMap = new Map();

let dataDir = path.join(__dirname, 'data');
let cacheFilePath = path.join(dataDir, 'shortened_links.json');
let configuredProvider = process.env.URL_SHORTENER_PROVIDER || 'tinyurl';
let defaultBaseUrl = process.env.STORE_ENTRY_DOMAIN || process.env.PUBLIC_URL || '';

function isAlreadyShortened(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (SHORT_HOSTS.has(host)) return true;
    if (parsed.pathname.startsWith('/s/')) return true;
    return false;
  } catch {
    return false;
  }
}

function loadCache() {
  try {
    if (fs.existsSync(cacheFilePath)) {
      const data = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
      for (const [longUrl, info] of Object.entries(data)) {
        if (info && info.shortUrl) {
          cache.set(longUrl, info);
          if (info.code) codeMap.set(info.code, longUrl);
        }
      }
    }
  } catch (err) {
    console.error('[SHORTENER] Failed to load cache:', err.message);
  }
}

function persistCache() {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const obj = {};
    for (const [k, v] of cache.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(cacheFilePath, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[SHORTENER] Failed to save cache:', err.message);
  }
}

function initShortener(options = {}) {
  if (options.dataDir) {
    dataDir = options.dataDir;
    cacheFilePath = path.join(dataDir, 'shortened_links.json');
  }
  if (options.provider) {
    configuredProvider = options.provider;
  }
  if (options.baseUrl) {
    defaultBaseUrl = options.baseUrl;
  }
  loadCache();
}

// Initial load
loadCache();

function getShortLinkSync(longUrl) {
  if (!longUrl || typeof longUrl !== 'string') return null;
  const trimmed = longUrl.trim();
  const cached = cache.get(trimmed);
  return cached ? cached.shortUrl : null;
}

function resolveShortCode(code) {
  if (!code || typeof code !== 'string') return null;
  const clean = code.trim().toLowerCase();
  return codeMap.get(clean) || null;
}

function shortenTextSync(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const [longUrl, info] of cache.entries()) {
    if (info && info.shortUrl && out.includes(longUrl)) {
      out = out.replaceAll(longUrl, info.shortUrl);
    }
  }
  return out;
}

async function requestWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function callTinyUrl(longUrl) {
  const endpoint = `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`;
  const res = await requestWithTimeout(endpoint, { method: 'GET' }, 4000);
  if (!res.ok) throw new Error(`TinyURL returned status ${res.status}`);
  const text = (await res.text()).trim();
  if (text.startsWith('http://') || text.startsWith('https://')) {
    return text;
  }
  throw new Error(`TinyURL invalid response: ${text}`);
}

async function callIsGd(longUrl) {
  const endpoint = `https://is.gd/create.php?format=simple&url=${encodeURIComponent(longUrl)}`;
  const res = await requestWithTimeout(endpoint, { method: 'GET' }, 4000);
  if (!res.ok) throw new Error(`is.gd returned status ${res.status}`);
  const text = (await res.text()).trim();
  if (text.startsWith('http://') || text.startsWith('https://')) {
    return text;
  }
  throw new Error(`is.gd invalid response: ${text}`);
}

function makeInternalShortLink(longUrl, baseUrlOverride) {
  const code = crypto.createHash('md5').update(longUrl).digest('hex').slice(0, 6);
  const base = baseUrlOverride || defaultBaseUrl || process.env.STORE_ENTRY_DOMAIN || 'https://istoreoffer.quest';
  const cleanBase = base.replace(/\/+$/, '');
  const shortUrl = `${cleanBase}/s/${code}`;
  return { shortUrl, code };
}

async function shortenUrl(longUrl, options = {}) {
  if (!longUrl || typeof longUrl !== 'string') return longUrl;
  const raw = longUrl.trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  if (isAlreadyShortened(raw)) return raw;

  // Check cache
  if (cache.has(raw)) {
    return cache.get(raw).shortUrl;
  }

  const provider = options.provider || configuredProvider || 'tinyurl';
  let shortUrl = null;
  let resolvedProvider = provider;
  const internalFallback = makeInternalShortLink(raw, options.baseUrl);
  const code = internalFallback.code;

  if (provider === 'tinyurl') {
    try {
      shortUrl = await callTinyUrl(raw);
      resolvedProvider = 'tinyurl';
    } catch (err) {
      // Fallback 1: is.gd
      try {
        shortUrl = await callIsGd(raw);
        resolvedProvider = 'isgd';
      } catch (err2) {
        // Fallback 2: internal
        shortUrl = internalFallback.shortUrl;
        resolvedProvider = 'internal';
      }
    }
  } else if (provider === 'isgd') {
    try {
      shortUrl = await callIsGd(raw);
      resolvedProvider = 'isgd';
    } catch (err) {
      try {
        shortUrl = await callTinyUrl(raw);
        resolvedProvider = 'tinyurl';
      } catch (err2) {
        shortUrl = internalFallback.shortUrl;
        resolvedProvider = 'internal';
      }
    }
  } else {
    // Internal
    shortUrl = internalFallback.shortUrl;
    resolvedProvider = 'internal';
  }

  if (shortUrl) {
    const entry = {
      shortUrl,
      provider: resolvedProvider,
      code,
      createdAt: Date.now()
    };
    cache.set(raw, entry);
    codeMap.set(code, raw);
    persistCache();
    return shortUrl;
  }

  return raw;
}

const URL_REGEX = /(?<![\w@.-])(?:https?:\/\/[^\s<>"'`]+)/gi;

async function shortenAllLinksInText(text, options = {}) {
  if (!text || typeof text !== 'string') return text;
  const matches = [...text.matchAll(URL_REGEX)];
  if (matches.length === 0) return text;

  // Extract unique clean URLs
  const urlMap = new Map();
  for (const m of matches) {
    const full = m[0];
    const punctuation = full.match(/[.,!?;:)\]}*]+$/)?.[0] || '';
    const clean = punctuation ? full.slice(0, -punctuation.length) : full;
    if (/^https?:\/\//i.test(clean) && !isAlreadyShortened(clean)) {
      urlMap.set(clean, null);
    }
  }

  if (urlMap.size === 0) return text;

  // Shorten in parallel
  await Promise.all(
    Array.from(urlMap.keys()).map(async (rawUrl) => {
      try {
        const short = await shortenUrl(rawUrl, options);
        urlMap.set(rawUrl, short);
      } catch {
        urlMap.set(rawUrl, rawUrl);
      }
    })
  );

  // Replace in text
  return text.replace(URL_REGEX, full => {
    const punctuation = full.match(/[.,!?;:)\]}*]+$/)?.[0] || '';
    const clean = punctuation ? full.slice(0, -punctuation.length) : full;
    if (urlMap.has(clean)) {
      const short = urlMap.get(clean);
      return (short || clean) + punctuation;
    }
    return full;
  });
}

module.exports = {
  initShortener,
  shortenUrl,
  shortenAllLinksInText,
  getShortLinkSync,
  shortenTextSync,
  resolveShortCode,
  isAlreadyShortened
};

