const SESSION_FAILURE = /target closed|session closed|connection closed|browser.*disconnected|execution context.*destroyed|protocol error|WhatsApp send task timeout|Engine bootstrap|SESSION_HEALTH/i;
function isSessionFailure(error) {
  return SESSION_FAILURE.test(String(error?.message || error));
}
function pickNextSession(sessions, currentId, now = Date.now()) {
  const index = sessions.findIndex(s => s.id === currentId);
  for (let offset = 1; offset <= sessions.length; offset++) {
    const candidate = sessions[(index + offset) % sessions.length];
    if (candidate && candidate.id !== currentId && candidate.status === 'linked' && !(candidate.retryAfter > now)) return candidate;
  }
  return null;
}
async function closeSession(client, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => client.destroy()).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}
function monitorSession(client, { isCurrent, isReady, onFailure, intervalMs = 30000, timeoutMs = 15000, startupMs = 180000 }) {
  const started = Date.now();
  let stopped = false;
  let checking = false;
  let failures = 0;
  let timer;
  let deadline;
  const stop = () => { stopped = true; clearInterval(timer); clearTimeout(deadline); };
  const check = async () => {
    if (stopped || checking) return;
    if (!isCurrent()) { stop(); return; }
    if (!isReady()) {
      if (Date.now() - started > startupMs) { stop(); await onFailure(new Error('SESSION_HEALTH: startup did not complete')); }
      return;
    }
    checking = true;
    try {
      if (client.pupPage?.isClosed() || (client.pupBrowser && !client.pupBrowser.isConnected())) throw new Error('SESSION_HEALTH: browser closed');
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('SESSION_HEALTH: connection check timed out')), timeoutMs); })
      ]);
      if (state !== 'CONNECTED') throw new Error(`SESSION_HEALTH: ${state || 'connection unavailable'}`);
      failures = 0;
    } catch (error) {
      failures++;
      if (failures >= 2 && isCurrent() && !stopped) { stop(); await onFailure(new Error(`SESSION_HEALTH: ${error.message || String(error)}`)); }
    } finally { clearTimeout(deadline); checking = false; }
  };
  timer = setInterval(() => { check().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return { stop, check };
}
module.exports = { isSessionFailure, pickNextSession, monitorSession, closeSession };