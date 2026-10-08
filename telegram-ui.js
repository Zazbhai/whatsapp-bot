// Telegram presentation helpers; no bot token or network access in this module.
const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const button = (text, callback_data) => ({ text, callback_data });
const keyboard = (...rows) => ({ inline_keyboard: rows });
const homeKeyboard = (admin) => keyboard(
  [button('📱 Add session', 'add'), button('🎁 My redeem codes', 'mine:0')],
  [button('📊 My sessions', 'sessions'), button('❓ Help', 'help')],
  ...(admin ? [[button('👑 Admin panel', 'admin')]] : [])
);
const backKeyboard = () => keyboard([button('🏠 Main menu', 'home')]);
const cancelKeyboard = () => keyboard([button('✖️ Cancel', 'cancel')]);
const adminKeyboard = () => keyboard(
  [button('🎁 All codes', 'codes:all:0')],
  [button('🟢 Unused', 'codes:unused:0'), button('✅ Used', 'codes:used:0')],
  [button('🔎 Find code', 'find'), button('📦 Update APK', 'upload')],
  [button('🏠 Main menu', 'home')]
);
function canViewCode(record, userId, admin) { return !!record && (admin || String(record.tgUserId) === String(userId)); }
function canUseCallback(data, admin) {
  return !/^(admin|codes|find|upload|used|unused)(:|$)/.test(data) || admin;
}
function pageOf(records, page, size = 5) {
  const pages = Math.max(1, Math.ceil(records.length / size));
  const index = Math.min(Math.max(Number.parseInt(page, 10) || 0, 0), pages - 1);
  return { rows: records.slice(index * size, (index + 1) * size), index, pages };
}
function codePage(records, page, prefix, admin) {
  const { rows, index, pages } = pageOf(records, page);
  const text = rows.map((r) => `${r.used ? '✅' : '🟢'} <code>${escapeHtml(r.code)}</code>\n📱 +${escapeHtml(r.phone)}${admin ? ` · ${escapeHtml(String(r.tgName || r.tgUserId).slice(0, 60))}` : ''}`).join('\n\n');
  const buttons = rows.map((r) => [button(`🎁 ${r.code}`, `detail:${r.code}`)]);
  const nav = [];
  if (index > 0) nav.push(button('⬅️ Previous', `${prefix}:${index - 1}`));
  if (index + 1 < pages) nav.push(button('Next ➡️', `${prefix}:${index + 1}`));
  if (nav.length) buttons.push(nav);
  buttons.push([button(admin ? '👑 Admin panel' : '🏠 Main menu', admin ? 'admin' : 'home')]);
  return { text: `<b>🎁 ${admin ? 'Redeem code register' : 'Your redeem codes'}</b>\n📋 ${records.length} total · Page ${index + 1}/${pages}\n\n${text || 'No codes here yet.'}`, reply_markup: keyboard(...buttons) };
}
module.exports = { escapeHtml, button, keyboard, homeKeyboard, backKeyboard, cancelKeyboard, adminKeyboard, canViewCode, canUseCallback, pageOf, codePage };
