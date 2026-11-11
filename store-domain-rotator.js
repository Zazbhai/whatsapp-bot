'use strict';

const crypto = require('crypto');

/**
 * Calculates current time-window index based on rotation minutes.
 */
function getRotateWindow(rotateMinutes = 5) {
  const mins = Math.max(1, Number(rotateMinutes) || 5);
  return Math.floor(Date.now() / (mins * 60 * 1000));
}

/**
 * Generates a consistent 6-character subdomain hash for a given time window.
 */
function getSubdomainForWindow({ windowIndex, prefix = 'store', domain = 'husan.shop' }) {
  const hash = crypto
    .createHash('md5')
    .update(`${windowIndex}:${domain}:${prefix}`)
    .digest('hex')
    .slice(0, 6);
  return prefix ? `${prefix}-${hash}` : hash;
}

/**
 * Returns the currently active full domain (e.g. store-a7b2c9.husan.shop).
 */
function getActiveDomain({
  wildcardDomain = process.env.STORE_WILDCARD_DOMAIN || '',
  rotateMinutes = Number(process.env.STORE_DOMAIN_ROTATE_MINUTES || 5),
  prefix = process.env.STORE_SUBDOMAIN_PREFIX || 'store'
} = {}) {
  const raw = String(wildcardDomain || '').trim();
  if (!raw) return null;

  // Support comma-separated list of domains
  const domains = raw
    .split(',')
    .map(d => d.trim().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/+$/, ''))
    .filter(Boolean);

  if (!domains.length) return null;

  const windowIndex = getRotateWindow(rotateMinutes);
  const domain = domains[windowIndex % domains.length];
  const sub = getSubdomainForWindow({ windowIndex, prefix, domain });
  return `${sub}.${domain}`;
}

/**
 * Calculates seconds remaining until the next domain rotation window.
 */
function getNextRotateRemainingSeconds(rotateMinutes = 5) {
  const mins = Math.max(1, Number(rotateMinutes) || 5);
  const windowMs = mins * 60 * 1000;
  const currentWindow = Math.floor(Date.now() / windowMs);
  const nextWindowMs = (currentWindow + 1) * windowMs;
  return Math.max(0, Math.round((nextWindowMs - Date.now()) / 1000));
}

/**
 * Checks if incoming host matches the current active domain.
 */
function isHostMatchingActiveDomain(host, activeDomain) {
  if (!host || !activeDomain) return false;
  const cleanHost = String(host).split(':')[0].trim().toLowerCase();
  const cleanActive = String(activeDomain).split(':')[0].trim().toLowerCase();
  return cleanHost === cleanActive;
}

const isTestEnv = process.env.NODE_ENV === 'test' ||
  (Array.isArray(process.execArgv) && process.execArgv.includes('--test')) ||
  (Array.isArray(process.argv) && process.argv.some(a => typeof a === 'string' && a.includes('test')));

/**
 * Express middleware to redirect non-active or direct port 3002 requests to the 5-minute active domain.
 */
function createDomainRedirectMiddleware(options = {}) {
  return function domainRedirectMiddleware(req, res, next) {
    if (isTestEnv && options.wildcardDomain === undefined) {
      return next();
    }

    const wildcardDomain = options.wildcardDomain !== undefined
      ? options.wildcardDomain
      : (process.env.STORE_WILDCARD_DOMAIN || '');

    if (!wildcardDomain) {
      return next();
    }

    const reqPath = req.path || '';

    // Bypass internal management endpoints and health checks
    if (
      reqPath === '/health' ||
      reqPath === '/api/store/active-domain' ||
      reqPath.startsWith('/api/store/apk/')
    ) {
      return next();
    }

    const rotateMinutes = options.rotateMinutes || Number(process.env.STORE_DOMAIN_ROTATE_MINUTES || 5);
    const prefix = options.prefix !== undefined ? options.prefix : (process.env.STORE_SUBDOMAIN_PREFIX || 'store');

    const activeDomain = getActiveDomain({ wildcardDomain, rotateMinutes, prefix });
    if (!activeDomain) {
      return next();
    }

    const incomingHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].trim().toLowerCase();

    // Already on the current 5-minute active domain -> serve requested content
    if (incomingHost === activeDomain.toLowerCase()) {
      return next();
    }

    // Direct hit on localhost/IP or older/expired domain -> 302 redirect to current active domain
    const targetUrl = `https://${activeDomain}${req.originalUrl || req.url || '/'}`;
    return res.redirect(302, targetUrl);
  };
}

module.exports = {
  getRotateWindow,
  getSubdomainForWindow,
  getActiveDomain,
  getNextRotateRemainingSeconds,
  isHostMatchingActiveDomain,
  createDomainRedirectMiddleware
};

