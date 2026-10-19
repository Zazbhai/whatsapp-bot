const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const tui = require('./telegram-ui');
function harness() {
  const source = fs.readFileSync(require.resolve('./features'), 'utf8');
  const start = source.indexOf('  const tg =');
  const end = source.indexOf('  async function telegramLoop()', start);
  const calls = [];
  const instances = [{ slug: 'main', sessions: [], redeemCodes: [
    { code: 'RDM-ABCDEFGH', tgUserId: '12', phone: '919876543210', tgName: '<Alice>', createdAt: '2026-10-08', used: false }
  ] }];
  let saves = 0;
  const linking = [];
  const context = {
    tui, console, process: { env: { TELEGRAM_ADMIN_IDS: '99' } }, ctx: {},
    setTimeout: () => 0, setInterval: () => 0, onQr: () => () => {}, qrcode: { toBuffer: async () => Buffer.from('') },
    addSession: (slug, phone, label) => { const s = { id: 's' + (linking.length + 1), phone, label, status: 'pending' }; instances.find((i) => i.slug === slug).sessions.push(s); return s; },
    beginLinking: async (slug, s) => { linking.push(`${slug}:${s.id}`); },
    waitForCode: async () => 'ABCD-1234',
    app: { get() {}, post() {} }, authenticateToken() {},
    fetch: async (url, options) => { calls.push({ method: url.split('/').pop(), ...JSON.parse(options.body) }); return { json: async () => ({ ok: true, result: {} }) }; },
    loadInstances: () => instances, saveInstances: () => { saves++; },
    digits: (v) => String(v).replace(/\D/g, ''), now: () => '2026-10-08',
    getInst: (slug) => instances.find((i) => i.slug === slug), ensureSessions: (i) => i.sessions,
    persist() {}, logInstanceEvent() {}, storeLink: () => 'https://example.com/app'
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nthis.handlers = { handleTelegramCallback, handleTelegramMessage, checkPendingCouponDeliveries, handleSessionLoggedOut };', context);
  const message = (id, text, type = 'private') => ({ from: { id, first_name: 'Alice' }, chat: { id, type }, text });
  return { calls, instances, saves: () => saves, linking: () => linking,
    message: (id, text, type) => context.handlers.handleTelegramMessage(message(id, text, type)),
    callback: (id, data, type) => context.handlers.handleTelegramCallback({ id: 'query', from: { id, first_name: 'Alice' }, message: message(id, '', type), data }),
    checkPendingCoupons: () => context.handlers.checkPendingCouponDeliveries(),
    handleSessionLoggedOut: (slug, s, reason) => context.handlers.handleSessionLoggedOut(slug, s, reason),
    ctx: context.ctx
  };
}
test('non-admin cannot trigger admin coupon callbacks', async () => {
  const h = harness(); await h.callback(12, 'addcoupon');
  assert.equal(h.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 12).length, 0);
});
test('admin coupon inventory displays app and status without used/unused filters', async () => {
  const h = harness();
  await h.message(99, '/addcoupon Blinkit BLINK50');
  await h.callback(99, 'coupons:0');
  const last = h.calls.filter((c) => c.method === 'sendMessage').at(-1);
  assert.equal(last.text.includes('Blinkit'), true);
  assert.equal(last.text.includes('BLINK50'), true);
  assert.equal(last.text.includes('Available in pool'), true);
  assert.equal(last.text.includes('used'), false);
});
test('another user cannot get code details from a copied button', async () => {
  const h = harness(); await h.callback(13, 'detail:RDM-ABCDEFGH');
  assert.equal(h.calls.filter((c) => c.method === 'sendMessage').some((c) => c.text.includes('RDM-ABCDEFGH')), false);
});
test('group callbacks cannot read codes even for an admin', async () => {
  const h = harness(); await h.callback(99, 'codes:all:0', 'group');
  assert.equal(h.calls.filter((c) => c.method === 'sendMessage').length, 0);
});
test('cancel button prevents the next number from starting a session', async () => {
  const h = harness(); await h.callback(12, 'add'); await h.callback(12, 'cancel');
  await h.message(12, '919876543210');
  assert.equal(h.instances[0].sessions.length, 0);
});
test('button search resolves an exact redeem code for admin', async () => {
  const h = harness(); await h.callback(99, 'find'); await h.message(99, 'RDM-ABCDEFGH');
  assert.equal(h.calls.filter((c) => c.method === 'sendMessage').at(-1).text.includes('RDM-ABCDEFGH'), true);
});
test('add session offers QR code and pairing code options', async () => {
  const h = harness(); await h.message(12, '/addsession');
  const last = h.calls.filter((c) => c.method === 'sendMessage').at(-1);
  assert.equal(last.text.includes('QR code'), true);
  assert.equal(last.text.includes('Pairing code'), true);
  const data = last.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(data.slice(0, 2), ['add:qr', 'add:code']);
});
test('pairing code option asks for the phone number', async () => {
  const h = harness(); await h.callback(12, 'add:code');
  const last = h.calls.filter((c) => c.method === 'sendMessage').at(-1);
  assert.equal(last.text.includes('country code'), true);
});
test('QR option creates a phone-less session and starts linking', async () => {
  const h = harness(); await h.callback(12, 'add:qr');
  assert.equal(h.instances[0].sessions.length, 1);
  assert.equal(h.instances[0].sessions[0].phone, null);
  assert.equal(h.linking().length, 1);
});
test('admin can configure coupon app and code via buttons and commands', async () => {
  const h = harness();
  // Admin clicks addcoupon, selects Blinkit app, and sends code
  await h.callback(99, 'addc:app:Blinkit');
  await h.message(99, 'BLINKIT50');
  assert.equal(h.instances[0].redeemCodes[0].app, 'Blinkit');
  assert.equal(h.instances[0].redeemCodes[0].code, 'BLINKIT50');

  // Admin adds via command with app and code
  await h.message(99, '/addcoupon BigBasket BB2026');
  assert.equal(h.instances[0].redeemCodes[0].app, 'BigBasket');
  assert.equal(h.instances[0].redeemCodes[0].code, 'BB2026');
});
test('non-admin cannot create coupons', async () => {
  const h = harness();
  await h.callback(12, 'addc:app:Blinkit');
  assert.equal(h.instances[0].redeemCodes.length, 1);
  await h.message(12, '/addcoupon Blinkit HACK');
  assert.equal(h.instances[0].redeemCodes.length, 1);
});
test('session linking delivers preferred app coupon after 6h without random codes', async () => {
  const h = harness();
  // Admin adds Blinkit and Swiggy coupons to the pool
  await h.message(99, '/addcoupon Blinkit BLINKIT100');
  await h.message(99, '/addcoupon Swiggy SWIGGY50');

  // User links a session
  const session = { id: 'sess_1', phone: '919876543210', status: 'linked', tgOwner: { id: '12', chatId: 12, name: 'Alice' } };
  h.instances[0].sessions.push(session);
  h.ctx.onSessionLinked('main', session);

  // 1. Verifies no random code was generated or assigned
  assert.equal(session.redeemCode, undefined);
  assert.equal(session.couponDelivered, false);
  assert.equal(typeof session.couponDeliveryAt, 'number');

  // 2. User selects Blinkit preference
  await h.callback(12, 'prefapp:Blinkit');
  assert.equal(session.preferredApp, 'Blinkit');

  // 3. Before 6h, delivery check should not deliver anything
  await h.checkPendingCoupons();
  assert.equal(session.couponDelivered, false);
  assert.equal(session.redeemCode, undefined);

  // 4. Advance time past 6 hours (simulate delivery)
  session.couponDeliveryAt = Date.now() - 1000;
  await h.checkPendingCoupons();

  // 5. Verifies preferred Blinkit coupon was delivered, not random code!
  assert.equal(session.couponDelivered, true);
  assert.equal(session.redeemCode, 'BLINKIT100');
  assert.equal(session.couponApp, 'Blinkit');
  const deliveredMsg = h.calls.filter((c) => c.chat_id === 12).at(-1);
  assert.equal(deliveredMsg.text.includes('Blinkit'), true);
  assert.equal(deliveredMsg.text.includes('BLINKIT100'), true);
});

test('once a user logs in with a number, the same number cannot be logged in again while active', async () => {
  const h = harness();
  // 1. Session is linked with phone 919876543210
  const session = { id: 's_linked', phone: '919876543210', status: 'linked', tgOwner: { id: '12', chatId: 12, name: 'Alice' } };
  h.instances[0].sessions.push(session);

  // 2. Another or same user attempts to add session with the same number while active
  await h.callback(13, 'add:code');
  await h.message(13, '919876543210');

  const lastCall = h.calls.filter((c) => c.chat_id === 13).at(-1);
  assert.equal(lastCall.text.includes('Number already in use'), true);
  assert.equal(lastCall.text.includes('currently active'), true);

  // Ensure no new session was added to linking list
  assert.equal(h.instances[0].sessions.filter((s) => s.id !== 's_linked').length, 0);
});

test('user can enter the same number if the session logged out', async () => {
  const h = harness();
  // Session was previously logged in and is now logged out
  const session = { id: 's_loggedout', phone: '919888888888', status: 'logged_out', everLinked: true };
  h.instances[0].sessions.push(session);

  await h.callback(14, 'add:code');
  await h.message(14, '919888888888');

  assert.equal(h.calls.some((c) => c.chat_id === 14 && c.text && c.text.includes('Preparing session')), true);
  const lastCall = h.calls.filter((c) => c.chat_id === 14).at(-1);
  assert.equal(lastCall.text.includes('Approve our bot session'), true);
});

test('findcode searching for an app returns only that app without matching coupons with empty phone', async () => {
  const h = harness();
  await h.message(99, '/addcoupon Zepto ZEPTO50');
  await h.message(99, '/addcoupon Blinkit BLINKIT20');
  await h.message(99, '/findcode Zepto');

  const lastCall = h.calls.filter((c) => c.chat_id === 99).at(-1);
  assert.equal(lastCall.text.includes('ZEPTO50'), true);
  assert.equal(lastCall.text.includes('BLINKIT20'), false);
});

test('cross-instance coupon fallback delivers coupons when the primary instance is out', async () => {
  const h = harness();
  // Instance 2 has the coupon
  h.instances.push({
    slug: 'backup-bot',
    sessions: [],
    redeemCodes: [
      { code: 'BIGBASKET99', app: 'BigBasket', isAdminAdded: true, deliveredTo: null, assignedSessionId: null, createdAt: '2026-10-08', used: false }
    ]
  });

  const session = { id: 's_cross', phone: '919111111111', status: 'linked', tgOwner: { id: '77', chatId: 77, name: 'Bob' }, preferredApp: 'BigBasket' };
  h.instances[0].sessions.push(session);
  h.ctx.onSessionLinked('main', session);

  session.couponDeliveryAt = Date.now() - 1000;
  await h.checkPendingCoupons();

  assert.equal(session.couponDelivered, true);
  assert.equal(session.redeemCode, 'BIGBASKET99');
  assert.equal(session.couponApp, 'BigBasket');
  const userMsg = h.calls.filter((c) => c.chat_id === 77).at(-1);
  assert.equal(userMsg.text.includes('BIGBASKET99'), true);
});

test('when session logs out, pending coupon is cancelled and user receives Telegram relogin message', async () => {
  const h = harness();
  const session = {
    id: 's_user1',
    phone: '919555555555',
    status: 'linked',
    tgOwner: { id: '55', chatId: 55, name: 'Charlie' }
  };
  h.instances[0].sessions.push(session);
  h.ctx.onSessionLinked('main', session);

  // Scheduled coupon is pending
  assert.equal(session.couponDelivered, false);
  assert.equal(typeof session.couponDeliveryAt, 'number');

  // Session logs out
  h.handleSessionLoggedOut('main', session, 'UNPAIRED');

  // 1. Coupon is rejected and cancelled
  assert.equal(session.couponCancelled, true);
  assert.equal(session.couponDelivered, true);
  assert.equal(session.couponDeliveryAt, null);

  // 2. User received logout and relogin notification
  const userMsg = h.calls.filter((c) => c.chat_id === 55).at(-1);
  assert.ok(userMsg);
  assert.equal(userMsg.text.includes('logged out or expired'), true);
  assert.equal(userMsg.text.includes('re-login and reconnect'), true);
  assert.equal(userMsg.text.includes('Pending coupon rejected'), true);
  assert.equal(userMsg.text.includes('Coupon cancelled because session logged out/expired, please re-login to claim the coupon code'), true);

  // 3. User can re-login with the same number after logout
  session.status = 'logged_out';
  await h.callback(55, 'add:code');
  await h.message(55, '919555555555');

  assert.equal(h.calls.filter((c) => c.chat_id === 55).some((c) => c.text?.includes('Preparing session')), true);

  // But another user trying to claim the same number while it is active is blocked
  await h.callback(999, 'add:code');
  await h.message(999, '919555555555');
  const blockedCall = h.calls.filter((c) => c.chat_id === 999).at(-1);
  assert.equal(blockedCall.text.includes('Number already in use'), true);
});

test('coupons and mine callbacks work with or without page suffix', async () => {
  const h = harness();
  await h.message(99, '/addcoupon Blinkit BLINKIT99');
  await h.callback(99, 'coupons');
  const adminMsg = h.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 99).at(-1);
  assert.ok(adminMsg);
  assert.equal(adminMsg.text.includes('BLINKIT99'), true);

  await h.callback(12, 'mine');
  const userMsg = h.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 12).at(-1);
  assert.ok(userMsg);
  assert.equal(userMsg.text.includes('Your coupons'), true);
});

test('non-admin sending /coupons gets personal coupons instead of admin error', async () => {
  const h = harness();
  await h.message(12, '/coupons');
  const userMsg = h.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 12).at(-1);
  assert.ok(userMsg);
  assert.equal(userMsg.text.includes('Your coupons'), true);
  assert.equal(userMsg.text.includes('Open the admin panel'), false);
});

test('admin panel view coupons button works with verified .env ID even with empty inventory', async () => {
  const h = harness();
  // Admin 99 clicks 'admin' to open admin panel
  await h.callback(99, 'admin');
  const panelMsg = h.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 99).at(-1);
  assert.ok(panelMsg);
  assert.equal(panelMsg.text.includes('Admin panel'), true);

  // Admin clicks 'coupons:0' (View coupons)
  await h.callback(99, 'coupons:0');
  const couponsMsg = h.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 99).at(-1);
  assert.ok(couponsMsg);
  assert.equal(couponsMsg.text.includes('Coupon Inventory &amp; Delivery'), true);
  assert.equal(couponsMsg.text.includes('RDM-ABCDEFGH'), true);
});

test('view coupons shows all coupons added by admin grouped for each added service like blinkit and bigbasket', async () => {
  const h = harness();
  // Admin adds Blinkit coupons
  await h.message(99, '/addcoupon Blinkit BLINK50');
  await h.message(99, '/addcoupon Blinkit BLINK100');
  // Admin adds BigBasket coupon
  await h.message(99, '/addcoupon BigBasket BB2026');

  // Admin opens view coupons
  await h.callback(99, 'coupons:0');
  const msg = h.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 99).at(-1);
  assert.ok(msg);
  // Verify both services have their sections
  assert.equal(msg.text.includes('Blinkit'), true);
  assert.equal(msg.text.includes('BigBasket'), true);
  // Verify coupons are listed under their services
  assert.equal(msg.text.includes('BLINK50'), true);
  assert.equal(msg.text.includes('BLINK100'), true);
  assert.equal(msg.text.includes('BB2026'), true);
  // Verify status
  assert.equal(msg.text.includes('Available in pool'), true);

  // Verify service filter buttons exist in the keyboard
  const buttons = msg.reply_markup.inline_keyboard.flat();
  const filterBlinkit = buttons.find((b) => b.callback_data === 'coupons:app:Blinkit:0');
  const filterBigBasket = buttons.find((b) => b.callback_data === 'coupons:app:BigBasket:0');
  assert.ok(filterBlinkit, 'Blinkit filter button should exist');
  assert.ok(filterBigBasket, 'BigBasket filter button should exist');

  // Admin clicks filter for Blinkit
  await h.callback(99, 'coupons:app:Blinkit:0');
  const blinkitMsg = h.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 99).at(-1);
  assert.equal(blinkitMsg.text.includes('BLINK50'), true);
  assert.equal(blinkitMsg.text.includes('BLINK100'), true);
  assert.equal(blinkitMsg.text.includes('BB2026'), false);

  // Admin filters via command /coupons BigBasket
  await h.message(99, '/coupons BigBasket');
  const bbMsg = h.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 99).at(-1);
  assert.equal(bbMsg.text.includes('BB2026'), true);
  assert.equal(bbMsg.text.includes('BLINK50'), false);
});



