const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function metricsPath(dataDir, slug) {
  if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error('Invalid store slug');
  return path.join(dataDir, 'store_metrics', `${slug}.json`);
}

function loadMetrics(dataDir, slug) {
  try {
    return JSON.parse(fs.readFileSync(metricsPath(dataDir, slug), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { installClicks: 0, visitors: {}, trackingStartedAt: null, lastClickedAt: null };
  }
}

function summarizeMetrics(metrics) {
  return {
    installClicks: metrics.installClicks,
    uniqueInstallVisitors: Object.keys(metrics.visitors).length,
    trackingStartedAt: metrics.trackingStartedAt,
    lastClickedAt: metrics.lastClickedAt
  };
}

// Read fresh from disk: port 3002 and the dashboard run in separate processes.
function readStoreMetrics(dataDir, slug) {
  return summarizeMetrics(loadMetrics(dataDir, slug));
}

function recordInstallClick(dataDir, slug, visitorId) {
  const metrics = loadMetrics(dataDir, slug);
  const now = new Date().toISOString();
  metrics.installClicks++;
  metrics.visitors[visitorId] = true;
  metrics.trackingStartedAt ||= now;
  metrics.lastClickedAt = now;
  const file = metricsPath(dataDir, slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(metrics), 'utf8');
    fs.renameSync(temporaryFile, file);
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
  return summarizeMetrics(metrics);
}

function storeVisitorId(req, res, wildcardDomain = '') {
  const cookie = (req.headers.cookie || '').split(';')
    .map(value => value.trim()).find(value => value.startsWith('store_visitor='));
  const existingId = cookie?.slice('store_visitor='.length);
  if (/^[a-f0-9]{32}$/.test(existingId || '')) return existingId;

  const id = crypto.randomBytes(16).toString('hex');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim().split(':')[0].toLowerCase();
  const domain = String(wildcardDomain).split(',')
    .map(value => value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/\/+$/, ''))
    .find(value => /^[a-z0-9.-]+$/.test(value) && value.includes('.') &&
      (host === value || host.endsWith(`.${value}`)));
  res.cookie('store_visitor', id, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 365 * 24 * 60 * 60 * 1000,
    ...(domain ? { domain } : {})
  });
  return id;
}

module.exports = { readStoreMetrics, recordInstallClick, storeVisitorId };
