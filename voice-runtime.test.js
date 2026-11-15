const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePython, runVoiceProcess } = require('./voice-runtime');

test('resolvePython uses the configured executable and resolves relative paths from the project', () => {
  assert.equal(resolvePython(__dirname, { PYTHON_PATH: 'python-custom' }, 'linux'), 'python-custom');
  assert.equal(resolvePython(__dirname, { PYTHON_PATH: './missing-python' }, 'linux'), 'python3');
  assert.equal(resolvePython(__dirname, {}, 'win32'), 'python');
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
