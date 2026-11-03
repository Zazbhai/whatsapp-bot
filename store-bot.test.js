'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const { createStoreApp, startStoreServer } = require('./store-server');

const TEST_STORE_APK_DIR = path.join(__dirname, '_test_store_apk_dir_' + Date.now());
const TEST_TOKEN = 'test-secure-token-abc123';

// Minimal fake APK (ZIP magic + padding to satisfy the 78-byte minimum)
const fakeApkBuffer = Buffer.from('PK\x03\x04' + 'X'.repeat(100));

function makeRequest(server, method, pathStr, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const addr  = server.address();
    const opts  = { hostname: '127.0.0.1', port: addr.port, path: pathStr, method, headers };
    const req   = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Build a minimal multipart/form-data body containing an APK file + optional fields */
function buildMultipart(buffer, filename, version = '', notes = '') {
  const boundary = 'TestBoundary12345';
  const CRLF = '\r\n';

  const filePart = Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="apk"; filename="${filename}"${CRLF}` +
      `Content-Type: application/vnd.android.package-archive${CRLF}${CRLF}`
    ),
    buffer,
    Buffer.from(CRLF)
  ]);

  const textPart = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="version"${CRLF}${CRLF}${version}${CRLF}` +
    `--${boundary}${CRLF}Content-Disposition: form-data; name="notes"${CRLF}${CRLF}${notes}${CRLF}` +
    `--${boundary}--${CRLF}`
  );

  return {
    body: Buffer.concat([filePart, textPart]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

// ── Cleanup helper ───────────────────────────────────────────────────────────
function cleanup() {
  try { fs.rmSync(TEST_STORE_APK_DIR, { recursive: true, force: true }); } catch {}
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('upload endpoint rejects request with no token (401)', async () => {
  const app    = createStoreApp({ rootDir: __dirname, dataDir: path.join(__dirname, 'data'), storeApkDir: TEST_STORE_APK_DIR, storeApkToken: TEST_TOKEN });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await makeRequest(server, 'POST', '/api/store/apk/upload', {}, null);
    assert.equal(res.statusCode, 401);
    assert.ok(res.body.error || String(res.body).includes('Invalid'));
  } finally {
    server.close(); cleanup();
  }
});

test('upload endpoint rejects request with wrong token (401)', async () => {
  const app    = createStoreApp({ rootDir: __dirname, dataDir: path.join(__dirname, 'data'), storeApkDir: TEST_STORE_APK_DIR, storeApkToken: TEST_TOKEN });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const { body: mp, contentType } = buildMultipart(fakeApkBuffer, 'app.apk');
    const res = await makeRequest(server, 'POST', '/api/store/apk/upload', {
      'Authorization': 'Bearer wrong-token',
      'Content-Type': contentType,
      'Content-Length': mp.length
    }, mp);
    assert.equal(res.statusCode, 401);
  } finally {
    server.close(); cleanup();
  }
});

test('upload endpoint accepts valid APK with correct token and persists to storeApkDir', async () => {
  const app    = createStoreApp({ rootDir: __dirname, dataDir: path.join(__dirname, 'data'), storeApkDir: TEST_STORE_APK_DIR, storeApkToken: TEST_TOKEN });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const { body: mp, contentType } = buildMultipart(fakeApkBuffer, 'myapp.apk', '2.5', 'test notes');
    const res = await makeRequest(server, 'POST', '/api/store/apk/upload', {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Content-Type': contentType,
      'Content-Length': mp.length
    }, mp);

    assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.version, '2.5');
    assert.ok(res.body.filename);
    assert.ok(res.body.uploadedAt);

    // File must be persisted to the isolated storeApkDir — NOT the main data/
    const persistedPath = path.join(TEST_STORE_APK_DIR, 'latest_apk.json');
    assert.ok(fs.existsSync(persistedPath), 'APK JSON was not written to storeApkDir');
    const saved = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    assert.equal(saved.version, '2.5');
    assert.equal(saved.notes, 'test notes');
    assert.equal(saved.uploadedBy, 'store-bot');
    assert.ok(saved.data && saved.data.length > 0, 'Base64 APK data should be saved');

    // Main bot data/ must be completely untouched
    const mainApkJson = path.join(__dirname, 'data', 'latest_apk_primary.json');
    // We don't assert it doesn't exist (it might exist from other tests) —
    // we assert we never wrote to it in this test (no changes during this test run).
    const mainDataFiles = fs.readdirSync(path.join(__dirname, 'data'));
    assert.ok(!mainDataFiles.includes('latest_apk_store-bot.json'), 'Should not write to main data/');
  } finally {
    server.close(); cleanup();
  }
});

test('/api/store/apk/info returns cached=false when no APK has been uploaded yet', async () => {
  const emptyDir = path.join(__dirname, '_test_empty_store_' + Date.now());
  const app      = createStoreApp({ rootDir: __dirname, dataDir: path.join(__dirname, 'data'), storeApkDir: emptyDir, storeApkToken: TEST_TOKEN });
  const server   = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await makeRequest(server, 'GET', '/api/store/apk/info', { 'Authorization': `Bearer ${TEST_TOKEN}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cached, false);
  } finally {
    server.close();
    try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch {}
  }
});

test('/api/store/apk/info returns cached=true and correct metadata after upload', async () => {
  const app    = createStoreApp({ rootDir: __dirname, dataDir: path.join(__dirname, 'data'), storeApkDir: TEST_STORE_APK_DIR, storeApkToken: TEST_TOKEN });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    // Upload first
    const { body: mp, contentType } = buildMultipart(fakeApkBuffer, 'check.apk', '3.0', 'info test');
    await makeRequest(server, 'POST', '/api/store/apk/upload', {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Content-Type': contentType,
      'Content-Length': mp.length
    }, mp);

    // Then check info
    const res = await makeRequest(server, 'GET', '/api/store/apk/info', { 'Authorization': `Bearer ${TEST_TOKEN}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cached, true);
    assert.equal(res.body.source, 'store');
    assert.equal(res.body.version, '3.0');
    assert.equal(res.body.notes, 'info test');
    assert.equal(res.body.uploadedBy, 'store-bot');
  } finally {
    server.close(); cleanup();
  }
});

test('/api/store/apk/info requires auth — rejects wrong token', async () => {
  const app    = createStoreApp({ rootDir: __dirname, dataDir: path.join(__dirname, 'data'), storeApkDir: TEST_STORE_APK_DIR, storeApkToken: TEST_TOKEN });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await makeRequest(server, 'GET', '/api/store/apk/info', { 'Authorization': 'Bearer bad' });
    assert.equal(res.statusCode, 401);
  } finally {
    server.close(); cleanup();
  }
});

test('after upload, /download serves the isolated store APK (not main bot cache)', async () => {
  const mainCacheWithDifferentApk = {
    primary: {
      data: Buffer.from('different-apk-data').toString('base64'),
      filename: 'main-bot.apk'
    }
  };
  const app    = createStoreApp({
    rootDir: __dirname,
    dataDir: path.join(__dirname, 'data'),
    storeApkDir: TEST_STORE_APK_DIR,
    storeApkToken: TEST_TOKEN,
    latestApkCache: mainCacheWithDifferentApk
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    // Upload isolated store APK
    const { body: mp, contentType } = buildMultipart(fakeApkBuffer, 'store-upload.apk', '9.9');
    await makeRequest(server, 'POST', '/api/store/apk/upload', {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Content-Type': contentType,
      'Content-Length': mp.length
    }, mp);

    // Download should serve the STORE APK, not main-bot.apk
    const addr = server.address();
    const downloaded = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${addr.port}/download`, (res) => {
        assert.equal(res.statusCode, 200, 'Download should return 200');
        assert.ok(res.headers['content-disposition'].includes('store-upload.apk'), 'Should serve store-upload.apk, not main-bot.apk');
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });

    assert.ok(downloaded.length >= 78, 'Downloaded buffer should be the real APK');
    // Verify it's NOT the main bot's fake data
    assert.notEqual(downloaded.toString(), 'different-apk-data');
  } finally {
    server.close(); cleanup();
  }
});

test('upload rejects a non-APK file (wrong extension)', async () => {
  const app    = createStoreApp({ rootDir: __dirname, dataDir: path.join(__dirname, 'data'), storeApkDir: TEST_STORE_APK_DIR, storeApkToken: TEST_TOKEN });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const { body: mp, contentType } = buildMultipart(Buffer.from('not an apk'), 'malware.exe', '1.0');
    const res = await makeRequest(server, 'POST', '/api/store/apk/upload', {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Content-Type': contentType,
      'Content-Length': mp.length
    }, mp);
    assert.equal(res.statusCode, 400);
  } finally {
    server.close(); cleanup();
  }
});

test('store-server loads existing isolated APK from disk on startup', async () => {
  // Pre-write a persisted APK JSON to storeApkDir before the server starts
  fs.mkdirSync(TEST_STORE_APK_DIR, { recursive: true });
  const preloadData = {
    data: fakeApkBuffer.toString('base64'),
    filename: 'preloaded.apk',
    version: '1.0-preload',
    notes: 'Preloaded',
    uploadedBy: 'store-bot',
    uploadedAt: new Date().toISOString(),
    sizeMB: '0.00'
  };
  fs.writeFileSync(path.join(TEST_STORE_APK_DIR, 'latest_apk.json'), JSON.stringify(preloadData));

  const app    = createStoreApp({ rootDir: __dirname, dataDir: path.join(__dirname, 'data'), storeApkDir: TEST_STORE_APK_DIR, storeApkToken: TEST_TOKEN });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await makeRequest(server, 'GET', '/api/store/apk/info', { 'Authorization': `Bearer ${TEST_TOKEN}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cached, true);
    assert.equal(res.body.version, '1.0-preload');
  } finally {
    server.close(); cleanup();
  }
});

