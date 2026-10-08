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

  const usable = (s) => s && (s.status === 'linked' || (s.phone && s.status !== 'logged_out'));

  // Which session should the main WhatsApp engine of this bot run?
  function resolveSession(slug, forcedId) {
    const inst = getInst(slug);
    if (!inst) return null;
    const list = ensureSessions(inst);
    if (forcedId) return list.find((s) => s.id === forcedId) || null;
    const active = list.find((s) => s.id === inst.activeSessionId);
    if (usable(active)) return active;
    const pick = list.find((s) => s.status === 'linked') || list.find((s) => s.phone && s.status !== 'logged_out');
    if (pick) setActive(slug, pick.id);
    return pick || null;
  }

  function nextLinked(slug, currentId) {
    const inst = getInst(slug);
    const list = ensureSessions(inst);
    const idx = list.findIndex((s) => s.id === currentId);
    for (let k = 1; k <= list.length; k++) {
      const s = list[(idx + k) % list.length];
      if (s.id !== currentId && s.status === 'linked') return s;
    }
    return null;
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
      addedAt: s.addedAt
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
    markSession(slug, s.id, { status: 'linked', pairingCode: null, phone: s.phone || wid });
    setActive(slug, s.id);
    emitSessions(slug);
    ctx.onSessionLinked && ctx.onSessionLinked(slug, s);
  }

  async function handleSessionLoss(slug, s, reason, client) {
    const st = clientStates[slug];
    if (activeClients[slug] === client) delete activeClients[slug];
    try { await client.destroy(); } catch (_) {}

    if (st && st.manualStop) { st.manualStop = false; emitSessions(slug); return; }

    const hard = /LOGOUT|UNPAIRED|CONFLICT|AUTH_FAILURE|TOS_BLOCK|BANNED/i.test(String(reason));
    if (hard) {
      markSession(slug, s.id, { status: 'logged_out', pairingCode: null });
      setTimeout(() => { try { fs.rmSync(authDirFor(slug, s), { recursive: true, force: true }); } catch (_) {} }, 3000);
      logInstanceEvent(slug, 'whatsapp', `Number ${s.phone ? '+' + s.phone : s.label} was logged out (${reason}).`);
      const next = nextLinked(slug, s.id);
      if (next) {
        setActive(slug, next.id);
        logInstanceEvent(slug, 'system', `Auto-switched to backup number ${next.phone ? '+' + next.phone : next.label}.`);
        io.to(room(slug)).emit('session_switched', { from: s.id, to: next.id, phone: next.phone });
        setTimeout(() => { if (!activeClients[slug]) initClient(slug, next.id); }, 4000);
      } else {
        logInstanceEvent(slug, 'error', 'No linked backup numbers left. Add a number on the Sessions page.');
        if (st) { st.status = 'needs_number'; io.to(room(slug)).emit('status', { status: 'needs_number', stats: st.stats }); }
      }
    } else {
      logInstanceEvent(slug, 'system', `Connection dropped (${reason}). Reconnecting the same number in 10s...`);
      setTimeout(() => { if (!activeClients[slug]) initClient(slug, s.id); }, 10000);
    }
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
      setTimeout(stop, 8000);
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
  const tgReply = (chatId, text) => tgCall('sendMessage', { chat_id: chatId, text }).catch(() => {});

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
    tgReply(s.tgOwner.chatId, `✅ Your WhatsApp +${sess.phone} is linked successfully!\n\n🎁 Your redeem code: ${code}\n\nKeep it safe.`);
    tgAdmins().forEach((a) => tgReply(a, `🆕 New session added via Telegram\nUser: ${s.tgOwner.name} (${s.tgOwner.id})\nNumber: +${sess.phone}\nRedeem code: ${code}`));
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

  async function handleSessionFlow(m, text) {
    const chatId = m.chat.id;
    const fromId = String(m.from && m.from.id);
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || fromId;
    if (/^\/(addsession|login)\b/i.test(text)) {
      const slug = sessionBotSlug();
      if (!slug) return tgReply(chatId, '⚠️ No bot is set up yet. Try again later.'), true;
      tgFlow[chatId] = { step: 'phone', slug };
      return tgReply(chatId, '📱 Send your WhatsApp number with country code.\nExample: 919876543210\n\nSend /cancel to stop.'), true;
    }
    if (/^\/cancel\b/i.test(text)) { delete tgFlow[chatId]; return tgReply(chatId, 'Cancelled.'), true; }
    if (/^\/mycodes\b/i.test(text)) {
      const mine = allCodes().filter((r) => r.tgUserId === fromId);
      return tgReply(chatId, mine.length ? '🎁 Your redeem codes:\n' + mine.map((r) => `${r.code} — +${r.phone}${r.used ? ' (used)' : ''}`).join('\n') : 'You have no redeem codes yet. Send /addsession to get one.'), true;
    }
    const f = tgFlow[chatId];
    if (!f || f.step !== 'phone' || !text || text.startsWith('/')) return false;
    const phone = digits(text);
    if (phone.length < 10 || phone.length > 15) return tgReply(chatId, '❌ That doesn\'t look right. Send the full number with country code, e.g. 919876543210'), true;
    const inst = getInst(f.slug);
    const existing = ensureSessions(inst).find((x) => x.phone === phone);
    if (existing && existing.status === 'linked') { delete tgFlow[chatId]; return tgReply(chatId, '⚠️ This number is already linked.'), true; }
    delete tgFlow[chatId];
    tgReply(chatId, '⏳ Getting your login code from WhatsApp, please wait up to 1 minute...');
    const s = addSession(f.slug, phone, `TG: ${name}`.slice(0, 60));
    s.tgOwner = { id: fromId, chatId, name };
    persist();
    try {
      const wait = waitForCode(f.slug, s.id);
      await beginLinking(f.slug, s);
      const code = await wait;
      await tgReply(chatId, `🔑 Your login code: ${code}\n\nOn your phone:\n1. Open WhatsApp → Settings → Linked devices\n2. Tap "Link a device"\n3. Tap "Link with phone number instead"\n4. Enter the code above\n\nThe code expires in a few minutes. You'll get your redeem code here once login succeeds.`);
    } catch (e) {
      tgReply(chatId, `❌ ${e.message}\nSend /addsession to try again.`);
    }
    return true;
  }

  async function handleAdminCodes(m, text, isAdmin) {
    const chatId = m.chat.id;
    if (!/^\/(codes|used|unused|findcode)\b/i.test(text)) return false;
    if (!isAdmin) return tgReply(chatId, '⛔ Admins only.'), true;
    const [cmd, arg] = text.split(/\s+/);
    if (/^\/codes/i.test(cmd)) {
      const list = allCodes();
      const filter = (arg || '').toLowerCase();
      const shown = list.filter((r) => filter === 'unused' ? !r.used : filter === 'used' ? r.used : true).slice(0, 40);
      if (!shown.length) return tgReply(chatId, 'No redeem codes yet.'), true;
      const unusedN = list.filter((r) => !r.used).length;
      return tgReply(chatId, `🎁 Redeem codes (${list.length} total, ${unusedN} unused)\n\n${shown.map(fmtCode).join('\n')}\n\n/codes unused · /codes used · /findcode <code or number> · /used <code> · /unused <code>`), true;
    }
    if (/^\/findcode/i.test(cmd)) {
      const q = String(arg || '').toUpperCase();
      const hits = allCodes().filter((r) => r.code === q || r.phone === digits(q) || r.tgUserId === q);
      return tgReply(chatId, hits.length ? hits.map(fmtCode).join('\n') : 'Not found.'), true;
    }
    const r = setCodeUsed(String(arg || '').toUpperCase(), /^\/used/i.test(cmd));
    return tgReply(chatId, r ? `Updated: ${fmtCode(r)}` : 'Code not found.'), true;
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
    if (m.chat.type === 'private' && await handleSessionFlow(m, text)) return;
    if (await handleAdminCodes(m, text, isAdmin)) return;
    if (text.startsWith('/start') || text.startsWith('/id')) {
      return tgReply(chatId, `👋 Welcome! Your Telegram ID is ${fromId}.\n\n/addsession — link your WhatsApp and get a redeem code\n/mycodes — see your redeem codes${isAdmin ? '\n\n👑 Admin:\n/codes — all redeem codes\n/findcode <code or number>\n/used <code> · /unused <code>\nSend an .apk file to update the app.' : ''}`);
    }
    const doc = m.document;
    if (!doc) return;
    if (!isAdmin) return tgReply(chatId, `⛔ You are not allowed to upload APKs. Your ID: ${fromId}`);
    const name = (doc.file_name || '').toLowerCase();
    if (!name.endsWith('.apk') && doc.mime_type !== 'application/vnd.android.package-archive') {
      return tgReply(chatId, 'Please send an .apk file.');
    }
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      return tgReply(chatId, '⚠️ Telegram bots can only download files up to 20 MB. Upload this APK from the dashboard instead (APK & Store page).');
    }
    await tgReply(chatId, '⏳ Downloading APK...');
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
    await tgReply(chatId, `✅ APK ${meta.version} is now live for: ${targets.join(', ')}\nStore page: ${storeLink(targets[0])}`);
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
        const updates = await tgCall('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        tg.error = '';
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.message) {
            handleTelegramMessage(u.message).catch((e) => {
              console.error('[TELEGRAM]', e.message);
              tgReply(u.message.chat.id, `❌ Failed: ${e.message}`);
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
    authDirFor, markSession
  };
};
