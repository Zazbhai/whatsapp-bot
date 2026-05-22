const { spawn } = require('child_process');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
const restartDelayMs = Number(process.env.BOT_RESTART_DELAY_MS || 5000);
const maxRestarts = Number(process.env.BOT_MAX_RESTARTS || 0);

let child = null;
let restartCount = 0;
let shuttingDown = false;

function startBot() {
  console.log(`[SUPERVISOR] Starting WhatsApp bot process...`);

  child = spawn(process.execPath, [serverPath], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit'
  });

  child.on('exit', (code, signal) => {
    child = null;

    if (shuttingDown || signal === 'SIGINT' || signal === 'SIGTERM') {
      console.log(`[SUPERVISOR] Bot stopped normally (${signal || `code ${code}`}).`);
      process.exit(code || 0);
    }

    restartCount++;
    const reachedLimit = maxRestarts > 0 && restartCount > maxRestarts;
    console.error(`[SUPERVISOR] Bot crashed/exited with code ${code} (signal: ${signal || 'none'}).`);

    if (reachedLimit) {
      console.error(`[SUPERVISOR] Restart limit reached (${maxRestarts}). Not restarting.`);
      process.exit(code || 1);
    }

    console.log(`[SUPERVISOR] Restarting in ${restartDelayMs}ms...`);
    setTimeout(startBot, restartDelayMs);
  });

  child.on('error', (err) => {
    console.error(`[SUPERVISOR] Failed to start bot: ${err.message}`);
  });
}

function stopSupervisor(signal) {
  shuttingDown = true;
  console.log(`[SUPERVISOR] ${signal} received. Stopping bot...`);

  if (child) {
    child.kill(signal);
    return;
  }

  process.exit(0);
}

process.on('SIGINT', () => stopSupervisor('SIGINT'));
process.on('SIGTERM', () => stopSupervisor('SIGTERM'));

startBot();
