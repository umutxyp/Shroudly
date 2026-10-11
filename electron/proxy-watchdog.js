'use strict';

/*
 * Proxy watchdog: started detached (ELECTRON_RUN_AS_NODE) while the system proxy
 * points at Shroudly. If the app disappears without restoring it (killed in
 * Task Manager, crashed), this puts the user's previous settings back so their
 * internet keeps working. It exits on its own once the state file is gone,
 * which is what a normal stop does.
 *
 *   proxy-watchdog.js <stateFile> <appPid>
 */

const fs = require('fs');
const SystemProxy = require('./system-proxy');

const [stateFile, pidArg] = process.argv.slice(2);
const appPid = Number(pidArg);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

if (!stateFile || !appPid) process.exit(2);

const timer = setInterval(() => {
  if (!fs.existsSync(stateFile)) { clearInterval(timer); process.exit(0); }
  if (alive(appPid)) return;
  clearInterval(timer);
  try { SystemProxy.recoverSync({ stateFile }); } catch {}
  process.exit(0);
}, 1000);
