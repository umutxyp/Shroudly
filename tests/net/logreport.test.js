'use strict';

/* "Copy logs" (electron/log-report.js): what goes to the clipboard is the
 * log as the background process wrote it (English, with times and levels),
 * whatever language the window shows it in, under a short header that says
 * what a report needs: the version, the system, protection, the route mode,
 * Advanced mode, the modes, and the network as the log last described it. */

const path = require('path');
const { ROOT, suite } = require('./helpers');
const { buildReport, toClipboard } = require(path.join(ROOT, 'electron', 'log-report.js'));
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
console.log(`logreport: ${t.count} passed`);
