'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  resolveActiveWhatsAppNumber,
  buildWhatsAppUrl,
  createRedirectApp,
  startRedirectServer
} = require('./redirect-server');

test('resolveActiveWhatsAppNumber prioritizes live ready client over fallback session phone', () => {
  const instances = [
    {
      slug: 'primary',
      name: 'Primary Bot',
      activeSessionId: 'default',
      sessions: [
        { id: 'default', phone: '+91 99999-11111', status: 'linked' },
        { id: 'backup', phone: '+91 88888-22222', status: 'linked' }
      ]
    }
  ];

  // When live client is ready with a different connected phone
  const activeClients = {
    primary: {
      info: { wid: { user: '918888822222' } }
    }
  };
  const clientStates = {
    primary: { status: 'ready', info: { wid: '918888822222@c.us' } }
  };

  const resolved = resolveActiveWhatsAppNumber({
    loadInstances: () => instances,
    activeClients,
    clientStates,
    preferredSlug: 'primary'
  });

  assert.equal(resolved?.phone, '918888822222');
  assert.equal(resolved?.source, 'live_client');
});

test('resolveActiveWhatsAppNumber falls back to activeSession phone when client is not yet ready', () => {
  const instances = [
    {
      slug: 'primary',
      name: 'Primary Bot',
      activeSessionId: 'backup',
      sessions: [
        { id: 'default', phone: '+91 99999-11111', status: 'logged_out' },
        { id: 'backup', phone: '+91 89494-46687', status: 'connecting' }
      ]
    }
  ];

  const resolved = resolveActiveWhatsAppNumber({
    loadInstances: () => instances,
    activeClients: {},
    clientStates: { primary: { status: 'connecting' } },
    preferredSlug: 'primary'
  });

  assert.equal(resolved?.phone, '918949446687');
  assert.equal(resolved?.source, 'active_session');
});

test('resolveActiveWhatsAppNumber returns null when no numbers are available', () => {
  const instances = [
    {
      slug: 'primary',
      name: 'Primary Bot',
      activeSessionId: 'default',
      sessions: []
    }
  ];

  const resolved = resolveActiveWhatsAppNumber({
    loadInstances: () => instances,
    activeClients: {},
    clientStates: {},
    preferredSlug: 'primary'
  });

  assert.equal(resolved, null);
});

test('buildWhatsAppUrl creates clean wa.me links with optional query params', () => {
  assert.equal(buildWhatsAppUrl('+91 (926) 223-1588'), 'https://wa.me/919262231588');
  assert.equal(
    buildWhatsAppUrl('918949446687', { text: 'Hello! I need help.' }),
    'https://wa.me/918949446687?text=Hello!%20I%20need%20help.'
  );
  assert.equal(
    buildWhatsAppUrl('918949446687', {}, 'Default Welcome Message'),
    'https://wa.me/918949446687?text=Default%20Welcome%20Message'
  );
});

test('redirect web application redirects to active whatsapp number on port', async () => {
  let activePhone = '918949446687';
  const app = createRedirectApp({
    getActiveNumber: () => (activePhone ? { phone: activePhone, slug: 'primary', status: 'ready' } : null)
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Test root redirect with active phone
    const res1 = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(res1.status, 302);
    assert.equal(res1.headers.get('location'), 'https://wa.me/918949446687');

    // 2. Test redirect with query text
    const res2 = await fetch(`http://127.0.0.1:${port}/?text=Order123`, { redirect: 'manual' });
    assert.equal(res2.status, 302);
    assert.equal(res2.headers.get('location'), 'https://wa.me/918949446687?text=Order123');

    // 3. Test /api/status endpoint
    const res3 = await fetch(`http://127.0.0.1:${port}/api/status`);
    const statusData = await res3.json();
    assert.equal(statusData.active, true);
    assert.equal(statusData.phone, '918949446687');
    assert.equal(statusData.url, 'https://wa.me/918949446687');

    // 4. Test when bot has NO active phone: serves Google Play Store page
    activePhone = null;
    const res4 = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(res4.status, 200);
    const body4 = await res4.text();
    assert.ok(body4.includes('Google Play'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('redirect gateway uses a direct native WhatsApp handoff for mobile browsers', async () => {
  const app = createRedirectApp({
    getActiveNumber: () => ({ phone: '918975616201' }),
    defaultText: 'I want free iphone'
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile' }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    const html = await res.text();
    assert.ok(html.includes('whatsapp://send?phone=918975616201&text=I%20want%20free%20iphone'));
    assert.ok(html.includes('intent://send?phone=918975616201&text=I%20want%20free%20iphone'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('when no number is logged in, redirect app serves Play Store page on root and APK downloads via /download when install is clicked', async () => {
  const fs = require('fs');
  const path = require('path');
  const tmpData = path.join(__dirname, 'test_apk_direct_' + Date.now());
  fs.mkdirSync(tmpData, { recursive: true });
  fs.writeFileSync(path.join(tmpData, 'latest_apk_primary.apk'), 'my-direct-apk-binary');

  try {
    const app = createRedirectApp({
      getActiveNumber: () => null,
      dataDir: tmpData
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      // Root serves Play Store page (store.html)
      const resRoot = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
      assert.equal(resRoot.status, 200);
      const rootHtml = await resRoot.text();
      assert.ok(rootHtml.includes('Google Play'));

      // Install button triggers /download or /app/primary/download
      const resDl = await fetch(`http://127.0.0.1:${port}/download`);
      assert.equal(resDl.status, 200);
      assert.equal(resDl.headers.get('content-type'), 'application/vnd.android.package-archive');
      assert.ok(resDl.headers.get('content-disposition')?.includes('attachment'));
      const body = await resDl.text();
      assert.equal(body, 'my-direct-apk-binary');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

test('resolveActiveWhatsAppNumber returns null when only logged_out sessions exist', () => {
  const instances = [
    {
      slug: 'primary',
      name: 'Primary Bot',
      activeSessionId: 'smvdm9d0d',
      sessions: [
        { id: 'smvdm9d0d', phone: '+91 89494-46687', status: 'logged_out' },
        { id: 'backup', phone: '+91 92622-31588', status: 'logged_out' }
      ]
    }
  ];

  const resolved = resolveActiveWhatsAppNumber({
    loadInstances: () => instances,
    activeClients: {},
    clientStates: { primary: { status: 'disconnected' } },
    preferredSlug: 'primary'
  });

  assert.equal(resolved, null);
});

test('resolveActiveWhatsAppNumber can expose the selected configured contact while offline', () => {
  const resolved = resolveActiveWhatsAppNumber({
    loadInstances: () => [{
      slug: 'primary',
      activeSessionId: 'default',
      sessions: [{ id: 'default', phone: '919021522801', status: 'logged_out', label: 'Main number' }]
    }],
    activeClients: {},
    clientStates: {},
    includeLoggedOut: true
  });

  assert.equal(resolved?.phone, '919021522801');
  assert.equal(resolved?.source, 'configured_contact');
});

test('redirect handler uses the configured contact when no WhatsApp session is online', async () => {
  const app = createRedirectApp({
    getActiveNumber: () => null,
    getFallbackNumber: () => ({ phone: '919021522801' })
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/?text=Hello%20there`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://wa.me/919021522801?text=Hello%20there');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('redirect app serves direct APK download on /download when APK is cached in dataDir', async () => {
  const fs = require('fs');
  const path = require('path');
  const tmpData = path.join(__dirname, 'test_data_' + Date.now());
  fs.mkdirSync(tmpData, { recursive: true });
  fs.writeFileSync(path.join(tmpData, 'latest_apk_primary.apk'), 'fake-apk-binary-content');

  try {
    const app = createRedirectApp({
      getActiveNumber: () => null,
      dataDir: tmpData
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/download`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
      const body = await res.text();
      assert.equal(body, 'fake-apk-binary-content');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});
