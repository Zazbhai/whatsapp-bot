const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { isSessionFailure } = require('./session-health');
const { sanitizeReplyLinks, dedupeConfiguredLink, stripLinksForSpeech } = require('./reply-links');
const { downloadVoiceMedia, describeVoiceError, voiceMediaState } = require('./voice-runtime');
const source = fs.readFileSync(require.resolve('./server'), 'utf8').replace(/\r\n/g, '\n');

function replyHarness({ demanded = true, synthesize, uploadError, voiceRewrite, isPureHindi = text => {
  const devanagari = (text.match(/[\u0900-\u097F]/g) || []).length;
  const latin = (text.match(/[a-z]/gi) || []).length;
  return devanagari >= 5 && latin / (devanagari + latin) <= 0.5;
} } = {}) {
  const events = [];
  const media = { data: 'voice-data' };
  const context = {
    activeClients: { main: {} },
    loadSeenUsers: () => [{ number: '123', demandedVoiceNote: false, voiceName: 'F1' }],
    isPureHindi,
    logInstanceEvent() {},
    isSessionFailure,
    sanitizeReplyLinks, dedupeConfiguredLink, stripLinksForSpeech,
    prepareUserFacingLink: (slug, number, text) => ({ text, containsLink: false }),
    features: { storeLink: () => 'https://store.customer.app/app/main' },
    createVoiceReplyMedia: async () => { events.push('synthesize'); return synthesize ? synthesize(context) : media; },
    generateAIResponse: async (...args) => { events.push('voice-rewrite'); return voiceRewrite ? voiceRewrite(...args) : { text: 'ऐप डाउनलोड करके खोलें।' }; },
    enqueueWhatsAppSend: async (slug, task) => { events.push('queue'); return task(); }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function sendSmartReply('), source.indexOf('async function resolveMuteChatCandidates')), context);
  const msg = { from: '123@lid', _voiceReplyRequested: demanded, reply: async (value, chatId, options) => {
    if (value === media && uploadError) throw uploadError;
    events.push(typeof value === 'string' ? 'text' : 'voice');
    if (value === media) assert.equal(options.sendAudioAsVoice, true);
  } };
  return { context, events, send: () => context.sendSmartReply('main', msg, null, 'App download karke open karein.') };
}

test('requested Hinglish voice replies synthesize before entering the WhatsApp send queue', async () => {
  let synthesizedText;
  const harness = replyHarness({ synthesize: () => { synthesizedText = 'ऐप डाउनलोड करके खोलें।'; return { data: 'voice-data' }; } });
  const deliveredAsVoice = await harness.send();
  assert.equal(deliveredAsVoice, true);
  assert.deepEqual(harness.events, ['voice-rewrite', 'synthesize', 'queue', 'voice']);
  assert.equal(synthesizedText, 'ऐप डाउनलोड करके खोलें।');
});

test('voice notes never synthesize URLs, including already-Hindi replies', async () => {
  let synthesizedText;
  const harness = replyHarness({ demanded: true, isPureHindi: () => true });
  harness.context.createVoiceReplyMedia = async (_slug, _msg, text) => {
    synthesizedText = text;
    return { data: 'voice-data' };
  };
  const msg = { from: '123@lid', _voiceReplyRequested: true, reply: async value => {
    harness.events.push(typeof value === 'string' ? 'text' : 'voice');
  } };
  await harness.context.sendSmartReply('main', msg, null,
    'नमस्ते, ऐप यहाँ देखें: https://store.customer.app/app/main');
  assert.equal(synthesizedText, 'नमस्ते, ऐप यहाँ देखें');
  assert.equal(synthesizedText.includes('store.customer.app'), false);
  assert.ok(stripLinksForSpeech('यह ऐप customer.app/download से लें।').includes('यह ऐप'));
});

test('a voice request is consumed after one reply', async () => {
  const harness = replyHarness();
  await harness.send();
  harness.events.length = 0;
  await harness.context.sendSmartReply('main', { from: '123@lid', reply: async value => {
    harness.events.push(typeof value === 'string' ? 'text' : 'voice');
  } }, null, 'A later answer');
  assert.deepEqual(harness.events, ['queue', 'text']);
});

test('repeated questions are eligible for one voice reply', () => {
  const context = {
    loadMemory: () => ({ '123': [{ role: 'user', content: 'Where is my order?' }] })
  };
  vm.createContext(context);
  const start = source.indexOf('function getConversationHistory(');
  const end = source.indexOf('function addToMemory(', start);
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.isRepeatedQuestion('main', '123', 'Where is my order?'), true);
  assert.equal(context.isRepeatedQuestion('main', '123', 'Hi'), false);
});

test('only an explicit voice request enables voice mode; a PTT message alone does not', () => {
  const start = source.indexOf('function checkAndSetVoiceNoteDemand(');
  const end = source.indexOf('async function createVoiceReplyMedia', start);
  const context = {
    isDirectChatId: id => /@(c\.us|lid)$/.test(id),
    loadSeenUsers: () => [],
    updateUserVoiceSettings: () => ({ voiceName: 'F1' }),
    logInstanceEvent() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const voiceNote = { from: '123@lid', type: 'ptt', hasMedia: true, body: '' };
  context.checkAndSetVoiceNoteDemand('main', '123', voiceNote);
  assert.equal(voiceNote._voiceReplyRequested, undefined);
  const explicit = { from: '123@lid', type: 'chat', hasMedia: false, body: 'Please send a voice note' };
  context.checkAndSetVoiceNoteDemand('main', '123', explicit);
  assert.equal(explicit._voiceReplyRequested, true);
});

test('failed Hindi rewrite falls back to text instead of speaking Hinglish', async () => {
  let synthesized = false;
  const harness = replyHarness({
    voiceRewrite: () => null,
    synthesize: () => { synthesized = true; return { data: 'voice-data' }; }
  });
  await harness.send();
  assert.equal(synthesized, false);
  assert.deepEqual(harness.events, ['voice-rewrite', 'queue', 'text']);
});

test('automatic Hindi replies stay text until voice is requested', async () => {
  let selectedVoice;
  const harness = replyHarness({
    demanded: false,
    isPureHindi: text => /[\u0900-\u097F]/.test(text),
    synthesize: () => ({ data: 'voice-data' })
  });
  harness.context.createVoiceReplyMedia = async (slug, msg, text, voiceName) => { selectedVoice = voiceName; return { data: 'voice-data' }; };
  const start = source.indexOf('async function sendSmartReply(');
  assert.match(source.slice(start, source.indexOf('async function sendSmartReplyNow', start)), /const voiceName = 'F1'/);
  await harness.context.sendSmartReply('main', { from: '123@lid', reply: async () => {} }, null, 'नमस्ते, कैसे हैं?');
  assert.equal(selectedVoice, undefined);
});

test('normal Latin text replies remain text when voice was not requested', async () => {
  const harness = replyHarness({ demanded: false });
  await harness.send();
  assert.deepEqual(harness.events, ['queue', 'text']);
});

test('speech synthesis errors preserve the text reply', async () => {
  const harness = replyHarness({ synthesize: () => { throw new Error('Missing speech model'); } });
  await harness.send();
  assert.deepEqual(harness.events, ['voice-rewrite', 'synthesize', 'queue', 'text']);
});

test('a session change during synthesis cannot replay the reply on the replacement client', async () => {
  const harness = replyHarness({ synthesize: context => { context.activeClients.main = {}; return {}; } });
  await assert.rejects(harness.send(), /Session changed while generating reply/);
  assert.deepEqual(harness.events, ['voice-rewrite', 'synthesize']);
});

test('voice upload errors fall back to text but session failures reach recovery', async () => {
  const upload = replyHarness({ uploadError: new Error('Unsupported media') });
  await upload.send();
  assert.deepEqual(upload.events, ['voice-rewrite', 'synthesize', 'queue', 'text']);
  const session = replyHarness({ uploadError: new Error('Target closed') });
  await assert.rejects(session.send(), /Target closed/);
  assert.deepEqual(session.events, ['voice-rewrite', 'synthesize', 'queue']);
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
    downloadVoiceMedia, describeVoiceError, voiceMediaState,
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
