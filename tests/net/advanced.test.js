'use strict';

/* The command shown when Advanced mode's library is missing on Linux must be
 * the right one for the distribution: the package name and the installer
 * differ per family. (CI installs exactly these packages on each.) */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const { buildArgs, buildAdvancedArgs, winQuoteArg } = require(path.join(ROOT, 'electron', 'advanced-mode.js'));
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
t.ok(argval(dLinux, '--split') === 'on', `default: the real first segment is cut -> ${argval(dLinux, '--split')}`);
t.ok(argval(buildAdvancedArgs({ ...base, platform: 'win32' }), '--split') === 'on', 'windows cuts it too');
t.ok(argval(buildAdvancedArgs({ ...base, platform: 'linux', opts: { split: 'disorder' } }), '--split') === 'disorder', 'split: disorder passed');
t.ok(argval(buildAdvancedArgs({ ...base, platform: 'linux', opts: { split: 'off' } }), '--split') === 'off', 'split can be switched off');
t.ok(argval(buildAdvancedArgs({ ...base, platform: 'linux', opts: { split: false } }), '--split') === 'off', 'split: false is off');
t.ok(argval(buildAdvancedArgs({ ...base, platform: 'linux', opts: { split: 'bogus' } }), '--split') === 'on', 'an unknown split mode falls back to on');
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

// Other programs' DNS from the forwarder (core/src/dnsgate.h): only with a
// forwarder port to give, and only a port.
t.ok(!def.includes('--dns-gate'), 'no forwarder: no DNS gate');
const gate = buildArgs({ ...ubase, platform: 'win32', dnsGate: 53123 });
t.ok(gate[gate.indexOf('--dns-gate') + 1] === '53123', 'the forwarder port -> --dns-gate <port>');
t.ok(['0', 'x', '70000', -1].every((p) => !buildArgs({ ...ubase, platform: 'linux', dnsGate: p }).includes('--dns-gate')), 'no port, or not a port: no DNS gate');

// fake-repeats passed through when set, floored, ignored when not positive
const rep = buildArgs({ ...ubase, platform: 'win32', fakeRepeats: 8 });
t.ok(rep.join(' ').includes('--fake-repeats 8'), 'fakeRepeats:8 -> --fake-repeats 8');
t.ok(!buildArgs({ ...ubase, platform: 'win32' }).includes('--fake-repeats'), 'no fakeRepeats -> no flag');
t.ok(!buildArgs({ ...ubase, platform: 'win32', fakeRepeats: 0 }).includes('--fake-repeats'), 'fakeRepeats:0 -> no flag');

// The elevated engine's arguments on Windows, read back the way Windows reads
// a command line (CommandLineToArgvW's rules): exactly what was given, spaces,
// quotes and backslashes included.
function windowsArgv(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '', quoted = false;
    while (i < line.length && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
      if (line[i] === '\\') {
        let n = 0;
        while (line[i] === '\\') { n++; i++; }
        if (line[i] === '"') { arg += '\\'.repeat(n >> 1); if (n & 1) { arg += '"'; i++; } }
        else arg += '\\'.repeat(n);
      } else if (line[i] === '"') { quoted = !quoted; i++; }
      else arg += line[i++];
    }
    out.push(arg);
  }
  return out;
}
{
  const tricky = ['--status-file', 'C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\shroudly-adv-x\\status.log',
    'C:\\dir with space\\', 'say "hi"', 'a\\"b', 'back\\\\"slash', '', 'plain', 'tab\there', '\\\\server\\share\\'];
  const back = windowsArgv(tricky.map(winQuoteArg).join(' '));
  t.ok(JSON.stringify(back) === JSON.stringify(tricky), `elevated engine arguments survive Windows' own parsing (${tricky.length} awkward ones)`);
  t.ok(winQuoteArg('plain') === 'plain' && winQuoteArg('') === '""', 'plain arguments are left alone, an empty one is kept');
}
(async () => {
  // The permission prompt on screen when the computer goes to sleep: the
  // answer after the wake is no timeout. The limit counts awake time only.
  const AdvancedMode = require(path.join(ROOT, 'electron', 'advanced-mode.js'));
  const am = new AdvancedMode(() => {});
  am.readyTimeoutMs = 3000;
  let ready = null;
  am._readStatus = () => (ready ? { ready, errors: [] } : { errors: [] });
  am.childExit = null;
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  const p = am._waitReady().then((r) => r, (e) => e);
  await new Promise((r) => setTimeout(r, 300));
  skew += 30 * 60 * 1000;            // half an hour asleep with the prompt up
  await new Promise((r) => setTimeout(r, 300));
  ready = { pid: 1 };
  const got = await p;
  t.ok(got && got.pid === 1, `asleep for half an hour while the prompt waited: the answer after the wake is taken (${got && got.code ? got.code : 'ready'})`);
  ready = null;
  const am2 = new AdvancedMode(() => {});
  am2.readyTimeoutMs = 600;
  am2._readStatus = () => ({ errors: [] });
  am2.childExit = null;
  const e2 = await am2._waitReady().then(() => null, (e) => e);
  Date.now = realNow;
  t.ok(e2 && e2.code === 'timeout', 'awake and no answer within the limit: still a timeout');
  console.log(`advanced: ${t.count} passed`);
})();
