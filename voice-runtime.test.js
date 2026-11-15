const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePython, runVoiceProcess, audioConversionIsComplete, downloadVoiceMedia, describeVoiceError, voiceMediaState } = require('./voice-runtime');

test('resolvePython uses the configured executable and resolves relative paths from the project', () => {
  assert.equal(resolvePython(__dirname, { PYTHON_PATH: 'python-custom' }, 'linux'), 'python-custom');
  assert.equal(resolvePython(__dirname, { PYTHON_PATH: './missing-python' }, 'linux'), 'python3');
  assert.equal(resolvePython(__dirname, {}, 'win32'), 'python');
});

test('audio conversion rejects clipped output and accepts normal encoder padding', () => {
  assert.equal(audioConversionIsComplete(4.2, 4.0), true);
  assert.equal(audioConversionIsComplete(4.2, 3.4), false);
  assert.equal(audioConversionIsComplete('bad', 4.2), false);
});

test('runVoiceProcess returns stdout and includes stderr in failures', async () => {
  const node = process.execPath;
  const output = await runVoiceProcess(node, ['-e', 'process.stdout.write("voice-ok")'], { cwd: __dirname });
  assert.equal(output, 'voice-ok');
  await assert.rejects(
    runVoiceProcess(node, ['-e', 'process.stderr.write("voice-failed"); process.exit(2)'], { cwd: __dirname }),
    /voice-failed/
  );
});

test('voice process arguments remain literal rather than becoming shell commands', async () => {
  const value = 'voice with spaces; $(not-a-command) "quoted"';
  const output = await runVoiceProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]);
  assert.equal(output, value);
});

test('voice download retries an opaque WhatsApp error and pending media before transcription', async () => {
  let calls = 0;
  const retries = [];
  const audio = { mimetype: 'audio/ogg', data: 'YXVkaW8=' };
  const result = await downloadVoiceMedia({ downloadMedia: async () => {
    calls++;
    if (calls === 1) throw new Error('t');
    return calls === 2 ? undefined : audio;
  } }, { wait: async () => {}, onRetry: attempt => retries.push(attempt) });
  assert.equal(result, audio);
  assert.deepEqual(retries, [1, 2]);
  assert.equal(calls, 3);
});

test('persistent voice download failures stop after three attempts', async () => {
  let calls = 0;
  await assert.rejects(downloadVoiceMedia({ downloadMedia: async () => {
    calls++; throw new Error('t');
  } }, { wait: async () => {} }), /t/);
  assert.equal(calls, 3);
});

test('a stalled media download times out without overlapping retries', async () => {
  let calls = 0;
  await assert.rejects(downloadVoiceMedia({ downloadMedia: () => {
    calls++; return new Promise(() => {});
  } }, { timeoutMs: 10, wait: async () => {} }), /timed out/);
  assert.equal(calls, 1);
});

test('downloads do not retry a closed or replaced WhatsApp session', async () => {
  let current = true;
  let calls = 0;
  await assert.rejects(downloadVoiceMedia({ downloadMedia: async () => {
    calls++; current = false; throw new Error('t');
  } }, { isCurrent: () => current, wait: async () => {} }), /t/);
  assert.equal(calls, 1);
  await assert.rejects(downloadVoiceMedia({ downloadMedia: async () => {
    calls++; throw new Error('Target closed');
  } }, { wait: async () => {} }), /Target closed/);
  assert.equal(calls, 2);
});

test('voice errors retain browser stacks and status instead of only the short message', () => {
  const error = new Error('t');
  error.stack = 'Error: t\n    at downloadAndMaybeDecrypt (browser.js:10)';
  error.status = 403;
  assert.match(describeVoiceError(error), /downloadAndMaybeDecrypt/);
  assert.match(describeVoiceError(error), /status=403/);
  assert.equal(describeVoiceError('download failed'), 'download failed');
});

test('media diagnostics include loading state and exclude encryption keys and URLs', async () => {
  const vm = require('node:vm');
  const msg = {
    id: { _serialized: 'voice-id' },
    client: { pupPage: { evaluate: async (fn, id) => {
      assert.equal(id, 'voice-id');
      const context = { window: { require: () => ({ Msg: { get: () => ({
        type: 'ptt', mimetype: 'audio/ogg', mediaData: { mediaStage: 'FETCHING' },
        mediaKey: 'secret', directPath: 'private-url'
      }) } }) } };
      return vm.runInNewContext(`(${fn.toString()})('voice-id')`, context);
    } } }
  };
  const state = await voiceMediaState(msg);
  assert.equal(state.mediaStage, 'FETCHING');
  assert.equal(state.found, true);
  assert.equal(JSON.stringify(state).includes('secret'), false);
  assert.equal(JSON.stringify(state).includes('private-url'), false);
});
