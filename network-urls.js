'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Discovers the host's primary IPv4 address for phone / LAN testing.
 */
function getLocalIp() {
  try {
    const interfaces = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const lower = name.toLowerCase();
          const isVpn = lower.includes('tailscale') || lower.includes('warp') || lower.includes('vpn') || lower.includes('veth');
          candidates.push({ address: iface.address, priority: isVpn ? 1 : 10 });
        }
      }
    }
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates[0] ? candidates[0].address : null;
  } catch {
    return null;
  }
}

/**
 * Reads any quick-tunnel URL saved to .tunnel_url_<port> by cloudflared.sh
 */
function getTunnelUrl(port) {
  try {
    const p = path.join(__dirname, `.tunnel_url_${port}`);
    if (fs.existsSync(p)) {
      const u = fs.readFileSync(p, 'utf8').trim();
      if (u && u.startsWith('http')) return u;
    }
  } catch {}
  return null;
}

/**
 * Aggregates all public, phone/LAN, and local test URLs.
 */
function getStartupUrls({
  port = Number(process.env.PORT || 3000),
  redirectPort = Number(process.env.REDIRECT_PORT || 3001),
  storePort = Number(process.env.STORE_PORT || 3002),
  activeStoreDomain = null
} = {}) {
  const localIp = getLocalIp();
  const dashTunnel = getTunnelUrl(port);
  const redirectTunnel = getTunnelUrl(redirectPort);
  const storeTunnel = getTunnelUrl(storePort);

  const cleanEntry = process.env.STORE_ENTRY_DOMAIN
    ? (process.env.STORE_ENTRY_DOMAIN.startsWith('http') ? process.env.STORE_ENTRY_DOMAIN : `https://${process.env.STORE_ENTRY_DOMAIN}`)
    : null;

  return {
    localIp,
    dashboard: {
      local: `http://localhost:${port}`,
      lan: localIp ? `http://${localIp}:${port}` : null,
      public: process.env.PUBLIC_URL || dashTunnel || null
    },
    redirect: {
      local: `http://localhost:${redirectPort}`,
      lan: localIp ? `http://${localIp}:${redirectPort}` : null,
      public: process.env.REDIRECT_PUBLIC_URL || redirectTunnel || null
    },
    store: {
      entry: cleanEntry,
      activeDomain: activeStoreDomain ? (activeStoreDomain.startsWith('http') ? activeStoreDomain : `https://${activeStoreDomain}`) : null,
      local: `http://localhost:${storePort}`,
      lan: localIp ? `http://${localIp}:${storePort}` : null,
      public: storeTunnel || null
    }
  };
}

/**
 * Pretty-prints a phone & remote testing URL block for starting logs.
 */
function logStartupUrls(options = {}) {
  const urls = getStartupUrls(options);
  console.log(`\n=============================================================`);
  console.log(`📱 PHONE & PUBLIC TESTING URLS:`);

  // Play Store Portal URLs
  if (urls.store.entry) {
    console.log(`  👉 Store Entry Link (Phone/Public): ${urls.store.entry}`);
  }
  if (urls.store.activeDomain) {
    console.log(`  🔄 Active 5-Min Rotating Domain:    ${urls.store.activeDomain}`);
  }
  if (urls.store.lan) {
    console.log(`  📶 Store Local LAN (Same Wi-Fi):    ${urls.store.lan}`);
  }

  // Dashboard URLs
  console.log(`  🌐 Dashboard Interface:             ${urls.dashboard.local}${urls.dashboard.lan ? ` | ${urls.dashboard.lan}` : ''}`);
  if (urls.dashboard.public) {
    console.log(`  🌍 Dashboard Public Tunnel:         ${urls.dashboard.public}`);
  }

  // WhatsApp Auto-Redirect Gateway
  console.log(`  🔗 WhatsApp Auto-Redirect:          ${urls.redirect.local}${urls.redirect.lan ? ` | ${urls.redirect.lan}` : ''}`);
  if (urls.redirect.public) {
    console.log(`  🌍 WhatsApp Redirect Public:        ${urls.redirect.public}`);
  }
  console.log(`=============================================================\n`);
}

module.exports = {
  getLocalIp,
  getTunnelUrl,
  getStartupUrls,
  logStartupUrls
};

