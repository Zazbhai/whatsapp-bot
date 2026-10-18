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

    // 4. Test when bot has NO active phone
    activePhone = null;
    const res4 = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(res4.status, 200);
    const html = await res4.text();
    assert.ok(html.includes('Connecting to WhatsApp'));
    assert.ok(html.includes('http-equiv="refresh"'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
