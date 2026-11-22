'use strict';

/*
 * Advanced mode started with the administrator permission given once
 * (Windows; the engine's half is core/src/advtask.h, which says why and how
 * it is kept safe).
 *
 * Until 2.6.87 every start of the Advanced engine was a permission prompt:
 * at every start of the computer, and whenever the engine had ended. Now
 * the engine started through the prompt copies itself to a folder only an
 * administrator can write (<Common Files>\Shroudly\advanced) and registers
 * a scheduled task that runs that copy, for this user only. From then on
 * Shroudly writes a request (the engine's options, checked there one by
 * one) into the user's own folder and starts the task: no prompt.
 *
 * It is used only while the copies are, byte for byte, the engine this
 * Shroudly brings: after an update that changed the engine the prompt comes
 * once more, and the copies with it. Whatever goes wrong on this way (no
 * task, a policy, an antivirus, a folder that cannot be written) ends in
 * the prompt, as before.
 *
 * Here: where the folders are, whether the copies are current, and the
 * request's text. advanced-mode.js does the starting.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILES = ['shroudly-core-adv.exe', 'WinDivert.dll', 'WinDivert64.sys'];
// What a request may carry (advtask.c OPTS), by whether a value follows.
const FLAGS = new Set(['--advanced', '--no-quic-block', '--no-udp-fake']);
const VALUES = new Set(['--fake-ttl', '--parent-pid', '--drop-rst', '--autottl', '--seqovl', '--tlsrec', '--keep-driver',
  '--fake-repeats', '--dns-gate', '--split', '--desync-mode', '--decoy-name']);

const absolute = (p) => typeof p === 'string' && /^[A-Za-z]:\\/.test(p);

/* <Common Files>\Shroudly\advanced. The engine reads Common Files from the
 * registry; the environment says the same unless somebody changed it, and
 * then the copies are simply not found here. */
function adminDir(env = process.env) {
  const base = env.CommonProgramW6432 || env.CommonProgramFiles;
  return absolute(base) ? path.win32.join(base, 'Shroudly', 'advanced') : null;
}

/* %LOCALAPPDATA%\Shroudly\advanced: the request, and the files the engine
 * is controlled by. */
function userDir(env = process.env) {
  return absolute(env.LOCALAPPDATA) ? path.win32.join(env.LOCALAPPDATA, 'Shroudly', 'advanced') : null;
}

/* The user's name as Windows has it (the task is named after it), or null
 * for one that could not go on a command line as it is. */
function userName(info = () => os.userInfo().username, env = process.env) {
  let n = '';
  try { n = String(info() || ''); } catch {}
  if (!n) n = String(env.USERNAME || '');
  // eslint-disable-next-line no-control-regex
  return /^[^"\\/[\]:;|=,+*?<>\x00-\x1f]{1,64}$/.test(n) && n.trim() === n ? n : null;
}

function taskName(user) { return `Shroudly Advanced mode (${user})`; }

function sameFile(a, b) {
  try {
    const x = fs.readFileSync(a);
    const y = fs.readFileSync(b);
    return x.length > 0 && x.length === y.length && x.equals(y);
  } catch { return false; }
}

/* The copies are the engine this Shroudly brings, byte for byte. */
function current(bundledDir, admin) {
  return !!bundledDir && !!admin && FILES.every((f) => sameFile(path.join(bundledDir, f), path.join(admin, f)));
}

function newId() { return crypto.randomBytes(16).toString('hex'); }

/* The engine's arguments as a request carries them: without the status
 * file (the engine decides where it writes), and nothing the engine would
 * refuse; null when something else is among them (then the prompt it is). */
function requestArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--status-file') { i++; continue; }
    if (FLAGS.has(a)) { out.push(a); continue; }
    if (!VALUES.has(a) || i + 1 >= args.length) return null;
    out.push(a, String(args[++i]));
  }
  return out;
}

function requestText(id, args) {
  return ['shroudly-advanced 1', `id ${id}`, ...args, ''].join('\n');
}

const UNINSTALL_TEXT = 'shroudly-advanced 1\nuninstall\n';

/* The process id the engine says first when its task started it
 * ({"type":"task","pid":N}), or null while it has not. */
function pidLine(statusFile) {
  let text = '';
  try { text = fs.readFileSync(statusFile, 'utf8'); } catch { return null; }
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.includes('"task"')) continue;
    try {
      const m = JSON.parse(raw);
      if (m.type === 'task' && Number.isInteger(m.pid) && m.pid > 0) return m.pid;
    } catch {}
  }
  return null;
}

/* What the engine's installer wrote: { ok, why, hr }, or null. */
function installResult(admin) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(admin, 'run', 'install.log'), 'utf8').trim().split(/\r?\n/).pop());
    if (m && m.type === 'task_install') return { ok: m.ok === 1, why: String(m.why || ''), hr: String(m.hr || '') };
  } catch {}
  return null;
}

function schtasks(env = process.env) {
  return path.win32.join(absolute(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows', 'System32', 'schtasks.exe');
}

module.exports = {
  FILES, adminDir, userDir, userName, taskName, current, newId, requestArgs, requestText, UNINSTALL_TEXT, pidLine, installResult, schtasks,
};
