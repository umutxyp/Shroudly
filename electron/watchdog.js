'use strict';

/*
 * Starts the one watchdog process on first use and tells it which state files
 * to look after. Shared by system-proxy.js and app-env.js, so there is a
 * single small process however much is armed, and it sleeps until Shroudly
 * ends.
 *
 * The watchdog is the engine binary in its "--watchdog" mode (core/src/
 * watchdog.c, about 1-2 MB): if Shroudly disappears with something still
 * applied it starts "Shroudly --restore-proxy", the same restore that runs
 * after a power cut. Only when that binary is missing does it fall back to
 * proxy-watchdog.js run by a second copy of Electron (about 18 MB).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let child = null;
// What it was told to look after, so that a watchdog that was stopped while
// Shroudly runs (a task manager, a sweep of processes) is started again with
// the same list: else a later kill would leave everything behind.
let lastOpts = null;
const watched = new Set();
let restarts = [];

/* An AppImage runs from a mount that disappears with Shroudly, and the
 * watchdog must outlive exactly that: run a copy kept next to the settings. */
function runnableCore(core, copyDir) {
  const appDir = process.env.APPDIR;
  if (!copyDir || process.platform !== 'linux' || !appDir || !core.startsWith(appDir + path.sep)) return core;
  try {
    const dest = path.join(copyDir, 'shroudly-watchdog');
    const src = fs.readFileSync(core);
    let same = false;
    try { same = fs.readFileSync(dest).equals(src); } catch {}
    if (!same) {
      fs.mkdirSync(copyDir, { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, src, { mode: 0o755 });
      fs.renameSync(tmp, dest);
    }
    return dest;
  } catch { return core; }
}

function start(opts) {
  const env = { ...process.env };
  let cmd, args;
  if (opts.core && opts.restore && opts.restore.exe && fs.existsSync(opts.core)) {
    delete env.ELECTRON_RUN_AS_NODE;   // the restore is a normal Shroudly start
    cmd = runnableCore(opts.core, opts.copyDir);
    args = ['--watchdog', String(process.pid), opts.restore.exe, ...(opts.restore.args || [])];
  } else if (opts.execPath && opts.script) {
    env.ELECTRON_RUN_AS_NODE = '1';
    cmd = opts.execPath;
    args = [opts.script, String(process.pid)];
  } else return null;
  const c = spawn(cmd, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env });
  c.on('error', () => { if (child === c) child = null; });
  c.on('exit', () => { if (child === c) { child = null; respawn(); } });
  c.stdin.on('error', () => {});
  c.unref();
  // The pipe must not keep Shroudly from exiting: its closing at exit is the
  // signal.
  if (c.stdin.unref) c.stdin.unref();
  return c;
}

/* Start it again after it was stopped, at most five times in ten minutes. */
function respawn() {
  if (!lastOpts || !watched.size) return;
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 10 * 60 * 1000);
  if (restarts.length >= 5) return;
  restarts.push(now);
  const t = setTimeout(() => {
    if (child || !lastOpts) return;
    try { child = start(lastOpts); } catch { child = null; }
    if (!child) return;
    for (const line of watched) { try { child.stdin.write(line); } catch {} }
  }, 1000);
  if (t.unref) t.unref();
}

/* opts: { core, restore: { exe, args }, copyDir, execPath, script };
 * kind: 'proxy' | 'env'. */
function watch(opts, kind, file) {
  if (!opts || !file) return false;
  lastOpts = opts;
  watched.add(`${kind}\t${file}\n`);
  if (!child) {
    try { child = start(opts); } catch { child = null; }
    if (!child) return false;
  }
  try { child.stdin.write(`${kind}\t${file}\n`); return true; } catch { return false; }
}

function running() { return !!child; }
function pid() { return child ? child.pid : 0; }

module.exports = { watch, running, pid };
