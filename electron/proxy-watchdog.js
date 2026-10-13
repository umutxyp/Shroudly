'use strict';

/*
 * Proxy watchdog: started detached (ELECTRON_RUN_AS_NODE) while the system proxy
 * points at Shroudly. If the app disappears without restoring it (killed in
 * Task Manager, crashed), this puts the user's previous settings back so their
 * internet keeps working. It exits on its own once the state file is gone,
 * which is what a normal stop does.
 *
 * With "env" it watches the session's HTTPS_PROXY instead (app-env.js), which
 * would otherwise leave programs pointed at a proxy that is gone.
 *
 *   proxy-watchdog.js <stateFile> <appPid> [env]
 */

const fs = require('fs');

const [stateFile, pidArg, kind] = process.argv.slice(2);
const appPid = Number(pidArg);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

if (!stateFile || !appPid) process.exit(2);

const timer = setInterval(() => {
  if (!fs.existsSync(stateFile)) { clearInterval(timer); process.exit(0); }
  if (alive(appPid)) return;
  clearInterval(timer);
  try {
    if (kind === 'env') require('./app-env').recoverSync({ stateFile });
    else require('./system-proxy').recoverSync({ stateFile });
  } catch {}
  process.exit(0);
}, 1000);
