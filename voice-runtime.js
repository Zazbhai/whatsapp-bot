const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { isSessionFailure } = require('./session-health');

function describeVoiceError(error) {
  if (!error || typeof error !== 'object') return String(error);
  const details = [error.stack || `${error.name || 'Error'}: ${error.message || String(error)}`];
  for (const key of ['status', 'code']) {
    if (error[key] != null) details.push(`${key}=${error[key]}`);
  }
  return details.join(' | ');
}

async function downloadVoiceMedia(msg, {
  isCurrent = () => true,
  onRetry = () => {},
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 20000
} = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!isCurrent()) throw new Error('Session changed before voice download');
    let timer;
    let timedOut = false;
    try {
      const media = await Promise.race([
        Promise.resolve().then(() => msg.downloadMedia()),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`WhatsApp voice media download timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
      if (!isCurrent()) throw new Error('Session changed during voice download');
      if (media && typeof media.data === 'string' && media.data.length > 0) return media;
      throw new Error('WhatsApp returned no audio data (media may still be downloading or expired)');
    } catch (error) {
      // Do not start overlapping downloads after a timeout or use a replaced session.
      if (timedOut || !isCurrent() || isSessionFailure(error) || attempt === 3) throw error;
      onRetry(attempt, error);
    } finally { clearTimeout(timer); }
    await wait(1000);
  }
}

async function voiceMediaState(msg) {
  const page = msg.client?.pupPage;
  const id = msg.id?._serialized || msg.id?.$1;
  if (!page || !id) return { available: false };
  return page.evaluate(messageId => {
    const message = window.require('WAWebCollections')?.Msg?.get(messageId);
    return {
      found: Boolean(message),
      type: message?.type,
      mimetype: message?.mimetype,
      mediaStage: message?.mediaData?.mediaStage,
      hasMediaData: Boolean(message?.mediaData)
    };
  }, id);
}

function resolvePython(rootDir, env = process.env, platform = process.platform) {
  const configured = (env.PYTHON_PATH || '').trim();
  if (configured) {
    if (!/[\\/]/.test(configured)) return configured;
    const absolute = path.resolve(rootDir, configured);
    if (fs.existsSync(absolute)) return absolute;
  }
  return platform === 'win32' ? 'python' : 'python3';
}

function runVoiceProcess(command, args, { cwd, timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${path.basename(command)} failed: ${(stderr || stdout || error.message).trim()}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

module.exports = { resolvePython, runVoiceProcess, describeVoiceError, downloadVoiceMedia, voiceMediaState };
