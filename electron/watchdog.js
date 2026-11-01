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
 * after a power cut. When that binary is missing (an antivirus quarantined
 * it), nothing is started: Shroudly.exe is never run as plain Node.js for
 * this (ELECTRON_RUN_AS_NODE, switched off in the build: package.json
 * electronFuses), which antivirus programs flag as a known way to disguise a
 * program. The restore at the next login or the next start, and the
 * installer, put things back then.
 *
 * A watchdog that was ended while its file is gone is not started again: an
 * antivirus quarantined the engine (and so the watchdog, the same program),
 * and starting anything again then can only fail or give it one more reason
 * to act. That is said once (opts.onCoreGone; the engine's own end tells
 * the user).
 *
 * Windows: a process tree kill (Task Manager's "End process tree", taskkill
 * /T, which cafe reset scripts use) ends every process Shroudly started, a
 * watchdog among them, and nothing would be put back. There the watchdog
 * starts a copy of itself outside Shroudly's tree and leaves (core/src/
 * watchdog.c), and the copy talks to Shroudly over a named pipe Shroudly
 * serves: it says its process id, reads what to look after, and the pipe
 * breaking, however Shroudly ends, is the signal stdin's closing is
 * elsewhere.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fileState, isGone } = require('./security-block');

let child = null;
// What it was told to look after, so that a watchdog that was stopped while
// Shroudly runs (a task manager, a sweep of processes) is started again with
// the same list: else a later kill would leave everything behind.
let lastOpts = null;
const watched = new Set();
let restarts = [];
let coreGoneTold = false;

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

/* The running watchdog: { pid, write(line) }. */
function start(opts) {
  const env = { ...process.env };
  let cmd, args;
  if (opts.core && opts.restore && opts.restore.exe && fs.existsSync(opts.core)) {
    delete env.ELECTRON_RUN_AS_NODE;   // the restore is a normal Shroudly start
    cmd = runnableCore(opts.core, opts.copyDir);
    args = ['--watchdog', String(process.pid), opts.restore.exe, ...(opts.restore.args || [])];
  } else return null;
  if (process.platform === 'win32') return startPiped(cmd, args, env);
  const c = spawn(cmd, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env });
  const w = { pid: c.pid, write: (line) => c.stdin.write(line) };
  c.on('error', () => { if (child === w) child = null; });
  c.on('exit', () => { if (child === w) { child = null; respawn(); } });
  c.stdin.on('error', () => {});
  c.unref();
  // The pipe must not keep Shroudly from exiting: its closing at exit is the
  // signal.
  if (c.stdin.unref) c.stdin.unref();
  return w;
}

/* Windows (see the top): the pipe served here, the watchdog started with its
 * name; lines written before the copy connects wait for it. Gone (the pipe
 * broke, or no copy connected): started again as one that ended. */
const CONNECT_MS = 15000;
function startPiped(cmd, args, env) {
  const name = `\\\\.\\pipe\\shroudly-watchdog-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const pending = [];
  let sock = null;
  let ended = false;
  const w = {
    pid: 0,
    write: (line) => { if (sock) sock.write(line); else pending.push(line); },
  };
  const gone = () => {
    if (ended) return;
    ended = true;
    clearTimeout(wait);
    try { server.close(); } catch {}
    if (child === w) { child = null; respawn(); }
  };
  const server = net.createServer((s) => {
    // One copy, once: anything else that connects is turned away.
    if (sock || ended) { s.destroy(); return; }
    sock = s;
    s.unref();
    s.setEncoding('utf8');
    s.on('error', () => {});
    s.on('close', gone);
    let said = '';
    s.on('data', (d) => {
      said = (said + d).slice(-64);
      const m = /pid\t(\d+)\n/.exec(said);
      if (m) w.pid = Number(m[1]);
    });
    for (const line of pending.splice(0)) s.write(line);
  });
  server.on('error', gone);
  server.listen(name);
  server.unref();
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, SHROUDLY_WD_PIPE: name } });
  c.on('error', gone);
  c.unref();
  const wait = setTimeout(() => { if (!sock) gone(); }, CONNECT_MS);
  if (wait.unref) wait.unref();
  return w;
}

/* Its file gone (see the top): said once. */
function coreGone() {
  if (!lastOpts || !lastOpts.core || !isGone(fileState(lastOpts.core))) return false;
  if (!coreGoneTold && typeof lastOpts.onCoreGone === 'function') { coreGoneTold = true; try { lastOpts.onCoreGone(lastOpts.core); } catch {} }
  return true;
}

/* Start it again after it was stopped, at most five times in ten minutes,
 * and not once its file is gone: looked at again just before, since an
 * antivirus may end a program a moment before it moves its file away. */
function respawn() {
  if (!lastOpts || !watched.size || coreGone()) return;
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 10 * 60 * 1000);
  if (restarts.length >= 5) return;
  restarts.push(now);
  const t = setTimeout(() => {
    if (child || !lastOpts || coreGone()) return;
    try { child = start(lastOpts); } catch { child = null; }
    if (!child) return;
    for (const line of watched) { try { child.write(line); } catch {} }
  }, 1000);
  if (t.unref) t.unref();
}

/* opts: { core, restore: { exe, args }, copyDir, onCoreGone(core) };
 * kind: 'proxy' | 'env' | 'discord'. */
function watch(opts, kind, file) {
  if (!opts || !file) return false;
  lastOpts = opts;
  watched.add(`${kind}\t${file}\n`);
  if (!child) {
    try { child = start(opts); } catch { child = null; }
    if (!child) return false;
  }
  try { child.write(`${kind}\t${file}\n`); return true; } catch { return false; }
}

function running() { return !!child; }
function pid() { return child ? child.pid : 0; }

module.exports = { watch, running, pid };
