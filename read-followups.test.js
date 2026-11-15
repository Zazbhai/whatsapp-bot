'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadFollowupScheduler, isEligibleFollowup } = require('./read-followups');

function fakeClock() {
  let now = 1000;
  let nextId = 1;
  const timers = new Map();
  return {
    timers, now: () => now,
    setTimer(callback, delay) { const id = nextId++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      now += ms;
      while (true) {
        const next = [...timers.entries()].find(([, timer]) => timer.at <= now);
        if (!next) break;
        timers.delete(next[0]);
        await next[1].callback();
      }
    }
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-followups-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('only direct app/order follow-up messages are eligible', () => {
  assert.equal(isEligibleFollowup({ direct: true, text: 'Install the app to place your order.' }), true);
  assert.equal(isEligibleFollowup({ direct: true, text: 'How are you?' }), false);
  assert.equal(isEligibleFollowup({ direct: false, text: 'Install this app.' }), false);
  assert.equal(isEligibleFollowup({ direct: true, text: 'Here is your link', storeUrl: 'https://shop.test/app' }), false);
  assert.equal(isEligibleFollowup({ direct: true, text: 'Here is https://shop.test/app', storeUrl: 'https://shop.test/app' }), true);
});

test('starts the delay only on read ACK, and cancels when the user replies', async t => {
  const clock = fakeClock();
  const sent = [];
  const scheduler = new ReadFollowupScheduler({
    dataDir: tempDir(t), delayMs: 5000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    canSend: async () => true, onDue: async (_slug, entry) => sent.push(entry.sender)
  });
  scheduler.track({ slug: 'primary', sender: '123', chatId: '123@lid', messageId: 'm1', text: 'Install the app', direct: true });
  await clock.advance(30000);
  assert.deepEqual(sent, []);
  scheduler.read('primary', 'm1');
  await clock.advance(4999);
  assert.deepEqual(sent, []);
  scheduler.cancelForUser('primary', '123');
  await clock.advance(1);
  assert.deepEqual(sent, []);
});

test('sends at most one reminder per user and enforces a 24-hour cooldown', async t => {
  const clock = fakeClock();
  const sent = [];
  const scheduler = new ReadFollowupScheduler({
    dataDir: tempDir(t), delayMs: 5000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    canSend: async () => true, onDue: async (_slug, entry) => sent.push(entry.sender)
  });
  scheduler.track({ slug: 'p', sender: '7', chatId: '7@lid', messageId: 'm1', text: 'Install the app', direct: true });
  assert.equal(scheduler.track({ slug: 'p', sender: '7', chatId: '7@lid', messageId: 'm2', text: 'Place an order', direct: true }), false);
  scheduler.read('p', 'm1');
  await clock.advance(5000);
  assert.deepEqual(sent, ['7']);
  assert.equal(scheduler.track({ slug: 'p', sender: '7', chatId: '7@lid', messageId: 'm3', text: 'Order in the app', direct: true }), false);
});

test('restores a read pending state across scheduler restart and sends after its original due time', async t => {
  const dataDir = tempDir(t);
  const clock = fakeClock();
  let sent = 0;
  const options = { dataDir, delayMs: 5000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, canSend: async () => true, onDue: async () => sent++ };
  const first = new ReadFollowupScheduler(options);
  first.track({ slug: 'p', sender: '8', chatId: '8@lid', messageId: 'm1', text: 'Order in app', direct: true });
  first.read('p', 'm1');
  first.close();
  clock.timers.clear();
  const restored = new ReadFollowupScheduler(options);
  await clock.advance(5000);
  assert.equal(sent, 1);
  restored.close();
});

test('opt-out and completion cancel timers and prevent further follow-ups', async t => {
  const clock = fakeClock();
  let sent = 0;
  const scheduler = new ReadFollowupScheduler({
    dataDir: tempDir(t), delayMs: 1000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    canSend: async () => true, onDue: async () => sent++
  });
  scheduler.track({ slug: 'p', sender: '9', chatId: '9@lid', messageId: 'm1', text: 'Get the app and order', direct: true });
  scheduler.read('p', 'm1');
  scheduler.markCompleted('p', '9');
  await clock.advance(1000);
  assert.equal(sent, 0);
  assert.equal(scheduler.track({ slug: 'p', sender: '9', chatId: '9@lid', messageId: 'm2', text: 'Order with app', direct: true }), false);
});

test('stops at three delivered reminders, invokes auto-mute once, and rejects further reminders', async t => {
  const clock = fakeClock();
  const dir = tempDir(t);
  const sent = [];
  const muted = [];
  const scheduler = new ReadFollowupScheduler({
    dataDir: dir, delayMs: 1000, cooldownMs: 5000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    canSend: async () => true,
    onDue: async (_slug, entry) => sent.push(entry.messageId),
    onLimitReached: async (_slug, entry) => muted.push(entry.sender)
  });
  for (let index = 1; index <= 3; index++) {
    const id = `m${index}`;
    assert.equal(scheduler.track({ slug: 'p', sender: '10', chatId: '10@lid', messageId: id, text: 'Install the app', direct: true }), true);
    scheduler.read('p', id);
    await clock.advance(1000);
    if (index < 3) await clock.advance(5000);
  }
  assert.deepEqual(sent, ['m1', 'm2', 'm3']);
  assert.deepEqual(muted, ['10']);
  assert.equal(scheduler.track({ slug: 'p', sender: '10', chatId: '10@lid', messageId: 'm4', text: 'Install the app', direct: true }), false);
  assert.equal(scheduler.state('p').reminderCountByUser['10'], 3);
});
