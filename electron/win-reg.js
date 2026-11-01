'use strict';

/*
 * Windows' registry: reg.exe, and the engine where Windows will not start
 * reg.exe at all.
 *
 * A policy ("Prevent access to registry editing tools", AppLocker, Software
 * Restriction Policies), a security program's application control, or
 * damaged system files can make Windows refuse to start reg.exe, even for an
 * administrator (issue #64: spawnSync reg.exe EPERM). Shroudly then could not
 * set the system proxy, and protection did not start. reg.exe is tried first;
 * when it could not start (no exit code, a spawn error), the same arguments
 * go to the engine's own `--reg` (core/src/winreg.c), which answers the way
 * reg.exe does: the same lines for a query, exit 1 for a value that is not
 * there. Once refused, reg.exe is not tried again in this run. Said once.
 *
 * reg.exe that ran and ended with an error (a value not there, access
 * denied to one key) is its answer, not a refusal to start: passed on.
 */

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const { coreBinaryPath } = require('./core-path');

const SPAWN_REFUSED = new Set(['EPERM', 'EACCES', 'ENOENT', 'UNKNOWN', 'EINVAL']);
let refused = null;      // the spawn error reg.exe gave, once it gave one
let log = () => {};
let told = false;
// Tests: stand-ins for the two programs.
let hooks = null;

/* reg.exe, by its name or its full path. */
function isReg(cmd) {
  return /(^|[\\/])reg(\.exe)?$/i.test(String(cmd || ''));
}

/* It could not start: a spawn error and no exit code. A timeout or an exit
 * code means it ran. */
function notStarted(e) {
  return !!e && (e.status === undefined || e.status === null) && !e.signal && !e.killed
    && typeof e.code === 'string' && SPAWN_REFUSED.has(e.code);
}

function engine() {
  const core = hooks && hooks.core ? hooks.core : coreBinaryPath();
  return fs.existsSync(core) ? core : null;
}

function noteRefused(e) {
  refused = e;
  if (told) return;
  told = true;
  try { log('warning', `Windows does not let Shroudly start reg.exe (${e.code}); Shroudly reads and writes these settings itself`); } catch {}
}

function viaEngineSync(args, timeout) {
  const core = engine();
  if (!core) throw refused;
  const run = hooks && hooks.execFileSync ? hooks.execFileSync : execFileSync;
  return String(run(core, ['--reg', ...args], { timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || '');
}

/* reg.exe's answer, or the engine's when reg.exe cannot start. cmd: the
 * reg.exe the caller names (a full path or just "reg.exe"). Throws as
 * execFileSync does: e.status 1 for "not there". */
function runSync(args, { timeout = 4000, cmd = 'reg.exe' } = {}) {
  if (!refused) {
    const run = hooks && hooks.execFileSync ? hooks.execFileSync : execFileSync;
    try { return String(run(cmd, args, { timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || ''); }
    catch (e) { if (!notStarted(e)) throw e; noteRefused(e); }
  }
  return viaEngineSync(args, timeout);
}

function execAsync(file, args, timeout) {
  const run = hooks && hooks.execFile ? hooks.execFile : execFile;
  return new Promise((resolve, reject) => {
    run(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); return; }
      resolve(String(stdout || ''));
    });
  });
}

/* The same, without blocking. */
async function run(args, { timeout = 8000, cmd = 'reg.exe' } = {}) {
  if (!refused) {
    try { return await execAsync(cmd, args, timeout); }
    catch (e) { if (!notStarted(e)) throw e; noteRefused(e); }
  }
  const core = engine();
  if (!core) throw refused;
  return execAsync(core, ['--reg', ...args], timeout);
}

module.exports = {
  isReg,
  notStarted,
  runSync,
  run,
  setLog(fn) { log = typeof fn === 'function' ? fn : () => {}; },
  // Whether reg.exe was refused this run (Repair and the log say so).
  refused: () => !!refused,
  _setHooks(h) { hooks = h; refused = null; told = false; },
};
