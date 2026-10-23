'use strict';

/* The log for a report (electron/log-report.js): as the background process
 * wrote it (English, with times and levels), whatever language the window
 * shows it in, under a short header that says what a report needs: the
 * version, the system, protection, the route mode, Advanced mode, the modes,
 * and the network as the log last described it. "Save logs" writes all of
 * it to a file; "Copy logs" puts a short version on the clipboard that a
 * chat app takes as one message. */

const path = require('path');
const { ROOT, suite } = require('./helpers');
const fs = require('fs');
const os = require('os');
const { buildReport, buildCompact, saveReport, fileName, toClipboard, COPY_MAX_CHARS } = require(path.join(ROOT, 'electron', 'log-report.js'));
const t = suite('logreport');

const logs = [
  { timestamp: '2026-10-21T10:10:03.000Z', level: 'info', message: 'Starting engine: shroudly-core --listen 127.0.0.1 --port 10811 --watch discord.media' },
  { timestamp: '2026-10-21T10:10:04.000Z', level: 'info', message: 'System: Windows 11 (x64) — network Wi-Fi (wifi), DNS 192.168.1.1' },
  { timestamp: '2026-10-21T10:10:18.000Z', level: 'warning', message: 'rr4---sn-abc.googlevideo.com: could not be reached (DNS)' },
  { timestamp: '2026-10-21T11:31:49.000Z', level: 'error', message: 'Engine exited unexpectedly (code null).' },
  { timestamp: '2026-10-21T11:31:52.000Z', level: 'success', message: 'line one\nline two' },
];
const s = {
  version: '2.6.3', os: 'Windows 10.0.26100', arch: 'x64', protection: 'on', routeMode: 'all',
  advanced: { on: false, available: true }, discordMode: true, appsMode: false, storeApps: false, now: Date.parse('2026-10-21T12:00:00Z'),
};
const r = buildReport(s, logs);
const [head, body] = r.split(`\n${'-'.repeat(40)}\n`);
t.ok(head.startsWith('Shroudly 2.6.3 log, copied 2026-10-21T12:00:00.000Z\nSystem: Windows 10.0.26100 (x64)\n'), 'the header names the version, when it was copied, the system and its architecture');
t.ok(head.includes('Protection: on; route: every site') && head.includes('Advanced mode: off') && head.includes('Modes: Discord app mode on, Games and apps mode off, Microsoft Store apps off'),
  'protection, the route mode, Advanced mode and every mode on or off');
t.ok(head.includes('Network: Wi-Fi (wifi), DNS 192.168.1.1') && head.includes('Lines: 5'), 'the network as the log last described it, and how many lines follow');
const lines = body.trim().split('\n');
t.ok(lines.length === 5 && lines[0] === '2026-10-21T10:10:03.000Z INFO Starting engine: shroudly-core --listen 127.0.0.1 --port 10811 --watch discord.media'
  && lines[3] === '2026-10-21T11:31:49.000Z ERROR Engine exited unexpectedly (code null).' && lines[2].includes(' WARN '),
'every log line as written: its time, its level, its English text');
t.ok(lines[4].endsWith('OK line one line two'), 'one line per entry, whatever is in it');
const mac = buildReport({ ...s, os: 'macOS 15.1', arch: 'arm64', storeApps: null, routeMode: 'listed', advanced: { on: true, available: true }, protection: 'off' }, []);
t.ok(mac.includes('Modes: Discord app mode on, Games and apps mode off\n') && mac.includes('route: listed sites only') && mac.includes('Advanced mode: on')
  && mac.includes('Network: not logged yet') && mac.includes('Lines: 0'), 'macOS and Linux: no Store apps line; listed sites; an empty log');
t.ok(!/https?:\/\//.test(r.replace(/--watch discord\.media/, '')) && !r.includes('siteList'), 'nothing beyond what the log already says (no site list, no history)');
// The clipboard read back: a desktop that takes nothing from a program
// without a focused window (Wayland, from the tray) is not reported as done.
{
  let held = '';
  const works = { writeText: (x) => { held = x; }, readText: () => held };
  const wayland = { writeText: () => {}, readText: () => 'what was there before' };
  const broken = { writeText: () => { throw new Error('no clipboard'); }, readText: () => '' };
  t.ok(toClipboard(r, works) === true && held === r, 'on the clipboard, read back the same: done');
  t.ok(toClipboard(r, wayland) === false, 'a clipboard that kept what it had (Wayland, no focused window): not done, so the window opens on the Logs panel instead');
  t.ok(toClipboard(r, broken) === false, 'no clipboard at all: not done');
}

// ── Copy logs: the short version ──
{
  const c = buildCompact({ ...s, utcOffsetMin: 180 }, logs);
  const [ch, cb] = c.split(`\n${'-'.repeat(40)}\n`);
  t.ok(ch.startsWith('Shroudly 2.6.3 log, copied 2026-10-21T12:00:00.000Z\nSystem: Windows 10.0.26100 (x64)\n') && ch.includes('Modes: Discord app mode on')
    && ch.includes('Network: Wi-Fi (wifi), DNS 192.168.1.1') && ch.includes('Lines: 5') && ch.endsWith('Times: UTC+03:00'),
  'the short version keeps the whole header, and says what the times are');
  const cl = cb.trim().split('\n');
  t.ok(cl[0] === '[2026-10-21]' && cl[1] === '13:10:03 Starting engine: shroudly-core' && cl[3] === '13:10:18 WARN rr4---sn-abc.googlevideo.com: could not be reached (DNS)'
    && cl[4] === '14:31:49 ERROR Engine exited unexpectedly (code null).' && cl[5] === '14:31:52 OK line one line two',
  `the day once, then the time of day only, a level only where it is not plain information, no engine command arguments (${cl.slice(0, 3).join(' | ')})`);
  // The 2.6.3 report: the same takeover again and again, Discord's line
  // put back, a busy log of 500 lines.
  const big = [];
  let at = Date.parse('2026-10-21T19:06:49Z');
  const take = 'Autopilot: another program changed the system proxy (AutoConfigURL) to no proxy (removed); set it back to Shroudly';
  for (let i = 0; i < 500; i++) {
    at += 1500;
    const m = i % 5 === 0 ? take : i % 5 === 1 ? `cdn${i}.example.com: could not be reached (DNS)` : 'Discord app mode: Discord added';
    big.push({ timestamp: new Date(at).toISOString(), level: i % 5 === 1 ? 'warning' : 'info', message: m });
  }
  big.push({ timestamp: new Date(at + 1000).toISOString(), level: 'info', message: 'Starting engine: shroudly-core --listen 127.0.0.1 --port 10811 '.repeat(20) });
  const full = buildReport(s, big);
  const short = buildCompact({ ...s, utcOffsetMin: 180 }, big);
  t.ok(full.length > 30000 && short.length <= COPY_MAX_CHARS && COPY_MAX_CHARS <= 4096,
    `500 lines: ${full.length} characters in full, ${short.length} copied, within one chat message (Telegram: 4096)`);
  const sl = short.split('\n');
  t.ok(sl.some((l) => /^\.\.\. \d+ earlier lines left out; Save logs keeps the whole log in a file$/.test(l)) && /Lines: 501 \(the newest \d+ here\)/.test(short)
    && sl[sl.length - 2] === '22:19:20 Starting engine: shroudly-core', 'what does not fit is the oldest, and the copy says so and where the whole log is');
  t.ok(sl.some((l) => / Discord app mode: Discord added \(x3, last \d\d:\d\d:\d\d\)$/.test(l)), 'a line said again and again in a row: once, with how many times and the last time');
  const takes = sl.filter((l) => l.includes('another program changed the system'));
  t.ok(takes.length > 3 && takes.filter((l) => l.endsWith(take)).length === 1 && takes.slice(1).every((l) => /again: Autopilot: another program changed the sys/.test(l) && l.length < 80),
    'a long line said earlier: whole once, then only its start, with its time');
  t.ok(buildCompact(s, []).includes('Lines: 0') && !buildCompact(s, []).includes('left out'), 'an empty log: the header alone');
  t.ok(!buildCompact(s, logs).includes('--port') && buildReport(s, logs).includes('--port 10811'), "Save logs keeps the engine's command line; Copy logs does not");
}

// ── Save logs: a file in Downloads, else the next folder that takes it ──
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-logs-'));
  const dl = path.join(tmp, 'Downloads');
  const desk = path.join(tmp, 'Desktop');
  fs.mkdirSync(desk);
  const now = new Date(2026, 9, 22, 22, 17, 0).getTime();
  t.ok(fileName(now) === 'Shroudly-log-2026-10-22-221700.txt', 'named after when it was saved, in this computer\'s time');
  const text = buildReport({ ...s, verb: 'saved' }, logs);
  t.ok(text.startsWith('Shroudly 2.6.3 log, saved '), 'the file says it was saved, not copied');
  // No Downloads folder (Linux without XDG folders), one that throws: Desktop.
  const r1 = saveReport(text, [() => { throw new Error('no such path'); }, dl, desk], { now, platform: 'linux' });
  t.ok(r1.ok && r1.file === path.join(desk, 'Shroudly-log-2026-10-22-221700.txt') && fs.readFileSync(r1.file, 'utf8') === text,
    'no Downloads folder: written to the Desktop, all of it');
  fs.mkdirSync(dl);
  const r2 = saveReport(text, [dl, desk], { now, platform: 'win32' });
  const r3 = saveReport('second', [dl, desk], { now, platform: 'win32' });
  t.ok(r2.ok && path.dirname(r2.file) === dl && fs.readFileSync(r2.file, 'utf8') === text.replace(/\n/g, '\r\n'),
    'Downloads first; Windows line ends on Windows');
  t.ok(r3.ok && r3.file === path.join(dl, 'Shroudly-log-2026-10-22-221700-2.txt') && fs.readFileSync(r2.file, 'utf8').startsWith('Shroudly'),
    'a file of the same name is never overwritten');
  t.ok(saveReport(text, [path.join(tmp, 'none')], { now }).ok === false, 'no folder at all: not saved, and said so');
  fs.rmSync(tmp, { recursive: true, force: true });
}
// A message on several lines is one line in the short version, the blank
// ones dropped; a long run of spaces costs no time (no regex that backtracks).
{
  const s0 = { version: '2.6.5', platform: 'win32', release: '10.0.26100', arch: 'x64', now: Date.parse('2026-10-23T12:00:00Z') };
  const c = buildCompact(s0, [{ timestamp: '2026-10-23T11:00:00.000Z', level: 'info', message: 'first  \r\n\n   second\nthird' }]);
  t.ok(c.includes('first second third'), 'several lines: joined by one space, blank ones dropped');
  const spaces = ' '.repeat(200000);
  const t0 = Date.now();
  buildCompact(s0, [{ timestamp: '2026-10-23T11:00:00.000Z', level: 'info', message: `${spaces}x${spaces}` }]);
  t.ok(Date.now() - t0 < 500, `a line of 400 000 spaces: ${Date.now() - t0} ms`);
}
console.log(`logreport: ${t.count} passed`);
