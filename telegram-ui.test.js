const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('./telegram-ui');
test('users can only open their own redeem codes', () => {
  assert.equal(ui.canViewCode({ tgUserId: '12' }, '12', false), true);
  assert.equal(ui.canViewCode({ tgUserId: '12' }, '13', false), false);
  assert.equal(ui.canViewCode({ tgUserId: '12' }, '13', true), true);
});
test('every admin button requires admin privileges', () => {
  for (const action of ['admin', 'codes:all:0', 'codes:used:0', 'find', 'upload', 'used:RDM-ABCDEFGH', 'unused:RDM-ABCDEFGH']) {
    assert.equal(ui.canUseCallback(action, false), false, action);
    assert.equal(ui.canUseCallback(action, true), true, action);
  }
  assert.equal(ui.canUseCallback('mine:0', false), true);
});
test('code pagination preserves all stored records', () => {
  const records = Array.from({ length: 13 }, (_, id) => ({ id }));
  assert.deepEqual([0, 1, 2].flatMap((page) => ui.pageOf(records, page).rows), records);
  assert.equal(ui.pageOf(records, 100).index, 2);
  assert.equal(ui.pageOf(records, -1).index, 0);
});
