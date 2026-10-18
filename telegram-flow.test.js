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
    app: { get() {}, post() {} }, authenticateToken() {},
    fetch: async (url, options) => { calls.push({ method: url.split('/').pop(), ...JSON.parse(options.body) }); return { json: async () => ({ ok: true, result: {} }) }; },
    loadInstances: () => instances, saveInstances: () => { saves++; },
    digits: (v) => String(v).replace(/\D/g, ''), now: () => '2026-10-08',
    getInst: (slug) => instances.find((i) => i.slug === slug), ensureSessions: (i) => i.sessions,
    persist() {}, logInstanceEvent() {}, storeLink: () => 'https://example.com/app'
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nthis.handlers = { handleTelegramCallback, handleTelegramMessage, checkPendingCouponDeliveries };', context);
  const message = (id, text, type = 'private') => ({ from: { id, first_name: 'Alice' }, chat: { id, type }, text });
  return { calls, instances, saves: () => saves, linking: () => linking,
    message: (id, text, type) => context.handlers.handleTelegramMessage(message(id, text, type)),
    callback: (id, data, type) => context.handlers.handleTelegramCallback({ id: 'query', from: { id, first_name: 'Alice' }, message: message(id, '', type), data }),
    checkPendingCoupons: () => context.handlers.checkPendingCouponDeliveries(),
    ctx: context.ctx
  };
}
test('forged mark-used callback cannot alter admin register', async () => {
  const h = harness(); await h.callback(12, 'used:RDM-ABCDEFGH');
  assert.equal(h.instances[0].redeemCodes[0].used, false);
  assert.equal(h.saves(), 0);
});
test('admin mark-used and unused buttons persist the chosen state', async () => {
  const h = harness(); await h.callback(99, 'used:RDM-ABCDEFGH');
  assert.equal(h.instances[0].redeemCodes[0].used, true);
  await h.callback(99, 'unused:RDM-ABCDEFGH');
  assert.equal(h.instances[0].redeemCodes[0].used, false);
  assert.equal(h.saves(), 2);
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
test('admin can create random and custom coupons via buttons and commands', async () => {
  const h = harness();
  await h.callback(99, 'addcode:gen');
  assert.equal(h.instances[0].redeemCodes.length, 2);
  assert.equal(h.instances[0].redeemCodes[0].used, false);

  await h.message(99, '/addcode VIP2026');
  assert.equal(h.instances[0].redeemCodes.length, 3);
  assert.equal(h.instances[0].redeemCodes[0].code, 'VIP2026');
  assert.equal(h.instances[0].redeemCodes[0].used, false);
});
test('non-admin cannot create coupons', async () => {
  const h = harness();
  await h.callback(12, 'addcode:gen');
  assert.equal(h.instances[0].redeemCodes.length, 1);
  await h.message(12, '/addcode HACK');
  assert.equal(h.instances[0].redeemCodes.length, 1);
});
test('session linking does not give random codes immediately, delivers admin-added coupon after 6h', async () => {
  const h = harness();
  // Admin adds a coupon to the pool
  await h.message(99, '/addcode PROMO6H');
  assert.equal(h.instances[0].redeemCodes[0].code, 'PROMO6H');
  assert.equal(h.instances[0].redeemCodes[0].assignedSessionId, undefined);

  // User links a session
  const session = { id: 'sess_1', phone: '919876543210', status: 'linked', tgOwner: { id: '12', chatId: 12, name: 'Alice' } };
  h.instances[0].sessions.push(session);
  h.ctx.onSessionLinked('main', session);

  // 1. Verifies no random code was generated or assigned
  assert.equal(session.redeemCode, undefined);
  assert.equal(session.couponDelivered, false);
  assert.equal(typeof session.couponDeliveryAt, 'number');

  // 2. Verifies user got the 6 hours message
  const userMsg = h.calls.filter((c) => c.chat_id === 12).at(-1);
  assert.equal(userMsg.text.includes('delivered after 6 hours'), true);
  assert.equal(userMsg.text.includes('RDM-'), false);

  // 3. Before 6h, delivery check should not deliver anything
  await h.checkPendingCoupons();
  assert.equal(session.couponDelivered, false);
  assert.equal(session.redeemCode, undefined);

  // 4. Advance time past 6 hours (simulate delivery)
  session.couponDeliveryAt = Date.now() - 1000;
  await h.checkPendingCoupons();

  // 5. Verifies admin-added coupon was delivered, not random code!
  assert.equal(session.couponDelivered, true);
  assert.equal(session.redeemCode, 'PROMO6H');
  const deliveredMsg = h.calls.filter((c) => c.chat_id === 12).at(-1);
  assert.equal(deliveredMsg.text.includes('PROMO6H'), true);
});
