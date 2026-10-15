'use strict';

/* The command shown when Advanced mode's library is missing on Linux must be
 * the right one for the distribution: the package name and the installer
 * differ per family. (CI installs exactly these packages on each.) */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const { linuxInstallCommand, buildAdvancedArgs } = require(path.join(ROOT, 'electron', 'advanced-mode.js'));
const t = suite('advanced');

/* The new packet-layer flags must reach the privileged engine as argv, with the
 * sensible defaults on and overrides honoured. (main.c parses exactly these.) */
function argval(a, flag) { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; }

const base = { fakeTtl: 4, statusFile: '/tmp/s.log', parentPid: 123, queueNum: 200 };

// Defaults (Linux): drop-rst and autottl on, plain fake decoy, seqovl off.
const dLinux = buildAdvancedArgs({ ...base, platform: 'linux' });
t.ok(argval(dLinux, '--drop-rst') === '1', `default drop-rst on -> ${argval(dLinux, '--drop-rst')}`);
t.ok(argval(dLinux, '--autottl') === '1', `default autottl on -> ${argval(dLinux, '--autottl')}`);
t.ok(argval(dLinux, '--seqovl') === '0', `default seqovl off -> ${argval(dLinux, '--seqovl')}`);
t.ok(argval(dLinux, '--desync-mode') === 'fake', `default mode fake -> ${argval(dLinux, '--desync-mode')}`);
t.ok(argval(dLinux, '--fake-ttl') === '4', 'fake-ttl passed');
t.ok(dLinux.includes('--queue') && argval(dLinux, '--queue') === '200', 'linux passes the queue number');

// Windows: no --queue.
const dWin = buildAdvancedArgs({ ...base, platform: 'win32' });
t.ok(!dWin.includes('--queue'), 'windows omits the queue number');
t.ok(argval(dWin, '--drop-rst') === '1' && argval(dWin, '--autottl') === '1', 'windows carries the protections too');

// Overrides: everything switchable.
const ov = buildAdvancedArgs({ ...base, platform: 'linux',
  opts: { dropRst: false, autottl: false, seqovl: 681, desyncMode: 'fakeddisorder' } });
t.ok(argval(ov, '--drop-rst') === '0', 'drop-rst can be switched off');
t.ok(argval(ov, '--autottl') === '0', 'autottl can be switched off');
t.ok(argval(ov, '--seqovl') === '681', `seqovl configurable -> ${argval(ov, '--seqovl')}`);
t.ok(argval(ov, '--desync-mode') === 'fakeddisorder', `desync mode selectable -> ${argval(ov, '--desync-mode')}`);

// Bad values fall back to safe ones (no crash, no garbage reaching the engine).
const bad = buildAdvancedArgs({ ...base, platform: 'linux', opts: { seqovl: -5, desyncMode: 'nonsense' } });
t.ok(argval(bad, '--seqovl') === '0', 'negative seqovl clamps to 0');
t.ok(argval(bad, '--desync-mode') === 'fake', 'unknown desync mode falls back to fake');

const CASES = [
  ['ID=arch', 'sudo pacman -S libnetfilter_queue'],
  ['ID=manjaro\nID_LIKE=arch', 'sudo pacman -S libnetfilter_queue'],
  ['ID=endeavouros\nID_LIKE=arch', 'sudo pacman -S libnetfilter_queue'],
  ['ID=fedora', 'sudo dnf install libnetfilter_queue'],
  ['ID="rocky"\nID_LIKE="rhel centos fedora"', 'sudo dnf install libnetfilter_queue'],
  ['ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"', 'sudo zypper install libnetfilter_queue1'],
  ['ID="opensuse-leap"\nID_LIKE="suse opensuse"', 'sudo zypper install libnetfilter_queue1'],
  ['ID=ubuntu\nID_LIKE=debian', 'sudo apt install libnetfilter-queue1'],
  ['ID=debian', 'sudo apt install libnetfilter-queue1'],
  ['ID=linuxmint\nID_LIKE="ubuntu debian"', 'sudo apt install libnetfilter-queue1'],
  ['', 'sudo apt install libnetfilter-queue1'],
];
for (const [osr, want] of CASES) {
  const got = linuxInstallCommand(osr);
  t.ok(got === want, `${JSON.stringify(osr).slice(0, 44)} -> ${got}`);
}
console.log(`advanced: ${t.count} passed`);
