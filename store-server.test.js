'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  createStoreApp,
  startStoreServer,
  getApkFromMemoryOrDisk,
  resolveApkInfo,
  DEFAULT_LISTING
} = require('./store-server');

const testDataDir = path.join(__dirname, 'test_store_data');

function makeRequest(server, pathStr) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: pathStr,
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('store-server serves Google Play Store page on root /', async () => {
  const app = createStoreApp({
    rootDir: __dirname,
    dataDir: path.join(__dirname, 'data'),
    loadInstances: () => [{ slug: 'primary', name: 'Primary Bot' }]
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    const res = await makeRequest(server, '/');
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('iStore - Apps on Google Play') || res.body.includes('Google Play'));
  } finally {
    server.close();
  }
});

test('store-server serves Play Store page for /app, /app/primary, /store, /playstore, and catch-all routes', async () => {
  const app = createStoreApp({
    rootDir: __dirname,
    dataDir: path.join(__dirname, 'data')
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    for (const testPath of ['/app', '/app/primary', '/store', '/playstore', '/any-random-path']) {
      const res = await makeRequest(server, testPath);
      assert.equal(res.statusCode, 200, `Failed for path ${testPath}`);
      assert.ok(res.headers['content-type'].includes('text/html'));
      assert.ok(res.body.includes('Google Play'));
    }
  } finally {
    server.close();
  }
});

test('store-server dynamic API /api/public/store returns valid listing JSON', async () => {
  const customInstances = [
    {
      slug: 'primary',
      name: 'Primary Bot',
      storeListing: {
        appName: 'One Shop Premium',
        developer: 'One Shop Ltd',
        rating: 4.8
      }
    }
  ];

  const app = createStoreApp({
    rootDir: __dirname,
    dataDir: path.join(__dirname, 'data'),
    loadInstances: () => customInstances
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    const res = await makeRequest(server, '/api/public/store/primary');
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.appName, 'One Shop Premium');
    assert.equal(data.developer, 'One Shop Ltd');
    assert.equal(data.rating, 4.8);
    assert.equal(data.downloadUrl, '/app/primary/download');
    assert.ok(Array.isArray(data.screenshots));

    // Also verify root API without slug falls back cleanly
    const resNoSlug = await makeRequest(server, '/api/public/store');
    assert.equal(resNoSlug.statusCode, 200);
    const dataNoSlug = JSON.parse(resNoSlug.body);
    assert.equal(dataNoSlug.appName, 'One Shop Premium');
  } finally {
    server.close();
  }
});

test('store-server serves static /istore/logo.jpg image assets', async () => {
  const app = createStoreApp({
    rootDir: __dirname,
    dataDir: path.join(__dirname, 'data')
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    const res = await makeRequest(server, '/istore/logo.jpg');
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('image/jpeg'));
  } finally {
    server.close();
  }
});

test('store-server never serves dashboard files (e.g. /app.js returns store.html, not JS)', async () => {
  const app = createStoreApp({
    rootDir: __dirname,
    dataDir: path.join(__dirname, 'data')
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    const res = await makeRequest(server, '/app.js');
    assert.equal(res.statusCode, 200);
    // Should serve store.html, NOT JavaScript source code of the dashboard!
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('Google Play'));
  } finally {
    server.close();
  }
});

test('store-server downloads APK when present in memory or disk', async () => {
  if (!fs.existsSync(testDataDir)) fs.mkdirSync(testDataDir, { recursive: true });
  
  // Create a dummy fake APK binary
  const fakeApkBuffer = Buffer.from('PK\x03\x04' + 'x'.repeat(100)); // APK zip header + content >= 78 bytes
  const apkPath = path.join(testDataDir, 'latest_apk_primary.apk');
  fs.writeFileSync(apkPath, fakeApkBuffer);

  let instances = [{ slug: 'primary', storeListing: { downloadCount: 10 } }];

  const app = createStoreApp({
    rootDir: __dirname,
    dataDir: testDataDir,
    loadInstances: () => instances,
    saveInstances: (newList) => { instances = newList; }
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    const res = await makeRequest(server, '/app/primary/download');
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('vnd.android.package-archive'));
    assert.ok(res.headers['content-disposition'].includes('istore.apk'));
    assert.equal(instances[0].storeListing.downloadCount, 11);

    // Direct /download path also works
    const resDownload = await makeRequest(server, '/download');
    assert.equal(resDownload.statusCode, 200);
    assert.ok(resDownload.headers['content-type'].includes('vnd.android.package-archive'));
  } finally {
    server.close();
    try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  }
});

test('store-server returns 404 when no APK package is cached', async () => {
  const emptyDataDir = path.join(__dirname, 'test_empty_store_data');
  if (!fs.existsSync(emptyDataDir)) fs.mkdirSync(emptyDataDir, { recursive: true });

  const app = createStoreApp({
    rootDir: __dirname,
    dataDir: emptyDataDir,
    loadInstances: () => []
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    const res = await makeRequest(server, '/download');
    assert.equal(res.statusCode, 404);
    assert.ok(res.body.includes('No APK package available yet'));
  } finally {
    server.close();
    try { fs.rmSync(emptyDataDir, { recursive: true, force: true }); } catch {}
  }
});

test('startStoreServer listens on custom port and closes gracefully', async () => {
  const port = 34567;
  const instance = startStoreServer({
    port,
    rootDir: __dirname,
    dataDir: path.join(__dirname, 'data')
  });

  try {
    const res = await makeRequest(instance.server, '/health');
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.service, 'playstore');
    assert.equal(data.status, 'healthy');
  } finally {
    await instance.close();
  }
});

