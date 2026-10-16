'use strict';

/* The command shown when Advanced mode's library is missing on Linux must be
 * the right one for the distribution: the package name and the installer
 * differ per family. (CI installs exactly these packages on each.) */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const { linuxInstallCommand, buildArgs, buildAdvancedArgs } = require(path.join(ROOT, 'electron', 'advanced-mode.js'));
const t = suite('advanced');

/* The new packet-layer flags must reach the privileged engine as argv, with the
 * sensible defaults on and overrides honoured. (main.c parses exactly these.) */
function argval(a, flag) { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; }

const base = { fakeTtl: 4, statusFile: '/tmp/s.log', parentPid: 123, queueNum: 200 };

// Defaults (Linux): drop-rst, autottl and the split on, plain fake decoy, seqovl off.
const dLinux = buildAdvancedArgs({ ...base, platform: 'linux' });
t.ok(argval(dLinux, '--drop-rst') === '1', `default drop-rst on -> ${argval(dLinux, '--drop-rst')}`);
t.ok(argval(dLinux, '--autottl') === '1', `default autottl on -> ${argval(dLinux, '--autottl')}`);
t.ok(argval(dLinux, '--seqovl') === '0', `default seqovl off -> ${argval(dLinux, '--seqovl')}`);
t.ok(argval(dLinux, '--split') === '1', `default split on -> ${argval(dLinux, '--split')}`);
t.ok(argval(dLinux, '--desync-mode') === 'fake', `default mode fake -> ${argval(dLinux, '--desync-mode')}`);
t.ok(argval(dLinux, '--fake-ttl') === '4', 'fake-ttl passed');
t.ok(dLinux.includes('--queue') && argval(dLinux, '--queue') === '200', 'linux passes the queue number');

// Windows: no --queue.
const dWin = buildAdvancedArgs({ ...base, platform: 'win32' });
t.ok(!dWin.includes('--queue'), 'windows omits the queue number');
t.ok(argval(dWin, '--drop-rst') === '1' && argval(dWin, '--autottl') === '1' && argval(dWin, '--split') === '1', 'windows carries the protections too');

// Overrides: everything switchable.
const ov = buildAdvancedArgs({ ...base, platform: 'linux',
  opts: { dropRst: false, autottl: false, seqovl: 681, split: false, desyncMode: 'fakeddisorder' } });
t.ok(argval(ov, '--split') === '0', 'split can be switched off');
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

/* The flags the elevated engine is started with. QUIC forced to TCP and
 * Discord-voice decoys are on by default (no opt-out flag passed); turning one
 * off adds exactly its --no- flag, and an old engine that ignores them still
 * runs with both on. */
const ubase = { ttl: 4, statusFile: '/tmp/s.log', parentPid: 123 };

// defaults: no opt-out flags, so both features are on in the engine
const def = buildArgs({ ...ubase, platform: 'win32' });
t.ok(def.includes('--advanced'), 'default: --advanced present');
t.ok(def.join(' ').includes('--fake-ttl 4'), 'default: fake TTL passed');
t.ok(!def.includes('--no-quic-block'), 'default: QUIC block stays on (no opt-out flag)');
t.ok(!def.includes('--no-udp-fake'), 'default: UDP decoys stay on (no opt-out flag)');
t.ok(!def.includes('--queue'), 'win32: no NFQUEUE flag');

// Linux adds the queue number
const lin = buildArgs({ ...ubase, platform: 'linux' });
t.ok(lin.includes('--queue'), 'linux: --queue present');

// turning QUIC off adds only its flag
const noQuic = buildArgs({ ...ubase, platform: 'linux', quicBlock: false });
t.ok(noQuic.includes('--no-quic-block'), 'quicBlock:false -> --no-quic-block');
t.ok(!noQuic.includes('--no-udp-fake'), 'quicBlock:false leaves UDP decoys on');

// turning Discord decoys off adds only its flag
const noUdp = buildArgs({ ...ubase, platform: 'linux', udpFake: false });
t.ok(noUdp.includes('--no-udp-fake'), 'udpFake:false -> --no-udp-fake');
t.ok(!noUdp.includes('--no-quic-block'), 'udpFake:false leaves QUIC block on');

// both off
const both = buildArgs({ ...ubase, platform: 'win32', quicBlock: false, udpFake: false });
t.ok(both.includes('--no-quic-block') && both.includes('--no-udp-fake'), 'both off -> both flags');

// fake-repeats passed through when set, floored, ignored when not positive
const rep = buildArgs({ ...ubase, platform: 'win32', fakeRepeats: 8 });
t.ok(rep.join(' ').includes('--fake-repeats 8'), 'fakeRepeats:8 -> --fake-repeats 8');
t.ok(!buildArgs({ ...ubase, platform: 'win32' }).includes('--fake-repeats'), 'no fakeRepeats -> no flag');
t.ok(!buildArgs({ ...ubase, platform: 'win32', fakeRepeats: 0 }).includes('--fake-repeats'), 'fakeRepeats:0 -> no flag');

console.log(`advanced: ${t.count} passed`);
