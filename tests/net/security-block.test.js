'use strict';

/* An antivirus that removed or stopped a part of Shroudly, told apart from
 * Shroudly's own failures (electron/security-block.js): a program file that
 * is gone, empty, no longer a program or unreadable; Windows refusing to
 * start one that is there; an engine ended right after its start without a
 * word (never a crash, never off Windows); WinDivert's error codes; the
 * folder to name as the exception; and the log's lines about it. Pure, so
 * every system runs all of it. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ROOT, suite } = require('./helpers');
const SB = require(path.join(ROOT, 'electron', 'security-block.js'));

const t = suite('security-block');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-sb-'));

(async () => {
  // ── fileState ──
  const exe = path.join(dir, 'shroudly-core.exe');
  fs.writeFileSync(exe, Buffer.from('MZ\x90\x00rest of a program'));
  t.ok(SB.fileState(exe, { platform: 'win32' }) === 'ok', 'a Windows program that is there and starts with MZ: ok');
  t.ok(SB.fileState(path.join(dir, 'gone.exe'), { platform: 'win32' }) === 'missing', 'one that is not there: missing');
  const empty = path.join(dir, 'empty.exe');
  fs.writeFileSync(empty, '');
  t.ok(SB.fileState(empty, { platform: 'win32' }) === 'empty', 'one left empty (an antivirus "cleaned" it): empty');
  const text = path.join(dir, 'text.exe');
  fs.writeFileSync(text, 'This file was quarantined');
  t.ok(SB.fileState(text, { platform: 'win32' }) === 'damaged', 'one that is no longer a program on Windows: damaged');
  t.ok(SB.fileState(text, { platform: 'linux' }) === 'ok', 'elsewhere a program has no MZ: only that it is there and readable counts');
  t.ok(SB.fileState(dir, { platform: 'win32' }) === 'missing', 'a folder in its place: missing');
  // What the file system answers, without a real one: refused, held by a scan.
  const answer = (statErr, openErr) => ({
    statSync: () => { if (statErr) throw Object.assign(new Error(statErr), { code: statErr }); return { isFile: () => true, size: 10 }; },
    openSync: () => { throw Object.assign(new Error(openErr), { code: openErr }); },
    readSync: () => 0, closeSync: () => {},
  });
  t.ok(SB.fileState('x', { platform: 'win32', fsys: answer(null, 'EPERM') }) === 'unreadable', 'opening it refused: unreadable');
  t.ok(SB.fileState('x', { platform: 'win32', fsys: answer('EACCES') }) === 'unreadable', 'even looking at it refused: unreadable');
  t.ok(SB.fileState('x', { platform: 'win32', fsys: answer(null, 'EBUSY') }) === 'busy', 'held by a scan right now: busy, not taken for a block');
  t.ok(!SB.isGone('busy') && !SB.isGone('ok') && ['missing', 'empty', 'damaged', 'unreadable'].every(SB.isGone), 'which states are a block');
  {
    let calls = 0;
    const waits = [];
    const fsys = { ...answer(null, 'EBUSY'), openSync: () => { calls++; if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return 3; }, readSync: (fd, b) => { b[0] = 0x4d; b[1] = 0x5a; return 2; } };
    const st = await SB.settledFileState('x', { platform: 'win32', fsys }, async (ms) => { waits.push(ms); });
    t.ok(st === 'ok' && waits.join() === String(SB.BUSY_RETRY_MS), `held by a scan: looked at again once, after ${SB.BUSY_RETRY_MS} ms (${st})`);
    const gone = await SB.settledFileState(path.join(dir, 'gone.exe'), { platform: 'win32' }, async () => { throw new Error('no wait'); });
    t.ok(gone === 'missing', 'not there: no waiting');
  }

  // ── classifySpawnError ──
  const err = (code) => Object.assign(new Error(`spawn x ${code}`), { code });
  t.ok(SB.classifySpawnError(err('ENOENT'), 'missing', 'win32') === 'missing', 'ENOENT with the file gone: missing');
  t.ok(SB.classifySpawnError(err('ENOENT'), 'ok', 'win32') === null, 'ENOENT with the file there: not a block');
  t.ok(SB.classifySpawnError(err('EPERM'), 'ok', 'win32') === 'denied' && SB.classifySpawnError(err('EACCES'), 'ok', 'win32') === 'denied',
    'Windows refused a file that is there (access denied, 5): denied');
  t.ok(SB.classifySpawnError(err('UNKNOWN'), 'ok', 'win32') === 'blocked', '"contains a virus" (225, 226: UNKNOWN in Node): blocked');
  t.ok(SB.classifySpawnError(err('EPERM'), 'busy', 'win32') === 'denied', 'refused while a scan holds it: still refused');
  t.ok(SB.classifySpawnError(err('EPERM'), 'unreadable', 'win32') === 'unreadable', 'refused and unreadable now: what the file is');
  t.ok(SB.classifySpawnError(err('EACCES'), 'ok', 'linux') === null && SB.classifySpawnError(err('EACCES'), 'ok', 'darwin') === null,
    'off Windows a refusal is no antivirus sign (a lost execute bit, a noexec mount)');
  t.ok(SB.classifySpawnError(err('EMFILE'), 'ok', 'win32') === null && SB.classifySpawnError(new Error('x'), 'ok', 'win32') === null, 'other errors: not a block');

  // ── classifyEarlyExit ──
  const early = (o) => SB.classifyEarlyExit({ code: 1, ms: 800, quiet: true, platform: 'win32', ...o });
  t.ok(early({}) === 'weak', 'Windows, ended by itself 0.8 s after its start, without a word: weak');
  t.ok(early({ code: 0xC0000022 }) === 'weak' && early({ code: -1073741790 }) === 'weak', 'access denied (0xC0000022), either way Node gives it: weak');
  t.ok(early({ code: 0xC0000005 }) === null && early({ code: 0xC0000409 }) === null && early({ code: -1073741819 }) === null,
    'a crash (access violation, stack overrun): its own failure, not a block');
  t.ok(early({ ms: SB.EARLY_EXIT_MS + 1 }) === null, `after ${SB.EARLY_EXIT_MS} ms: not "right after its start"`);
  t.ok(early({ ms: -5 }) === null, 'a clock set back meanwhile: not counted');
  t.ok(early({ quiet: false }) === null, 'it said why (stderr, an error line): not a block');
  t.ok(early({ platform: 'darwin' }) === null && early({ platform: 'linux' }) === null, 'off Windows: never');
  t.ok(early({ code: null }) === 'weak', 'ended by a signal (no code): weak');

  // ── classifyWinDivert ──
  const wd = (code, win32) => SB.classifyWinDivert({ code, win32 });
  t.ok(wd('windivert_open', 1275).code === 'security_blocked' && wd('windivert_open', 1275).kind === 'driver', '1275 (driver blocked): security_blocked, the driver');
  t.ok(wd('windivert_open', 577).code === 'security_blocked' && wd('windivert_open', 5).code === 'security_blocked'
    && wd('windivert_open', 225).code === 'security_blocked', '577 (signature refused), 5 (denied though elevated), 225: security_blocked');
  t.ok(wd('windivert_open', 2).code === 'files_missing', '2 (the driver file not there): files_missing');
  t.ok(wd('windivert_load', 126).code === 'files_missing' && wd('windivert_load', 193).code === 'files_missing', 'WinDivert.dll not there (126) or not a program (193): files_missing');
  t.ok(wd('windivert_load', 5).code === 'security_blocked', 'WinDivert.dll refused (5): security_blocked');
  t.ok(wd('windivert_open', 654).code === 'rival' && wd('windivert_open', 1753).code === 'bfe_off', '654: another WinDivert loaded; 1753: Base Filtering Engine off');
  t.ok(wd('windivert_open', 87) === null && wd('other', 5) === null && SB.classifyWinDivert(null) === null && SB.classifyWinDivert({ code: 'windivert_open' }) === null,
    'anything else: not classified (start_failed stays)');

  // ── installFolder ──
  t.ok(SB.installFolder({ platform: 'win32', execPath: 'C:\\Users\\Ümit\\AppData\\Local\\Programs\\Shroudly\\Shroudly.exe', env: {} })
    === 'C:\\Users\\Ümit\\AppData\\Local\\Programs\\Shroudly', 'Windows: the folder Shroudly.exe is in');
  t.ok(SB.installFolder({ platform: 'darwin', execPath: '/Applications/Shroudly.app/Contents/MacOS/Shroudly', env: {} }) === '/Applications/Shroudly.app', 'macOS: the app');
  t.ok(SB.installFolder({ platform: 'linux', execPath: '/tmp/.mount_ShroudXYZ/shroudly', env: { APPIMAGE: '/home/a/Apps/Shroudly.AppImage' } }) === '/home/a/Apps',
    'Linux AppImage: the folder of the AppImage, not its passing mount');

  // ── the log's lines ──
  const info = { part: 'engine', kind: 'vanished', certain: true, file: 'shroudly-core.exe', folder: 'C:\\Shroudly' };
  t.ok(SB.logLine(info) === 'Security software: shroudly-core.exe disappeared while it ran (quarantined?); protection is off. Folder: C:\\Shroudly',
    `one plain English line, with the file and the folder (${SB.logLine(info)})`);
  t.ok(SB.logLine({ part: 'advanced', kind: 'driver', file: 'WinDivert64.sys', detail: 'WinDivertOpen: error 1275' })
    === 'Security software: Windows refused to load the WinDivert driver (WinDivertOpen: error 1275); Advanced mode is off.', 'the driver refused: Advanced mode is off');
  t.ok(SB.logLine({ part: 'engine', kind: 'denied', file: 'shroudly-core.exe', detail: 'spawn EPERM' }).includes('starting shroudly-core.exe was refused (spawn EPERM)'), 'a refused start names the error');
  t.ok(SB.logLine({ part: 'engine', kind: 'early_exit', certain: false, file: 'shroudly-core.exe' }).includes('an antivirus may be stopping it'), 'the weak one says "may"');
  t.ok(SB.summary({ part: 'engine', kind: 'missing', file: 'shroudly-core.exe' }) === 'engine blocked (shroudly-core.exe missing)', 'the log header: the engine blocked, how');
  t.ok(SB.summary({ part: 'advanced', kind: 'driver', win32: 1275 }) === 'Advanced mode blocked (WinDivert driver refused, error 1275)', 'the log header: the driver');
  t.ok(SB.summary({ part: 'engine', kind: 'early_exit', certain: false }) === 'engine may be blocked (ended right after it started, twice)', 'the log header: the weak one');
  t.ok(SB.summary(null) === null, 'nothing blocked: no line');
  const w = SB.forWindow({ ...info, detail: 'secret detail' }, 123);
  t.ok(JSON.stringify(w) === JSON.stringify({ part: 'engine', kind: 'vanished', certain: true, file: 'shroudly-core.exe', folder: 'C:\\Shroudly', win32: null, at: 123 }),
    'the window gets what it shows and copies, and when (a newer one is shown again)');
  t.ok(SB.summary(w) === 'engine blocked (shroudly-core.exe vanished)', 'the log header reads it from what the window has');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`security-block: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
