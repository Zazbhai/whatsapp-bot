'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const {
  getRotateWindow,
  getSubdomainForWindow,
  getActiveDomain,
  getNextRotateRemainingSeconds,
  isHostMatchingActiveDomain,
  createDomainRedirectMiddleware
} = require('./store-domain-rotator');
const { createStoreApp } = require('./store-server');

function makeRequest(server, pathStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: pathStr,
      method: 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('getRotateWindow increments every 5 minutes', () => {
  const w1 = getRotateWindow(5);
  assert.ok(typeof w1 === 'number');
  assert.ok(w1 > 0);
});

test('getSubdomainForWindow generates deterministic hash with prefix', () => {
  const sub1 = getSubdomainForWindow({ windowIndex: 1000, prefix: 'store', domain: 'husan.shop' });
  const sub2 = getSubdomainForWindow({ windowIndex: 1000, prefix: 'store', domain: 'husan.shop' });
  const sub3 = getSubdomainForWindow({ windowIndex: 1001, prefix: 'store', domain: 'husan.shop' });

  assert.equal(sub1, sub2);
  assert.notEqual(sub1, sub3);
  assert.ok(sub1.startsWith('store-'));
});

test('getActiveDomain formats complete full domain', () => {
  const domain = getActiveDomain({ wildcardDomain: 'husan.shop', rotateMinutes: 5, prefix: 'store' });
  assert.ok(domain);
  assert.ok(domain.endsWith('.husan.shop'));
  assert.ok(domain.startsWith('store-'));
});

test('getActiveDomain cleans up leading wildcard *. or protocol', () => {
  const domain = getActiveDomain({ wildcardDomain: '*.husan.shop', rotateMinutes: 5, prefix: 'store' });
  assert.ok(domain);
  assert.ok(!domain.includes('*.'));
  assert.ok(domain.endsWith('.husan.shop'));
});

test('getNextRotateRemainingSeconds returns valid seconds count', () => {
  const secs = getNextRotateRemainingSeconds(5);
  assert.ok(secs >= 0);
  assert.ok(secs <= 300);
});

test('isHostMatchingActiveDomain compares hosts case-insensitively and ignores port', () => {
  assert.equal(isHostMatchingActiveDomain('store-abc123.husan.shop:3002', 'store-abc123.husan.shop'), true);
  assert.equal(isHostMatchingActiveDomain('STORE-ABC123.HUSAN.SHOP', 'store-abc123.husan.shop'), true);
  assert.equal(isHostMatchingActiveDomain('localhost:3002', 'store-abc123.husan.shop'), false);
});

test('redirect middleware redirects direct localhost requests to active 5-minute domain', async () => {
  const app = express();
  const activeDomain = getActiveDomain({ wildcardDomain: 'husan.shop', rotateMinutes: 5, prefix: 'store' });

  app.use(createDomainRedirectMiddleware({ wildcardDomain: 'husan.shop', rotateMinutes: 5, prefix: 'store' }));
  app.get('*', (req, res) => res.send('OK'));

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    const res = await makeRequest(server, '/app/primary', { host: 'localhost:3002' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `https://${activeDomain}/app/primary`);
  } finally {
    server.close();
  }
});

test('redirect middleware redirects entry domain (playstores.istoreoffer.quest) to active temporary domain', async () => {
  const app = express();
  const activeDomain = getActiveDomain({ wildcardDomain: 'istoreoffer.quest', rotateMinutes: 5, prefix: 'store' });

  app.use(createDomainRedirectMiddleware({ wildcardDomain: 'istoreoffer.quest', rotateMinutes: 5, prefix: 'store' }));
  app.get('*', (req, res) => res.send('OK'));

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    const res = await makeRequest(server, '/app/primary', { host: 'playstores.istoreoffer.quest' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `https://${activeDomain}/app/primary`);
  } finally {
    server.close();
  }
});

test('redirect middleware allows requests arriving on active domain without redirect', async () => {
  const app = express();
  const activeDomain = getActiveDomain({ wildcardDomain: 'husan.shop', rotateMinutes: 5, prefix: 'store' });

  app.use(createDomainRedirectMiddleware({ wildcardDomain: 'husan.shop', rotateMinutes: 5, prefix: 'store' }));
  app.get('/app/primary', (req, res) => res.json({ success: true }));

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    const res = await makeRequest(server, '/app/primary', { 'x-forwarded-host': activeDomain });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
  } finally {
    server.close();
  }
});

test('store app exposes /api/store/active-domain and bypasses health from redirect', async () => {
  const app = createStoreApp({
    rootDir: __dirname,
    dataDir: __dirname,
    wildcardDomain: 'husan.shop',
    rotateMinutes: 5,
    subdomainPrefix: 'store'
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    // Health check must not be redirected
    const healthRes = await makeRequest(server, '/health', { host: 'localhost:3002' });
    assert.equal(healthRes.statusCode, 200);

    // Active domain endpoint must return active domain info
    const activeRes = await makeRequest(server, '/api/store/active-domain', { host: 'localhost:3002' });
    assert.equal(activeRes.statusCode, 200);
    const activeData = JSON.parse(activeRes.body);
    assert.ok(activeData.activeDomain.endsWith('.husan.shop'));
    assert.equal(activeData.rotateMinutes, 5);
    assert.ok(activeData.nextRotateInSeconds >= 0);
  } finally {
    server.close();
  }
});

