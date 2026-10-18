'use strict';

const express = require('express');
const http = require('http');

/**
 * Resolves the currently active WhatsApp phone number across bot instances.
 * Priority order:
 * 1. Live client that is currently 'ready' or 'connected'
 * 2. Active session of the preferred instance (e.g., 'primary')
 * 3. Any session marked 'linked'
 * 4. Any session with a configured phone number
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

  // 2. Currently active session configured for the instance
  for (const inst of sorted) {
    const slug = inst.slug;
    const sessions = Array.isArray(inst.sessions) ? inst.sessions : [];
    const active = sessions.find((s) => s.id === inst.activeSessionId);
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

  // 3. Any session with status === 'linked'
  for (const inst of sorted) {
    const slug = inst.slug;
    const sessions = Array.isArray(inst.sessions) ? inst.sessions : [];
    const linked = sessions.find((s) => s.status === 'linked' && s.phone);
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

  // 4. Any session with a phone number
  for (const inst of sorted) {
    const slug = inst.slug;
    const sessions = Array.isArray(inst.sessions) ? inst.sessions : [];
    const anyPhone = sessions.find((s) => s.phone);
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
function renderWaitingPage({ mainDashboardPort = 3000 } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="4">
  <title>Connecting to WhatsApp | WhatsApp Gateway</title>
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
      width: 88px;
      height: 88px;
      margin: 0 auto 28px;
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
      width: 72px;
      height: 72px;
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
      width: 38px;
      height: 38px;
      fill: #ffffff;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 12px;
      background: linear-gradient(to right, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: var(--text-muted);
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 28px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 16px;
      background: rgba(37, 211, 102, 0.1);
      border: 1px solid rgba(37, 211, 102, 0.25);
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      color: var(--wa-green);
      margin-bottom: 24px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--wa-green);
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
      display: block;
      width: 100%;
      padding: 13px 20px;
      border-radius: 12px;
      font-size: 14px;
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
          <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm.01 1.67c4.54 0 8.24 3.7 8.24 8.24 0 2.2-.86 4.27-2.42 5.82a8.19 8.19 0 0 1-5.82 2.42c-1.48 0-2.93-.39-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.18 8.18 0 0 1-1.25-4.38c0-4.54 3.7-8.24 8.24-8.24zm4.52 11.64c-.25-.13-1.47-.72-1.7-.81-.23-.08-.39-.13-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.13-1.06-.39-2.02-1.25-.75-.67-1.26-1.5-1.41-1.75-.14-.25-.02-.39.11-.51.11-.11.25-.29.38-.44.13-.14.17-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.35-.77-1.85-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.44.06-.67.31-.23.25-.87.85-.87 2.08 0 1.23.9 2.42 1.02 2.59.13.17 1.77 2.7 4.29 3.79.6.26 1.07.41 1.44.53.6.19 1.15.16 1.58.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.15-1.18-.06-.1-.23-.17-.48-.29z"/>
        </svg>
      </div>
    </div>
    <div class="status-badge">
      <span class="status-dot"></span>
      <span>Bot is connecting...</span>
    </div>
    <h1>Connecting to WhatsApp</h1>
    <p>Please wait a moment while our WhatsApp bot engine establishes connection. You will be redirected automatically once online.</p>
    <div class="actions">
      <button class="btn btn-primary" onclick="window.location.reload()">🔄 Check Again</button>
      <a class="btn btn-secondary" href="http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${mainDashboardPort}" target="_blank">Open Admin Dashboard</a>
    </div>
  </div>

  <script>
    // Poll the status API every 2 seconds and redirect as soon as a number is active
    (function poll() {
      fetch('/api/status')
        .then(r => r.json())
        .then(data => {
          if (data && data.active && data.url) {
            window.location.href = data.url;
          } else {
            setTimeout(poll, 2000);
          }
        })
        .catch(() => setTimeout(poll, 3000));
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
  mainDashboardPort = process.env.PORT || 3000
} = {}) {
  const app = express();

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // JSON API status endpoint
  app.get('/api/status', (req, res) => {
    const active = typeof getActiveNumber === 'function' ? getActiveNumber() : null;
    if (active && active.phone) {
      const url = buildWhatsAppUrl(active.phone, req.query, defaultText);
      return res.json({
        ok: true,
        active: true,
        phone: active.phone,
        url,
        slug: active.slug,
        status: active.status,
        source: active.source
      });
    }
    return res.json({
      ok: false,
      active: false,
      message: 'No active WhatsApp session currently available. Please link a session in the bot.'
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

    // No active number yet - serve stylish waiting page with auto-refresh
    res.status(200).send(renderWaitingPage({ mainDashboardPort }));
  };

  app.get('/', redirectHandler);
  app.get('/wa', redirectHandler);
  app.get('/chat', redirectHandler);

  return app;
}

/**
 * Starts the standalone HTTP server on the designated redirect port.
 */
function startRedirectServer({
  port = Number(process.env.REDIRECT_PORT || 3001),
  getActiveNumber,
  defaultText,
  mainDashboardPort = Number(process.env.PORT || 3000)
} = {}) {
  const app = createRedirectApp({ getActiveNumber, defaultText, mainDashboardPort });
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
