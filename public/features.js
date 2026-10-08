// Dashboard UI for: Sessions (phone login + failover), APK & Store, Flagged chats.
// Uses globals from app.js: apiFetch, activeInstanceSlug, socket, showToast, escapeHtml.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(String(v ?? '')) : String(v ?? ''));
  const slug = () => activeInstanceSlug;
  const icons = () => window.lucide && window.lucide.createIcons();
  let currentTab = '';
  let flags = [];
  let unreadFlags = 0;
  let features = null;

  async function api(url, opts = {}) {
    if (opts.json !== undefined) {
      opts.method = opts.method || 'POST';
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    const r = await apiFetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }
  const toast = (m, t) => showToast(m, t || 'info');

  // ── Tab headers + loading ───────────────────────────────────
  const TABS = {
    sessions: ['WhatsApp Sessions', 'Log in with phone numbers. The next linked number takes over when one logs out.', loadSessions],
    apkstore: ['APK & Store', 'Telegram APK updates, the download link message and your Play Store page.', loadFeatures],
    flagged: ['Flagged Chats', 'Messages containing your watch words, saved with a chat screenshot.', loadFlagged]
  };
  document.querySelectorAll('.menu-item').forEach((item) => {
    item.addEventListener('click', () => {
      const tab = item.getAttribute('data-tab');
      currentTab = tab;
      const t = TABS[tab];
      if (!t) return;
      setTimeout(() => {
        $('page-title').textContent = t[0];
        $('page-subtitle').textContent = t[1];
      }, 0);
      if (tab === 'flagged') { unreadFlags = 0; $('unread-flags').style.display = 'none'; }
      t[2]();
    });
  });

  // ── Live updates over the existing socket ───────────────────
  let boundSocket = null;
  setInterval(() => {
    if (typeof socket === 'undefined' || !socket || socket === boundSocket) return;
    boundSocket = socket;
    socket.on('sessions', (list) => renderSessions(list));
    socket.on('pairing_code', (d) => showCode(d.phone, d.code));
    socket.on('session_switched', (d) => toast(`Active number logged out. Switched to +${d.phone}.`, 'info'));
    socket.on('flagged', (entry) => {
      flags.unshift(entry);
      if (currentTab === 'flagged') renderFlags();
      else { unreadFlags++; $('unread-flags').textContent = unreadFlags; $('unread-flags').style.display = 'inline-flex'; }
    });
    socket.on('apk_cached', () => { if (currentTab === 'apkstore') loadFeatures(); });
  }, 1000);

  // ── Sessions ────────────────────────────────────────────────
  const STATUS = {
    linked: ['Linked', 'ok'], pairing: ['Waiting for code', 'warn'], pending: ['Not linked', 'muted'], logged_out: ['Logged out', 'bad']
  };
  async function loadSessions() {
    try { renderSessions(await api(`/api/instances/${slug()}/sessions`)); } catch (e) { toast(e.message, 'error'); }
  }
  function renderSessions(list) {
    $('feat-session-count').textContent = list.length;
    if (!list.length) { $('feat-sessions-list').innerHTML = '<p class="feat-muted">No numbers yet. Add one above.</p>'; return; }
    $('feat-sessions-list').innerHTML = list.map((s, i) => {
      const [label, cls] = s.online ? ['Online — active', 'ok'] : (STATUS[s.status] || [s.status, 'muted']);
      return `<div class="feat-item">
        <div class="feat-prio">${i + 1}</div>
        <div class="feat-item-main">
          <div class="feat-item-title">${s.phone ? '+' + esc(s.phone) : 'No number'} <span class="feat-muted">· ${esc(s.label || '')}</span></div>
          <div><span class="feat-pill ${cls}">${label}</span>${s.active && !s.online ? ' <span class="feat-pill warn">Starting</span>' : ''}${s.linking ? ' <span class="feat-pill warn">Linking in background</span>' : ''}${s.pairingCode && s.status === 'pairing' ? ` <code class="feat-inline-code">${esc(s.pairingCode)}</code>` : ''}</div>
        </div>
        <div class="feat-actions">
          <button class="btn-action" title="Move up" data-act="up" data-id="${s.id}" ${i === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i></button>
          <button class="btn-action" title="Move down" data-act="down" data-id="${s.id}" ${i === list.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i></button>
          ${s.status === 'linked' && !s.active ? `<button class="btn btn-secondary btn-sm" data-act="activate" data-id="${s.id}">Use now</button>` : ''}
          ${s.phone && s.status !== 'linked' ? `<button class="btn btn-secondary btn-sm" data-act="relink" data-id="${s.id}">New code</button>` : ''}
          <button class="btn-action" title="Remove" data-act="remove" data-id="${s.id}"><i data-lucide="trash-2"></i></button>
        </div>
      </div>`;
    }).join('');
    icons();
  }
  function showCode(phone, code) {
    $('feat-code-box').style.display = 'block';
    $('feat-code-phone').textContent = phone ? '+' + phone : '';
    $('feat-code-val').textContent = code && code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
  }
  $('feat-add-session').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('feat-add-session-btn');
    btn.disabled = true;
    toast('Asking WhatsApp for a pairing code. This can take up to a minute...', 'info');
    try {
      const r = await api(`/api/instances/${slug()}/sessions`, { json: { phone: $('feat-session-phone').value, label: $('feat-session-label').value } });
      showCode($('feat-session-phone').value.replace(/\D/g, ''), r.code);
      $('feat-session-phone').value = ''; $('feat-session-label').value = '';
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false;
    loadSessions();
  });
  $('feat-sessions-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id, act = b.dataset.act, base = `/api/instances/${slug()}/sessions/${id}`;
    try {
      if (act === 'up' || act === 'down') await api(`${base}/move`, { json: { direction: act } });
      if (act === 'activate') { await api(`${base}/activate`, { json: {} }); toast('Switching number...', 'info'); }
      if (act === 'relink') { toast('Getting a new code...', 'info'); const r = await api(`${base}/relink`, { json: {} }); showCode('', r.code); }
      if (act === 'remove') {
        if (!confirm('Remove this number? It will be logged out from the bot.')) return;
        await api(base, { method: 'DELETE' });
      }
    } catch (err) { toast(err.message, 'error'); }
    loadSessions();
  });

  // ── APK & Store ─────────────────────────────────────────────
  async function loadFeatures() {
    try { features = await api(`/api/instances/${slug()}/features`); } catch (e) { return toast(e.message, 'error'); }
    const tg = features.telegram;
    $('feat-tg-badge').textContent = tg.configured ? (tg.error ? 'Error' : 'Connected') : 'Not set up';
    $('feat-tg-badge').className = 'badge feat-pill ' + (tg.configured && !tg.error ? 'ok' : 'bad');
    $('feat-tg-text').innerHTML = tg.configured
      ? `Bot: <strong>@${esc(tg.username || '...')}</strong> · ${tg.admins} admin ID(s) allowed${tg.lastUpload ? ` · last upload ${esc(tg.lastUpload.version)} on ${new Date(tg.lastUpload.at).toLocaleString()}` : ''}${tg.error ? `<br><span class="feat-bad">${esc(tg.error)}</span>` : ''}`
      : 'Add <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_ADMIN_IDS</code> to your <code>.env</code> file and restart the bot.';
    const a = features.apk;
    $('feat-apk-info').innerHTML = a
      ? `<strong>${esc(a.version || 'istore.apk')}</strong> · ${esc(a.size)}<br>From ${esc(a.uploadedBy)} on ${new Date(a.uploadedAt).toLocaleString()}${a.notes ? `<br>${esc(a.notes)}` : ''}`
      : 'No APK yet. Send one to the Telegram bot.';
    $('feat-linkmsg').value = features.apkLinkMessage;
    $('feat-store-link').textContent = features.storeLink;
    $('feat-store-open').href = `/app/${slug()}`;
    const f = $('feat-store-form'), l = features.storeListing;
    Array.from(f.elements).forEach((el) => { if (el.name && l[el.name] !== undefined) el.value = l[el.name]; });
    const media = (file) => `/store-media/${slug()}/${encodeURIComponent(file)}`;
    $('feat-icon').innerHTML = l.icon ? thumb(media(l.icon), l.icon) : '<span class="feat-muted">No icon</span>';
    $('feat-shots').innerHTML = (l.screenshots || []).map((s) => thumb(media(s), s)).join('') || '<span class="feat-muted">No screenshots</span>';
    renderWords();
  }
  const thumb = (src, file) => `<div class="feat-thumb"><img src="${src}"><button type="button" data-file="${esc(file)}" title="Remove">×</button></div>`;
  ['feat-icon', 'feat-shots'].forEach((id) => $(id).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-file]');
    if (!b) return;
    await api(`/api/instances/${slug()}/store/media/${encodeURIComponent(b.dataset.file)}`, { method: 'DELETE' }).catch((er) => toast(er.message, 'error'));
    loadFeatures();
  }));
  async function uploadFile(url, file, extra) {
    const fd = new FormData();
    Object.entries(extra || {}).forEach(([k, v]) => fd.append(k, v));
    fd.append('file', file);
    const r = await apiFetch(url, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Upload failed');
  }
  $('feat-icon-file').addEventListener('change', async (e) => {
    if (!e.target.files[0]) return;
    try { await uploadFile(`/api/instances/${slug()}/store/media`, e.target.files[0], { kind: 'icon' }); toast('Icon updated', 'success'); } catch (er) { toast(er.message, 'error'); }
    e.target.value = ''; loadFeatures();
  });
  $('feat-shot-file').addEventListener('change', async (e) => {
    if (!e.target.files[0]) return;
    try { await uploadFile(`/api/instances/${slug()}/store/media`, e.target.files[0], { kind: 'screenshot' }); toast('Screenshot added', 'success'); } catch (er) { toast(er.message, 'error'); }
    e.target.value = ''; loadFeatures();
  });
  $('feat-apk-upload').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('feat-apk-file').files[0];
    if (!file) return;
    toast('Uploading APK...', 'info');
    try { await uploadFile(`/api/instances/${slug()}/apk/upload`, file, { version: $('feat-apk-version').value }); toast('APK is live', 'success'); e.target.reset(); } catch (er) { toast(er.message, 'error'); }
    loadFeatures();
  });
  $('feat-linkmsg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api(`/api/instances/${slug()}/features`, { method: 'PUT', json: { apkLinkMessage: $('feat-linkmsg').value } }); toast('Message saved', 'success'); } catch (er) { toast(er.message, 'error'); }
  });
  $('feat-store-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const listing = {};
    Array.from(e.target.elements).forEach((el) => { if (el.name) listing[el.name] = el.value; });
    try { await api(`/api/instances/${slug()}/features`, { method: 'PUT', json: { storeListing: listing } }); toast('Store page saved', 'success'); loadFeatures(); } catch (er) { toast(er.message, 'error'); }
  });

  // ── Watch words + flagged chats ─────────────────────────────
  function renderWords() {
    const words = (features && features.watchWords) || [];
    $('feat-words').innerHTML = words.map((w) => `<span class="feat-chip">${esc(w)}<button type="button" data-word="${esc(w)}">×</button></span>`).join('') || '<span class="feat-muted">No watch words yet.</span>';
  }
  async function saveWords(words) {
    await api(`/api/instances/${slug()}/features`, { method: 'PUT', json: { watchWords: words } });
    features.watchWords = words;
    renderWords();
  }
  $('feat-words-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const w = $('feat-word-input').value.trim().toLowerCase();
    if (!w) return;
    try { await saveWords([...new Set([...(features.watchWords || []), w])]); $('feat-word-input').value = ''; } catch (er) { toast(er.message, 'error'); }
  });
  $('feat-words').addEventListener('click', (e) => {
    const b = e.target.closest('[data-word]');
    if (b) saveWords(features.watchWords.filter((w) => w !== b.dataset.word)).catch((er) => toast(er.message, 'error'));
  });

  async function loadFlagged() {
    try {
      features = await api(`/api/instances/${slug()}/features`);
      renderWords();
      flags = await api(`/api/instances/${slug()}/flagged`);
      renderFlags();
    } catch (e) { toast(e.message, 'error'); }
  }
  function renderFlags() {
    const q = $('feat-flag-search').value.trim().toLowerCase();
    const list = flags.filter((f) => !q || [f.sender, f.senderName, f.message, f.word].join(' ').toLowerCase().includes(q));
    $('feat-flags').innerHTML = list.map((f) => `<div class="feat-item">
        <div class="feat-item-main">
          <div class="feat-item-title">${esc(f.senderName || 'Unknown')} <span class="feat-muted">+${esc(f.sender)} · ${new Date(f.at).toLocaleString()}</span></div>
          <div class="feat-msg">${esc(f.message)}</div>
          <span class="feat-pill warn">${esc(f.word)}</span>
        </div>
        <div class="feat-actions">
          ${f.screenshot ? `<button class="btn btn-secondary btn-sm" data-shot="${f.id}"><i data-lucide="image"></i><span>Screenshot</span></button>` : '<span class="feat-muted">No screenshot</span>'}
          <button class="btn-action" title="Delete" data-del="${f.id}"><i data-lucide="trash-2"></i></button>
        </div>
      </div>`).join('') || '<p class="feat-muted">Nothing flagged yet.</p>';
    icons();
  }
  $('feat-flag-search').addEventListener('input', renderFlags);
  $('feat-flags').addEventListener('click', async (e) => {
    const shot = e.target.closest('[data-shot]'), del = e.target.closest('[data-del]');
    if (shot) {
      try {
        const r = await apiFetch(`/api/instances/${slug()}/flagged/${shot.dataset.shot}/screenshot`);
        if (!r.ok) throw new Error('Screenshot not found');
        $('feat-shot-img').src = URL.createObjectURL(await r.blob());
        $('feat-shot-modal').classList.add('active');
      } catch (er) { toast(er.message, 'error'); }
    }
    if (del) {
      await api(`/api/instances/${slug()}/flagged/${del.dataset.del}`, { method: 'DELETE' }).catch((er) => toast(er.message, 'error'));
      flags = flags.filter((f) => f.id !== del.dataset.del);
      renderFlags();
    }
  });
  $('feat-flag-clear').addEventListener('click', async () => {
    if (!confirm('Delete all flagged messages and screenshots?')) return;
    await api(`/api/instances/${slug()}/flagged/all`, { method: 'DELETE' }).catch((er) => toast(er.message, 'error'));
    flags = []; renderFlags();
  });
  $('feat-flag-export').addEventListener('click', () => {
    const rows = [['Time', 'Name', 'Number', 'Word', 'Message']].concat(flags.map((f) => [f.at, f.senderName, f.sender, f.word, f.message]));
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `flagged-${slug()}.csv`;
    a.click();
  });

  // Reload the open tab when the bot selector changes
  const sel = $('active-instance-select');
  if (sel) sel.addEventListener('change', () => { const t = TABS[currentTab]; if (t) setTimeout(t[2], 300); });
})();
