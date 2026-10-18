const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

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
      if (content && content.data) {
        return {
          buffer: Buffer.from(content.data, 'base64'),
          filename: content.filename || 'istore.apk'
        };
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
        if (content && content.data) {
          return {
            buffer: Buffer.from(content.data, 'base64'),
            filename: content.filename || 'istore.apk'
          };
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
function resolveActiveWhatsAppNumber({ loadInstances, activeClients, clientStates, preferredSlug = 'primary' }) {
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
  defaultText = process.env.REDIRECT_DEFAULT_TEXT || '',
  mainDashboardPort = process.env.PORT || 3000,
  dataDir = path.join(__dirname, 'data'),
  rootDir = __dirname
} = {}) {
  const app = express();

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // Direct APK download routes
  app.get(['/download', '/apk', '/get-apk', '/app.apk'], (req, res) => {
    const apk = getApkFile(dataDir);
    if (apk && apk.path) {
      return res.download(apk.path, apk.filename || 'app.apk');
    }
    if (apk && apk.buffer) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${apk.filename || 'app.apk'}"`);
      return res.send(apk.buffer);
    }
    // Fallback: forward to /app store page
    res.redirect(302, '/app');
  });

  // App download endpoint for a specific slug
  app.get('/app/:slug/download', (req, res) => {
    const slug = (req.params.slug || 'primary').toLowerCase();
    const apk = getApkFile(dataDir, slug);
    if (apk && apk.path) return res.download(apk.path, apk.filename || 'app.apk');
    if (apk && apk.buffer) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${apk.filename || 'app.apk'}"`);
      return res.send(apk.buffer);
    }
    res.status(404).send('No APK available yet.');
  });

  // Forward store / APK download requests to the main dashboard port (3000)
  app.use(['/store-media'], (req, res) => {
    const host = req.headers.host ? req.headers.host.split(':')[0] : 'localhost';
    const targetUrl = `http://${host}:${mainDashboardPort}${req.originalUrl}`;
    res.redirect(302, targetUrl);
  });

  // Store page /app
  app.get(['/app', '/app/:slug'], (req, res) => {
    const storePath = path.join(rootDir, 'public', 'store.html');
    if (fs.existsSync(storePath)) {
      return res.sendFile(storePath);
    }
    const host = req.headers.host ? req.headers.host.split(':')[0] : 'localhost';
    res.redirect(302, `http://${host}:${mainDashboardPort}${req.originalUrl}`);
  });

  // JSON API status endpoint
  app.get('/api/status', (req, res) => {
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
      message: 'No active WhatsApp session currently available. You can download the APK directly.'
    });
  });

  // Redirect handler for root and any path
  const redirectHandler = (req, res) => {
    const active = typeof getActiveNumber === 'function' ? getActiveNumber() : null;
    if (active && active.phone) {
      const targetUrl = buildWhatsAppUrl(active.phone, req.query, defaultText);
      // HTTP 302 Temporary Redirect so browsers don't cache stale numbers when failover rotates
      return res.redirect(302, targetUrl);
    }

    // Direct download if query parameter requested (?download=1 or ?apk=1)
    if (req.query.download === '1' || req.query.apk === '1') {
      const apk = getApkFile(dataDir);
      if (apk && apk.path) return res.download(apk.path, apk.filename || 'app.apk');
      if (apk && apk.buffer) {
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', `attachment; filename="${apk.filename || 'app.apk'}"`);
        return res.send(apk.buffer);
      }
    }

    // No active number yet - serve stylish waiting/download page with APK download button
    const apk = getApkFile(dataDir);
    res.status(200).send(renderWaitingPage({
      mainDashboardPort,
      apkAvailable: Boolean(apk),
      downloadUrl: '/download'
    }));
  };

  // Catch-all route: redirects to active WhatsApp number or shows APK download / waiting page
  app.get('*', redirectHandler);

  return app;
}

/**
 * Starts the standalone HTTP server on the designated redirect port.
 */
function startRedirectServer({
  port = Number(process.env.REDIRECT_PORT || 3001),
  getActiveNumber,
  defaultText,
  mainDashboardPort = Number(process.env.PORT || 3000),
  dataDir = path.join(__dirname, 'data'),
  rootDir = __dirname
} = {}) {
  const app = createRedirectApp({ getActiveNumber, defaultText, mainDashboardPort, dataDir, rootDir });
  const server = http.createServer(app);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`\n⚠️  [WARN] WhatsApp Redirect Portal: Port ${port} is already in use.`);
      console.warn(`   Configure REDIRECT_PORT in .env to choose a different port.\n`);
    } else {
      console.error('[SYSTEM] WhatsApp Redirect Portal server error:', err.message);
    }
  });

  server.listen(port, () => {
    console.log(`🌐 WhatsApp Auto-Redirect Gateway: http://localhost:${port} -> Directs visitors to active WhatsApp number`);
  });

  return {
    app,
    server,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = {
  createRedirectApp,
  resolveActiveWhatsAppNumber,
  buildWhatsAppUrl,
  renderWaitingPage,
  startRedirectServer
};
