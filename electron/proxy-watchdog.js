'use strict';

/*
 * Watchdog: one small process, started detached (ELECTRON_RUN_AS_NODE) the
 * first time Shroudly changes something that must not outlive it: the system
 * proxy (system-proxy.js) or the session's HTTPS_PROXY (app-env.js). If
 * Shroudly then disappears without putting things back (killed in Task
 * Manager, crashed), this puts them back, so the user's internet and
 * programs keep working.
 *
 * Shroudly tells it what to look after on stdin, one line per state file:
 * "proxy<TAB><file>" or "env<TAB><file>". The same pipe is how it learns that
 * Shroudly is gone: the pipe closes the moment Shroudly ends, however it
 * ends, so there is nothing to poll. (A slow check of the process remains as
 * a fallback.) A state file still there then means a change that was never
 * undone; a normal quit removes them first, and this then exits doing nothing.
 *
 *   proxy-watchdog.js <appPid>
 */

const fs = require('fs');

const appPid = Number(process.argv[2]);
if (!appPid) process.exit(2);

const watched = new Map();   // file -> 'proxy' | 'env'
let finished = false;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function recover() {
  if (finished) return;
  finished = true;
  for (const [file, kind] of watched) {
    if (!fs.existsSync(file)) continue;
    try {
      if (kind === 'env') require('./app-env').recoverSync({ stateFile: file });
      else require('./system-proxy').recoverSync({ stateFile: file });
    } catch {}
  }
  process.exit(0);
}

/* The pipe closed: Shroudly is ending. Give it a moment to finish dying (it
 * cleans up before it exits on a normal quit), then put back what is left. */
function pipeClosed() {
  let tries = 0;
  const t = setInterval(() => {
    if (!alive(appPid) || ++tries > 50) { clearInterval(t); if (!alive(appPid)) recover(); }
  }, 200);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const [kind, file] = buf.slice(0, i).split('\t');
    buf = buf.slice(i + 1);
    if ((kind === 'proxy' || kind === 'env') && file) watched.set(file, kind);
  }
});
process.stdin.on('end', pipeClosed);
process.stdin.on('error', pipeClosed);

// Fallback, should the pipe somehow not report the end.
setInterval(() => { if (!alive(appPid)) recover(); }, 10000);
