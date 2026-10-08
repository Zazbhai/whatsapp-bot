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
    enqueueMessage: (slug, number, msg) => queued.push(msg), process: { env: {} },
    isDirectChatId: (id) => /@(c\.us|lid)$/.test(id || '')
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
test('incoming messages with the new WhatsApp ID format keep a readable sender', () => {
  const { normalizeStructureData } = require('./whatsapp-compat');
  const data = normalizeStructureData({
    id: { $1: 'false_123@lid_ABC', fromMe: false, remote: { $1: '123@lid' } },
    from: { $1: '123@lid' }, to: { $1: '919999999999@c.us' }, body: 'hi'
  });
  assert.equal(data.id._serialized, 'false_123@lid_ABC');
  assert.equal(data.id.remote._serialized, '123@lid');
  assert.equal(data.from._serialized, '123@lid');
  assert.equal(data.to._serialized, '919999999999@c.us');
});

test('patched WhatsApp structures read the sender from the new ID format', () => {
  const { patchStructures } = require('./whatsapp-compat');
  class Message { constructor(data) { this._patch(data); } _patch(data) { this.from = typeof data.from === 'object' ? data.from._serialized : data.from; this.id = data.id; } }
  patchStructures((name) => { if (name === 'Message') return Message; throw new Error('missing'); });
  patchStructures((name) => { if (name === 'Message') return Message; throw new Error('missing'); });
  const msg = new Message({ id: { $1: 'm-1' }, from: { $1: '555@lid' } });
  assert.equal(msg.from, '555@lid');
  assert.equal(msg.id._serialized, 'm-1');
  const legacy = new Message({ id: { _serialized: 'm-2' }, from: { _serialized: '911@c.us' } });
  assert.equal(legacy.from, '911@c.us');
});

test('private chats using the new @lid address count as direct chats', () => {
  const start = source.indexOf('function isDirectChatId');
  const end = source.indexOf('function checkAndSetVoiceNoteDemand', start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.isDirectChatId('123456@lid'), true);
  assert.equal(context.isDirectChatId('919999999999@c.us'), true);
  assert.equal(context.isDirectChatId('12345-678@g.us'), false);
  assert.equal(context.isDirectChatId(undefined), false);
});
