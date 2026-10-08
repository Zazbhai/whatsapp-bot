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

  function ensureSessions(inst) {
    if (!inst) return [];
    if (!Array.isArray(inst.sessions)) {
      const legacyLinked = fs.existsSync(path.join(authRoot, `session-session_${inst.slug}`));
      inst.sessions = [{
        id: 'default', phone: '', label: 'Main number',
        status: legacyLinked ? 'linked' : 'pending', addedAt: now()
      }];
      inst.activeSessionId = 'default';
      persist();
    }
    return inst.sessions;
  }

  function markSession(slug, id, patch) {
    const inst = getInst(slug);
    const s = inst && ensureSessions(inst).find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch);
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

  const usable = (s) => s && !(s.retryAfter > Date.now()) && (s.status === 'linked' || (s.phone && s.status !== 'logged_out'));

  // Which session should the main WhatsApp engine of this bot run?
  function resolveSession(slug, forcedId) {
    const inst = getInst(slug);
    if (!inst) return null;
    const list = ensureSessions(inst);
    if (forcedId) return list.find((s) => s.id === forcedId) || null;
    // Always prefer a linked number over one still waiting for its pairing code.
    const active = list.find((s) => s.id === inst.activeSessionId);
    const pick = pickAutoSession(list, inst.activeSessionId) || (usable(active) ? active : list.find(usable));
    if (pick) setActive(slug, pick.id);
    return pick || null;
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
      active: inst.activeSessionId === s.id && !!activeClients[slug],
      online: inst.activeSessionId === s.id && st.status === 'ready',
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
      const t = setTimeout(() => reject(new Error('WhatsApp did not return a pairing code in time. Try again.')), ms);
      (codeWaiters[key] = codeWaiters[key] || []).push((c) => { clearTimeout(t); resolve(c); });
    });
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
    markSession(slug, s.id, { status: 'linked', pairingCode: null, phone: s.phone || wid, lastError: null, retryAfter: 0 });
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
  const linkers = {};
  function startLinker(slug, s) {
    const key = `${slug}:${s.id}`;
    if (linkers[key]) { try { linkers[key].destroy(); } catch (_) {} delete linkers[key]; }
    const c = new Client({
      authStrategy: new LocalAuth({ clientId: clientIdFor(slug, s), dataPath: authRoot }),
      puppeteer: { executablePath: findChrome(), headless: true, protocolTimeout: 600000, args: CHROME_ARGS },
      pairWithPhoneNumber: { phoneNumber: s.phone, showNotification: true, intervalMs: 180000 }
    });
    linkers[key] = c;
    const stop = async () => { try { await c.destroy(); } catch (_) {} if (linkers[key] === c) delete linkers[key]; emitSessions(slug); };
    const timeout = setTimeout(() => {
      logInstanceEvent(slug, 'system', `Linking +${s.phone} timed out. Click "New code" to try again.`);
      markSession(slug, s.id, { status: 'pending', pairingCode: null });
      stop();
    }, 10 * 60 * 1000);
    c.on('code', (code) => emitCode(slug, s, code));
    c.on('ready', () => {
      clearTimeout(timeout);
      const wid = c.info && c.info.wid ? c.info.wid.user : '';
      markSession(slug, s.id, { status: 'linked', pairingCode: null, phone: s.phone || wid });
      logInstanceEvent(slug, 'whatsapp', `Backup number +${s.phone} linked and on standby.`);
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

  async function restartMainWith(slug, id) {
    const cur = activeClients[slug];
    if (cur) {
      if (clientStates[slug]) clientStates[slug].manualStop = true;
      delete activeClients[slug];
      try { await cur.destroy(); } catch (_) {}
      if (clientStates[slug]) clientStates[slug].manualStop = false;
    }
    setActive(slug, id);
    initClient(slug, id);
  }

  // Start linking a session: through the main engine if nothing is online, otherwise in the background.
  async function beginLinking(slug, s) {
    const st = clientStates[slug];
    if (st && st.status === 'ready' && activeClients[slug]) startLinker(slug, s);
    else await restartMainWith(slug, s.id);
  }

  function addSession(slug, phone, label) {
    const inst = getInst(slug);
    const list = ensureSessions(inst);
    let s = list.find((x) => x.phone === phone);
    if (!s) {
      // Reuse the empty legacy slot instead of creating a duplicate
      const empty = list.find((x) => !x.phone && x.status !== 'linked');
      if (empty) { empty.phone = phone; empty.label = label || empty.label; s = empty; }
      else {
        s = { id: 's' + Date.now().toString(36), phone, label: label || `Number ${list.length + 1}`, status: 'pending', addedAt: now() };
        list.push(s);
      }
    }
    if (s.status === 'logged_out') s.status = 'pending';
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
      const name = target.phone ? '+' + target.phone : target.label;
      idleTicks[slug] = 0; delete pairingSince[slug];
      if (action.start) {
        logInstanceEvent(slug, 'system', `No number was online. Automatically selected ${name}.`);
        setActive(slug, target.id);
        Promise.resolve(initClient(slug, target.id)).catch((e) => logInstanceEvent(slug, 'error', `Auto-select failed: ${e.message}`));
      } else {
        logInstanceEvent(slug, 'system', `Pairing for ${current.phone ? '+' + current.phone : current.label} did not finish. Automatically switched back to ${name}.`);
        markSession(slug, current.id, { status: 'pending', pairingCode: null });
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
  function makeRedeemCode(inst) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = 'RDM-' + Array.from({ length: 8 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); }
    while ((inst.redeemCodes || []).some((r) => r.code === c));
    return c;
  }
  ctx.onSessionLinked = (slug, s) => {
    const inst = getInst(slug);
    if (!inst || !s.tgOwner || s.redeemCode) return;
    const sess = ensureSessions(inst).find((x) => x.id === s.id) || s;
    const code = makeRedeemCode(inst);
    sess.redeemCode = code;
    inst.redeemCodes = inst.redeemCodes || [];
    inst.redeemCodes.unshift({
      code, bot: slug, sessionId: sess.id, phone: sess.phone,
      tgUserId: s.tgOwner.id, tgName: s.tgOwner.name, createdAt: now(), used: false, usedAt: null
    });
    inst.redeemCodes = inst.redeemCodes.slice(0, 5000);
    persist();
    logInstanceEvent(slug, 'system', `Redeem code ${code} issued to ${s.tgOwner.name} for +${sess.phone}.`);
    tgReply(s.tgOwner.chatId, `<b>✅ Session connected!</b>\n\n📱 +${esc(sess.phone)} is now connected to our bot server.\n\n<b>🎁 Your redeem code</b>\n<code>${esc(code)}</code>\n\nKeep this code safe.`, tui.homeKeyboard(tgAdmins().includes(String(s.tgOwner.id))));
    tgAdmins().forEach((a) => tgReply(a, `<b>🆕 New session connected</b>\n\n👤 ${esc(s.tgOwner.name)} (${esc(s.tgOwner.id)})\n📱 +${esc(sess.phone)}\n🎁 <code>${esc(code)}</code>`, tui.keyboard([tui.button('🔎 View redeem code', `detail:${code}`)], [tui.button('👑 Admin panel', 'admin')])));
  };
  function allCodes() {
    return loadInstances().flatMap((i) => i.redeemCodes || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  function setCodeUsed(code, used) {
    const insts = loadInstances();
    for (const i of insts) {
      const r = (i.redeemCodes || []).find((x) => x.code === code);
      if (r) { r.used = used; r.usedAt = used ? now() : null; saveInstances(insts); return r; }
    }
    return null;
  }
  const fmtCode = (r) => `${r.used ? '☑️' : '🟢'} ${r.code} — +${r.phone} — ${r.tgName} (${r.tgUserId}) — ${r.createdAt.slice(0, 16).replace('T', ' ')}${r.used ? ' — used' : ''}`;

  async function sendCodeList(m, admin, filter = 'all', page = 0) {
    const records = allCodes().filter((r) => admin
      ? (filter === 'unused' ? !r.used : filter === 'used' ? r.used : true)
      : String(r.tgUserId) === String(m.from.id));
    const view = tui.codePage(records, page, admin ? `codes:${filter}` : 'mine', admin);
    return tgReply(m.chat.id, view.text, view.reply_markup);
  }

  async function showCode(m, code, admin) {
    const r = allCodes().find((r) => r.code === code);
    if (!tui.canViewCode(r, m.from.id, admin)) return tgReply(m.chat.id, '⛔ Code unavailable.', tui.backKeyboard());
    const rows = admin ? [[tui.button(r.used ? '🟢 Mark unused' : '✅ Mark used', `${r.used ? 'unused' : 'used'}:${r.code}`)]] : [];
    rows.push([tui.button(admin ? '👑 Admin panel' : '🎁 My codes', admin ? 'admin' : 'mine:0')]);
    return tgReply(m.chat.id, `<b>🎁 Redeem code details</b>\n\n<code>${esc(r.code)}</code>\n📱 +${esc(r.phone)}\n${admin ? `👤 ${esc(r.tgName)} (${esc(r.tgUserId)})\n` : ''}📅 ${esc(r.createdAt)}\n${r.used ? '✅ Used' : '🟢 Unused'}`, tui.keyboard(...rows));
  }

  async function handleSessionFlow(m, text) {
    const chatId = m.chat.id;
    const fromId = String(m.from.id);
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || fromId;
    if (/^\/(addsession|login)\b/i.test(text)) {
      const slug = sessionBotSlug();
      if (!slug) { await tgReply(chatId, '⚠️ No bot is set up yet. Try again later.', tui.backKeyboard()); return true; }
      tgFlow[chatId] = { step: 'phone', slug };
      await tgReply(chatId, '<b>📱 Add a WhatsApp session</b>\n\nSend your number with country code, for example <code>919876543210</code>.\n\n🔐 You are approving a linked session on our server, not signing in on your phone. Our service will be able to send messages from your number. Only continue with a number you own.', tui.cancelKeyboard());
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
    const existing = ensureSessions(inst).find((x) => x.phone === phone);
    if (existing && existing.status === 'linked') { delete tgFlow[chatId]; await tgReply(chatId, '⚠️ This number is already linked.', tui.backKeyboard()); return true; }
    delete tgFlow[chatId];
    await tgReply(chatId, '<b>⏳ Preparing session…</b>\nRequesting a pairing code from WhatsApp. This may take up to a minute.');
    const s = addSession(f.slug, phone, `TG: ${name}`.slice(0, 60));
    s.tgOwner = { id: fromId, chatId, name };
    persist();
    try {
      const wait = waitForCode(f.slug, s.id);
      await beginLinking(f.slug, s);
      const code = await wait;
      await tgReply(chatId, `<b>🔑 Approve our bot session</b>\n\n📱 +${esc(phone)}\n<code>${esc(code)}</code>\n\nOn the phone where this number is already logged into WhatsApp:\n1️⃣ Open WhatsApp → Settings → Linked devices.\n2️⃣ Tap Link a device → Link with phone number instead.\n3️⃣ Enter the code above to authorize our bot server.\n\n⏱ The code expires shortly.\n🎁 Your redeem code arrives here only after the session connects.`, tui.keyboard([tui.button('🔄 Check my sessions', 'sessions')], [tui.button('🏠 Main menu', 'home')]));
    } catch (e) {
      await tgReply(chatId, `❌ Could not connect: ${esc(e.message)}\nPlease try again.`, tui.keyboard([tui.button('🔄 Try again', 'add')], [tui.button('🏠 Main menu', 'home')]));
    }
    return true;
  }

  async function handleAdminCodes(m, text, isAdmin) {
    if (!/^\/(codes|used|unused|findcode)\b/i.test(text)) return false;
    if (!isAdmin || m.chat.type !== 'private') { await tgReply(m.chat.id, '⛔ Open the admin panel in a private chat with this bot.'); return true; }
    delete tgFlow[m.chat.id];
    const [cmd, arg] = text.split(/\s+/);
    if (/^\/codes/i.test(cmd)) { await sendCodeList(m, true, (arg || 'all').toLowerCase()); return true; }
    if (/^\/findcode/i.test(cmd)) {
      if (!arg) { tgFlow[m.chat.id] = { step: 'find' }; await tgReply(m.chat.id, '<b>🔎 Find a redeem code</b>\nSend a redeem code, full phone number or Telegram user ID.', tui.cancelKeyboard()); return true; }
      const q = arg.toUpperCase();
      const hits = allCodes().filter((r) => r.code === q || r.phone === digits(q) || String(r.tgUserId) === q);
      const view = tui.codePage(hits, 0, 'codes:all', true);
      await tgReply(m.chat.id, view.text, view.reply_markup);
      return true;
    }
    const r = setCodeUsed(String(arg || '').toUpperCase(), /^\/used/i.test(cmd));
    if (r) await showCode(m, r.code, true);
    else await tgReply(m.chat.id, '⚠️ Code not found.', tui.adminKeyboard());
    return true;
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
    if (data === 'cancel') return handleSessionFlow(m, '/cancel');
    if (data.startsWith('mine:')) return sendCodeList(m, false, 'all', data.split(':')[1]);
    if (data === 'admin') return tgReply(m.chat.id, '<b>👑 Admin panel</b>\n\n🎁 Manage redeem codes\n📦 Publish APK updates', tui.adminKeyboard());
    if (data.startsWith('codes:')) { const [, filter, page] = data.split(':'); return sendCodeList(m, true, filter, page); }
    if (data === 'find') return handleAdminCodes(m, '/findcode', admin);
    if (data.startsWith('detail:')) return showCode(m, data.slice(7), admin);
    if (/^(used|unused):/.test(data)) { const [action, code] = data.split(':'); return handleAdminCodes(m, `/${action} ${code}`, admin); }
    if (data === 'upload') return tgReply(m.chat.id, '<b>📦 Update the APK</b>\n\nSend an .apk document here (up to 20 MB).\nCaption: <code>v2.4 Bug fixes</code>\nFor one bot: <code>@bot-slug v2.4 Bug fixes</code>\n\n📤 The file becomes the latest version after upload.', tui.adminKeyboard());
    if (data === 'sessions') {
      const sessions = loadInstances().flatMap((i) => (i.sessions || []).filter((s) => s.tgOwner && String(s.tgOwner.id) === String(m.from.id)).map((s) => `📱 +${esc(s.phone)} · ${s.status === 'linked' ? '🟢 Connected' : s.status === 'logged_out' ? '🔴 Logged out' : '🟡 ' + esc(s.status)}`));
      const shown = sessions.slice(0, 30);
      return tgReply(m.chat.id, `<b>📊 Your sessions</b>\n\n${shown.join('\n') || 'No sessions yet.'}${sessions.length > 30 ? `\n… ${sessions.length - 30} more sessions` : ''}`, tui.keyboard([tui.button('🔄 Refresh', 'sessions'), tui.button('📱 Add session', 'add')], [tui.button('🏠 Main menu', 'home')]));
    }
    if (data === 'help') return tgReply(m.chat.id, '<b>❓ Session help</b>\n\n📱 Add session → send your number → approve the pairing code in WhatsApp Linked devices.\n🎁 Once connected, your redeem code appears here.\n🔐 Our server becomes a linked device; you stay logged in on your phone. Our service can send messages from your number. Revoke access anytime in WhatsApp → Linked devices.\n\n🆔 Your Telegram ID: <code>' + esc(m.from.id) + '</code>', tui.backKeyboard());
    return tgReply(m.chat.id, '⚠️ This button is no longer available.', tui.backKeyboard());
  }

  // Dashboard API for redeem codes
  app.get('/api/redeem-codes', authenticateToken, (req, res) => res.json(allCodes()));
  app.post('/api/redeem-codes/:code/used', authenticateToken, (req, res) => {
    const r = setCodeUsed(req.params.code.toUpperCase(), req.body.used !== false);
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
      if (/^\/help\b/i.test(text)) return tgReply(chatId, '❓ Use Add session to approve a linked session on our bot server; your phone stays logged in. Redeem codes appear only after connection.', tui.homeKeyboard(isAdmin));
      return replyHome(m);
    }
    if (tgFlow[chatId] && tgFlow[chatId].step === 'find' && text && !text.startsWith('/') && isAdmin) {
      return handleAdminCodes(m, `/findcode ${text}`, isAdmin);
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
    resolveSession, clientOptionsFor, onSessionReady, handleSessionLoss, emitCode,
    emitSessions, requestCodeForNumber, apkCaption, storeLink, checkWatchWords,
    authDirFor, markSession, reportSessionError
  };
};
