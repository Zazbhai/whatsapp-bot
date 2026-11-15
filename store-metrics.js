const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function metricsPath(dataDir, slug) {
  if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error('Invalid store slug');
  return path.join(dataDir, 'store_metrics', `${slug}.json`);
}

function loadMetrics(dataDir, slug) {
  try {
    const metrics = JSON.parse(fs.readFileSync(metricsPath(dataDir, slug), 'utf8'));
    metrics.pageVisits ||= 0;
    metrics.visitors ||= {};
    // Migrate the previous format, where `visitors` meant install visitors.
    metrics.installVisitors ||= { ...metrics.visitors };
    metrics.trackingStartedAt ||= null;
    metrics.lastVisitedAt ||= null;
    metrics.lastClickedAt ||= null;
    return metrics;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      pageVisits: 0, installClicks: 0, visitors: {}, installVisitors: {},
      trackingStartedAt: null, lastVisitedAt: null, lastClickedAt: null
    };
  }
}

function summarizeMetrics(metrics) {
  return {
    pageVisits: metrics.pageVisits,
    uniqueVisitors: Object.keys(metrics.visitors).length,
    installClicks: metrics.installClicks,
    uniqueInstallVisitors: Object.keys(metrics.installVisitors).length,
    trackingStartedAt: metrics.trackingStartedAt,
    lastVisitedAt: metrics.lastVisitedAt,
    lastClickedAt: metrics.lastClickedAt
  };
}

// Read fresh from disk: port 3002 and the dashboard run in separate processes.
function readStoreMetrics(dataDir, slug) {
  return summarizeMetrics(loadMetrics(dataDir, slug));
}

function persistMetrics(dataDir, slug, metrics) {
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

function recordStoreVisit(dataDir, slug, visitorId) {
  const metrics = loadMetrics(dataDir, slug);
  const now = new Date().toISOString();
  metrics.pageVisits++;
  metrics.visitors[visitorId] = true;
  metrics.trackingStartedAt ||= now;
  metrics.lastVisitedAt = now;
  return persistMetrics(dataDir, slug, metrics);
}

function recordInstallClick(dataDir, slug, visitorId) {
  const metrics = loadMetrics(dataDir, slug);
  const now = new Date().toISOString();
  metrics.installClicks++;
  metrics.visitors[visitorId] = true;
  metrics.installVisitors[visitorId] = true;
  metrics.trackingStartedAt ||= now;
  metrics.lastClickedAt = now;
  return persistMetrics(dataDir, slug, metrics);
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

module.exports = { readStoreMetrics, recordStoreVisit, recordInstallClick, storeVisitorId };
