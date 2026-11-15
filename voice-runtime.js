const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

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

module.exports = { resolvePython, runVoiceProcess };
