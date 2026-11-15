const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { isSessionFailure } = require('./session-health');
const { sanitizeReplyLinks } = require('./reply-links');
const source = fs.readFileSync(require.resolve('./server'), 'utf8').replace(/\r\n/g, '\n');

function replyHarness({ demanded = true, synthesize, uploadError } = {}) {
  const events = [];
  const media = { data: 'voice-data' };
  const context = {
    activeClients: { main: {} },
    loadSeenUsers: () => [{ number: '123', demandedVoiceNote: demanded, voiceName: 'F1' }],
    isPureHindi: () => false,
    logInstanceEvent() {},
    isSessionFailure,
    sanitizeReplyLinks, features: { storeLink: () => 'https://store.customer.app/app/main' },
    createVoiceReplyMedia: async () => { events.push('synthesize'); return synthesize ? synthesize(context) : media; },
    enqueueWhatsAppSend: async (slug, task) => { events.push('queue'); return task(); }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function sendSmartReply('), source.indexOf('async function resolveMuteChatCandidates')), context);
  const msg = { from: '123@lid', reply: async (value, chatId, options) => {
    if (value === media && uploadError) throw uploadError;
    events.push(typeof value === 'string' ? 'text' : 'voice');
    if (value === media) assert.equal(options.sendAudioAsVoice, true);
  } };
  return { context, events, send: () => context.sendSmartReply('main', msg, null, 'App download karke open karein.') };
}

test('requested Hinglish voice replies synthesize before entering the WhatsApp send queue', async () => {
  const harness = replyHarness();
  await harness.send();
  assert.deepEqual(harness.events, ['synthesize', 'queue', 'voice']);
});

test('normal Latin text replies remain text when voice was not requested', async () => {
  const harness = replyHarness({ demanded: false });
  await harness.send();
  assert.deepEqual(harness.events, ['queue', 'text']);
});

test('speech synthesis errors preserve the text reply', async () => {
  const harness = replyHarness({ synthesize: () => { throw new Error('Missing speech model'); } });
  await harness.send();
  assert.deepEqual(harness.events, ['synthesize', 'queue', 'text']);
});

test('a session change during synthesis cannot replay the reply on the replacement client', async () => {
  const harness = replyHarness({ synthesize: context => { context.activeClients.main = {}; return {}; } });
  await assert.rejects(harness.send(), /Session changed while generating reply/);
  assert.deepEqual(harness.events, ['synthesize']);
});

test('voice upload errors fall back to text but session failures reach recovery', async () => {
  const upload = replyHarness({ uploadError: new Error('Unsupported media') });
  await upload.send();
  assert.deepEqual(upload.events, ['synthesize', 'queue', 'text']);
  const session = replyHarness({ uploadError: new Error('Target closed') });
  await assert.rejects(session.send(), /Target closed/);
  assert.deepEqual(session.events, ['synthesize', 'queue']);
});

function incomingHarness(transcription) {
  const queued = [];
  const replies = [];
  let attempts = 0;
  let prompted = 0;
  let handler;
  const client = { on: (event, callback) => { handler = callback; }, sendSeen: async () => {} };
  const context = {
    slug: 'main', client, activeClients: { main: client },
    clientStates: { main: { processedMessageIds: new Set(), stats: { received: 0 } } },
    io: { to: () => ({ emit() {} }) },
    features: { checkWatchWords() {}, reportSessionError: async () => {} },
    loadInstances: () => [], loadSeenUsers: () => [], loadIgnoredUsers: () => [],
    recordSpamMessage: () => false, logInstanceEvent() {},
    isDirectChatId: id => /@(c\.us|lid)$/.test(id || ''),
    checkAndSetVoiceNoteDemand() {}, process: { env: {} },
    markVoiceNoteTextPrompted: () => { prompted++; return true; },
    enqueueWhatsAppSend: async (slug, task) => task(),
    transcribeAudio: async () => { attempts++; return transcription; },
    enqueueMessage: (slug, number, msg) => queued.push(msg.body)
  };
  vm.createContext(context);
  const start = source.indexOf("  client.on('message', async (msg) => {");
  vm.runInContext(source.slice(start, source.indexOf('\n  try {\n    activeClients[slug] = client;', start)), context);
  const msg = {
    from: '123@lid', type: 'ptt', hasMedia: true, body: '', _data: {}, id: { _serialized: 'voice-1' },
    downloadMedia: async () => ({ data: 'audio' }), reply: async text => replies.push(text)
  };
  return { queued, replies, attempts: () => attempts, prompted: () => prompted, receive: () => handler(msg) };
}

test('the first voice note from an LID sender is transcribed and queued', async () => {
  const harness = incomingHarness('Mujhe app chahiye');
  await harness.receive();
  assert.equal(harness.attempts(), 1);
  assert.equal(harness.prompted(), 0);
  assert.deepEqual(harness.queued, ['Mujhe app chahiye']);
  assert.deepEqual(harness.replies, []);
});

test('failed transcription asks for text only after trying speech recognition', async () => {
  const harness = incomingHarness(null);
  await harness.receive();
  assert.equal(harness.attempts(), 1);
  assert.equal(harness.prompted(), 1);
  assert.deepEqual(harness.queued, []);
  assert.match(harness.replies[0], /couldn't understand/);
});

test('placeholder HF tokens select local recognition and clean up temporary files', async () => {
  const files = new Map();
  const commands = [];
  const context = {
    __dirname, path, Buffer, dataDir: __dirname, logInstanceEvent() {},
    process: { env: { HF_TOKENS: 'hf_your_token_here' } },
    fs: {
      writeFileSync: (name, data) => files.set(name, data),
      readFileSync: name => files.get(name), existsSync: name => files.has(name),
      unlinkSync: name => files.delete(name)
    },
    resolvePython: () => 'python',
    runVoiceProcess: async (command, args) => {
      commands.push({ command, args });
      if (command === 'ffmpeg') { files.set(args.at(-1), Buffer.from('wav')); return ''; }
      return JSON.stringify({ text: 'नमस्ते' });
    }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function getHuggingFaceTokens'), source.indexOf('// Initialize active WhatsApp Client')), context);
  assert.equal(await context.transcribeAudio('main', { data: 'YXVkaW8=', mimetype: 'audio/ogg' }), 'नमस्ते');
  assert.equal(commands.length, 2);
  assert.notEqual(commands[0].args[2], commands[0].args.at(-1));
  assert.equal(commands[1].args[0], path.join(__dirname, 'transcribe_audio.py'));
  assert.equal(files.size, 0);
  commands.length = 0;
  assert.equal(await context.transcribeAudio('main', { data: 'YXVkaW8=', mimetype: 'audio/wav' }), 'नमस्ते');
  assert.notEqual(commands[0].args[2], commands[0].args.at(-1));
  assert.equal(files.size, 0);
});
