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
  const context = {
    tui, console, process: { env: { TELEGRAM_ADMIN_IDS: '99' } }, ctx: {},
    app: { get() {}, post() {} }, authenticateToken() {},
    fetch: async (url, options) => { calls.push({ method: url.split('/').pop(), ...JSON.parse(options.body) }); return { json: async () => ({ ok: true, result: {} }) }; },
    loadInstances: () => instances, saveInstances: () => { saves++; },
    digits: (v) => String(v).replace(/\D/g, ''), now: () => '2026-10-08',
    getInst: (slug) => instances.find((i) => i.slug === slug), ensureSessions: (i) => i.sessions,
    persist() {}, logInstanceEvent() {}, storeLink: () => 'https://example.com/app'
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nthis.handlers = { handleTelegramCallback, handleTelegramMessage };', context);
  const message = (id, text, type = 'private') => ({ from: { id, first_name: 'Alice' }, chat: { id, type }, text });
  return { calls, instances, saves: () => saves,
    message: (id, text, type) => context.handlers.handleTelegramMessage(message(id, text, type)),
    callback: (id, data, type) => context.handlers.handleTelegramCallback({ id: 'query', from: { id, first_name: 'Alice' }, message: message(id, '', type), data })
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
