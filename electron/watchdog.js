'use strict';

/*
 * Starts the one watchdog process (proxy-watchdog.js) on first use and tells
 * it which state files to look after. Shared by system-proxy.js and
 * app-env.js, so there is a single small process however much is armed, and
 * it sleeps until Shroudly ends.
 */

const { spawn } = require('child_process');

let child = null;

/* opts: { execPath, script }; kind: 'proxy' | 'env'. */
function watch(opts, kind, file) {
  if (!opts || !file) return false;
  if (!child) {
    try {
      const c = spawn(opts.execPath, [opts.script, String(process.pid)], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      c.on('error', () => { if (child === c) child = null; });
      c.on('exit', () => { if (child === c) child = null; });
      c.stdin.on('error', () => {});
      c.unref();
      // The pipe must not keep Shroudly from exiting: its closing at exit is
      // the signal.
      if (c.stdin.unref) c.stdin.unref();
      child = c;
    } catch { child = null; return false; }
  }
  try { child.stdin.write(`${kind}\t${file}\n`); return true; } catch { return false; }
}

function running() { return !!child; }

module.exports = { watch, running };
