const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { getLocalIp } = require('./network-urls');

// ── Rate limiter helper ──
function createRateLimiter(maxRequests, windowMs) {
  const buckets = {};
  return function (identifier) {
    const now = Date.now();
    if (!buckets[identifier]) buckets[identifier] = [];
    // Prune old entries
    buckets[identifier] = buckets[identifier].filter(t => now - t < windowMs);
    if (buckets[identifier].length >= maxRequests) return false;
    buckets[identifier].push(now);
    return true;
  };
}

/**
 * Searches the data directory for the latest uploaded APK file or JSON cache.
 */
function getApkFile(dataDir, slug = 'primary') {
  if (!dataDir) return null;
  try {
    const rawPath = path.join(dataDir, `latest_apk_${slug}.apk`);
    if (fs.existsSync(rawPath)) {
      return { path: rawPath, filename: 'istore.apk' };
    }
    const jsonPath = path.join(dataDir, `latest_apk_${slug}.json`);
    if (fs.existsSync(jsonPath)) {
      const content = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (content && content.data && typeof content.data === 'string' && content.data.length > 0) {
        const buffer = Buffer.from(content.data, 'base64');
        // Verify minimum size: APK magic bytes are 4 bytes, but a valid APK is at least ~78 bytes
        if (buffer.length < 78) return null;
        return { buffer, filename: content.filename || 'istore.apk' };
      }
    }
    // Search any available APK across all slugs
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir);
      const apk = files.find(f => f.startsWith('latest_apk_') && f.endsWith('.apk'));
      if (apk) {
        return { path: path.join(dataDir, apk), filename: 'istore.apk' };
      }
      const json = files.find(f => f.startsWith('latest_apk_') && f.endsWith('.json'));
      if (json) {
        const content = JSON.parse(fs.readFileSync(path.join(dataDir, json), 'utf8'));
        if (content && content.data && typeof content.data === 'string' && content.data.length > 0) {
          const buffer = Buffer.from(content.data, 'base64');
          if (buffer.length < 78) return null;
          return { buffer, filename: content.filename || 'istore.apk' };
        }
      }
    }
  } catch (err) {
    console.error('[REDIRECT] Error checking APK cache:', err.message);
  }
  return null;
}

/**
 * Resolves the currently active WhatsApp phone number across bot instances.
 * Priority order:
 * 1. Live client that is currently 'ready' or 'connected'
 * 2. Active session of the preferred instance (e.g., 'primary') that is NOT logged out
 * 3. Any session marked 'linked' that is NOT logged out
 * 4. Any session with a configured phone number that is NOT logged out
 */
function resolveActiveWhatsAppNumber({ loadInstances, activeClients, clientStates, preferredSlug = 'primary', includeLoggedOut = false }) {
  const instances = typeof loadInstances === 'function' ? loadInstances() : [];
  if (!Array.isArray(instances) || instances.length === 0) return null;

  const cleanDigits = (val) => {
    if (!val) return null;
    const str = typeof val === 'object' && val.user ? String(val.user) : String(val);
    const d = str.split('@')[0].replace(/\D/g, '');
    return d.length >= 7 ? d : null;
  };

  const isUsable = (s) => Boolean(
    s &&
    s.phone &&
    s.status !== 'logged_out' &&
    !(s.retryAfter > Date.now())
  );

  // Sort preferred slug to the front
  const sorted = [...instances].sort((a, b) => {
    if (a.slug === preferredSlug) return -1;
    if (b.slug === preferredSlug) return 1;
    return 0;
  });

  // 1. Live ready/connected client
  for (const inst of sorted) {
    const slug = inst.slug;
    const state = clientStates ? clientStates[slug] : null;
    const client = activeClients ? activeClients[slug] : null;

    if (state && (state.status === 'ready' || state.status === 'connected')) {
      const liveWid = client?.info?.wid?.user || state.info?.wid;
      const phone = cleanDigits(liveWid);
      if (phone) {
        return {
          phone,
          slug,
          status: 'ready',
          label: inst.name || slug,
          source: 'live_client'
        };
      }
    }
  }

  // 2. Currently active session configured for the instance (only if NOT logged out)
  for (const inst of sorted) {
    const slug = inst.slug;
    const sessions = Array.isArray(inst.sessions) ? inst.sessions : [];
    const active = sessions.find((s) => s.id === inst.activeSessionId && isUsable(s));
    if (active && active.phone) {
      const phone = cleanDigits(active.phone);
      if (phone) {
        return {
          phone,
          slug,
          status: active.status || 'active',
          label: active.label || inst.name || slug,
          source: 'active_session'
        };
      }
    }
  }

  // 3. Any session with status === 'linked' that is NOT logged out
  for (const inst of sorted) {
    const slug = inst.slug;
    const sessions = Array.isArray(inst.sessions) ? inst.sessions : [];
    const linked = sessions.find((s) => s.status === 'linked' && isUsable(s));
    if (linked && linked.phone) {
      const phone = cleanDigits(linked.phone);
      if (phone) {
        return {
          phone,
          slug,
          status: linked.status,
          label: linked.label || inst.name || slug,
          source: 'linked_session'
        };
      }
    }
  }

  // 4. Any session with a phone number that is NOT logged out
  for (const inst of sorted) {
    const slug = inst.slug;
    const sessions = Array.isArray(inst.sessions) ? inst.sessions : [];
    const anyPhone = sessions.find((s) => isUsable(s));
    if (anyPhone && anyPhone.phone) {
      const phone = cleanDigits(anyPhone.phone);
      if (phone) {
        return {
          phone,
          slug,
          status: anyPhone.status,
          label: anyPhone.label || inst.name || slug,
          source: 'configured_session'
        };
      }
    }
  }

  // A public chat link can still point to the configured contact while its bot session is offline.
  if (includeLoggedOut) {
    for (const inst of sorted) {
      const sessions = Array.isArray(inst.sessions) ? inst.sessions : [];
      const selected = sessions.find((s) => s.id === inst.activeSessionId && s.phone);
      const phone = cleanDigits(selected?.phone);
      if (phone) {
        return {
          phone,
          slug: inst.slug,
          status: selected.status || 'offline',
          label: selected.label || inst.name || inst.slug,
          source: 'configured_contact'
        };
      }
    }
  }

  return null;
}

/**
 * Builds the WhatsApp target URL for a phone number with optional query parameters.
 */
function buildWhatsAppUrl(phone, query = {}, defaultText = '') {
  const clean = String(phone).replace(/\D/g, '');
  let url = `https://wa.me/${clean}`;
  const text = query.text || query.msg || query.message || defaultText;
  if (text) {
    url += `?text=${encodeURIComponent(text)}`;
  }
  return url;
}

function buildWhatsAppAppUrl(phone, query = {}, defaultText = '') {
  const clean = String(phone).replace(/\D/g, '');
  const text = query.text || query.msg || query.message || defaultText;
  const encodedText = text ? encodeURIComponent(text) : '';
  return `whatsapp://send?phone=${clean}${encodedText ? `&text=${encodedText}` : ''}`;
}

function buildWhatsAppIntentUrl(phone, query = {}, defaultText = '') {
  const clean = String(phone).replace(/\D/g, '');
  const text = query.text || query.msg || query.message || defaultText;
  const encodedText = text ? encodeURIComponent(text) : '';
  return `intent://send?phone=${clean}${encodedText ? `&text=${encodedText}` : ''}#Intent;scheme=whatsapp;package=com.whatsapp;end`;
}

function isMobileUserAgent(userAgent = '') {
  return /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(userAgent);
}

function renderMobileWhatsAppHandoff({ phone, query = {}, defaultText = '' }) {
  const clean = String(phone).replace(/\D/g, '');
  const text = query.text || query.msg || query.message || defaultText;
  const encodedText = text ? encodeURIComponent(text) : '';
  const nativeAppUrl = `whatsapp://send?phone=${clean}${encodedText ? `&text=${encodedText}` : ''}`;
  const intentUrl = `intent://send?phone=${clean}${encodedText ? `&text=${encodedText}` : ''}#Intent;scheme=whatsapp;package=com.whatsapp;end`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta http-equiv="refresh" content="0;url=${nativeAppUrl}">
  <title>Opening WhatsApp...</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0b141a;
      color: #e9edef;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      text-align: center;
    }
    .card {
      background: #111b21;
      border: 1px solid #222d34;
      border-radius: 20px;
      padding: 32px 24px;
      max-width: 380px;
      width: 100%;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }
    .wa-icon {
      width: 60px;
      height: 60px;
      background: #25d366;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
      box-shadow: 0 4px 16px rgba(37, 211, 102, 0.4);
    }
    .wa-icon svg {
      width: 34px;
      height: 34px;
      fill: #ffffff;
    }
    h2 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #e9edef;
    }
    p {
      color: #8696a0;
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .btn {
      display: block;
      background: #25d366;
      color: #0b141a;
      font-weight: 700;
      font-size: 16px;
      padding: 14px 24px;
      border-radius: 28px;
      text-decoration: none;
      transition: background 0.2s, transform 0.1s;
    }
    .btn:active {
      transform: scale(0.98);
      background: #20ba5a;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="wa-icon">
      <svg viewBox="0 0 24 24"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2M12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.58 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 15 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67M9.05 7.42C8.87 7.42 8.59 7.49 8.35 7.75C8.11 8.01 7.44 8.64 7.44 9.92C7.44 11.2 8.38 12.43 8.5 12.6C8.64 12.78 10.36 15.42 12.97 16.55C13.59 16.82 14.07 16.98 14.45 17.1C15.07 17.3 15.63 17.27 16.08 17.2C16.58 17.13 17.62 16.57 17.84 15.96C18.05 15.34 18.05 14.82 17.99 14.71C17.93 14.6 17.76 14.54 17.5 14.41C17.24 14.28 15.96 13.65 15.72 13.56C15.49 13.48 15.32 13.43 15.15 13.69C14.97 13.95 14.48 14.54 14.33 14.71C14.18 14.88 14.03 14.91 13.78 14.78C13.52 14.65 12.69 14.38 11.71 13.51C10.95 12.83 10.43 12 10.28 11.74C10.14 11.49 10.26 11.35 10.39 11.22C10.51 11.1 10.66 10.91 10.79 10.76C10.92 10.61 10.97 10.5 11.05 10.33C11.14 10.16 11.09 10.01 11.03 9.89C10.97 9.76 10.47 8.53 10.26 8.03C10.06 7.54 9.86 7.6 9.71 7.6C9.57 7.6 9.4 7.6 9.23 7.6H9.05Z"/></svg>
    </div>
    <h2>Opening WhatsApp...</h2>
    <p>Connecting you directly to chat. If WhatsApp does not open automatically, tap below.</p>
    <a id="action-btn" class="btn" href="${nativeAppUrl}">Continue to WhatsApp</a>
  </div>

  <script>
    (function () {
      var isAndroid = /Android/i.test(navigator.userAgent);
      var nativeUrl = ${JSON.stringify(nativeAppUrl)};
      var intentUrl = ${JSON.stringify(intentUrl)};
      var targetUrl = isAndroid ? intentUrl : nativeUrl;
      var btn = document.getElementById('action-btn');
      btn.href = targetUrl;

      // Programmatically trigger launch
      try { btn.click(); } catch (_) {}
      window.location.href = targetUrl;
    })();
  </script>
</body>
</html>`;
}

/**
 * HTML response when no WhatsApp number is active or ready.
 */
/**
 * HTML response when no WhatsApp number is active or ready.
 * Allows user to download the APK directly or view the store page.
 */
function renderWaitingPage({ mainDashboardPort = 3000, apkAvailable = false, downloadUrl = '/download' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="5">
  <title>Connecting to WhatsApp | Download APK</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(18, 24, 38, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --wa-green: #25D366;
      --wa-glow: rgba(37, 211, 102, 0.35);
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: radial-gradient(circle at 50% 20%, #152238 0%, var(--bg) 70%);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-radius: 24px;
      padding: 44px 36px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6), 0 0 40px rgba(37, 211, 102, 0.1);
      animation: fadeIn 0.6s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(16px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .pulse-wrapper {
      position: relative;
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pulse-ring {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      border: 2px solid var(--wa-green);
      animation: pulse 2.2s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
      opacity: 0.6;
    }
    .pulse-ring:nth-child(2) {
      animation-delay: 0.7s;
    }
    @keyframes pulse {
      0% { transform: scale(0.8); opacity: 0.8; }
      100% { transform: scale(1.6); opacity: 0; }
    }
    .icon-circle {
      width: 68px;
      height: 68px;
      background: linear-gradient(135deg, #25D366, #128C7E);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 10px 25px var(--wa-glow);
      position: relative;
      z-index: 2;
    }
    .icon-circle svg {
      width: 36px;
      height: 36px;
      fill: #ffffff;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 12px;
      color: #ffffff;
    }
    p {
      color: var(--text-muted);
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 16px;
      background: rgba(234, 179, 8, 0.12);
      border: 1px solid rgba(234, 179, 8, 0.3);
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      color: #facc15;
      margin-bottom: 20px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #facc15;
      animation: blink 1.4s infinite ease-in-out;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.3; transform: scale(0.7); }
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 13px 20px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s ease;
      border: none;
    }
    .btn-primary {
      background: linear-gradient(135deg, #25D366, #1fad55);
      color: #0b1a10;
      box-shadow: 0 8px 20px rgba(37, 211, 102, 0.25);
    }
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 25px rgba(37, 211, 102, 0.35);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      border: 1px solid var(--card-border);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.09);
      color: var(--text-main);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="pulse-wrapper">
      <div class="pulse-ring"></div>
      <div class="pulse-ring"></div>
      <div class="icon-circle">
        <svg viewBox="0 0 24 24">
          <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
        </svg>
      </div>
    </div>
    <div class="status-badge">
      <span class="status-dot"></span>
      <span>No active session · Download APK instead</span>
    </div>
    <h1>Download Official App</h1>
    <p>WhatsApp support is temporarily offline or disconnected. You can download the official Android application directly to get instant access and updates.</p>
    <div class="actions">
      <a class="btn btn-primary" href="${downloadUrl}" download id="download-apk-btn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
        </svg>
        <span>Download APK (Direct)</span>
      </a>
      <a class="btn btn-secondary" href="/app">
        <span>📱 Open App Store Page</span>
      </a>
      <button class="btn btn-secondary" onclick="window.location.reload()">🔄 Check WhatsApp Status</button>
    </div>
  </div>

  <script>
    // Poll the status API every 3 seconds to auto-redirect if WhatsApp comes back online
    (function poll() {
      fetch('/api/status')
        .then(r => r.json())
        .then(data => {
          if (data && data.active && data.url) {
            window.location.href = data.url;
          } else {
            setTimeout(poll, 3000);
          }
        })
        .catch(() => setTimeout(poll, 4000));
    })();
  </script>
</body>
</html>`;
}

/**
 * Creates an Express app for the WhatsApp direct redirect gateway.
 */
function createRedirectApp({
  getActiveNumber,
  getFallbackNumber,
  defaultText = process.env.REDIRECT_DEFAULT_TEXT || '',
  mainDashboardPort = process.env.PORT || 3000,
  dataDir = path.join(__dirname, 'data'),
  rootDir = __dirname
} = {}) {
  const app = express();

  // Security headers
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block'
    });
    next();
  });

  // Request logging
  app.use((req, res, next) => {
    console.log(`[REDIRECT] ${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });

  // Serve public static assets (like /istore/*.jpg) directly without intercepting root '/'
  app.use(express.static(path.join(rootDir, 'public'), { index: false }));

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // Direct APK download routes
  app.get(['/download', '/apk', '/get-apk', '/app.apk'], (req, res) => {
    const apk = getApkFile(dataDir);
    if (apk && apk.path) {
      return res.download(apk.path, apk.filename || 'app.apk', (err) => {
        if (err) res.status(500).send('Download error');
      });
    }
    if (apk && apk.buffer) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${apk.filename || 'app.apk'}"`);
      res.setHeader('Content-Length', apk.buffer.length);
      return res.send(apk.buffer);
    }
    // Fallback: forward to /app store page
    res.redirect(302, '/app');
  });

  // App download endpoint for a specific slug
  app.get('/app/:slug/download', (req, res) => {
    const slug = (req.params.slug || 'primary').toLowerCase();
    const apk = getApkFile(dataDir, slug);
    if (apk && apk.path) {
      return res.download(apk.path, apk.filename || 'app.apk', (err) => {
        if (err) res.status(500).send('Download error');
      });
    }
    if (apk && apk.buffer) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${apk.filename || 'app.apk'}"`);
      res.setHeader('Content-Length', apk.buffer.length);
      return res.send(apk.buffer);
    }
    res.status(404).send('No APK available yet.');
  });

  // Forward store / APK download requests to the main dashboard port
  app.use(['/store-media', '/api/public/store'], (req, res) => {
    const host = (req.hostname || req.headers.host || 'localhost').split(':')[0];
    const targetUrl = `http://${host}:${mainDashboardPort}${req.originalUrl}`;
    res.redirect(302, targetUrl);
  });

  // Store page /app
  app.get(['/app', '/app/:slug'], (req, res) => {
    const storePath = path.join(rootDir, 'public', 'store.html');
    if (fs.existsSync(storePath)) {
      return res.sendFile(storePath);
    }
    const host = (req.hostname || req.headers.host || 'localhost').split(':')[0];
    res.redirect(302, `http://${host}:${mainDashboardPort}${req.originalUrl}`);
  });

  // Rate limiter for /api/status
  const statusRateLimiter = createRateLimiter(10, 60000); // 10 req/min

  // JSON API status endpoint
  app.get('/api/status', (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    if (!statusRateLimiter(clientIp)) {
      return res.status(429).json({ error: 'Too many requests. Rate limit: 10/minute.' });
    }
    const active = typeof getActiveNumber === 'function' ? getActiveNumber() : null;
    const apk = getApkFile(dataDir);
    if (active && active.phone) {
      const url = buildWhatsAppUrl(active.phone, req.query, defaultText);
      return res.json({
        ok: true,
        active: true,
        phone: active.phone,
        url,
        slug: active.slug,
        status: active.status,
        source: active.source,
        apkAvailable: Boolean(apk)
      });
    }
    return res.json({
      ok: false,
      active: false,
      apkAvailable: Boolean(apk),
      downloadUrl: '/download',
      message: 'No active WhatsApp session currently available. You can view the Play Store app page or download the APK.'
    });
  });

  // Redirect handler for root and any path
  const redirectHandler = (req, res) => {
    const active = typeof getActiveNumber === 'function' ? getActiveNumber() : null;
    const fallback = !active && typeof getFallbackNumber === 'function' ? getFallbackNumber() : null;
    const target = active?.phone ? active : fallback;
    if (target && target.phone) {
      if (isMobileUserAgent(req.get('user-agent'))) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.type('html').send(renderMobileWhatsAppHandoff({
          phone: target.phone,
          query: req.query,
          defaultText
        }));
      }

      const targetUrl = buildWhatsAppUrl(target.phone, req.query, defaultText);
      // HTTP 302 Temporary Redirect so browsers don't cache stale numbers when failover rotates
      return res.redirect(302, targetUrl);
    }

    // No active number in sessions: instead of directly downloading the APK,
    // show user the Google Play Store page so they can click Install to download the APK
    const storePath = path.join(rootDir, 'public', 'store.html');
    if (fs.existsSync(storePath)) {
      return res.sendFile(storePath);
    }

    // Fallback: forward to /app store page on main dashboard port
    const host = (req.hostname || req.headers.host || 'localhost').split(':')[0];
    return res.redirect(302, `http://${host}:${mainDashboardPort}/app`);
  };

  // Catch-all route: redirects to active WhatsApp number or shows Play Store page
  app.get('*', redirectHandler);

  return app;
}

/**
 * Starts the standalone HTTP server on the designated redirect port.
 */
function startRedirectServer({
  port = Number(process.env.REDIRECT_PORT || 3001),
  getActiveNumber,
  getFallbackNumber,
  defaultText,
  mainDashboardPort = Number(process.env.PORT || 3000),
  dataDir = path.join(__dirname, 'data'),
  rootDir = __dirname
} = {}) {
  const app = createRedirectApp({ getActiveNumber, getFallbackNumber, defaultText, mainDashboardPort, dataDir, rootDir });
  const server = http.createServer(app);
  let closeTimer = null;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`\n⚠️  [WARN] WhatsApp Redirect Portal: Port ${port} is already in use.`);
      console.warn(`   Configure REDIRECT_PORT in .env to choose a different port.\n`);
    } else {
      console.error('[SYSTEM] WhatsApp Redirect Portal server error:', err.message);
    }
  });

  server.listen(port, () => {
    const localIp = getLocalIp();
    const lanStr = localIp ? ` (Phone/LAN: http://${localIp}:${port})` : '';
    console.log(`🌐 WhatsApp Auto-Redirect Gateway: http://localhost:${port}${lanStr} -> Directs visitors to active WhatsApp number`);
  });

  // Graceful shutdown on SIGTERM/SIGINT
  const shutdown = () => {
    if (closeTimer) return; // already shutting down
    closeTimer = setTimeout(() => {
      console.error('[REDIRECT] Force-closing server after shutdown timeout.');
      server.close();
    }, 5000).unref();
    server.close((err) => {
      if (!err) console.log('[REDIRECT] Server closed.');
      else console.error('[REDIRECT] Error closing server:', err.message);
    });
  };

  // Register cleanup only if not already registered in this process
  if (!process._redirectServerShutdown) {
    process._redirectServerShutdown = true;
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  return {
    app,
    server,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
    })
  };
}

module.exports = {
  createRedirectApp,
  resolveActiveWhatsAppNumber,
  buildWhatsAppUrl,
  buildWhatsAppAppUrl,
  buildWhatsAppIntentUrl,
  isMobileUserAgent,
  renderMobileWhatsAppHandoff,
  renderWaitingPage,
  startRedirectServer
};
