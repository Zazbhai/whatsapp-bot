const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { selectStoreBaseUrl, sanitizeReplyLinks, dedupeConfiguredLink, buildAppLinkInstructions } = require('./reply-links');
const realLink = 'https://store.customer.app/app/primary';

test('placeholder links are replaced with the configured app URL, including bare and formatted links', () => {
  for (const link of [
    'https://example.com/download.apk?campaign=test', 'http://EXAMPLE.ORG/app',
    'example.com', 'www.example.net/download', 'https://downloads.example.com/app',
    'https://your-domain.com/app', 'https://localhost:3000/app', 'https://store.invalid/download'
  ]) {
    assert.equal(sanitizeReplyLinks(`Download: ${link}`, realLink), `Download: ${realLink}`);
  }
  assert.equal(sanitizeReplyLinks('[Download](https://example.com/app).', realLink), `[Download](${realLink}).`);
  assert.equal(sanitizeReplyLinks('*https://example.com/app*', realLink), `*${realLink}*`);
  assert.equal(sanitizeReplyLinks('Download {link}', realLink), `Download ${realLink}`);
});

test('unrelated links, domain lookalikes, and email addresses are preserved', () => {
  const text = 'See https://help.customer.app/example.com and example.com.customer.app or email help@example.com.';
  assert.equal(sanitizeReplyLinks(text, realLink), text);
  assert.equal(sanitizeReplyLinks(realLink, realLink), realLink);
});

test('store URLs appear once per reply and are omitted from a recent repeat', () => {
  assert.equal(
    dedupeConfiguredLink(`Get the app: ${realLink}. Download again: ${realLink}`, realLink),
    `Get the app: ${realLink}. Download again:`
  );
  assert.equal(
    dedupeConfiguredLink(`Get the app: ${realLink}. Another link: ${realLink}`, realLink, true),
    'Get the app. Another link'
  );
  assert.equal(dedupeConfiguredLink('No link here.', realLink, true), 'No link here.');
});

test('a missing public URL removes placeholder destinations instead of inventing a link', () => {
  const reply = sanitizeReplyLinks('Download https://example.com/app', 'http://localhost:3000/app/main');
  assert.equal(reply, 'Download (app link unavailable)');
  assert.match(buildAppLinkInstructions('http://localhost:3000'), /No public app link is configured/);
});

test('store URL selection skips placeholder settings and retains valid overrides', () => {
  assert.equal(selectStoreBaseUrl(['https://example.com', 'store.customer.app'], 'http://localhost:3000'), 'https://store.customer.app');
  assert.equal(selectStoreBaseUrl(['https://custom.customer.app/', 'store.customer.app'], ''), 'https://custom.customer.app');
  assert.equal(selectStoreBaseUrl(['not a url', 'javascript:alert(1)'], 'http://localhost:3000'), 'http://localhost:3000');
});

test('APK captions and store links share the real configured destination', () => {
  const featureSource = fs.readFileSync(require.resolve('./features'), 'utf8');
  const inst = { storeListing: { publicUrl: 'https://example.com' }, apkLinkMessage: 'Download https://example.com/app or {link}' };
  const context = {
    selectStoreBaseUrl, sanitizeReplyLinks, dedupeConfiguredLink, getInst: () => inst,
    process: { env: { STORE_ENTRY_DOMAIN: 'https://store.customer.app' } },
    port: 3000, DEFAULT_LINK_MSG: 'Download {link}'
  };
  vm.createContext(context);
  vm.runInContext(featureSource.slice(featureSource.indexOf('  function baseUrl('), featureSource.indexOf('  const apkInfo =')), context);
  assert.equal(context.storeLink('primary'), realLink);
  assert.equal(context.apkCaption('primary').split(realLink).length - 1, 1);
  inst.apkLinkMessage = 'Here is your app.';
  assert.equal(context.apkCaption('primary'), `Here is your app.\n\n${realLink}`);
  assert.equal(context.apkCaption('primary', 'Custom caption.'), `Custom caption.\n\n${realLink}`);
  assert.equal(context.apkCaption('primary', ''), realLink);

  // Exercise the shared APK send helper after a previous link starts the cooldown.
  const serverSource = fs.readFileSync(require.resolve('./server'), 'utf8');
  context.features = { apkCaption: context.apkCaption, storeLink: context.storeLink };
  vm.runInContext(serverSource.slice(serverSource.indexOf('const recentStoreLinkSends ='), serverSource.indexOf('async function sendSmartReply(')), context);
  context.markStoreLinkSent('primary', '1234');
  for (let i = 0; i < 2; i++) {
    assert.equal(context.userApkCaption('primary', '1234'), `Here is your app.\n\n${realLink}`);
  }
  assert.equal(context.prepareUserFacingLink('primary', '1234', `Get the app ${realLink}`).containsLink, false);
});

test('AI receives the real link and corrected assistant history; placeholder output is corrected before use', async () => {
  const serverSource = fs.readFileSync(require.resolve('./server'), 'utf8').replace(/\r\n/g, '\n');
  let payload;
  const context = {
    __dirname, path, setTimeout, clearTimeout, sanitizeReplyLinks, buildAppLinkInstructions,
    process: { env: {} }, features: { storeLink: () => realLink },
    DEFAULT_AI_CONFIG: { aiSystemPrompt: 'Help with the app.', aiApkInstructions: 'Use [SEND_APK] for the APK.' },
    getInstanceBySlug: () => ({ slug: 'primary' }), initApiKeysRegistryIfEmpty() {},
    apiKeysRegistry: { fake: { key: 'fake', provider: 'openrouter' } }, apiKeysRoundRobin: 0,
    logInstanceEvent() {},
    parseAIResponse: content => ({ text: content, sendApk: false }),
    fork: () => {
      const child = new EventEmitter();
      child.send = data => {
        payload = data;
        setImmediate(() => child.emit('message', { status: 'success', content: 'Download https://example.com/app' }));
      };
      return child;
    }
  };
  vm.createContext(context);
  vm.runInContext(serverSource.slice(serverSource.indexOf('function buildSystemPrompt'), serverSource.indexOf('function detectProcessIntent')), context);
  vm.runInContext(serverSource.slice(serverSource.indexOf('async function generateAIResponse('), serverSource.indexOf('// Retrieve and filter all Hugging Face tokens')), context);
  const result = await context.generateAIResponse('primary', 'Send the link', [
    { role: 'assistant', content: 'Try https://example.com/app' },
    { role: 'user', content: 'example.com did not work' }
  ]);
  assert.equal(result.text, `Download ${realLink}`);
  assert.ok(payload.systemPrompt.includes(realLink));
  assert.match(payload.systemPrompt, /Never invent URLs/);
  assert.equal(payload.history[0].content, `Try ${realLink}`);
  assert.equal(payload.history[1].content, 'example.com did not work');
});
