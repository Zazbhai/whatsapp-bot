// Telegram presentation helpers; no bot token or network access in this module.
const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const button = (text, callback_data) => ({ text, callback_data });
const keyboard = (...rows) => ({ inline_keyboard: rows });

const homeKeyboard = (admin) => keyboard(
  [button('📱 Add session', 'add'), button('🎁 My coupons', 'mine:0')],
  [button('📊 My sessions', 'sessions'), button('❓ Help', 'help')],
  ...(admin ? [[button('👑 Admin panel', 'admin')]] : [])
);

const backKeyboard = () => keyboard([button('🏠 Main menu', 'home')]);
const cancelKeyboard = () => keyboard([button('✖️ Cancel', 'cancel')]);

const adminKeyboard = () => keyboard(
  [button('➕ Add coupon', 'addcoupon'), button('🎁 View coupons', 'coupons:0')],
  [button('🔎 Find coupon', 'find'), button('📦 Update APK', 'upload')],
  [button('🏠 Main menu', 'home')]
);

const appSelectKeyboard = () => keyboard(
  [button('⚡ Blinkit', 'addc:app:Blinkit'), button('🛒 BigBasket', 'addc:app:BigBasket')],
  [button('🚀 Zepto', 'addc:app:Zepto'), button('🍔 Swiggy', 'addc:app:Swiggy')],
  [button('🛍️ Amazon', 'addc:app:Amazon'), button('📦 Flipkart', 'addc:app:Flipkart')],
  [button('✍️ Other App', 'addc:app:other')],
  [button('👑 Admin panel', 'admin')]
);

const userPrefAppKeyboard = () => keyboard(
  [button('⚡ Blinkit', 'prefapp:Blinkit'), button('🛒 BigBasket', 'prefapp:BigBasket')],
  [button('🚀 Zepto', 'prefapp:Zepto'), button('🍔 Swiggy', 'prefapp:Swiggy')],
  [button('🎁 Any App', 'prefapp:Any')],
  [button('🏠 Main menu', 'home')]
);

function canViewCode(record, userId, admin) {
  const ownerId = record && (record.deliveredTo || record.tgUserId);
  return !!record && (admin || (!!ownerId && !!userId && String(ownerId) === String(userId)));
}

function canUseCallback(data, admin) {
  return !/^(admin|coupons|codes|find|upload|addcoupon|addcode|addc)(:|$)/.test(data) || admin;
}

function pageOf(records, page, size = 5) {
  const pages = Math.max(1, Math.ceil(records.length / size));
  const index = Math.min(Math.max(Number.parseInt(page, 10) || 0, 0), pages - 1);
  return { rows: records.slice(index * size, (index + 1) * size), index, pages };
}

function codePage(records, page, prefix, admin) {
  const { rows, index, pages } = pageOf(records, page);
  const text = rows.map((r) => {
    const appLabel = escapeHtml(r.app || 'Coupon');
    const codeLabel = escapeHtml(r.code);
    if (admin) {
      const status = (r.deliveredTo || r.assignedSessionId)
        ? `📤 Delivered to +${escapeHtml(r.phone || r.deliveredPhone || '')}${r.tgName ? ` (${escapeHtml(r.tgName)})` : ''}`
        : '🟢 Available in pool';
      return `🏪 <b>${appLabel}</b>: <code>${codeLabel}</code>\n   ${status}`;
    }
    return `🏪 <b>${appLabel}</b>: <code>${codeLabel}</code>\n📱 +${escapeHtml(r.phone || '')}${r.deliveredAt ? ` · 📅 ${escapeHtml(String(r.deliveredAt).slice(0, 10))}` : ''}`;
  }).join('\n\n');

  const buttons = rows.map((r) => [button(`🎁 ${r.app ? r.app + ': ' : ''}${r.code}`, `detail:${r.code}`)]);
  const nav = [];
  if (index > 0) nav.push(button('⬅️ Previous', `${prefix}:${index - 1}`));
  if (index + 1 < pages) nav.push(button('Next ➡️', `${prefix}:${index + 1}`));
  if (nav.length) buttons.push(nav);
  buttons.push([button(admin ? '👑 Admin panel' : '🏠 Main menu', admin ? 'admin' : 'home')]);

  return {
    text: `<b>🎁 ${admin ? 'Coupon Inventory & Delivery' : 'Your coupons'}</b>\n📋 ${records.length} total · Page ${index + 1}/${pages}\n\n${text || 'No coupons here yet.'}`,
    reply_markup: keyboard(...buttons)
  };
}

module.exports = {
  escapeHtml, button, keyboard, homeKeyboard, backKeyboard, cancelKeyboard,
  adminKeyboard, appSelectKeyboard, userPrefAppKeyboard, canViewCode, canUseCallback, pageOf, codePage
};
