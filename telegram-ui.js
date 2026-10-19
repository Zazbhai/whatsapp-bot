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

function getAppEmoji(app) {
  const norm = String(app || '').trim().toLowerCase();
  if (norm.includes('blinkit')) return '⚡';
  if (norm.includes('bigbasket') || norm.includes('bb')) return '🛒';
  if (norm.includes('zepto')) return '🚀';
  if (norm.includes('swiggy')) return '🍔';
  if (norm.includes('zomato')) return '🍕';
  if (norm.includes('amazon')) return '🛍️';
  if (norm.includes('flipkart')) return '📦';
  if (norm.includes('myntra')) return '👗';
  if (norm.includes('uber') || norm.includes('ola')) return '🚖';
  if (norm.includes('domino')) return '🍕';
  if (norm.includes('kfc') || norm.includes('mcdonald')) return '🍟';
  return '🏪';
}

function codePage(records, page, prefix, admin, filter = 'all', allServices = []) {
  const pageSize = admin ? 25 : 5;
  const { rows, index, pages } = pageOf(records, page, pageSize);

  let text = '';
  if (admin) {
    if (!rows.length) {
      text = 'No coupons here yet.';
    } else {
      const groups = new Map();
      for (const r of rows) {
        const app = (r.app || 'General').trim();
        if (!groups.has(app)) groups.set(app, []);
        groups.get(app).push(r);
      }

      const sections = [];
      for (const [app, items] of groups.entries()) {
        const emoji = getAppEmoji(app);
        const inPool = items.filter((x) => !x.deliveredTo && !x.assignedSessionId).length;
        const delivered = items.length - inPool;
        const stats = items.length === 1
          ? (inPool ? '1 in pool' : '1 delivered')
          : `${items.length} coupons · ${inPool} in pool, ${delivered} delivered`;

        const lines = items.map((r) => {
          const codeLabel = escapeHtml(r.code);
          const isDelivered = Boolean(r.deliveredTo || r.assignedSessionId);
          let status = '🟢 Available in pool';
          if (isDelivered) {
            const phone = r.deliveredPhone || (r.phone && r.phone !== 'Admin Created' ? r.phone : '');
            const phoneStr = phone ? `+${escapeHtml(phone)}` : '';
            const nameStr = r.tgName || r.deliveredName ? ` (${escapeHtml(r.tgName || r.deliveredName)})` : '';
            status = `📤 Delivered to ${phoneStr}${nameStr}`.replace(/\s+/g, ' ').trim();
          }
          return `• <code>${codeLabel}</code> — ${status}`;
        });

        sections.push(`${emoji} <b>${escapeHtml(app)}</b> (${stats})\n${lines.join('\n')}`);
      }
      text = sections.join('\n\n');
    }
  } else {
    text = rows.map((r) => {
      const emoji = getAppEmoji(r.app);
      const appLabel = escapeHtml(r.app || 'Coupon');
      const codeLabel = escapeHtml(r.code);
      return `${emoji} <b>${appLabel}</b>: <code>${codeLabel}</code>\n📱 +${escapeHtml(r.phone || '')}${r.deliveredAt ? ` · 📅 ${escapeHtml(String(r.deliveredAt).slice(0, 10))}` : ''}`;
    }).join('\n\n');
  }

  const buttons = [];

  const distinctServices = (allServices && allServices.length)
    ? allServices
    : [...new Set(records.map((r) => (r.app || 'General').trim()).filter(Boolean))];

  if (admin && distinctServices.length > 1) {
    const filterRows = [];
    let currentRow = [];
    if (filter && filter !== 'all') {
      currentRow.push(button('🌐 All Services', 'coupons:0'));
    }
    for (const s of distinctServices.slice(0, 4)) {
      if (filter && filter.toLowerCase() === s.toLowerCase()) continue;
      currentRow.push(button(`${getAppEmoji(s)} ${s}`, `coupons:app:${s}:0`));
      if (currentRow.length === 2) {
        filterRows.push(currentRow);
        currentRow = [];
      }
    }
    if (currentRow.length) filterRows.push(currentRow);
    buttons.push(...filterRows);
  }

  if (admin) {
    for (let i = 0; i < rows.length; i += 2) {
      const row = [button(`🎁 ${rows[i].app ? rows[i].app + ': ' : ''}${rows[i].code}`, `detail:${rows[i].code}`)];
      if (i + 1 < rows.length) {
        row.push(button(`🎁 ${rows[i + 1].app ? rows[i + 1].app + ': ' : ''}${rows[i + 1].code}`, `detail:${rows[i + 1].code}`));
      }
      buttons.push(row);
    }
  } else {
    for (const r of rows) {
      buttons.push([button(`🎁 ${r.app ? r.app + ': ' : ''}${r.code}`, `detail:${r.code}`)]);
    }
  }

  const nav = [];
  if (index > 0) nav.push(button('⬅️ Previous', `${prefix}:${index - 1}`));
  if (index + 1 < pages) nav.push(button('Next ➡️', `${prefix}:${index + 1}`));
  if (nav.length) buttons.push(nav);

  if (admin) {
    buttons.push([button('➕ Add coupon', 'addcoupon'), button('👑 Admin panel', 'admin')]);
  } else {
    buttons.push([button('🏠 Main menu', 'home')]);
  }

  const totalCount = records.length;
  const inPoolCount = records.filter((r) => !r.deliveredTo && !r.assignedSessionId).length;
  const deliveredCount = totalCount - inPoolCount;

  let title = `<b>🎁 ${admin ? 'Coupon Inventory &amp; Delivery' : 'Your coupons'}</b>`;
  if (admin && filter && filter !== 'all') {
    title = `<b>🎁 ${getAppEmoji(filter)} ${escapeHtml(filter)} Coupons</b>`;
  }

  let subtitle = `📋 ${records.length} total · Page ${index + 1}/${pages}`;
  if (admin) {
    subtitle = `📋 ${totalCount} total · 🟢 ${inPoolCount} in pool · 📤 ${deliveredCount} delivered · Page ${index + 1}/${pages}`;
  }

  return {
    text: `${title}\n${subtitle}\n\n${text || 'No coupons here yet.'}`,
    reply_markup: keyboard(...buttons)
  };
}

module.exports = {
  escapeHtml, button, keyboard, homeKeyboard, backKeyboard, cancelKeyboard,
  adminKeyboard, appSelectKeyboard, userPrefAppKeyboard, canViewCode, canUseCallback, pageOf, getAppEmoji, codePage
};
