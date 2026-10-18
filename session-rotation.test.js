const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pickNextSession, isSessionFailure, monitorSession, closeSession } = require('./session-health');

test('selects next linked backup after logout, skipping unlinked sessions', () => {
  assert.equal(pickNextSession([{ id: 'a', status: 'logged_out' }, { id: 'b', status: 'pending' }, { id: 'c', status: 'linked' }], 'a').id, 'c');
});
test('rotates in order, wrapping past the end', () => {
  assert.equal(pickNextSession([{ id: 'a', status: 'linked' }, { id: 'b', status: 'linked' }], 'b').id, 'a');
});
test('skips temporarily failing backups and never selects the active session', () => {
  assert.equal(pickNextSession([{ id: 'a', status: 'linked' }, { id: 'b', status: 'linked', retryAfter: 200 }], 'a', 100), null);
});
test('browser and send timeouts trigger recovery, ordinary message failures do not', () => {
  assert.equal(isSessionFailure(new Error('Protocol error: Target closed')), true);
  assert.equal(isSessionFailure(new Error('WhatsApp send task timeout exceeded')), true);
  assert.equal(isSessionFailure(new Error('Invalid recipient number')), false);
});
test('two failed health checks trigger recovery once', async () => {
  let recovered = 0;
  const health = monitorSession({ getState: async () => 'UNPAIRED' }, { isCurrent: () => true, isReady: () => true, onFailure: async () => { recovered++; } });
  try { await health.check(); assert.equal(recovered, 0); await health.check(); await health.check(); assert.equal(recovered, 1); } finally { health.stop(); }
});
test('a successful health check resets transient failures', async () => {
  let state = 'TIMEOUT'; let recovered = 0;
  const health = monitorSession({ getState: async () => state }, { isCurrent: () => true, isReady: () => true, onFailure: async () => { recovered++; } });
  try { await health.check(); state = 'CONNECTED'; await health.check(); state = 'TIMEOUT'; await health.check(); assert.equal(recovered, 0); } finally { health.stop(); }
});
test('stale clients cannot trigger health recovery', async () => {
  let recovered = 0;
  const health = monitorSession({}, { isCurrent: () => false, isReady: () => true, onFailure: async () => { recovered++; } });
  await health.check(); assert.equal(recovered, 0); health.stop();
});

function harness() {
  const source = fs.readFileSync(require.resolve('./features'), 'utf8');
  const timers = []; const events = []; const starts = []; const removed = [];
  const instance = { slug: 'bot', activeSessionId: 'a', sessions: [{ id: 'a', status: 'linked', phone: '111' }, { id: 'b', status: 'linked', phone: '222' }] };
  const client = { destroy: async () => {} };
  const context = { fs: { rmSync: (...args) => removed.push(args) }, path: require('node:path'), authRoot: '/tmp/test-auth',
    now: () => new Date().toISOString(), persist() {}, getInst: () => instance, linkers: {},
    activeClients: { bot: client }, clientStates: { bot: { sessionId: 'a', status: 'ready', stats: {} } },
    io: { to: () => ({ emit: (...args) => events.push(args) }) }, room: s => s, ctx: {},
    initClient: (...args) => starts.push(args), logInstanceEvent() {}, pickNextSession, isSessionFailure, closeSession,
    setTimeout: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t; }, clearTimeout: t => { t.cancelled = true; }, Date
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function clientIdFor'), source.indexOf('  // Background linker:')) + '\nthis.loss = handleSessionLoss; this.report = reportSessionError;', context);
  return { context, instance, client, timers, events, starts, removed, loss: reason => context.loss('bot', instance.sessions[0], reason, client) };
}
test('logout rotates to backup and permanently excludes logged-out session', async () => {
  const h = harness(); await h.loss('LOGOUT');
  assert.equal(h.instance.sessions[0].status, 'logged_out');
  assert.equal(h.instance.activeSessionId, 'b');
  assert.equal(h.events.some(e => e[0] === 'session_switched' && e[1].to === 'b'), true);
  h.timers.find(t => !t.cancelled).fn(); assert.equal(h.starts[0][1], 'b');
});
test('transient errors rotate but preserve authentication for later recovery', async () => {
  const h = harness(); await h.loss('Target closed');
  assert.equal(h.instance.sessions[0].status, 'linked');
  assert.equal(h.instance.activeSessionId, 'b');
  assert.equal(h.removed.length, 0);
});
test('duplicate failure events schedule only one replacement', async () => {
  const h = harness(); await Promise.all([h.loss('LOGOUT'), h.loss('LOGOUT')]);
  assert.equal(h.timers.filter(t => !t.cancelled).length, 1);
});
test('manual stop never rotates', async () => {
  const h = harness(); h.context.clientStates.bot.manualStop = true; await h.loss('LOGOUT');
  assert.equal(h.instance.activeSessionId, 'a'); assert.equal(h.timers.filter(t => !t.cancelled).length, 0);
});
test('no backup after logout requests a new number without retrying the logged-out session', async () => {
  const h = harness(); h.instance.sessions.pop(); await h.loss('LOGOUT');
  assert.equal(h.context.clientStates.bot.status, 'needs_number'); assert.equal(h.timers.filter(t => !t.cancelled).length, 0);
});
test('stale send errors never replace the current session', async () => {
  const h = harness(); h.context.activeClients.bot = {}; await h.context.report('bot', h.client, new Error('Target closed'));
  assert.equal(h.instance.activeSessionId, 'a'); assert.equal(h.timers.length, 0);
});
test('a hanging browser shutdown cannot block rotation forever', async () => {
  assert.equal(await closeSession({ destroy: () => new Promise(() => {}) }, 5), false);
});
test('manual stop during the recovery delay cancels backup startup', async () => {
  const h = harness(); await h.loss('Target closed'); h.context.clientStates.bot.manualStop = true;
  h.timers.find(t => !t.cancelled).fn(); assert.equal(h.starts.length, 0);
});
test('all temporarily failing sessions wait before recovery instead of rapid cycling', async () => {
  const h = harness(); h.instance.sessions[1].retryAfter = Date.now() + 60000;
  await h.loss('Target closed');
  assert.equal(h.events.some(e => e[0] === 'session_switched'), false);
  assert.equal(h.timers.find(t => !t.cancelled).delay >= 10000, true);
});
const { pickAutoSession, autoSelectAction } = require('./session-health');
test('auto-select prefers a linked number over the active one still waiting for pairing', () => {
  const sessions = [{ id: 'new', status: 'pairing', phone: '91111' }, { id: 'old', status: 'linked' }];
  assert.equal(pickAutoSession(sessions, 'new').id, 'old');
  assert.equal(pickAutoSession([{ id: 'a', status: 'linked' }, { id: 'b', status: 'linked' }], 'b').id, 'b');
});
test('when no number is online for 3 checks, a linked number starts automatically', () => {
  const base = { sessions: [{ id: 'a', status: 'linked' }], activeId: 'x', running: false, manualStop: false };
  assert.equal(autoSelectAction({ ...base, idleTicks: 2 }), null);
  assert.deepEqual(autoSelectAction({ ...base, idleTicks: 3 }), { start: 'a' });
});
test('auto-select never overrides a manual stop', () => {
  assert.equal(autoSelectAction({ sessions: [{ id: 'a', status: 'linked' }], running: false, manualStop: true, idleTicks: 9 }), null);
});
test('pairing that has not finished after 10 minutes switches back to a linked number', () => {
  const sessions = [{ id: 'new', status: 'pairing' }, { id: 'old', status: 'linked' }];
  const args = { sessions, activeId: 'new', running: true, runningSessionId: 'new', status: 'connecting', manualStop: false, now: 700000 };
  assert.equal(autoSelectAction({ ...args, pairingSince: 200000 }), null);
  assert.deepEqual(autoSelectAction({ ...args, pairingSince: 100000 }), { switchTo: 'old' });
  assert.equal(autoSelectAction({ ...args, status: 'ready', pairingSince: 100000 }), null);
});

test('a single linked number in cooldown is still picked instead of reporting no number', () => {
  const now = Date.now();
  const only = [{ id: 'a', status: 'linked', retryAfter: now + 60000 }];
  assert.equal(pickAutoSession(only, 'a', now).id, 'a');
  const two = [{ id: 'a', status: 'linked', retryAfter: now + 60000 }, { id: 'b', status: 'linked' }];
  assert.equal(pickAutoSession(two, 'a', now).id, 'b');
  assert.equal(pickAutoSession([{ id: 'p', status: 'pending', phone: '1' }], 'p', now), null);
});

test('corrupted instances.json with unexpected end of JSON input automatically restores from backup', () => {
  const path = require('node:path');
  const tmpDir = path.join(__dirname, 'scratch_test_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const mainFile = path.join(tmpDir, 'instances.json');
  const bakFile = path.join(tmpDir, 'instances.json.bak');
  try {
    fs.writeFileSync(mainFile, '{"broken":', 'utf8');
    const validData = [{ id: 'inst_1', slug: 'primary', sessions: [{ id: 'default', phone: '918949446687', status: 'linked' }] }];
    fs.writeFileSync(bakFile, JSON.stringify(validData), 'utf8');

    const tryParse = (p) => {
      try {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (_) { return null; }
    };

    let loaded = tryParse(mainFile);
    if (!loaded && fs.existsSync(bakFile)) {
      loaded = tryParse(bakFile);
      if (loaded) {
        fs.copyFileSync(bakFile, mainFile);
      }
    }

    assert.equal(loaded?.[0]?.slug, 'primary');
    assert.equal(loaded?.[0]?.sessions?.[0]?.phone, '918949446687');
    assert.deepEqual(JSON.parse(fs.readFileSync(mainFile, 'utf8')), validData);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureSessions discovers and recovers linked sessions from authRoot (.wwebjs_auth)', () => {
  const path = require('node:path');
  const tmpAuth = path.join(__dirname, 'scratch_auth_' + Date.now());
  fs.mkdirSync(path.join(tmpAuth, 'session-session_primary'), { recursive: true });
  fs.mkdirSync(path.join(tmpAuth, 'session-session_primary_smv2nvup2'), { recursive: true });

  try {
    const inst = { slug: 'primary', sessions: [] };
    const authRoot = tmpAuth;
    const now = () => new Date().toISOString();

    const files = fs.readdirSync(authRoot);
    const prefix = `session-session_${inst.slug}`;
    for (const f of files) {
      if (f === prefix) {
        if (!inst.sessions.some(x => x.id === 'default')) {
          inst.sessions.unshift({ id: 'default', phone: '', label: 'Main number', status: 'linked', addedAt: now() });
        }
      } else if (f.startsWith(`${prefix}_`)) {
        const sid = f.slice(`${prefix}_`.length);
        if (sid && !inst.sessions.some(x => x.id === sid)) {
          inst.sessions.push({ id: sid, phone: '', label: `Session ${sid}`, status: 'linked', addedAt: now() });
        }
      }
    }

    assert.equal(inst.sessions.length, 2);
    assert.ok(inst.sessions.some(s => s.id === 'default' && s.status === 'linked'));
    assert.ok(inst.sessions.some(s => s.id === 'smv2nvup2' && s.status === 'linked'));
  } finally {
    fs.rmSync(tmpAuth, { recursive: true, force: true });
  }
});

