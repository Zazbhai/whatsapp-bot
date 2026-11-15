const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { isGreetingOnly } = require('./bot-policy');

const source = fs.readFileSync(require.resolve('./server'), 'utf8').replace(/\r\n/g, '\n');

test('anti-spam debounce combines rapid messages of the same category into one prompt, dropping standalone greetings', async () => {
  const start = source.indexOf('const pendingDebounces = {};');
  const end = source.indexOf('async function processCombinedMessage', start);
  assert.ok(start > -1 && end > -1, 'Debounce snippet found in server.js');

  const processedTasks = [];
  const logs = [];

  const context = {
    console,
    Date,
    Set,
    Map,
    setTimeout,
    clearTimeout,
    isGreetingOnly,
    process: { env: { MESSAGE_DEBOUNCE_MS: '50' } }, // 50ms for fast test execution
    isSpamCoolingDown: () => false,
    spamCooldowns: {},
    logInstanceEvent: (...args) => logs.push(args),
    enqueueIncomingProcessing: async (slug, fn) => {
      await fn();
    },
    processCombinedMessage: async (slug, senderNumber, msg) => {
      processedTasks.push({ slug, senderNumber, body: msg.body, combinedCount: msg._combinedCount, tagTarget: msg._tagTarget });
    }
  };

  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  // User sends 3 messages: greeting + 2 substantive in same category (APK_PROCESS)
  context.enqueueMessage('primary', '919876543210', {
    from: '919876543210@c.us',
    body: 'hi',
    id: { _serialized: 'm1' }
  });

  await new Promise(r => setTimeout(r, 15));

  context.enqueueMessage('primary', '919876543210', {
    from: '919876543210@c.us',
    body: 'i want iphone',
    id: { _serialized: 'm2' }
  });

  await new Promise(r => setTimeout(r, 15));

  context.enqueueMessage('primary', '919876543210', {
    from: '919876543210@c.us',
    body: 'how to get it',
    id: { _serialized: 'm3' }
  });

  // Wait for 50ms debounce window to fire
  await new Promise(r => setTimeout(r, 200));

  assert.equal(processedTasks.length, 1, 'Only one combined processing task should be executed for same category');
  assert.equal(processedTasks[0].body, 'i want iphone\nhow to get it', 'Greeting "hi" is dropped and substantive questions merged');
  assert.equal(processedTasks[0].tagTarget, undefined, 'Single category reply should not force tagTarget');
  assert.ok(logs.some(l => l[2].includes('single category: APK_PROCESS')), 'Should log single category detection');
});

test('context-aware grouping: differentiates categories and sends separate tagged replies', async () => {
  const start = source.indexOf('const pendingDebounces = {};');
  const end = source.indexOf('async function processCombinedMessage', start);
  assert.ok(start > -1 && end > -1, 'Debounce snippet found in server.js');

  const processedTasks = [];
  const logs = [];

  const context = {
    console,
    Date,
    Set,
    Map,
    setTimeout,
    clearTimeout,
    isGreetingOnly,
    process: { env: { MESSAGE_DEBOUNCE_MS: '40' } },
    isSpamCoolingDown: () => false,
    spamCooldowns: {},
    logInstanceEvent: (...args) => logs.push(args),
    enqueueIncomingProcessing: async (slug, fn) => {
      await fn();
    },
    processCombinedMessage: async (slug, senderNumber, msg) => {
      processedTasks.push({
        slug,
        senderNumber,
        body: msg.body,
        category: msg._category,
        tagTargetId: msg._tagTarget ? msg._tagTarget.id._serialized : null
      });
    }
  };

  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  // Exact user scenario: 4 messages in rapid succession
  // 1. hello (Greeting - dropped)
  // 2. please send apk (APK_PROCESS)
  // 3. whats the process (APK_PROCESS - merged with 2)
  // 4. when will delivery will come after order (DELIVERY - separate category)
  context.enqueueMessage('primary', '919876543210', {
    from: '919876543210@c.us',
    body: 'hello',
    id: { _serialized: 'msg-1' }
  });
  context.enqueueMessage('primary', '919876543210', {
    from: '919876543210@c.us',
    body: 'please send apk',
    id: { _serialized: 'msg-2' }
  });
  context.enqueueMessage('primary', '919876543210', {
    from: '919876543210@c.us',
    body: 'whats the process',
    id: { _serialized: 'msg-3' }
  });
  context.enqueueMessage('primary', '919876543210', {
    from: '919876543210@c.us',
    body: 'when will delivery will come after order',
    id: { _serialized: 'msg-4' }
  });

  // Wait for 40ms debounce window + cluster loop processing
  await new Promise(r => setTimeout(r, 2200));

  // Should generate exactly 2 category replies
  assert.equal(processedTasks.length, 2, 'Should send exactly 2 replies for the 2 distinct categories');

  // Reply 1: APK_PROCESS (merges 2 & 3, tags msg-3)
  assert.equal(processedTasks[0].category, 'APK_PROCESS');
  assert.equal(processedTasks[0].body, 'please send apk\nwhats the process');
  assert.equal(processedTasks[0].tagTargetId, 'msg-3', 'Reply 1 should tag the APK/process question');

  // Reply 2: DELIVERY (tags msg-4)
  assert.equal(processedTasks[1].category, 'DELIVERY');
  assert.equal(processedTasks[1].body, 'when will delivery will come after order');
  assert.equal(processedTasks[1].tagTargetId, 'msg-4', 'Reply 2 should tag the delivery question');

  assert.ok(logs.some(l => l[2].includes('Detected 2 distinct categories')), 'Should log category detection');
});

test('sendDirectMessage sends without quoting or tagging by default, but respects _tagTarget when present', async () => {
  const start = source.indexOf('async function sendDirectMessage(');
  const end = source.indexOf('// Automatically check', start);
  assert.ok(start > -1 && end > -1, 'sendDirectMessage snippet found in server.js');

  const sentClientMessages = [];
  const sentChatMessages = [];

  const mockClient = {
    sendMessage: async (chatId, content, options) => {
      sentClientMessages.push({ chatId, content, options });
      return { id: { _serialized: 'sent-1' } };
    }
  };

  const mockChat = {
    id: { _serialized: '12345@c.us' },
    sendMessage: async (content, options) => {
      sentChatMessages.push({ content, options });
      return { id: { _serialized: 'sent-chat-1' } };
    }
  };

  const context = {
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    activeClients: { primary: mockClient },
    isSessionFailure: () => false,
    logInstanceEvent: () => {}
  };

  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  // 1. Sending normal message without tagTarget -> no quotedMessageId
  const msgWithoutTag = { from: '12345@c.us' };
  await context.sendDirectMessage('primary', msgWithoutTag, mockChat, 'Direct chat reply without tag');

  assert.equal(sentChatMessages.length, 1);
  assert.equal(sentChatMessages[0].content, 'Direct chat reply without tag');
  assert.equal(sentChatMessages[0].options.quotedMessageId, undefined, 'Must not quote when no tagTarget');

  // 2. Sending message with _tagTarget -> passes quotedMessageId to WhatsApp
  const targetMsg = { id: { _serialized: 'target-question-123' } };
  const msgWithTag = { from: '98765@c.us', _tagTarget: targetMsg };
  await context.sendDirectMessage('primary', msgWithTag, null, 'Reply tagging question');

  assert.equal(sentClientMessages.length, 1);
  assert.equal(sentClientMessages[0].chatId, '98765@c.us');
  assert.equal(sentClientMessages[0].content, 'Reply tagging question');
  assert.equal(sentClientMessages[0].options.quotedMessageId, 'target-question-123', 'Must set quotedMessageId to target message');
});

test('false-positive order recovery: unmarks ordered state and restores pipeline on un-ordered inquiry, stays silent otherwise', () => {
  const { isUnorderedInquiry } = require('./bot-policy');

  let ignored = ['919999999999'];
  let seen = [{ number: '919999999999', ordered: true, orderedTime: Date.now() }];
  const logs = [];

  function simulateIncomingCheck(msg) {
    const slug = 'primary';
    const senderNumber = msg.from.split('@')[0];
    const isDirectChatId = id => !id.includes('@g.us');
    const users = isDirectChatId(msg.from) ? seen : [];
    const userEntry = users.find(u => u.number === senderNumber);
    const isOrderedUser = Boolean(userEntry?.ordered);
    const isIgnored = ignored.includes(senderNumber);

    if (isIgnored || isOrderedUser) {
      if (isUnorderedInquiry(msg.body)) {
        logs.push(`RESTORED: ${msg.body}`);
        if (isOrderedUser) {
          userEntry.ordered = false;
          delete userEntry.orderedTime;
        }
        if (isIgnored) {
          ignored = ignored.filter(n => n !== senderNumber);
        }
        return 'PROCEED_TO_PIPELINE';
      } else {
        logs.push(`SILENT_DROP: ${msg.body}`);
        return 'SILENT_DROP';
      }
    }
    return 'PROCEED_TO_PIPELINE';
  }

  // 1. Casual acknowledgement messages must be SILENTLY DROPPED (no response, remains ordered/ignored)
  const result1 = simulateIncomingCheck({ from: '919999999999@c.us', body: 'ok' });
  assert.equal(result1, 'SILENT_DROP');
  assert.equal(seen[0].ordered, true);
  assert.ok(ignored.includes('919999999999'));

  const result2 = simulateIncomingCheck({ from: '919999999999@c.us', body: 'thanks bhai' });
  assert.equal(result2, 'SILENT_DROP');
  assert.equal(seen[0].ordered, true);

  const result3 = simulateIncomingCheck({ from: '919999999999@c.us', body: 'when will delivery come' });
  assert.equal(result3, 'SILENT_DROP');
  assert.equal(seen[0].ordered, true);

  // 2. Multilingual inquiry indicating user hasn't ordered yet -> AUTOMATIC RECOVERY
  const result4 = simulateIncomingCheck({ from: '919999999999@c.us', body: 'whats the process' });
  assert.equal(result4, 'PROCEED_TO_PIPELINE');
  assert.equal(seen[0].ordered, false, 'User must be unmarked as ordered');
  assert.equal(ignored.includes('919999999999'), false, 'User must be removed from ignored list');

  // Verify logging
  assert.ok(logs.includes('SILENT_DROP: ok'));
  assert.ok(logs.includes('RESTORED: whats the process'));
});
