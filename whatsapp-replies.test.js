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

const source = fs.readFileSync(require.resolve('./server'), 'utf8').replace(/\r\n/g, '\n');
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

test('a failed shorter-reply retry keeps the earlier AI reply instead of sending nothing', () => {
  const start = source.indexOf('      const maxRetries = 1;');
  const end = source.indexOf('      // If still too long after max retries', start);
  assert.ok(start > 0 && end > start);
  const body = `(async () => { let replyText = first; let finalSendApk = false, finalOrderComplete = false, finalAskOrder = false; let aiResult;
${source.slice(start, end)}
return { replyText, calls }; })();`;
  const context = { first: 'One. Two. Three. Four.', calls: 0, countSentences: (t) => t.split('.').filter(Boolean).length,
    logInstanceEvent() {}, slug: 'main', msg: { body: 'Give me apk' }, history: [], senderNumber: '1' };
  context.generateAIResponse = async () => { context.calls++; return null; };
  vm.createContext(context);
  return vm.runInContext(body.replace('return { replyText, calls }', 'return { replyText, calls: globalThis.calls }'), context).then((r) => {
    assert.equal(r.replyText, 'One. Two. Three. Four.');
    assert.equal(r.calls, 1);
  });
});

test('parseAIResponse completely strips reasoning tags and extracts proper reply', () => {
  const start = source.indexOf('function parseAIResponse');
  const end = source.indexOf('function detectApkIntent', start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  // 1. Clean response
  const r1 = context.parseAIResponse('Hello! Aap kaise hain?');
  assert.equal(r1.text, 'Hello! Aap kaise hain?');

  // 2. <think> tag stripped
  const r2 = context.parseAIResponse('<think>User is greeting. Reply politely.</think>Namaste! Kaise ho?');
  assert.equal(r2.text, 'Namaste! Kaise ho?');

  // 3. Unclosed <think> tag stripped
  const r3 = context.parseAIResponse('<think>User is asking how to download... I should check rules');
  assert.equal(r3.text, null);

  // 4. Thought process with explicit reply marker
  const r4 = context.parseAIResponse(`Thinking Process:
1. User asked for app download
2. Persona requires Hinglish
Final Response:
App download karne ke liye upar wale link par click karein!`);
  assert.equal(r4.text, 'App download karne ke liye upar wale link par click karein!');

  // 5. Pure thought / system prompt leak rejected
  const r5 = context.parseAIResponse(`was too long or had reasoning)
   - Must not include thought process, analysis, or explanation
   - Must output only the direct response
   - If user has installed & ordered, add or , but this doesn't seem to be the case here - they're just asking how to download
   - The user previously got a link, asked about app status, asked about free iPhone, etc. No clear order confirmation yet.`);
  assert.equal(r5.text, null);

  // 6. Emotion expression tags like <laugh> and <sigh> preserved
  const r6 = context.parseAIResponse('Haan bilkul <laugh> main theek hoon! <sigh>');
  assert.equal(r6.text, 'Haan bilkul <laugh> main theek hoon! <sigh>');
});

test('buildSystemPrompt falls back to premade DEFAULT_AI_CONFIG when fields are empty', () => {
  const startCfg = source.indexOf('const DEFAULT_AI_CONFIG =');
  const endCfg = source.indexOf('// Bootstrap default bot instance', startCfg);
  const startPrompt = source.indexOf('function buildSystemPrompt');
  const endPrompt = source.indexOf('function detectProcessIntent', startPrompt);

  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(startCfg, endCfg) + '\n' + source.slice(startPrompt, endPrompt), context);

  // When instance has empty or undefined persona, premade persona is automatically applied
  const emptyInst = { slug: 'test' };
  const prompt = context.buildSystemPrompt(emptyInst);
  assert.ok(prompt.includes('One Shop app'));
  assert.ok(prompt.includes('RULES & PERSONA'));
  assert.ok(prompt.includes('[SEND_APK]'));
});


