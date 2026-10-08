const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildCompatibleUtils } = require('./whatsapp-compat');

test('WhatsApp new IDs work for chat and last-message lookups', () => {
  function loader() {
    const chat = { id: { $1: 'group@g.us' }, lastReceivedKey: { $1: 'message-123' } };
    const newMsgKey = { $1: 'sent-123' };
    return [chat.id._serialized, chat.lastReceivedKey._serialized, newMsgKey._serialized];
  }
  assert.deepEqual(buildCompatibleUtils(loader)(), ['group@g.us', 'message-123', 'sent-123']);
});
test('legacy WhatsApp IDs remain supported', () => {
  function loader() {
    const chat = { id: { _serialized: 'old-chat' }, lastReceivedKey: { _serialized: 'old-message' } };
    return [chat.id._serialized, chat.lastReceivedKey._serialized];
  }
  assert.deepEqual(buildCompatibleUtils(loader)(), ['old-chat', 'old-message']);
});
test('incoming message IDs and remote addresses normalize for replies and deduplication', () => {
  function loader() {
    const msg = { id: { $1: 'incoming-123', remote: { $1: 'sender@lid' } }, pendingAckUpdate: true };
    msg.id.remote = msg.id.remote._serialized;
    delete msg.pendingAckUpdate;
    return msg;
  }
  assert.deepEqual(buildCompatibleUtils(loader)(), { id: { $1: 'incoming-123', _serialized: 'incoming-123', remote: 'sender@lid' } });
});
test('APK media data cannot overwrite the outgoing message ID', () => {
  function loader() {
    const message = { __x_id: 'media-model-id', body: 'apk' };
    const botOptions = false;
    if (botOptions) { delete message.body; }
    return message;
  }
  assert.deepEqual(buildCompatibleUtils(loader)(), { body: 'apk' });
});

const source = fs.readFileSync(require.resolve('./server'), 'utf8');
test('a failed unread chat does not prevent another unread message from being queued', async () => {
  const start = source.indexOf('async function detectAndQueueUnrepliedMessages');
  const end = source.indexOf('// Shared rules path', start);
  const msg = { from: '123@c.us', fromMe: false, timestamp: Date.now() / 1000, id: { _serialized: 'm1' } };
  const emitted = [];
  const logs = [];
  const context = { console, Date, Set, loadInstances: () => [], loadIgnoredUsers: () => [], loadSeenUsers: () => [],
    process: { env: {} }, clientStates: { main: { processedMessageIds: new Set() } },
    logInstanceEvent: (...args) => logs.push(args), setTimeout };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const base = { unreadCount: 1, id: { user: '123', server: 'c.us' } };
  await context.detectAndQueueUnrepliedMessages('main', {
    getChats: async () => [
      { ...base, fetchMessages: async () => { throw new Error('r'); } },
      { ...base, fetchMessages: async () => [msg] }
    ], emit: (event, message) => emitted.push({ event, message })
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].message.id._serialized, 'm1');
  assert.equal(logs.some((entry) => entry[2].includes('Skipping unread chat')), true);
});
test('a never-finishing read receipt cannot hold up a new incoming reply', async () => {
  const start = source.indexOf("  client.on('message', async (msg) => {");
  const end = source.indexOf('\n  try {\n    activeClients[slug] = client;', start);
  let handler;
  const queued = [];
  const context = { console, Date, Set, slug: 'main',
    client: { on: (event, callback) => { handler = callback; }, sendSeen: () => new Promise(() => {}) },
    clientStates: { main: { processedMessageIds: new Set(), stats: { received: 0 } } },
    io: { to: () => ({ emit() {} }) }, features: { checkWatchWords() {}, reportSessionError: async () => {} },
    loadIgnoredUsers: () => [], loadSeenUsers: () => [], loadInstances: () => [],
    recordSpamMessage: () => false, checkAndSetVoiceNoteDemand() {}, logInstanceEvent() {},
    enqueueMessage: (slug, number, msg) => queued.push(msg), process: { env: {} }
  };
  context.activeClients = { main: context.client };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const msg = { from: '123@c.us', id: { _serialized: 'live-1' }, body: 'hi', _data: {},
    getChat: () => { throw new Error('Chat lookup must not block text receipt'); } };
  let timer;
  try {
    await Promise.race([handler(msg), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Incoming handler blocked')), 100); })]);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].body, 'hi');
    await handler(msg);
    assert.equal(queued.length, 1);
  } finally { clearTimeout(timer); }
});