'use strict';

/*
 * An antivirus that removed or stopped a part of Shroudly, told apart from
 * Shroudly's own failures.
 *
 * Antivirus programs (Bitdefender, Avast, Windows Security and others) take
 * Shroudly's engine for something to stop more often than one would think: a
 * program that changes how connections are made, runs in the background and,
 * for Advanced mode, loads a packet driver with the administrator's
 * permission. They quarantine its file, refuse to start it, or end it a
 * moment after it starts. Before this, every one of those looked like a
 * plain failure: "Engine binary not found. Run: npm run build:core" for a
 * file that was quarantined, five restarts of a program the antivirus kept
 * ending (each one more reason for it to act), "The Advanced engine did not
 * respond in time" after two minutes, and the window just saying "Not
 * protected". Nobody could tell what to do.
 *
 * So what such a block leaves behind is recognised here, from facts only:
 *   - the file is gone, empty, not a program any more, or cannot be read
 *     (fileState): certain;
 *   - Windows refused to start a file that is there (classifySpawnError):
 *     certain;
 *   - the engine ended right after it started, twice in a row, without a
 *     word of its own, and not the way a program that crashes ends
 *     (classifyEarlyExit): only "may", since a killer chooses the exit code;
 *   - Windows or the antivirus refused the WinDivert driver Advanced mode
 *     loads (classifyWinDivert, from the error code the engine reports).
 * main.js tells it in one place (securityBlocked): one line in the log, one
 * notification per part per session, a banner in the window with one action
 * (copy the folder to add as an exception), and no more automatic retries
 * against the blocker. Shroudly never opens the antivirus, the folder or its
 * own window by itself, and never tries to make itself an exception.
 *
 * Nothing here acts or tells: it reads a file at most, and judges, so all of
 * it can be tested on any system.
 */

const fs = require('fs');
const path = require('path');

// An engine that ends this soon after it was started, by itself and without
// a word, was most likely ended from outside (the start waits 6 s for it).
const EARLY_EXIT_MS = 5000;
// A file being scanned can refuse to be opened for a moment.
const BUSY_RETRY_MS = 1500;

/* The states that mean the file is not usable: a block left it so. */
const GONE = ['missing', 'empty', 'damaged', 'unreadable'];
const isGone = (state) => GONE.includes(state);

/*
 * What became of a program file: 'ok', 'missing', 'empty', 'damaged' (on
 * Windows, no longer a program: an antivirus that "cleans" a file can leave
 * it so), 'unreadable' (access refused), or 'busy' (held by a scan right
 * now; not taken as a block).
 */
function fileState(file, { platform = process.platform, fsys = fs } = {}) {
  let st;
  try { st = fsys.statSync(file); } catch (e) {
    const code = e && e.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return code === 'EBUSY' ? 'busy' : 'unreadable';
  }
  if (!st.isFile()) return 'missing';
  if (st.size === 0) return 'empty';
  let fd = null;
  try {
    fd = fsys.openSync(file, 'r');
    const head = Buffer.alloc(2);
    const n = fsys.readSync(fd, head, 0, 2, 0);
    // Every Windows program (exe, dll, sys) starts with "MZ".
    if (platform === 'win32' && (n < 2 || head[0] !== 0x4d || head[1] !== 0x5a)) return 'damaged';
    return 'ok';
  } catch (e) {
    return e && e.code === 'EBUSY' ? 'busy' : 'unreadable';
  } finally {
    if (fd !== null) { try { fsys.closeSync(fd); } catch {} }
  }
}

/* The same, looked at once more after a moment when a scan held the file. */
async function settledFileState(file, opts = {}, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const first = fileState(file, opts);
  if (first !== 'busy') return first;
  await wait(BUSY_RETRY_MS);
  return fileState(file, opts);
}

/*
 * A program that could not be started (Node's spawn error) with its file in
 * `state` (fileState, looked at just after): the kind of block, or null when
 * it is not one. On Windows an antivirus refusing a file that is there shows
 * as EPERM or EACCES (access denied, 5) or UNKNOWN (225 and 226, "contains a
 * virus", which have no name of their own in Node).
 */
function classifySpawnError(err, state, platform = process.platform) {
  const code = err && err.code;
  if (!code) return null;
  if (isGone(state)) return state;
  if (platform !== 'win32') return null;
  if (code === 'EPERM' || code === 'EACCES') return 'denied';
  if (code === 'UNKNOWN') return 'blocked';
  return null;
}

/* NTSTATUS codes of a crash (access violation, stack overrun, ...): the
 * program failed on its own. 0xC0000022 (access denied) is the exception:
 * that is what a process ended by a security program can show. */
const isCrash = (code) => code >= 0xC0000000 && code !== 0xC0000022;

/*
 * An engine that ended without being asked to: 'weak' when it looks like
 * one ended from outside (on Windows, within EARLY_EXIT_MS of its start,
 * with nothing on stderr and no error line of its own, and not a crash), or
 * null. One alone means little; two in a row are worth telling (as "may").
 *   { code, ms: since it was started, quiet: no stderr and no error line }
 */
function classifyEarlyExit({ code = null, ms, quiet, platform = process.platform } = {}) {
  if (platform !== 'win32' || !quiet || !(ms >= 0 && ms <= EARLY_EXIT_MS)) return null;
  if (code != null && Number.isFinite(Number(code)) && isCrash(Number(code) >>> 0)) return null;
  return 'weak';
}

/*
 * An error the Advanced engine reported about WinDivert ({ code:
 * 'windivert_load' | 'windivert_open', win32 }, core/src/raw_windows.c):
 *   { code: 'files_missing', kind }      a file is not there (2, 3, 126...);
 *   { code: 'security_blocked', kind }   refused although elevated (5),
 *       "contains a virus" (225, 226), a signature refused (577), a driver
 *       blocked (1275: security software, or a virtual machine without
 *       driver support);
 *   { code: 'rival' }                    another WinDivert version is loaded (654);
 *   { code: 'bfe_off' }                  the Base Filtering Engine service is off (1753);
 *   { code: 'needs_sha2' }               Windows 7 (or Vista) refused the signature
 *       (577) because it cannot check SHA-2 signatures without Microsoft's
 *       update KB4474419: no antivirus in it (a Russian report, 2.6.70);
 * or null for anything else.
 */
function classifyWinDivert(fault, { release = require('os').release() } = {}) {
  if (!fault || !fault.code || fault.win32 == null) return null;
  const w = Number(fault.win32) >>> 0;
  if (w === 577 && /^6\.[01]\./.test(String(release))) return { code: 'needs_sha2' };
  if (fault.code === 'windivert_load') {
    if ([2, 3, 126].includes(w)) return { code: 'files_missing', kind: 'missing' };
    if (w === 193) return { code: 'files_missing', kind: 'damaged' };
    if ([5, 225, 226, 577].includes(w)) return { code: 'security_blocked', kind: 'driver' };
    return null;
  }
  if (fault.code === 'windivert_open') {
    if (w === 2 || w === 3) return { code: 'files_missing', kind: 'missing' };
    if ([5, 225, 226, 577, 1275].includes(w)) return { code: 'security_blocked', kind: 'driver' };
    if (w === 654) return { code: 'rival' };
    if (w === 1753) return { code: 'bfe_off' };
  }
  return null;
}

/* The folder to name as the antivirus exception: the one Shroudly is
 * installed in (on macOS the app, on Linux the AppImage's own folder), which
 * holds the engine and Advanced mode's files too. */
function installFolder({ platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') {
    const i = execPath.indexOf('.app/');
    if (i > 0) return execPath.slice(0, i + 4);
  }
  if (platform === 'linux' && env.APPIMAGE) return p.dirname(env.APPIMAGE);
  return p.dirname(execPath);
}

const WHAT = {
  missing: (f) => `${f} is missing (quarantined?)`,
  empty: (f) => `${f} is empty (cleaned by an antivirus?)`,
  damaged: (f) => `${f} is no longer a program (cleaned by an antivirus?)`,
  unreadable: (f) => `${f} cannot be read (access refused)`,
  vanished: (f) => `${f} disappeared while it ran (quarantined?)`,
  denied: (f, d) => `starting ${f} was refused${d ? ` (${d})` : ''}`,
  blocked: (f, d) => `starting ${f} was refused${d ? ` (${d})` : ''}`,
  early_exit: (f, d) => `${f} was ended right after it started, twice${d ? ` (${d})` : ''}; an antivirus may be stopping it`,
  killed: (f) => `${f} was ended from outside before it was ready`,
  driver: (f, d) => `Windows refused to load the WinDivert driver${d ? ` (${d})` : ''}`,
};

/* The one line the log gets (English, like the rest of the log), e.g.
 * "Security software: shroudly-core.exe disappeared while it ran
 * (quarantined?); protection is off. Folder: C:\...". */
function logLine(info) {
  const i = info || {};
  const what = (WHAT[i.kind] || ((f, d) => `${f} was blocked${d ? ` (${d})` : ''}`))(i.file || 'a Shroudly file', i.detail);
  const off = i.part === 'advanced' ? 'Advanced mode is off' : 'protection is off';
  return `Security software: ${what}; ${off}.${i.folder ? ` Folder: ${i.folder}` : ''}`;
}

/* The log header's line ("Security software: ..."): what is blocked, and
 * how it is known, in a few words. */
function summary(info) {
  if (!info || !info.part) return null;
  const part = info.part === 'advanced' ? 'Advanced mode' : 'engine';
  const verdict = info.certain === false ? 'may be blocked' : 'blocked';
  const how = info.kind === 'driver' ? `WinDivert driver refused${info.win32 != null ? `, error ${info.win32}` : ''}`
    : info.kind === 'early_exit' ? 'ended right after it started, twice'
      : `${info.file || 'file'} ${info.kind || 'blocked'}`;
  return `${part} ${verdict} (${how})`;
}

/* What the window gets (advice.security): enough to choose the words, to
 * copy the folder and for the log's header line (summary), nothing more. */
function forWindow(info, now = Date.now()) {
  const i = info || {};
  return {
    part: i.part === 'advanced' ? 'advanced' : 'engine',
    kind: i.kind || null,
    certain: i.certain !== false,
    file: i.file || null,
    folder: i.folder || null,
    win32: i.win32 != null ? i.win32 : null,
    at: now,
  };
}

module.exports = {
  EARLY_EXIT_MS, BUSY_RETRY_MS,
  fileState, settledFileState, isGone, classifySpawnError, classifyEarlyExit, classifyWinDivert,
  installFolder, logLine, summary, forWindow,
};
