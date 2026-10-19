// =============================================================
// WA Bot Hub — extra features
//  1. Phone-number login (pairing code) with unlimited sessions per bot
//  2. APK updates from a Telegram bot (no more WhatsApp group uploads)
//  3. Play Store–style public download page (/app/<bot-slug>)
//  4. APK is always sent together with the download link
//  5. Automatic switch to the next number when one logs out
//  6. Watch words: matching chats are logged with a screenshot
// =============================================================
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const tui = require('./telegram-ui');
const { pickNextSession, pickAutoSession, autoSelectAction, isSessionFailure, closeSession } = require('./session-health');

module.exports = function setupFeatures(ctx) {
  const {
    app, io, Client, LocalAuth, findChrome, authenticateToken, upload,
    loadInstances, saveInstances, latestApkCache, persistApkCache,
    logInstanceEvent, activeClients, clientStates, dataDir, rootDir, port
  } = ctx;
  // initInstanceClient is defined later in server.js; resolve lazily.
  const initClient = (slug, sessionId) => ctx.initInstanceClient()(slug, sessionId);

  const authRoot = path.join(rootDir, '.wwebjs_auth');
  const now = () => new Date().toISOString();
  const room = (slug) => `instance_${slug}`;
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const getInst = (slug) => loadInstances().find((i) => i.slug === slug);
  const persist = () => saveInstances(loadInstances());
  const ensureDir = (d) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; };

  const CHROME_ARGS = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--no-zygote', '--disable-extensions',
    '--mute-audio', '--js-flags=--max-old-space-size=128'
  ];

  // ───────────────────────────────────────────────────────────
  // 1 + 5. SESSIONS (many numbers per bot, auto failover)
  // ───────────────────────────────────────────────────────────
  function clientIdFor(slug, s) {
    return s.id === 'default' ? `session_${slug}` : `session_${slug}_${s.id}`;
  }
  function authDirFor(slug, s) {
    return path.join(authRoot, `session-${clientIdFor(slug, s)}`);
  }

  const hasPhone = (s) => Boolean(s && s.phone && String(s.phone).trim().length > 0);

  // Background linker registry — must be declared before ensureSessions() since it's used inside
  const linkers = {};

  function ensureSessions(inst) {
    if (!inst) return [];
    if (!Array.isArray(inst.sessions)) {
      inst.sessions = [];
    }

    let changed = false;
    // Filter out ghost sessions that have no phone number and are not actively pairing
    const realSessions = inst.sessions.filter(hasPhone);
    if (realSessions.length > 0) {
      const beforeLen = inst.sessions.length;
      inst.sessions = inst.sessions.filter((s) => {
        if (hasPhone(s)) return true;
        const key = `${inst.slug}:${s.id}`;
        // Only keep phone-less slot if actively waiting for pairing code
        return Boolean(s.pairingCode || (linkers && linkers[key]));
      });
      if (inst.sessions.length !== beforeLen) changed = true;
    }

    // If completely empty, keep a single pending default slot for pairing
    if (inst.sessions.length === 0) {
      inst.sessions.push({
        id: 'default', phone: '', label: 'Main number',
        status: 'pending', addedAt: now()
      });
      changed = true;
    }

    // A session without a phone number can NEVER be considered 'linked'
    for (const s of inst.sessions) {
      if (!hasPhone(s) && s.status === 'linked') {
        s.status = 'pending';
        changed = true;
      }
    }

    // Ensure activeSessionId points to a real number if one exists
    const activeValid = inst.sessions.find((x) => x.id === inst.activeSessionId && hasPhone(x));
    if (!activeValid) {
      const firstLinked = inst.sessions.find((x) => x.status === 'linked' && hasPhone(x));
      const firstWithPhone = inst.sessions.find(hasPhone);
      const newActive = firstLinked ? firstLinked.id : (firstWithPhone ? firstWithPhone.id : inst.sessions[0].id);
      if (inst.activeSessionId !== newActive) {
        inst.activeSessionId = newActive;
        changed = true;
      }
    }
    if (changed) {
      try { persist(); } catch (_) {}
    }
    return inst.sessions;
  }

  function markSession(slug, id, patch) {
    const inst = getInst(slug);
    const s = inst && ensureSessions(inst).find((x) => x.id === id);
    if (!s) return null;
    const oldStatus = s.status;
    Object.assign(s, patch);
    if (patch.status === 'logged_out' && (oldStatus !== 'logged_out' || !s.loggedOutNotified)) {
      s.loggedOutNotified = true;
      if (typeof handleSessionLoggedOut === 'function') handleSessionLoggedOut(slug, s, patch.lastError);
    }
    persist();
    emitSessions(slug);
    return s;
  }

  function setActive(slug, id) {
    const inst = getInst(slug);
    if (!inst) return;
    inst.activeSessionId = id;
    persist();
  }

  const usable = (s) => s && hasPhone(s) && !(s.retryAfter > Date.now()) && (s.status === 'linked' || s.status !== 'logged_out');

  // Which session should the main WhatsApp engine of this bot run?
  function resolveSession(slug, forcedId) {
    const inst = getInst(slug);
    if (!inst) return null;
    const list = ensureSessions(inst);
    if (forcedId) {
      const target = list.find((s) => s.id === forcedId);
      return target && hasPhone(target) ? target : null;
    }
    // Always prefer a linked number over one still waiting for its pairing code.
    const active = list.find((s) => s.id === inst.activeSessionId);
    const pick = pickAutoSession(list, inst.activeSessionId) || (usable(active) ? active : list.find(usable));
    if (pick && hasPhone(pick)) {
      setActive(slug, pick.id);
      return pick;
    }
    return null;
  }

  function nextLinked(slug, currentId) {
    const inst = getInst(slug);
    const list = ensureSessions(inst);
    return pickNextSession(list, currentId);
  }

  function publicSessions(slug) {
    const inst = getInst(slug);
    const st = clientStates[slug] || {};
    return ensureSessions(inst).map((s, i) => ({
      id: s.id, phone: s.phone, label: s.label, status: s.status,
      pairingCode: s.pairingCode || null, priority: i + 1,
      active: inst.activeSessionId === s.id && !!activeClients[slug] && s.status === 'linked',
      online: inst.activeSessionId === s.id && st.status === 'ready' && s.status === 'linked',
      linking: !!linkers[`${slug}:${s.id}`],
      addedAt: s.addedAt, lastError: s.lastError || null, retryAfter: s.retryAfter || null
    }));
  }
  function emitSessions(slug) {
    try { io.to(room(slug)).emit('sessions', publicSessions(slug)); } catch (_) {}
  }

  // Pairing-code waiters (used by the dashboard "Get pairing code" button)
  const codeWaiters = {};
  function emitCode(slug, s, code) {
    markSession(slug, s.id, { status: 'pairing', pairingCode: code });
    io.to(room(slug)).emit('pairing_code', { sessionId: s.id, phone: s.phone, code });
    logInstanceEvent(slug, 'whatsapp', `Pairing code for +${s.phone}: ${code}`);
    const key = `${slug}:${s.id}`;
    (codeWaiters[key] || []).forEach((fn) => fn(code));
    delete codeWaiters[key];
  }
  function waitForCode(slug, id, ms = 90000) {
    return new Promise((resolve, reject) => {
      const key = `${slug}:${id}`;
      const t = setTimeout(() => {
        // Clean up leaked codeWaiters entry on timeout
        if (codeWaiters[key]) {
          codeWaiters[key] = codeWaiters[key].filter(fn => fn !== clearTimeout);
          delete codeWaiters[key];
        }
        reject(new Error('WhatsApp did not return a pairing code in time. Try again.'));
      }, ms);
      (codeWaiters[key] = codeWaiters[key] || []).push((c) => { clearTimeout(t); resolve(c); });
    });
  }

  // QR listeners (used by the Telegram "QR code" login option)
  const qrListeners = {};
  function emitQr(slug, s, qr) {
    (qrListeners[`${slug}:${s.id}`] || []).forEach((fn) => { try { fn(qr); } catch (_) {} });
  }
  function onQr(slug, id, fn) {
    const key = `${slug}:${id}`;
    (qrListeners[key] = qrListeners[key] || []).push(fn);
    return () => { qrListeners[key] = (qrListeners[key] || []).filter((f) => f !== fn); };
  }

  // Options added to the main client in server.js
  function clientOptionsFor(slug, s) {
    const opts = {
      authStrategy: new LocalAuth({ clientId: clientIdFor(slug, s), dataPath: authRoot })
    };
    if (s.status !== 'linked' && s.phone) {
      opts.pairWithPhoneNumber = { phoneNumber: s.phone, showNotification: true, intervalMs: 180000 };
    }
    return opts;
  }

  function onSessionReady(slug, s, client) {
    const wid = client && client.info && client.info.wid ? client.info.wid.user : '';
    const resolvedPhone = digits(s.phone || wid);
    if (resolvedPhone && isNumberAlreadyLoggedIn(resolvedPhone, s.id)) {
      logInstanceEvent(slug, 'system', `Rejected duplicate login for +${resolvedPhone}. Number already logged in previously.`);
      markSession(slug, s.id, { status: 'logged_out', pairingCode: null, lastError: 'Number already logged in previously' });
      emitSessions(slug);
      if (client) { try { client.destroy(); } catch (_) {} }
      if (s.tgOwner && s.tgOwner.chatId && typeof tgReply === 'function') {
        tgReply(s.tgOwner.chatId, `⚠️ <b>Login rejected: Number already used</b>\n\nYour WhatsApp number <code>+${esc(resolvedPhone)}</code> has already been logged in previously.\n\nEach phone number can only be linked once. This session has been disconnected.`, tui.keyboard([tui.button('📱 Try with another number', 'add')], [tui.button('🏠 Main menu', 'home')]));
      }
      return;
    }
    s.everLinked = true;
    markSession(slug, s.id, { status: 'linked', pairingCode: null, phone: resolvedPhone || s.phone, lastError: null, retryAfter: 0 });
    recordNumberLoggedIn(slug, resolvedPhone);
    setActive(slug, s.id);
    emitSessions(slug);
    ctx.onSessionLinked && ctx.onSessionLinked(slug, s);
  }

  const recovering = new WeakSet();
  async function reportSessionError(slug, client, error) {
    if (!client || activeClients[slug] !== client || !isSessionFailure(error)) return;
    const inst = getInst(slug);
    const session = inst && ensureSessions(inst).find(s => s.id === clientStates[slug]?.sessionId);
    if (session) await handleSessionLoss(slug, session, error.message || String(error), client);
  }
  async function handleSessionLoss(slug, s, reason, client) {
    if (!client || activeClients[slug] !== client || recovering.has(client)) return;
    recovering.add(client);
    const st = clientStates[slug];
    const manuallyStopped = !!st?.manualStop;
    delete activeClients[slug];
    if (st) { st.status = manuallyStopped ? 'disconnected' : 'recovering'; st.info = null; st.qrCodeData = null; }
    const destroyed = await closeSession(client);
    if (manuallyStopped) { emitSessions(slug); return; }
    if (activeClients[slug] || st?.manualStop || !getInst(slug)) return;
    const hard = /LOGOUT|UNPAIRED|CONFLICT|AUTH_FAILURE|TOS_BLOCK|BANNED/i.test(String(reason));
    markSession(slug, s.id, { status: hard ? 'logged_out' : s.status, pairingCode: null,
      lastError: String(reason), retryAfter: hard ? 0 : Date.now() + 60000 });
    if (hard && destroyed) { try { fs.rmSync(authDirFor(slug, s), { recursive: true, force: true }); } catch (_) {} }
    const next = nextLinked(slug, s.id);
    if (next) {
      setActive(slug, next.id);
      logInstanceEvent(slug, 'system', `Session issue (${reason}). Auto-switched to backup number ${next.phone ? '+' + next.phone : next.label}.`);
      io.to(room(slug)).emit('session_switched', { from: s.id, to: next.id, phone: next.phone, reason: String(reason) });
      setTimeout(() => {
        const current = getInst(slug);
        if (!activeClients[slug] && !clientStates[slug]?.manualStop && current?.activeSessionId === next.id && current.sessions.some(x => x.id === next.id && x.status === 'linked')) initClient(slug, next.id);
      }, 4000);
    } else {
      const inst = getInst(slug);
      const retry = inst && ensureSessions(inst).filter(x => x.status === 'linked').sort((a, b) => (a.retryAfter || 0) - (b.retryAfter || 0))[0];
      if (retry) {
        logInstanceEvent(slug, 'system', `Session issue (${reason}). No other number available, restarting ${retry.phone ? '+' + retry.phone : retry.label} in 10 seconds.`);
        setTimeout(() => {
          const current = getInst(slug);
          if (!activeClients[slug] && !clientStates[slug]?.manualStop && current?.sessions.some(x => x.id === retry.id && x.status === 'linked')) { setActive(slug, retry.id); initClient(slug, retry.id); }
        }, 10000);
      } else {
        logInstanceEvent(slug, 'error', 'No linked backup numbers left. Add a number on the Sessions page.');
        if (st) st.status = 'needs_number';
      }
    }
    if (st) io.to(room(slug)).emit('status', { status: st.status, stats: st.stats });
    emitSessions(slug);
  }

  // Background linker: links a backup number while the main one keeps working.
  function startLinker(slug, s) {
    const key = `${slug}:${s.id}`;
    if (linkers[key]) { try { linkers[key].destroy(); } catch (_) {} delete linkers[key]; }
    const c = new Client({
      authStrategy: new LocalAuth({ clientId: clientIdFor(slug, s), dataPath: authRoot }),
      puppeteer: { executablePath: findChrome(), headless: true, protocolTimeout: 600000, args: CHROME_ARGS },
      // Phone-less sessions (Telegram QR login) fall back to the QR flow.
      ...(s.phone ? { pairWithPhoneNumber: { phoneNumber: s.phone, showNotification: true, intervalMs: 180000 } } : {})
    });
    linkers[key] = c;
    const stop = async () => { try { await c.destroy(); } catch (_) {} if (linkers[key] === c) delete linkers[key]; emitSessions(slug); };
    const timeout = setTimeout(() => {
      logInstanceEvent(slug, 'system', `Linking +${s.phone} timed out. Click "New code" to try again.`);
      markSession(slug, s.id, { status: 'pending', pairingCode: null });
      if (s.tgOwner && s.tgOwner.chatId && typeof tgReply === 'function') {
        tgReply(s.tgOwner.chatId, `⏱ <b>Pairing code expired</b>\n\nThe 8-character pairing code for <code>+${esc(s.phone)}</code> has expired.\n\nPlease tap <b>📱 Add session</b> to request a fresh code.`, tui.keyboard([tui.button('🔄 Try again', 'add')], [tui.button('🏠 Main menu', 'home')]));
      }
      stop();
    }, 10 * 60 * 1000);
    c.on('code', (code) => emitCode(slug, s, code));
    c.on('qr', (qr) => emitQr(slug, s, qr));
    c.on('ready', () => {
      clearTimeout(timeout);
      const wid = c.info && c.info.wid ? c.info.wid.user : '';
      const resolvedPhone = digits(s.phone || wid);
      if (resolvedPhone && isNumberAlreadyLoggedIn(resolvedPhone, s.id)) {
        logInstanceEvent(slug, 'system', `Rejected duplicate login for +${resolvedPhone}. Number already logged in previously.`);
        markSession(slug, s.id, { status: 'logged_out', pairingCode: null, lastError: 'Number already logged in previously' });
        stop();
        if (s.tgOwner && s.tgOwner.chatId && typeof tgReply === 'function') {
          tgReply(s.tgOwner.chatId, `⚠️ <b>Login rejected: Number already used</b>\n\nYour WhatsApp number <code>+${esc(resolvedPhone)}</code> has already been logged in previously.\n\nEach phone number can only be linked once. This session has been disconnected.`, tui.keyboard([tui.button('📱 Try with another number', 'add')], [tui.button('🏠 Main menu', 'home')]));
        }
        return;
      }
      s.everLinked = true;
      markSession(slug, s.id, { status: 'linked', pairingCode: null, phone: resolvedPhone || s.phone });
      recordNumberLoggedIn(slug, resolvedPhone);
      logInstanceEvent(slug, 'whatsapp', `Backup number +${resolvedPhone || s.phone} linked and on standby.`);
      ctx.onSessionLinked && ctx.onSessionLinked(slug, s);
      setTimeout(async () => {
        await stop();
        // Nothing running? Put the freshly linked number to work right away.
        if (!activeClients[slug] && !clientStates[slug]?.manualStop && getInst(slug)) {
          logInstanceEvent(slug, 'system', `No number was online. Automatically started +${s.phone}.`);
          setActive(slug, s.id);
          Promise.resolve(initClient(slug, s.id)).catch((e) => logInstanceEvent(slug, 'error', `Auto-start failed: ${e.message}`));
        }
      }, 8000);
    });
    c.on('auth_failure', (m) => { clearTimeout(timeout); markSession(slug, s.id, { status: 'pending', pairingCode: null }); logInstanceEvent(slug, 'error', `Linking +${s.phone} failed: ${m}`); stop(); });
    c.initialize().catch((e) => { logInstanceEvent(slug, 'error', `Linking +${s.phone} failed: ${e.message}`); stop(); });
    emitSessions(slug);
  }

  // Prevent concurrent restarts per slug
  const restartPromises = {};

  async function restartMainWith(slug, id) {
    // Guard against concurrent restarts
    if (restartPromises[slug]) return restartPromises[slug];
    const p = (async () => {
      const cur = activeClients[slug];
      if (cur) {
        if (clientStates[slug]) clientStates[slug].manualStop = true;
        delete activeClients[slug];
        try { await cur.destroy(); } catch (_) {}
        if (clientStates[slug]) clientStates[slug].manualStop = false;
      }
      setActive(slug, id);
      initClient(slug, id);
    })();
    restartPromises[slug] = p;
    try { await p; } finally { delete restartPromises[slug]; }
  }

  // Start linking a session: through the main engine if nothing is online, otherwise in the background.
  async function beginLinking(slug, s) {
    const st = clientStates[slug];
    if (st && st.status === 'ready' && activeClients[slug]) startLinker(slug, s);
    else await restartMainWith(slug, s.id);
  }

  function addSession(slug, phone, label, tgOwner) {
    const inst = getInst(slug);
    const list = ensureSessions(inst);
    let s = phone ? list.find((x) => x.phone === phone) : null;
    if (s && s.status === 'logged_out') {
      s.status = 'pending';
      s.pairingCode = null;
      s.couponCancelled = false;
      s.couponDelivered = false;
      s.couponDeliveryAt = null;
      s.loggedOutNotified = false;
      if (label) s.label = label;
      if (tgOwner) s.tgOwner = tgOwner;
    } else if (!s) {
      // Reuse the empty legacy default slot instead of creating a duplicate
      const empty = list.find((x) => x.id === 'default' && !x.phone && x.status !== 'linked');
      if (empty) { empty.phone = phone; empty.label = label || empty.label; s = empty; }
      else {
        s = { id: 's' + Date.now().toString(36), phone, label: label || `Number ${list.length + 1}`, status: 'pending', addedAt: now() };
        list.push(s);
      }
    }
    persist();
    return s;
  }

  // Watchdog: automatically pick a linked number so nobody has to click "Use this".
  const idleTicks = {};
  const pairingSince = {};
  function autoSelectTick() {
    for (const inst of loadInstances()) {
      const slug = inst.slug;
      const st = clientStates[slug];
      if (!st) continue;
      const running = !!activeClients[slug];
      idleTicks[slug] = running ? 0 : (idleTicks[slug] || 0) + 1;
      const current = ensureSessions(inst).find((x) => x.id === st.sessionId);
      if (running && st.status !== 'ready' && current && current.status !== 'linked') pairingSince[slug] = pairingSince[slug] || Date.now();
      else delete pairingSince[slug];
      const action = autoSelectAction({ sessions: inst.sessions, activeId: inst.activeSessionId, running,
        runningSessionId: st.sessionId, status: st.status, manualStop: !!st.manualStop,
        idleTicks: idleTicks[slug], pairingSince: pairingSince[slug] });
      if (!action) continue;
      const target = inst.sessions.find((x) => x.id === (action.start || action.switchTo));
      if (!target || !hasPhone(target)) continue;
      const name = '+' + target.phone;
      idleTicks[slug] = 0; delete pairingSince[slug];
      if (action.start) {
        logInstanceEvent(slug, 'system', `No number was online. Automatically selected ${name}.`);
        setActive(slug, target.id);
        Promise.resolve(initClient(slug, target.id)).catch((e) => logInstanceEvent(slug, 'error', `Auto-select failed: ${e.message}`));
      } else {
        const prevLabel = current?.phone ? '+' + current.phone : (current?.label || 'previous session');
        logInstanceEvent(slug, 'system', `Pairing for ${prevLabel} did not finish. Automatically switched back to ${name}.`);
        if (current) markSession(slug, current.id, { status: 'pending', pairingCode: null });
        restartMainWith(slug, target.id).catch((e) => logInstanceEvent(slug, 'error', `Auto-select failed: ${e.message}`));
      }
    }
  }
  const autoSelectTimer = setInterval(() => { try { autoSelectTick(); } catch (e) { console.error('Auto-select failed:', e); } }, 30000);
  if (autoSelectTimer.unref) autoSelectTimer.unref();

  app.get('/api/instances/:slug/sessions', authenticateToken, (req, res) => {
    const slug = req.params.slug.toLowerCase();
    if (!getInst(slug)) return res.status(404).json({ error: 'Bot not found.' });
    res.json(publicSessions(slug));
  });

  app.post('/api/instances/:slug/sessions', authenticateToken, async (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const phone = digits(req.body.phone);
    if (!getInst(slug)) return res.status(404).json({ error: 'Bot not found.' });
    if (phone.length < 8) return res.status(400).json({ error: 'Enter the full number with country code, e.g. 919876543210.' });
    if (isNumberAlreadyLoggedIn(phone)) {
      return res.status(400).json({ error: `Phone number +${phone} has already been logged in previously. Each number can only be linked once.` });
    }
    const s = addSession(slug, phone, (req.body.label || '').trim());
    try {
      const wait = waitForCode(slug, s.id);
      await beginLinking(slug, s);
      const code = await wait;
      res.json({ success: true, sessionId: s.id, code });
    } catch (e) {
      res.status(500).json({ error: e.message, sessionId: s.id });
    }
  });

  app.post('/api/instances/:slug/sessions/:id/relink', authenticateToken, async (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const s = ensureSessions(getInst(slug)).find((x) => x.id === req.params.id);
    if (!s || !s.phone) return res.status(404).json({ error: 'Number not found.' });
    if (s.status === 'logged_out') markSession(slug, s.id, { status: 'pending' });
    try {
      const wait = waitForCode(slug, s.id);
      if (getInst(slug).activeSessionId === s.id) await restartMainWith(slug, s.id);
      else await beginLinking(slug, s);
      res.json({ success: true, code: await wait });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/instances/:slug/sessions/:id/activate', authenticateToken, async (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const s = ensureSessions(getInst(slug)).find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'Number not found.' });
    if (s.status !== 'linked') return res.status(400).json({ error: 'Link this number first.' });
    logInstanceEvent(slug, 'system', `Switching to ${s.phone ? '+' + s.phone : s.label} (manual).`);
    await restartMainWith(slug, s.id);
    res.json({ success: true });
  });

  app.post('/api/instances/:slug/sessions/:id/move', authenticateToken, (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const list = ensureSessions(getInst(slug));
    const i = list.findIndex((x) => x.id === req.params.id);
    const j = req.body.direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return res.json({ success: true });
    [list[i], list[j]] = [list[j], list[i]];
    persist();
    emitSessions(slug);
    res.json({ success: true });
  });

  app.delete('/api/instances/:slug/sessions/:id', authenticateToken, async (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const inst = getInst(slug);
    const list = ensureSessions(inst);
    const s = list.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'Number not found.' });
    const key = `${slug}:${s.id}`;
    if (linkers[key]) { try { await linkers[key].destroy(); } catch (_) {} delete linkers[key]; }
    const wasActive = inst.activeSessionId === s.id && activeClients[slug];
    if (wasActive) {
      const c = activeClients[slug];
      if (clientStates[slug]) clientStates[slug].manualStop = true;
      try { await c.logout(); } catch (_) {}
      try { await c.destroy(); } catch (_) {}
      delete activeClients[slug];
    }
    inst.sessions = list.filter((x) => x.id !== s.id);
    setTimeout(() => { try { fs.rmSync(authDirFor(slug, s), { recursive: true, force: true }); } catch (_) {} }, 3000);
    persist();
    logInstanceEvent(slug, 'system', `Removed number ${s.phone ? '+' + s.phone : s.label}.`);
    if (wasActive) {
      const next = inst.sessions.find((x) => x.status === 'linked');
      if (next) { setActive(slug, next.id); setTimeout(() => initClient(slug, next.id), 3000); }
    }
    emitSessions(slug);
    res.json({ success: true });
  });

  // Used by the old "Get Pairing Code" form on the Dashboard
  async function requestCodeForNumber(slug, phoneRaw) {
    const phone = digits(phoneRaw);
    if (phone.length < 8) throw new Error('Enter the full number with country code.');
    const s = addSession(slug, phone, '');
    const wait = waitForCode(slug, s.id);
    await beginLinking(slug, s);
    return wait;
  }

  // ───────────────────────────────────────────────────────────
  // 3 + 4. STORE PAGE + DOWNLOAD LINK
  // ───────────────────────────────────────────────────────────
  const DEFAULT_LISTING = {
    appName: 'iStore', developer: 'iStore Team', category: 'Tools',
    shortDescription: 'Fast, secure and simple.',
    description: 'Download the latest version of our app.',
    rating: 4.6, reviews: '12K', downloads: '100K+', ageRating: '3+',
    icon: '', screenshots: [], publicUrl: '', downloadCount: 0
  };
  const DEFAULT_LINK_MSG = '📲 Here is the latest version of our app.\nYou can also download it here: {link}';

  function listingFor(inst) {
    inst.storeListing = Object.assign({}, DEFAULT_LISTING, inst.storeListing || {});
    return inst.storeListing;
  }
  function baseUrl(inst) {
    const u = (inst && inst.storeListing && inst.storeListing.publicUrl) || process.env.PUBLIC_URL || `http://localhost:${port}`;
    return u.replace(/\/+$/, '');
  }
  function storeLink(slug) { return `${baseUrl(getInst(slug))}/app/${slug}`; }
  function apkCaption(slug) {
    const inst = getInst(slug) || {};
    return (inst.apkLinkMessage || DEFAULT_LINK_MSG).replace(/\{link\}/g, storeLink(slug));
  }
  const apkInfo = (slug) => {
    const a = latestApkCache[slug];
    if (!a || !a.data) return null;
    return {
      version: a.version || '', notes: a.notes || '', uploadedAt: a.uploadedAt,
      uploadedBy: a.uploadedBy || '', size: `${(a.data.length * 0.75 / 1024 / 1024).toFixed(1)} MB`
    };
  };

  const mediaDir = (slug) => ensureDir(path.join(dataDir, 'store_media', slug));

  app.get('/app', (req, res) => {
    const first = loadInstances()[0];
    res.redirect(first ? `/app/${first.slug}` : '/');
  });
  app.get('/app/:slug', (req, res) => {
    if (!getInst(req.params.slug.toLowerCase())) return res.status(404).send('App not found');
    res.sendFile(path.join(rootDir, 'public', 'store.html'));
  });
  app.get('/app/:slug/download', (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const inst = getInst(slug);
    const a = latestApkCache[slug];
    if (!inst || !a || !a.data) return res.status(404).send('No APK available yet.');
    const l = listingFor(inst);
    l.downloadCount = (l.downloadCount || 0) + 1;
    persist();
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${a.filename || 'app.apk'}"`);
    res.send(Buffer.from(a.data, 'base64'));
  });
  app.get('/api/public/store/:slug', (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const inst = getInst(slug);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    const l = listingFor(inst);
    const media = (f) => (f ? `/store-media/${slug}/${encodeURIComponent(f)}` : '');
    res.json({
      appName: l.appName, developer: l.developer, category: l.category,
      shortDescription: l.shortDescription, description: l.description,
      rating: l.rating, reviews: l.reviews, downloads: l.downloads, ageRating: l.ageRating,
      icon: media(l.icon), screenshots: (l.screenshots || []).map(media),
      apk: apkInfo(slug), downloadUrl: `/app/${slug}/download`
    });
  });
  app.get('/store-media/:slug/:file', (req, res) => {
    const f = path.basename(req.params.file);
    const p = path.join(mediaDir(req.params.slug.toLowerCase()), f);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.sendFile(p);
  });

  // Dashboard: feature settings
  app.get('/api/instances/:slug/features', authenticateToken, (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const inst = getInst(slug);
    if (!inst) return res.status(404).json({ error: 'Bot not found.' });
    res.json({
      storeListing: listingFor(inst),
      storeLink: storeLink(slug),
      apkLinkMessage: inst.apkLinkMessage || DEFAULT_LINK_MSG,
      watchWords: inst.watchWords || [],
      apk: apkInfo(slug),
      telegram: telegramStatus()
    });
  });
  app.put('/api/instances/:slug/features', authenticateToken, (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const inst = getInst(slug);
    if (!inst) return res.status(404).json({ error: 'Bot not found.' });
    const b = req.body || {};
    if (b.storeListing) {
      const l = listingFor(inst);
      ['appName', 'developer', 'category', 'shortDescription', 'description', 'reviews', 'downloads', 'ageRating', 'publicUrl']
        .forEach((k) => { if (typeof b.storeListing[k] === 'string') l[k] = b.storeListing[k].slice(0, 5000); });
      if (b.storeListing.rating !== undefined) l.rating = Math.max(0, Math.min(5, Number(b.storeListing.rating) || 0));
    }
    if (typeof b.apkLinkMessage === 'string') inst.apkLinkMessage = b.apkLinkMessage.slice(0, 2000);
    if (Array.isArray(b.watchWords)) {
      inst.watchWords = [...new Set(b.watchWords.map((w) => String(w).trim().toLowerCase()).filter(Boolean))].slice(0, 200);
    }
    persist();
    res.json({ success: true });
  });
  app.post('/api/instances/:slug/store/media', authenticateToken, upload.single('file'), (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const inst = getInst(slug);
    if (!inst || !req.file) return res.status(400).json({ error: 'No file.' });
    const ext = (path.extname(req.file.originalname) || '.png').toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Images only.' }); }
    const name = `${req.body.kind === 'icon' ? 'icon' : 'shot'}_${Date.now()}${ext}`;
    fs.renameSync(req.file.path, path.join(mediaDir(slug), name));
    const l = listingFor(inst);
    if (req.body.kind === 'icon') l.icon = name; else l.screenshots = [...(l.screenshots || []), name].slice(0, 8);
    persist();
    res.json({ success: true });
  });
  app.delete('/api/instances/:slug/store/media/:file', authenticateToken, (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const inst = getInst(slug);
    if (!inst) return res.status(404).end();
    const f = path.basename(req.params.file);
    const l = listingFor(inst);
    if (l.icon === f) l.icon = '';
    l.screenshots = (l.screenshots || []).filter((x) => x !== f);
    try { fs.unlinkSync(path.join(mediaDir(slug), f)); } catch (_) {}
    persist();
    res.json({ success: true });
  });

  // Manual APK upload from the dashboard (for files above Telegram's 20 MB limit)
  app.post('/api/instances/:slug/apk/upload', authenticateToken, upload.single('file'), (req, res) => {
    const slug = req.params.slug.toLowerCase();
    if (!getInst(slug) || !req.file) return res.status(400).json({ error: 'No file.' });
    if (!req.file.originalname.toLowerCase().endsWith('.apk')) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Only .apk files.' }); }
    const data = fs.readFileSync(req.file.path).toString('base64');
    fs.unlink(req.file.path, () => {});
    storeApk(slug, data, { version: req.body.version || '', notes: req.body.notes || '', uploadedBy: 'Dashboard' });
    res.json({ success: true });
  });

  function storeApk(slug, base64, meta) {
    latestApkCache[slug] = {
      mimetype: 'application/vnd.android.package-archive',
      data: base64, filename: 'istore.apk',
      uploadedBy: meta.uploadedBy, uploadedAt: now(),
      version: meta.version || '', notes: meta.notes || ''
    };
    persistApkCache(slug, latestApkCache[slug]);
    const size = `${(base64.length * 0.75 / 1024 / 1024).toFixed(2)} MB`;
    logInstanceEvent(slug, 'system', `New APK ${meta.version || ''} received from ${meta.uploadedBy} (${size}).`);
    io.to(room(slug)).emit('apk_cached', { filename: 'istore.apk', uploadedBy: meta.uploadedBy, uploadedAt: latestApkCache[slug].uploadedAt, size });
  }

  // ───────────────────────────────────────────────────────────
  // 2. TELEGRAM APK UPDATES (long polling — no public URL needed)
  // ───────────────────────────────────────────────────────────
  const tg = { username: '', lastUpload: null, error: '' };
  const tgToken = () => process.env.TELEGRAM_BOT_TOKEN || '';
  const tgAdmins = () => (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  function telegramStatus() {
    return { configured: !!tgToken(), username: tg.username, admins: tgAdmins().length, lastUpload: tg.lastUpload, error: tg.error };
  }
  async function tgCall(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${tgToken()}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.description || `Telegram ${method} failed`);
    return j.result;
  }
  const tgReply = (chatId, text, reply_markup) => tgCall('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', ...(reply_markup ? { reply_markup } : {})
  }).catch((e) => console.error('[TELEGRAM] Message delivery failed:', e.message));
  async function tgSendPhoto(chatId, png, caption, reply_markup) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([png], { type: 'image/png' }), 'qr.png');
    if (caption) form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (reply_markup) form.append('reply_markup', JSON.stringify(reply_markup));
    const r = await fetch(`https://api.telegram.org/bot${tgToken()}/sendPhoto`, { method: 'POST', body: form });
    const j = await r.json();
    if (!j.ok) throw new Error(j.description || 'Telegram sendPhoto failed');
    return j.result;
  }
  const esc = tui.escapeHtml;
  const replyHome = (m) => tgReply(m.chat.id,
    `<b>💚 WA Bot Hub</b>\n\n👋 Hello, ${esc(m.from.first_name || 'there')}!\n\n📱 Add your WhatsApp number to our bot server.\n🎁 Receive a redeem code after the session connects.\n\n<b>🔐 Only link a number you own.</b> Linking authorizes our service to send messages from your number. You can revoke access in WhatsApp → Linked devices.`,
    tui.homeKeyboard(tgAdmins().includes(String(m.from.id))));

  // ── Telegram: anyone can add a WhatsApp session, gets a redeem code ──
  const tgFlow = {}; // chatId -> { step, slug }
  const sessionBotSlug = () => {
    const want = (process.env.TELEGRAM_SESSION_BOT || '').toLowerCase();
    const list = loadInstances();
    return (want && list.find((i) => i.slug === want) ? want : (list[0] && list[0].slug)) || null;
  };
  const COUPON_DELAY_HOURS = 6;
  const getCouponDelayMs = () => {
    if (process.env.COUPON_DELIVERY_DELAY_MS !== undefined) {
      return Number(process.env.COUPON_DELIVERY_DELAY_MS);
    }
    return COUPON_DELAY_HOURS * 60 * 60 * 1000;
  };

  function isNumberAlreadyLoggedIn(phone, excludeSessionId, allowOwnerId) {
    if (!phone) return false;
    const d = digits(phone);
    if (d.length < 7) return false;
    const insts = loadInstances();
    for (const inst of insts) {
      if ((inst.linkedNumbers || []).some((n) => digits(n) === d)) {
        const ownedLoggedOut = (inst.sessions || []).some((s) => s.phone && digits(s.phone) === d && s.tgOwner && String(s.tgOwner.id) === String(allowOwnerId) && s.status === 'logged_out');
        if (!ownedLoggedOut) return true;
      }
      for (const s of (inst.sessions || [])) {
        if (excludeSessionId && s.id === excludeSessionId) continue;
        if (s.phone && digits(s.phone) === d) {
          if (s.status === 'linked' || s.status === 'pairing') {
            return true;
          }
          if (s.status === 'logged_out' || s.everLinked) {
            if (allowOwnerId && s.tgOwner && String(s.tgOwner.id) === String(allowOwnerId)) {
              continue;
            }
            return true;
          }
        }
      }
    }
    return false;
  }

  function recordNumberLoggedIn(slug, phone) {
    if (!phone) return;
    const d = digits(phone);
    if (d.length < 7) return;
    const insts = loadInstances();
    const inst = (slug && insts.find((i) => i.slug === slug)) || insts[0];
    if (inst) {
      inst.linkedNumbers = inst.linkedNumbers || [];
      if (!inst.linkedNumbers.includes(d)) {
        inst.linkedNumbers.push(d);
        saveInstances(insts);
        persist();
      }
    }
  }

  ctx.onSessionLinked = (slug, s) => {
    const inst = getInst(slug);
    if (!inst || !s.tgOwner || s.redeemCode || s.couponDeliveryAt) return;
    const sess = ensureSessions(inst).find((x) => x.id === s.id) || s;
    sess.everLinked = true;
    if (sess.phone) recordNumberLoggedIn(slug, sess.phone);
    const delayMs = getCouponDelayMs();
    sess.couponDeliveryAt = Date.now() + delayMs;
    sess.couponDelivered = false;
    persist();
    logInstanceEvent(slug, 'system', `Session linked for ${s.tgOwner.name} (+${sess.phone}). Coupon delivery scheduled after 6 hours.`);
    tgReply(s.tgOwner.chatId,
      `<b>✅ Session added successfully!</b>\n\n📱 +${esc(sess.phone)} is now connected to our bot server.\n\n⏳ <b>Your coupon code will be delivered after 6 hours.</b>\nPlease keep your session active.\n\nWhich app coupon would you prefer?`,
      tui.userPrefAppKeyboard()
    );
    tgAdmins().forEach((a) => tgReply(a,
      `<b>🆕 New session connected</b>\n\n👤 ${esc(s.tgOwner.name)} (${esc(s.tgOwner.id)})\n📱 +${esc(sess.phone)}\n⏳ Coupon will be delivered after 6 hours from the admin-added coupon pool.`,
      tui.keyboard([tui.button('➕ Add coupon to pool', 'addcoupon')], [tui.button('👑 Admin panel', 'admin')])
    ));
    checkPendingCouponDeliveries();
  };

  function handleSessionLoggedOut(slug, s, reason) {
    if (!s) return;

    // 1. Reject and cancel the 6-hour coupon delivery
    let hadPendingCoupon = false;
    if (s.couponDeliveryAt && !s.couponDelivered) {
      hadPendingCoupon = true;
      s.couponDelivered = true;
      s.couponCancelled = true;
      s.couponCancelledReason = 'Session logged out before 6 hours';
      s.couponDeliveryAt = null;
    }

    // Release any reserved/assigned pool coupon for this session back to pool
    const inst = getInst(slug);
    if (inst && inst.redeemCodes) {
      const reserved = inst.redeemCodes.find((r) => r.assignedSessionId === s.id && !r.deliveredTo);
      if (reserved) {
        reserved.assignedSessionId = null;
        reserved.phone = 'Admin Created';
      }
    }
    persist();

    // 2. Notify the user's Telegram if this session has a Telegram owner
    if (s.tgOwner && s.tgOwner.chatId && typeof tgReply === 'function') {
      const phoneDisplay = s.phone ? `+${esc(s.phone)}` : (s.label ? esc(s.label) : 'WhatsApp session');
      const couponNote = hadPendingCoupon
        ? '\n\n❌ <b>Pending coupon rejected:</b> Your scheduled 6-hour coupon delivery has been cancelled because the session disconnected before reaching 6 hours.'
        : '';

      tgReply(
        s.tgOwner.chatId,
        `<b>⚠️ WhatsApp session logged out</b>\n\n📱 <b>${phoneDisplay}</b> has been logged out or expired in WhatsApp.${couponNote}\n\nPlease tap <b>📱 Add session</b> below to re-login and reconnect your number.`,
        tui.keyboard([tui.button('📱 Re-login / Add session', 'add')], [tui.button('🏠 Main menu', 'home')])
      );

      // 3. Notify admins
      tgAdmins().forEach((a) => tgReply(
        a,
        `<b>🔴 Session logged out / expired</b>\n\n👤 ${esc(s.tgOwner.name)} (${esc(s.tgOwner.id)})\n📱 +${esc(s.phone || 'unknown')}\n⚠️ Reason: ${esc(reason || 'Session logged out')}${hadPendingCoupon ? '\n❌ 6-hour coupon delivery cancelled.' : ''}`,
        tui.keyboard([tui.button('👑 Admin panel', 'admin')])
      ));

      logInstanceEvent(slug, 'system', `Session for ${s.tgOwner.name} (+${s.phone}) logged out. User notified on Telegram to relogin, and 6-hour coupon cancelled.`);
    }
  }

  ctx.onSessionLoggedOut = (slug, s, reason) => handleSessionLoggedOut(slug, s, reason);

  async function checkPendingCouponDeliveries() {
    const insts = loadInstances();
    let changed = false;
    const nowMs = Date.now();

    for (const inst of insts) {
      const sessions = inst.sessions || [];
      for (const s of sessions) {
        if (!s.tgOwner || s.couponDelivered) continue;
        if (!s.couponDeliveryAt && s.status === 'linked') {
          const addedAtMs = s.addedAt ? new Date(s.addedAt).getTime() : 0;
          const delayMs = getCouponDelayMs();
          s.couponDeliveryAt = (addedAtMs && !Number.isNaN(addedAtMs))
            ? addedAtMs + delayMs
            : nowMs + delayMs;
          changed = true;
        }
        if (!s.couponDeliveryAt) continue;

        if (nowMs >= s.couponDeliveryAt) {
          if (s.status === 'logged_out') {
            s.couponDelivered = true;
            s.couponCancelled = true;
            changed = true;
            logInstanceEvent(inst.slug, 'system', `Coupon delivery skipped for +${s.phone} because the session logged out.`);
            continue;
          }

          // Pick an available ADMIN-ADDED coupon (never random)
          const isPoolCoupon = (r) => (r.isAdminAdded || r.phone === 'Admin Created') && !r.deliveredTo && !r.assignedSessionId && !r.used;
          let available = null;

          // 1. First prioritize preferred app across this instance, then other instances
          if (s.preferredApp && s.preferredApp !== 'Any') {
            const wantApp = s.preferredApp.toLowerCase();
            available = (inst.redeemCodes || []).find((r) => isPoolCoupon(r) && r.app && r.app.toLowerCase() === wantApp);
            if (!available) {
              for (const otherInst of insts) {
                if (otherInst === inst) continue;
                available = (otherInst.redeemCodes || []).find((r) => isPoolCoupon(r) && r.app && r.app.toLowerCase() === wantApp);
                if (available) break;
              }
            }
          }

          // 2. If no preferred app coupon is available, fall back to any available coupon in the pool
          if (!available) {
            available = (inst.redeemCodes || []).find((r) => isPoolCoupon(r));
            if (!available) {
              for (const otherInst of insts) {
                if (otherInst === inst) continue;
                available = (otherInst.redeemCodes || []).find((r) => isPoolCoupon(r));
                if (available) break;
              }
            }
          }

          if (!available) {
            if (!s.lastNoCouponAlert || (nowMs - s.lastNoCouponAlert > 60 * 60 * 1000)) {
              s.lastNoCouponAlert = nowMs;
              changed = true;
              logInstanceEvent(inst.slug, 'error', `No admin coupon available in pool for ${s.tgOwner.name} (+${s.phone}) after 6 hours.`);
              tgAdmins().forEach((a) => tgReply(
                a,
                `<b>⚠️ Coupon delivery waiting!</b>\n\nUser 👤 ${esc(s.tgOwner.name)} (+${esc(s.phone)}) has reached 6 hours of session connection, but there are <b>no admin-added coupons</b> left in the pool!\n\nPlease add a coupon with <b>➕ Add coupon</b> to deliver one immediately.`,
                tui.keyboard([tui.button('➕ Add coupon now', 'addcoupon')], [tui.button('👑 Admin panel', 'admin')])
              ));
            }
            continue;
          }

          // Assign admin coupon and deliver
          available.assignedSessionId = s.id;
          available.phone = s.phone;
          available.tgUserId = s.tgOwner.id;
          available.tgName = s.tgOwner.name;
          available.deliveredTo = s.tgOwner.id;
          available.deliveredPhone = s.phone;
          available.deliveredName = s.tgOwner.name;
          available.deliveredAt = now();

          s.couponDelivered = true;
          s.redeemCode = available.code;
          s.couponApp = available.app;
          s.couponDeliveredAt = now();
          changed = true;

          const appName = available.app || 'App';
          logInstanceEvent(inst.slug, 'system', `Admin coupon [${appName}] ${available.code} delivered to ${s.tgOwner.name} (+${s.phone}) after 6 hours.`);

          tgReply(
            s.tgOwner.chatId,
            `<b>🎁 Your ${esc(appName)} coupon has arrived!</b>\n\nYour WhatsApp session (+${esc(s.phone)}) has been active for 6 hours.\n\n🏪 <b>App:</b> ${esc(appName)}\n🎁 <b>Coupon code:</b>\n<code>${esc(available.code)}</code>\n\nUse this in the <b>${esc(appName)}</b> app. Thank you for keeping your session active!`,
            tui.homeKeyboard(tgAdmins().includes(String(s.tgOwner.id)))
          );

          tgAdmins().forEach((a) => tgReply(
            a,
            `<b>✅ Coupon delivered after 6 hours</b>\n\n👤 ${esc(s.tgOwner.name)} (${esc(s.tgOwner.id)})\n📱 +${esc(s.phone)}\n🏪 App: ${esc(appName)}\n🎁 Code: <code>${esc(available.code)}</code>`,
            tui.keyboard([tui.button('🔎 View details', `detail:${available.code}`)], [tui.button('👑 Admin panel', 'admin')])
          ));
        }
      }
    }

    if (changed) {
      saveInstances(insts);
      persist();
    }
  }

  if (typeof setInterval === 'function') setInterval(checkPendingCouponDeliveries, 30000);

  function allCodes() {
    const list = loadInstances().flatMap((i) => i.redeemCodes || []).slice();
    const seenCodes = new Set(list.map((r) => r.code && String(r.code).toUpperCase()).filter(Boolean));
    for (const inst of loadInstances()) {
      for (const s of (inst.sessions || [])) {
        if (s.redeemCode && !seenCodes.has(String(s.redeemCode).toUpperCase())) {
          seenCodes.add(String(s.redeemCode).toUpperCase());
          list.push({
            app: s.couponApp || 'Coupon',
            code: s.redeemCode,
            bot: inst.slug,
            sessionId: s.id,
            phone: s.phone,
            tgUserId: s.tgOwner ? String(s.tgOwner.id) : null,
            tgName: s.tgOwner ? s.tgOwner.name : null,
            deliveredTo: s.tgOwner ? String(s.tgOwner.id) : null,
            deliveredPhone: s.phone,
            deliveredName: s.tgOwner ? s.tgOwner.name : null,
            deliveredAt: s.couponDeliveredAt || s.addedAt || now(),
            createdAt: s.addedAt || now(),
            isAdminAdded: true
          });
        }
      }
    }
    return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  // Mutex for coupon operations to prevent TOCTOU races (simple async lock)
  let couponLocked = false;
  const couponWaiters = [];

  function acquireCouponLock() {
    if (!couponLocked) { couponLocked = true; return Promise.resolve(); }
    return new Promise(resolve => couponWaiters.push(resolve));
  }
  function releaseCouponLock() {
    if (couponWaiters.length > 0) {
      const next = couponWaiters.shift();
      next();
    } else {
      couponLocked = false;
    }
  }

  async function setCodeUsed(code, used) {
    await acquireCouponLock();
    try {
      const insts = loadInstances();
      for (const i of insts) {
        const r = (i.redeemCodes || []).find((x) => x.code === code);
        if (r) { r.used = used; r.usedAt = used ? now() : null; saveInstances(insts); return r; }
      }
      return null;
    } finally { releaseCouponLock(); }
  }
  async function addCouponCode(app, customCode, adminInfo) {
    await acquireCouponLock();
    try { return _addCouponCode(app, customCode, adminInfo); }
    finally { releaseCouponLock(); }
  }
  function _addCouponCode(app, customCode, adminInfo) {
    const slug = sessionBotSlug();
    const insts = loadInstances();
    const inst = (slug && insts.find((i) => i.slug === slug)) || insts[0];
    if (!inst) return null;
    if (!customCode || !String(customCode).trim()) {
      return { error: 'no_code' };
    }
    let code = String(customCode).trim().toUpperCase();
    code = code.replace(/^\/+/, '');
    if (!code) return { error: 'no_code' };
    if ((inst.redeemCodes || []).some((r) => r.code === code)) {
      return { error: 'exists', code };
    }
    const cleanApp = app ? String(app).trim() : 'General';
    const record = {
      app: cleanApp,
      code,
      bot: inst.slug,
      sessionId: null,
      phone: 'Admin Created',
      tgUserId: adminInfo ? String(adminInfo.id) : null,
      tgName: adminInfo ? (adminInfo.name || 'Admin') : 'Admin',
      deliveredTo: null,
      deliveredPhone: null,
      deliveredName: null,
      deliveredAt: null,
      createdAt: now(),
      isAdminAdded: true
    };
    inst.redeemCodes = inst.redeemCodes || [];
    inst.redeemCodes.unshift(record);
    inst.redeemCodes = inst.redeemCodes.slice(0, 5000);
    saveInstances(insts);
    persist();
    logInstanceEvent(inst.slug, 'system', `Coupon [${cleanApp}] ${code} added by ${record.tgName}.`);
    checkPendingCouponDeliveries();
    return { record };
  }

  async function sendCodeList(m, admin, filter = 'all', page = 0) {
    const records = allCodes().filter((r) => admin
      ? true
      : String(r.deliveredTo || r.tgUserId) === String(m.from.id));
    const view = tui.codePage(records, page, admin ? 'coupons' : 'mine', admin);
    return tgReply(m.chat.id, view.text, view.reply_markup);
  }

  async function showCode(m, code, admin) {
    const qCode = String(code || '').trim().toUpperCase();
    const r = allCodes().find((r) => r.code && String(r.code).toUpperCase() === qCode);
    if (!tui.canViewCode(r, m.from.id, admin)) return tgReply(m.chat.id, '⛔ Coupon unavailable.', tui.backKeyboard());
    const rows = [];
    if (admin) {
      rows.push([tui.button('🎁 View coupons', 'coupons:0'), tui.button('👑 Admin panel', 'admin')]);
    } else {
      rows.push([tui.button('🎁 My coupons', 'mine:0'), tui.button('🏠 Main menu', 'home')]);
    }
    const appLabel = esc(r.app || 'Coupon');
    const status = (r.deliveredTo || r.assignedSessionId)
      ? `📤 Delivered to +${esc(r.phone || r.deliveredPhone || '')}${r.tgName ? ` (${esc(r.tgName)})` : ''}\n📅 Delivered: ${esc(r.deliveredAt || r.createdAt)}`
      : '🟢 Available in pool';
    return tgReply(m.chat.id, `<b>🎁 Coupon details</b>\n\n🏪 <b>App:</b> ${appLabel}\n🎁 <b>Code:</b> <code>${esc(r.code)}</code>\n📊 <b>Status:</b> ${status}\n📅 <b>Created:</b> ${esc(r.createdAt)}`, tui.keyboard(...rows));
  }

  // QR login: link a session by scanning a QR code sent to the Telegram chat.
  async function startQrSession(m) {
    const chatId = m.chat.id;
    const fromId = String(m.from.id);
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || fromId;
    const slug = sessionBotSlug();
    const inst = slug && getInst(slug);
    if (!inst) { await tgReply(chatId, '⚠️ No bot is set up yet. Try again later.', tui.backKeyboard()); return; }
    const s = addSession(slug, null, `TG: ${name}`.slice(0, 60));
    s.tgOwner = { id: fromId, chatId, name };
    persist();
    await tgReply(chatId, '<b>⏳ Preparing QR login…</b>\nYour QR code arrives here in a few seconds.');
    let sent = 0;
    const off = onQr(slug, s.id, (qr) => {
      if (sent >= 5) return;
      sent += 1;
      qrcode.toBuffer(qr, { width: 512 }).then((buf) => tgSendPhoto(chatId, buf,
        sent === 1
          ? '<b>📷 Scan this QR code</b>\n\nOn the phone where your number is logged into WhatsApp:\n1️⃣ Open WhatsApp → Settings → Linked devices.\n2️⃣ Tap Link a device.\n3️⃣ Point the camera at this code.\n\n⏱ The code expires quickly — a fresh one is sent here automatically.\n🎁 Your coupon code will be delivered here after 6 hours once the session connects.'
          : '🔄 New QR code — the previous one expired.',
        tui.keyboard([tui.button('🏠 Main menu', 'home')])
      )).catch((e) => console.error('[TELEGRAM] QR photo failed:', e.message));
    });
    setTimeout(() => {
      off();
      const cur = getInst(slug);
      const sess = cur && ensureSessions(cur).find((x) => x.id === s.id);
      if (sess && sess.status !== 'linked') {
        if (cur.sessions) {
          const idx = cur.sessions.findIndex((x) => x.id === s.id);
          if (idx !== -1) {
            cur.sessions.splice(idx, 1);
            persist();
          }
        }
        tgReply(chatId, '⏱ The QR login expired. Tap 📱 Add session to try again.', tui.keyboard([tui.button('🔄 Try again', 'add')], [tui.button('🏠 Main menu', 'home')]));
      }
    }, 3 * 60 * 1000);
    try {
      await beginLinking(slug, s);
    } catch (e) {
      off();
      const cur = getInst(slug);
      if (cur && cur.sessions) {
        const idx = cur.sessions.findIndex((x) => x.id === s.id);
        if (idx !== -1 && cur.sessions[idx].status !== 'linked') {
          cur.sessions.splice(idx, 1);
          persist();
        }
      }
      await tgReply(chatId, `❌ Could not connect: ${esc(e.message)}\nPlease try again.`, tui.keyboard([tui.button('🔄 Try again', 'add')], [tui.button('🏠 Main menu', 'home')]));
    }
  }

  async function handleSessionFlow(m, text) {
    const chatId = m.chat.id;
    const fromId = String(m.from.id);
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || fromId;
    if (/^\/(addsession|login)\b/i.test(text)) {
      const slug = sessionBotSlug();
      if (!slug) { await tgReply(chatId, '⚠️ No bot is set up yet. Try again later.', tui.backKeyboard()); return true; }
      tgFlow[chatId] = { step: 'method', slug };
      await tgReply(chatId, '<b>📱 Add a WhatsApp session</b>\n\nHow do you want to connect your number?\n\n📷 <b>QR code</b> — scan a code with your phone.\n🔢 <b>Pairing code</b> — type an 8-letter code on your phone.\n\n🔐 You are approving a linked session on our server, not signing in on your phone. Our service will be able to send messages from your number. Only continue with a number you own.', tui.keyboard([tui.button('📷 QR code', 'add:qr'), tui.button('🔢 Pairing code', 'add:code')], [tui.button('✖️ Cancel', 'cancel')]));
      return true;
    }
    if (/^\/cancel\b/i.test(text)) { delete tgFlow[chatId]; await tgReply(chatId, '✖️ Request cancelled.', tui.homeKeyboard(tgAdmins().includes(fromId))); return true; }
    if (/^\/mycodes\b/i.test(text)) { delete tgFlow[chatId]; await sendCodeList(m, false); return true; }
    const f = tgFlow[chatId];
    if (!f || f.step !== 'phone' || !text || text.startsWith('/')) return false;
    const phone = digits(text);
    if (phone.length < 10 || phone.length > 15) { await tgReply(chatId, '⚠️ Send the full number with country code, for example <code>919876543210</code>.', tui.cancelKeyboard()); return true; }
    const inst = getInst(f.slug);
    if (!inst) { delete tgFlow[chatId]; await tgReply(chatId, '⚠️ This bot is no longer available.', tui.backKeyboard()); return true; }
    if (isNumberAlreadyLoggedIn(phone, null, fromId)) {
      delete tgFlow[chatId];
      await tgReply(chatId, `⚠️ <b>Number already used</b>\n\nThe WhatsApp number <code>+${esc(phone)}</code> has already been logged in previously.\n\nEach phone number can only be linked once. Please use a different WhatsApp number.`, tui.keyboard([tui.button('📱 Try with another number', 'add')], [tui.button('🏠 Main menu', 'home')]));
      return true;
    }
    delete tgFlow[chatId];
    await tgReply(chatId, '<b>⏳ Preparing session…</b>\nRequesting a pairing code from WhatsApp. This may take up to a minute.');
    const s = addSession(f.slug, phone, `TG: ${name}`.slice(0, 60), { id: fromId, chatId, name });
    s.tgOwner = { id: fromId, chatId, name };
    persist();
    try {
      const wait = waitForCode(f.slug, s.id);
      await beginLinking(f.slug, s);
      const code = await wait;
      await tgReply(chatId, `<b>🔑 Approve our bot session</b>\n\n📱 +${esc(phone)}\n<code>${esc(code)}</code>\n\nOn the phone where this number is already logged into WhatsApp:\n1️⃣ Open WhatsApp → Settings → Linked devices.\n2️⃣ Tap Link a device → Link with phone number instead.\n3️⃣ Enter the code above to authorize our bot server.\n\n⏱ The code expires shortly.\n🎁 Your coupon code will be delivered here after 6 hours once the session connects.`, tui.keyboard([tui.button('🔄 Check my sessions', 'sessions')], [tui.button('🏠 Main menu', 'home')]));
    } catch (e) {
      await tgReply(chatId, `❌ Could not connect: ${esc(e.message)}\nPlease try again.`, tui.keyboard([tui.button('🔄 Try again', 'add')], [tui.button('🏠 Main menu', 'home')]));
    }
    return true;
  }

  async function handleAdminCodes(m, text, isAdmin) {
    if (!/^\/(coupons|codes|mycoupons|findcode|addcoupon|addcode|newcode|coupon)\b/i.test(text)) return false;
    if (m.chat.type !== 'private') { await tgReply(m.chat.id, '⛔ Open this bot in a private chat.'); return true; }
    delete tgFlow[m.chat.id];
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    if (/^\/(coupons|codes|mycoupons)/i.test(cmd)) {
      await sendCodeList(m, isAdmin, 'all', args[0]);
      return true;
    }
    if (!isAdmin) { await tgReply(m.chat.id, '⛔ Open the admin panel in a private chat with this bot.'); return true; }
    if (/^\/(addcoupon|addcode|newcode|coupon)\b/i.test(cmd)) {
      if (!args.length) {
        return tgReply(m.chat.id, '<b>➕ Add coupon to pool</b>\n\nSelect which app this coupon is for:\nOr send <code>/addcoupon &lt;App&gt; &lt;Code&gt;</code>', tui.appSelectKeyboard());
      }
      let app = 'General';
      let code = args[0];
      if (args.length >= 2) {
        app = args[0];
        code = args.slice(1).join(' ');
      }
      const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || String(m.from.id);
      const res = await addCouponCode(app, code, { id: m.from.id, name });
      if (!res) { await tgReply(m.chat.id, '⚠️ Could not create coupon. Ensure a bot is configured.', tui.adminKeyboard()); return true; }
      if (res.error === 'exists') {
        await tgReply(m.chat.id, `⚠️ Coupon <code>${esc(res.code)}</code> already exists! Please choose another code.`, tui.keyboard([tui.button('➕ Try another', 'addcoupon')], [tui.button('👑 Admin panel', 'admin')]));
        return true;
      }
      if (res.error === 'no_code') {
        await tgReply(m.chat.id, '⚠️ Please provide a valid coupon code.', tui.keyboard([tui.button('➕ Add coupon', 'addcoupon')], [tui.button('👑 Admin panel', 'admin')]));
        return true;
      }
      await tgReply(m.chat.id, `<b>✅ Coupon created!</b>\n\n🏪 App: <b>${esc(res.record.app)}</b>\n🎁 Code: <code>${esc(res.record.code)}</code>\n🟢 Status: Available in pool\n📅 Created: ${esc(res.record.createdAt)}\n\nThis coupon will be delivered to connected sessions after 6 hours.`, tui.keyboard([tui.button('🔎 View details', `detail:${res.record.code}`)], [tui.button('➕ Add another', 'addcoupon')], [tui.button('👑 Admin panel', 'admin')]));
      return true;
    }
    if (/^\/(coupons|codes)/i.test(cmd)) { await sendCodeList(m, true, 'all', args[0]); return true; }
    if (/^\/findcode/i.test(cmd)) {
      const arg = args.join(' ');
      if (!arg) { tgFlow[m.chat.id] = { step: 'find' }; await tgReply(m.chat.id, '<b>🔎 Find a coupon</b>\nSend a coupon code, app name, full phone number or Telegram user ID.', tui.cancelKeyboard()); return true; }
      const q = arg.toUpperCase();
      const qDigits = digits(arg);
      const hits = allCodes().filter((r) => {
        if (r.code && r.code.toUpperCase() === q) return true;
        if (r.app && r.app.toUpperCase() === q) return true;
        if (String(r.tgUserId) === arg || String(r.deliveredTo) === arg) return true;
        if (qDigits && qDigits.length >= 7) {
          if (r.phone && digits(r.phone) === qDigits) return true;
          if (r.deliveredPhone && digits(r.deliveredPhone) === qDigits) return true;
        }
        return false;
      });
      const view = tui.codePage(hits, 0, 'codes:all', true);
      await tgReply(m.chat.id, view.text, view.reply_markup);
      return true;
    }
    return false;
  }

  async function handleTelegramCallback(q) {
    const m = q.message && { ...q.message, from: q.from };
    const data = String(q.data || '');
    const admin = tgAdmins().includes(String(q.from.id));
    await tgCall('answerCallbackQuery', { callback_query_id: q.id, ...(!m || m.chat.type !== 'private' ? { text: 'Open this bot in a private chat.', show_alert: true } : !tui.canUseCallback(data, admin) ? { text: 'Admins only.', show_alert: true } : {}) });
    if (!m || m.chat.type !== 'private' || !tui.canUseCallback(data, admin)) return;
    delete tgFlow[m.chat.id];
    if (data === 'home') return replyHome(m);
    if (data === 'add') return handleSessionFlow(m, '/addsession');
    if (data === 'add:code') {
      const slug = sessionBotSlug();
      if (!slug) return tgReply(m.chat.id, '⚠️ No bot is set up yet. Try again later.', tui.backKeyboard());
      tgFlow[m.chat.id] = { step: 'phone', slug };
      return tgReply(m.chat.id, '<b>🔢 Pairing code login</b>\n\nSend your number with country code, for example <code>919876543210</code>.', tui.cancelKeyboard());
    }
    if (data === 'add:qr') return startQrSession(m);
    if (data === 'cancel') return handleSessionFlow(m, '/cancel');
    if (data === 'mine' || data.startsWith('mine:')) {
      const parts = data.split(':');
      const page = parts.length > 1 ? parts.at(-1) : 0;
      return sendCodeList(m, false, 'all', page);
    }
    if (data === 'admin') return tgReply(m.chat.id, '<b>👑 Admin panel</b>\n\n🎁 Manage redeem codes\n📦 Publish APK updates', tui.adminKeyboard());
    if (data === 'addcoupon' || data === 'addcode') {
      return tgReply(m.chat.id, '<b>➕ Add coupon to pool</b>\n\nSelect which app this coupon is for:\nOr send <code>/addcoupon &lt;App&gt; &lt;Code&gt;</code>', tui.appSelectKeyboard());
    }
    if (data.startsWith('addc:app:')) {
      const appChoice = data.slice(9);
      if (appChoice === 'other') {
        tgFlow[m.chat.id] = { step: 'coupon_app' };
        return tgReply(m.chat.id, '<b>✍️ Custom app name</b>\n\nSend the name of the app (e.g. <code>Zomato</code>, <code>Uber</code>, <code>Myntra</code>):', tui.cancelKeyboard());
      }
      tgFlow[m.chat.id] = { step: 'coupon_code', app: appChoice };
      return tgReply(m.chat.id, `<b>🎁 Add ${esc(appChoice)} coupon</b>\n\nSend the coupon code for <b>${esc(appChoice)}</b>:\nExample: <code>${esc(appChoice.toUpperCase())}50</code> or <code>OFFER2026</code>`, tui.cancelKeyboard());
    }
    if (data.startsWith('prefapp:')) {
      const preferred = data.slice(8);
      const insts = loadInstances();
      for (const inst of insts) {
        const s = (inst.sessions || []).find((x) => x.tgOwner && String(x.tgOwner.id) === String(m.from.id) && !x.couponDelivered);
        if (s) {
          s.preferredApp = preferred;
        }
      }
      saveInstances(insts);
      persist();
      const label = preferred === 'Any' ? 'Any app' : preferred;
      return tgReply(m.chat.id, `✅ <b>Preference saved:</b> ${esc(label)}\n\nYour <b>${esc(label)}</b> coupon code will be delivered here once your 6-hour connection milestone is reached.`, tui.homeKeyboard(admin));
    }
    if (data === 'coupons' || data.startsWith('coupons:') || data === 'codes' || data.startsWith('codes:')) {
      const parts = data.split(':');
      const page = parts.length > 1 ? parts.at(-1) : 0;
      return sendCodeList(m, true, 'all', page);
    }
    if (data === 'find') return handleAdminCodes(m, '/findcode', admin);
    if (data.startsWith('detail:')) return showCode(m, data.slice(7), admin);
    if (data === 'upload') return tgReply(m.chat.id, '<b>📦 Update the APK</b>\n\nSend an .apk document here (up to 20 MB).\nCaption: <code>v2.4 Bug fixes</code>\nFor one bot: <code>@bot-slug v2.4 Bug fixes</code>\n\n📤 The file becomes the latest version after upload.', tui.adminKeyboard());
    if (data === 'sessions') {
      const sessions = loadInstances().flatMap((i) => (i.sessions || []).filter((s) => s.tgOwner && String(s.tgOwner.id) === String(m.from.id)).map((s) => {
        const timeRemaining = s.couponDeliveryAt && !s.couponDelivered
          ? Math.max(0, Math.ceil((s.couponDeliveryAt - Date.now()) / (60 * 60 * 1000)))
          : null;
        const couponNote = s.redeemCode
          ? `\n   🎁 ${s.couponApp ? s.couponApp + ' ' : ''}Coupon: <code>${esc(s.redeemCode)}</code>`
          : s.couponCancelled
          ? '\n   ❌ Coupon rejected (session disconnected)'
          : timeRemaining !== null
          ? `\n   ⏳ ${s.preferredApp && s.preferredApp !== 'Any' ? s.preferredApp + ' ' : ''}Coupon arrives in ~${timeRemaining}h`
          : '';
        return `📱 +${esc(s.phone)} · ${s.status === 'linked' ? '🟢 Connected' : s.status === 'logged_out' ? '🔴 Logged out' : '🟡 ' + esc(s.status)}${couponNote}`;
      }));
      const shown = sessions.slice(0, 30);
      return tgReply(m.chat.id, `<b>📊 Your sessions</b>\n\n${shown.join('\n\n') || 'No sessions yet.'}${sessions.length > 30 ? `\n… ${sessions.length - 30} more sessions` : ''}`, tui.keyboard([tui.button('🔄 Refresh', 'sessions'), tui.button('📱 Add session', 'add')], [tui.button('🏠 Main menu', 'home')]));
    }
    if (data === 'help') return tgReply(m.chat.id, '<b>❓ Session help</b>\n\n📱 Add session → send your number → approve the pairing code in WhatsApp Linked devices.\n🎁 Once connected, your coupon code will be delivered here after 6 hours.\n🔐 Our server becomes a linked device; you stay logged in on your phone. Our service can send messages from your number. Revoke access anytime in WhatsApp → Linked devices.\n\n🆔 Your Telegram ID: <code>' + esc(m.from.id) + '</code>', tui.backKeyboard());
    return tgReply(m.chat.id, '⚠️ This button is no longer available.', tui.backKeyboard());
  }

  // Dashboard API for redeem codes
  app.get('/api/redeem-codes', authenticateToken, (req, res) => res.json(allCodes()));
  app.post('/api/redeem-codes', authenticateToken, async (req, res) => {
    const resAdd = await addCouponCode(req.body.app, req.body.code, { id: 'dashboard', name: 'Dashboard' });
    if (!resAdd) return res.status(400).json({ error: 'No bot configured' });
    if (resAdd.error === 'exists') return res.status(409).json({ error: 'Coupon code already exists' });
    if (resAdd.error === 'no_code') return res.status(400).json({ error: 'Coupon code required' });
    res.json(resAdd.record);
  });
  app.post('/api/redeem-codes/:code/used', authenticateToken, async (req, res) => {
    const r = await setCodeUsed(req.params.code.toUpperCase(), req.body.used !== false);
    r ? res.json(r) : res.status(404).json({ error: 'Not found' });
  });

  async function handleTelegramMessage(m) {
    const fromId = String(m.from && m.from.id);
    const chatId = m.chat.id;
    const isAdmin = tgAdmins().includes(fromId);
    const text = (m.text || '').trim();
    if (m.chat.type !== 'private') {
      if (text.startsWith('/')) return tgReply(chatId, '🔐 Open this bot in a private chat to use the menu.');
      return;
    }
    if (/^\/(start|menu|id|help)\b/i.test(text)) {
      delete tgFlow[chatId];
      if (/^\/id\b/i.test(text)) return tgReply(chatId, `🆔 Your Telegram ID: <code>${esc(fromId)}</code>`, tui.homeKeyboard(isAdmin));
      if (/^\/help\b/i.test(text)) return tgReply(chatId, '❓ Use Add session to approve a linked session on our bot server; your phone stays logged in. Coupon codes will be delivered after 6 hours.', tui.homeKeyboard(isAdmin));
      return replyHome(m);
    }
    if (tgFlow[chatId] && tgFlow[chatId].step === 'find' && text && !text.startsWith('/') && isAdmin) {
      return handleAdminCodes(m, `/findcode ${text}`, isAdmin);
    }
    if (tgFlow[chatId] && tgFlow[chatId].step === 'coupon_app' && text && !text.startsWith('/') && isAdmin) {
      tgFlow[chatId].app = text.trim();
      tgFlow[chatId].step = 'coupon_code';
      return tgReply(chatId, `<b>🎁 Add ${esc(tgFlow[chatId].app)} coupon</b>\n\nSend the coupon code for <b>${esc(tgFlow[chatId].app)}</b>:`, tui.cancelKeyboard());
    }
    if (tgFlow[chatId] && tgFlow[chatId].step === 'coupon_code' && text && !text.startsWith('/') && isAdmin) {
      const app = tgFlow[chatId].app || 'General';
      delete tgFlow[chatId];
      return handleAdminCodes(m, `/addcoupon ${app} ${text}`, isAdmin);
    }
    if (tgFlow[chatId] && tgFlow[chatId].step === 'addcode' && text && !text.startsWith('/') && isAdmin) {
      delete tgFlow[chatId];
      return handleAdminCodes(m, `/addcoupon General ${text}`, isAdmin);
    }
    if (!m.document && await handleSessionFlow(m, text)) return;
    if (await handleAdminCodes(m, text, isAdmin)) return;
    const doc = m.document;
    if (!doc) return tgReply(chatId, '👇 Choose an option below.', tui.homeKeyboard(isAdmin));
    delete tgFlow[chatId];
    if (!isAdmin) return tgReply(chatId, `⛔ You are not allowed to upload APKs. Your ID: ${fromId}`);
    const name = (doc.file_name || '').toLowerCase();
    if (!name.endsWith('.apk') && doc.mime_type !== 'application/vnd.android.package-archive') {
      return tgReply(chatId, 'Please send an .apk file.');
    }
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      return tgReply(chatId, '⚠️ Telegram bots can only download files up to 20 MB. Upload this APK from the dashboard instead (APK & Store page).');
    }
    await tgReply(chatId, '<b>⏳ APK update in progress…</b>\nDownloading and preparing your file.');
    const file = await tgCall('getFile', { file_id: doc.file_id });
    if (!file || !file.file_path) throw new Error('Telegram file path not returned');
    const r = await fetch(`https://api.telegram.org/file/bot${tgToken()}/${file.file_path}`);
    if (!r.ok) throw new Error(`Download failed (${r.status})`);
    const base64 = Buffer.from(await r.arrayBuffer()).toString('base64');

    // Caption: "[@bot-slug] v2.4 notes..."
    let caption = (m.caption || '').trim();
    let targets = loadInstances().map((i) => i.slug);
    const envTargets = (process.env.TELEGRAM_APK_INSTANCES || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (envTargets.length) targets = targets.filter((s) => envTargets.includes(s));
    const at = caption.match(/^@([a-z0-9_-]+)\s*/i);
    if (at) { targets = targets.filter((s) => s === at[1].toLowerCase()); caption = caption.slice(at[0].length); }
    const [version, ...rest] = caption.split(/\s+/);
    const meta = { version: version || '', notes: rest.join(' '), uploadedBy: `Telegram: ${m.from.first_name || fromId}` };
    if (!targets.length) return tgReply(chatId, 'No matching bot found for this APK.');
    targets.forEach((slug) => storeApk(slug, base64, meta));
    tg.lastUpload = { at: now(), version: meta.version, by: meta.uploadedBy };
    await tgReply(chatId, `<b>✅ APK published!</b>\n\n📦 Version: ${esc(meta.version || 'Latest')}\n🤖 Bots: ${esc(targets.join(', '))}\n🔗 ${esc(storeLink(targets[0]))}`, tui.adminKeyboard());
  }

  async function telegramLoop() {
    if (!tgToken()) { console.log('[TELEGRAM] TELEGRAM_BOT_TOKEN not set — Telegram APK updates disabled.'); return; }
    try {
      await tgCall('deleteWebhook', { drop_pending_updates: false });
      const me = await tgCall('getMe');
      tg.username = me.username;
      console.log(`[TELEGRAM] Listening for APK uploads as @${me.username}`);
    } catch (e) { tg.error = e.message; console.error('[TELEGRAM]', e.message); }
    let offset = 0;
    for (;;) {
      try {
        const updates = await tgCall('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        tg.error = '';
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.callback_query) {
            handleTelegramCallback(u.callback_query).catch((e) => console.error('[TELEGRAM] Button failed:', e.message));
          }
          if (u.message) {
            handleTelegramMessage(u.message).catch((e) => {
              console.error('[TELEGRAM]', e.message);
              tgReply(u.message.chat.id, `❌ Failed: ${esc(e.message)}`);
            });
          }
        }
      } catch (e) {
        tg.error = e.message;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  telegramLoop();

  app.get('/api/telegram/status', authenticateToken, (req, res) => res.json(telegramStatus()));

  // ───────────────────────────────────────────────────────────
  // 6. WATCH WORDS + SCREENSHOTS
  // ───────────────────────────────────────────────────────────
  const flagFile = (slug) => path.join(dataDir, `flagged_${slug}.json`);
  const shotDir = (slug) => ensureDir(path.join(dataDir, 'screenshots', slug));
  const loadFlags = (slug) => { try { return JSON.parse(fs.readFileSync(flagFile(slug), 'utf8')); } catch (_) { return []; } };
  const saveFlags = (slug, list) => fs.promises.writeFile(flagFile(slug), JSON.stringify(list.slice(0, 3000), null, 2)).catch(() => {});
  const shotQueue = {};

  function checkWatchWords(slug, client, msg, senderNumber) {
    const inst = getInst(slug);
    const words = (inst && inst.watchWords) || [];
    if (!words.length || !msg.body) return;
    const body = msg.body.toLowerCase();
    const word = words.find((w) => body.includes(w));
    if (!word) return;

    shotQueue[slug] = (shotQueue[slug] || Promise.resolve()).then(async () => {
      const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      let screenshot = null;
      try {
        if (client.pupPage && client.interface) {
          await client.interface.openChatWindow(msg.from);
          await new Promise((r) => setTimeout(r, 2500));
          const buf = await client.pupPage.screenshot({ type: 'jpeg', quality: 70 });
          screenshot = `${id}.jpg`;
          fs.writeFileSync(path.join(shotDir(slug), screenshot), buf);
        }
      } catch (e) {
        logInstanceEvent(slug, 'error', `Screenshot failed for flagged chat: ${e.message}`);
      }
      const entry = {
        id, sender: senderNumber, senderName: (msg._data && msg._data.notifyName) || '',
        chatId: msg.from, message: msg.body, word, screenshot, at: now()
      };
      const list = loadFlags(slug);
      list.unshift(entry);
      await saveFlags(slug, list);
      logInstanceEvent(slug, 'system', `🚩 Watch word "${word}" from +${senderNumber}${screenshot ? ' (screenshot saved)' : ''}.`);
      io.to(room(slug)).emit('flagged', entry);
    }).catch(() => {});
  }

  app.get('/api/instances/:slug/flagged', authenticateToken, (req, res) => {
    res.json(loadFlags(req.params.slug.toLowerCase()));
  });
  app.get('/api/instances/:slug/flagged/:id/screenshot', authenticateToken, (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const e = loadFlags(slug).find((x) => x.id === req.params.id);
    if (!e || !e.screenshot) return res.status(404).end();
    res.sendFile(path.join(shotDir(slug), path.basename(e.screenshot)));
  });
  app.delete('/api/instances/:slug/flagged/:id', authenticateToken, async (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const list = loadFlags(slug);
    const keep = req.params.id === 'all' ? [] : list.filter((x) => x.id !== req.params.id);
    list.filter((x) => !keep.includes(x) && x.screenshot).forEach((x) => {
      try { fs.unlinkSync(path.join(shotDir(slug), x.screenshot)); } catch (_) {}
    });
    await saveFlags(slug, keep);
    res.json({ success: true });
  });

  return {
    resolveSession, clientOptionsFor, onSessionReady, handleSessionLoss, emitCode, emitQr,
    emitSessions, requestCodeForNumber, apkCaption, storeLink, checkWatchWords,
    authDirFor, markSession, reportSessionError
  };
};
