const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const express = require('express');
const { createStoreApp } = require('./store-server');
const { readStoreMetrics, recordInstallClick } = require('./store-metrics');

function temporaryData(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-metrics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function serve(t, app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('install clicks start at zero, persist across readers, and separate visitors and bot instances', t => {
  const dataDir = temporaryData(t);
  assert.equal(readStoreMetrics(dataDir, 'primary').installClicks, 0);
  recordInstallClick(dataDir, 'primary', 'visitor-a');
  recordInstallClick(dataDir, 'primary', 'visitor-a');
  recordInstallClick(dataDir, 'primary', 'visitor-b');
  const freshReader = require('./store-metrics').readStoreMetrics;
  const metrics = freshReader(dataDir, 'primary');
  assert.equal(metrics.installClicks, 3);
  assert.equal(metrics.uniqueInstallVisitors, 2);
  assert.ok(metrics.lastClickedAt);
  assert.ok(metrics.trackingStartedAt);
  assert.equal('visitors' in metrics, false);
  assert.equal(readStoreMetrics(dataDir, 'other').installClicks, 0);
  assert.throws(() => readStoreMetrics(dataDir, '../outside'), /Invalid store slug/);
});

test('port 3002 counts only Install POSTs, reuses browser cookies, and survives store app recreation', async t => {
  const dataDir = temporaryData(t);
  const options = {
    dataDir, storeApkDir: path.join(dataDir, 'apk'), wildcardDomain: '',
    loadInstances: () => [{ slug: 'primary' }, { slug: 'other' }],
    latestApkCache: { primary: { data: Buffer.from('APK test').toString('base64') } }
  };
  const request = await serve(t, createStoreApp(options));
  const listing = await request('/api/public/store/primary');
  const cookie = listing.headers['set-cookie'][0].split(';')[0];
  assert.equal(listing.headers['cache-control'], 'no-store');
  await request('/app/primary/download');
  assert.equal(readStoreMetrics(dataDir, 'primary').installClicks, 0);
  for (let i = 0; i < 2; i++) {
    const result = await request('/api/public/store/primary/install-click', { method: 'POST', headers: { cookie } });
    assert.equal(result.status, 204);
  }
  const requestAfterRestart = await serve(t, createStoreApp(options));
  await requestAfterRestart('/api/public/store/primary/install-click', { method: 'POST' });
  assert.equal(readStoreMetrics(dataDir, 'primary').installClicks, 3);
  assert.equal(readStoreMetrics(dataDir, 'primary').uniqueInstallVisitors, 2);
  assert.equal(readStoreMetrics(dataDir, 'other').installClicks, 0);
});

test('Install tracking still accepts POSTs during domain rotation and shares the browser cookie', async t => {
  const dataDir = temporaryData(t);
  const request = await serve(t, createStoreApp({
    dataDir, storeApkDir: path.join(dataDir, 'apk'),
    wildcardDomain: 'example.test', loadInstances: () => [{ slug: 'primary' }]
  }));
  const result = await request('/api/public/store/primary/install-click', {
    method: 'POST', headers: { host: 'store-expired.example.test' }
  });
  assert.equal(result.status, 204);
  assert.match(result.headers['set-cookie'][0], /Domain=example\.test/);
  assert.equal(readStoreMetrics(dataDir, 'primary').installClicks, 1);
});

test('dashboard metrics route requires the dashboard guards and returns fresh aggregate counts', async t => {
  const dataDir = temporaryData(t);
  const app = express();
  const source = fs.readFileSync(require.resolve('./server'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf("app.get('/api/store/metrics'"), source.indexOf("app.get('/api/status'")), {
    app, dataDir, readStoreMetrics, console,
    authenticateToken(req, res, next) {
      if (req.headers.authorization !== 'Bearer test') return res.sendStatus(401);
      next();
    },
    requireInstance(req, res, next) {
      if (!['primary', 'other'].includes(req.query.instance)) return res.sendStatus(404);
      req.instanceSlug = req.query.instance;
      next();
    }
  });
  const request = await serve(t, app);
  assert.equal((await request('/api/store/metrics?instance=primary')).status, 401);
  const headers = { authorization: 'Bearer test' };
  assert.equal((await request('/api/store/metrics?instance=missing', { headers })).status, 404);
  recordInstallClick(dataDir, 'primary', 'visitor-a');
  const result = await request('/api/store/metrics?instance=primary', { headers });
  assert.equal(JSON.parse(result.body).installClicks, 1);
  assert.equal(JSON.parse(result.body).uniqueInstallVisitors, 1);
  assert.equal('visitors' in JSON.parse(result.body), false);
  assert.equal(result.headers['cache-control'], 'no-store');
  recordInstallClick(dataDir, 'primary', 'visitor-b');
  assert.equal(JSON.parse((await request('/api/store/metrics?instance=primary', { headers })).body).installClicks, 2);
});

test('the Install button still downloads when analytics fails and ignores double clicks while busy', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'store.html'), 'utf8');
  const elements = Object.fromEntries(['install-btn', 'install-btn-text', 'install-progress-bar', 'install-spinner']
    .map(id => [id, { style: {} }]));
  let busy = false;
  elements['install-btn'].classList = { contains: () => busy, add: () => { busy = true; } };
  let downloads = 0;
  let clicks = 0;
  const context = vm.createContext({
    appStoreSlug: 'primary', appDownloadUrl: '/app/primary/download', showToast() {}, setInterval() {},
    fetch: () => { clicks++; return Promise.reject(new Error('Offline analytics')); },
    document: {
      getElementById: id => elements[id], body: { appendChild() {}, removeChild() {} },
      createElement: () => ({ setAttribute() {}, click() { downloads++; } })
    }
  });
  vm.runInContext(html.slice(html.indexOf('    function startInstall()'), html.indexOf('    // Dynamic store listing fetch')), context);
  context.startInstall();
  context.startInstall();
  await Promise.resolve();
  assert.equal(downloads, 1);
  assert.equal(clicks, 1);
});

test('dashboard discards metrics from an old instance after switching bots', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  const elements = Object.fromEntries(['stat-install-clicks', 'stat-install-visitors', 'store-metrics-note']
    .map(id => [id, { textContent: '—' }]));
  let resolveFetch;
  const context = vm.createContext({
    activeInstanceSlug: 'primary', document: { getElementById: id => elements[id] },
    apiFetch: () => new Promise(resolve => { resolveFetch = resolve; })
  });
  vm.runInContext(source.slice(source.indexOf('function resetStoreMetrics()'), source.indexOf('async function updateDashboardUsers()')), context);
  const pending = context.updateStoreMetrics();
  context.activeInstanceSlug = 'other';
  resolveFetch({ ok: true, json: async () => ({ installClicks: 8, uniqueInstallVisitors: 3 }) });
  await pending;
  assert.equal(elements['stat-install-clicks'].textContent, '—');
  context.apiFetch = async () => ({ ok: true, json: async () => ({ installClicks: 4, uniqueInstallVisitors: 2 }) });
  await context.updateStoreMetrics();
  assert.equal(elements['stat-install-clicks'].textContent, '4');
  assert.equal(elements['stat-install-visitors'].textContent, '2');
});
