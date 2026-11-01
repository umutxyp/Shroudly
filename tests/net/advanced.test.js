'use strict';

/* The command shown when Advanced mode's library is missing on Linux must be
 * the right one for the distribution: the package name and the installer
 * differ per family. (CI installs exactly these packages on each.)
 * And an antivirus in the way (security-block.js): the engine's WinDivert
 * errors with Windows' code, the launcher's exits, an elevated engine ended
 * from outside while it starts (told in about a second, not after two
 * minutes) and while it runs, and Advanced mode's files gone from an
 * installed Shroudly. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ROOT, suite } = require('./helpers');

const { buildArgs, buildAdvancedArgs, winQuoteArg, launcherArgs } = require(path.join(ROOT, 'electron', 'advanced-mode.js'));
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

// tlsrec (#48): opt-in, off by default (Advanced mode's broadened capture would
// otherwise double-process the engine's own proxy connections — a 2.6.29 regression).
t.ok(!def.includes('--tlsrec'), 'default: no --tlsrec (opt-in)');
t.ok(buildArgs({ ...ubase, platform: 'win32', opts: { tlsrec: true } }).includes('--tlsrec'), 'opts.tlsrec:true -> --tlsrec 1');
t.ok(!buildArgs({ ...ubase, platform: 'linux', opts: { tlsrec: false } }).includes('--tlsrec'), 'opts.tlsrec:false -> no flag');

// #56: the engine unloads the WinDivert driver at stop, unless another program
// that uses it runs (rivals.js) -> --keep-driver 1. Windows only.
t.ok(!def.includes('--keep-driver'), 'default: no --keep-driver (the driver is unloaded at stop)');
t.ok(argval(buildArgs({ ...ubase, platform: 'win32', opts: { keepDriver: true } }), '--keep-driver') === '1', 'a rival tool running: --keep-driver 1');
t.ok(!buildArgs({ ...ubase, platform: 'linux', opts: { keepDriver: true } }).includes('--keep-driver'), 'Linux has no WinDivert: no --keep-driver');

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

  // ── An antivirus in the way ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-adv-av-'));
  const statusOf = (am, lines) => { fs.writeFileSync(am.statusFile, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')); };
  const fresh = (name) => {
    const am = new AdvancedMode(() => {});
    am.statusFile = path.join(tmp, `${name}.log`);
    am.readyTimeoutMs = 120000;
    am._badFile = () => null;
    return am;
  };
  const failOf = async (am) => { const t0 = Date.now(); const e = await am._waitReady().then(() => null, (x) => x); return { e, ms: Date.now() - t0 }; };

  // The engine's own error lines (core/src/raw_windows.c), then "stopped".
  {
    const am = fresh('driver');
    statusOf(am, [{ type: 'error', code: 'windivert_open', win32: 1275, msg: 'WinDivertOpen failed (1275)' }, { type: 'stopped' }]);
    const { e } = await failOf(am);
    t.ok(e && e.code === 'security_blocked' && e.info && e.info.kind === 'driver' && e.info.win32 === 1275 && e.info.part === 'advanced',
      `the driver refused (WinDivertOpen 1275): security_blocked, the driver, with Windows' code (${e && e.code})`);
    t.ok(/WinDivertOpen: error 1275/.test(e.info.detail) && e.info.file === 'WinDivert64.sys', '…and what was refused, for the log');
  }
  {
    const am = fresh('dll');
    statusOf(am, [{ type: 'error', code: 'windivert_load', win32: 126, msg: 'Loading WinDivert.dll failed (126)' }, { type: 'stopped' }]);
    const { e } = await failOf(am);
    t.ok(e && e.code === 'files_missing' && e.info.file === 'WinDivert.dll', 'WinDivert.dll not there (126): files_missing, naming it');
  }
  {
    const am = fresh('rival');
    statusOf(am, [{ type: 'error', code: 'windivert_open', win32: 654, msg: 'WinDivertOpen failed (654)' }, { type: 'stopped' }]);
    const { e } = await failOf(am);
    t.ok(e && e.code === 'start_failed' && /different version of the WinDivert driver/.test(e.message), 'another WinDivert loaded (654): start_failed, saying so');
  }
  {
    const am = fresh('old');
    // An engine from before these lines: its plain words, as before.
    statusOf(am, ['WinDivertOpen failed (5). Run as Administrator.', { type: 'stopped' }]);
    const { e } = await failOf(am);
    t.ok(e && e.code === 'start_failed' && /Run as Administrator/.test(e.message), 'an older engine\'s plain line: start_failed with its words');
  }

  // Windows: the elevated engine's process gone before it was ready, without
  // a word: in about a second, not after two minutes.
  {
    const am = fresh('killed');
    statusOf(am, []);
    am.pid = 424242;
    let alive = true;
    am.alive = () => alive;
    setTimeout(() => { alive = false; }, 300);
    const { e, ms } = await failOf(am);
    t.ok(e && e.code === 'security_blocked' && e.info.kind === 'killed' && e.info.certain === false && ms < 2000,
      `ended from outside while it started: security_blocked, as "may", within ${ms} ms`);
  }
  {
    const am = fresh('killed-files');
    statusOf(am, []);
    am.pid = 424242;
    am.alive = () => false;
    am._badFile = () => ({ file: path.join(tmp, 'WinDivert64.sys'), state: 'missing' });
    const { e } = await failOf(am);
    t.ok(e && e.code === 'security_blocked' && e.info.kind === 'missing' && e.info.certain === true && e.info.file === 'WinDivert64.sys',
      'ended, and a file of it gone too: certain, naming the file');
  }
  {
    const am = fresh('ready-then-gone');
    am.pid = 424242;
    am.alive = () => false;
    statusOf(am, [{ type: 'raw_ready', ttl: 4 }]);
    const got = await am._waitReady();
    t.ok(got && got.ttl === 4, 'its "ready" written as it went: taken (what follows is the monitor\'s)');
    statusOf(am, [{ type: 'error', code: 'windivert_open', win32: 5, msg: 'x' }]);
    const { e } = await failOf(am);
    t.ok(e && e.code === 'security_blocked' && e.info.kind === 'driver', 'gone after writing why: what it wrote counts');
  }
  {
    const am = fresh('alive');
    am.readyTimeoutMs = 700;
    statusOf(am, []);
    am.pid = 424242;
    am.alive = () => true;
    const { e } = await failOf(am);
    t.ok(e && e.code === 'timeout', 'still there (or elevated and out of reach: EPERM), no answer: the time limit as before');
  }

  // While it runs: ended from outside is noticed, Advanced mode is off again,
  // and a block is told only when its files went too.
  {
    const lines = [];
    const am = new AdvancedMode((l, m) => lines.push(`${l}: ${m}`));
    am.dir = fs.mkdtempSync(path.join(tmp, 'run-'));
    am.statusFile = path.join(am.dir, 'status.log');
    fs.writeFileSync(am.statusFile, `${JSON.stringify({ type: 'raw_ready', ttl: 4 })}\n`);
    am.active = true;
    am.pid = 424242;
    am.aliveCheckMs = 0;
    let alive = true;
    let looks = 0;
    am.alive = () => { looks++; return alive; };
    const exits = [];
    const blocks = [];
    am.onExit = () => exits.push(1);
    am.onSecurityBlock = (info) => blocks.push(info);
    am._badFile = () => ({ file: path.join(tmp, 'shroudly-core-adv.exe'), state: 'missing' });
    am._startMonitor();
    await new Promise((r) => setTimeout(r, 1300));
    t.ok(am.active && !exits.length, 'while it is there, it stays on');
    alive = false;
    await new Promise((r) => setTimeout(r, 1300));
    clearInterval(am.monitor);
    t.ok(!am.active && exits.length === 1 && lines.includes('warning: Advanced backend was ended from outside (no stop was asked)'),
      'ended from outside while it ran: off, the window told, the log says so');
    t.ok(blocks.length === 1 && blocks[0].kind === 'vanished' && blocks[0].part === 'advanced' && blocks[0].file === 'shroudly-core-adv.exe',
      '…its file gone with it: told as the antivirus');
    // Unless set otherwise (here for speed), looked at every few seconds, not every one.
    const quietAm = new AdvancedMode(() => {});
    quietAm.dir = fs.mkdtempSync(path.join(tmp, 'run-'));
    quietAm.statusFile = path.join(quietAm.dir, 'status.log');
    fs.writeFileSync(quietAm.statusFile, '');
    quietAm.active = true;
    quietAm.pid = 424242;
    let quietLooks = 0;
    quietAm.alive = () => { quietLooks++; return true; };
    quietAm._startMonitor();
    await new Promise((r) => setTimeout(r, 3200));
    clearInterval(quietAm.monitor);
    t.ok(quietLooks === 0 && looks >= 2, `while it runs, its process is looked at every ${quietAm.aliveCheckMs / 1000} s, not every second (${quietLooks} in 3 s)`);
  }

  // An installed Shroudly: Advanced mode's files gone is files_missing (never
  // "this build does not include it"), and a start says so with the details.
  {
    const am = new AdvancedMode(() => {});
    am.platform = 'linux';
    am.packaged = true;
    const f = path.join(tmp, 'shroudly-core-adv');
    am._files = () => [f];
    t.ok(am.reasonCode() === 'files_missing' && !am.available(), 'installed, its file gone: files_missing, not available');
    fs.writeFileSync(f, 'a program');
    t.ok(am.reasonCode() === null && am.available(), 'there again: available');
    fs.writeFileSync(f, '');
    const e = await am._start(4, {}).then(() => null, (x) => x);
    t.ok(e && e.code === 'files_missing' && e.info && e.info.kind === 'empty' && e.info.part === 'advanced', 'a start with it emptied: files_missing, with what was found');
    const dev = new AdvancedMode(() => {});
    dev.platform = 'linux';
    dev.packaged = false;
    t.ok(['not_built', null].includes(dev.reasonCode()), 'a developer\'s run: "not built" as before');
  }

  // The launcher (Windows PowerShell, encoded so a user folder like C:\Users\Ümit
  // survives): the elevated engine's process id, and an exit per answer.
  {
    const a = launcherArgs('C:\\Users\\Ümit\\AppData\\Local\\Programs\\Shroudly\\shroudly-core-adv.exe', ['--status-file', 'C:\\Users\\Ümit\\x y\\status.log']);
    const script = Buffer.from(a[a.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    t.ok(a.includes('-EncodedCommand') && !a.includes('-Command') && script.includes('Ümit'), 'the script stays encoded, the folder intact');
    t.ok(/-Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop/.test(script) && /try \{ if \(\$p\) \{ \[Console\]::Out\.WriteLine\(\$p\.Id\) \} \} catch \{\}/.test(script),
      'the process id is written out, on its own (one that cannot be read never fails a start)');
    t.ok(/-eq 1223\) \{ exit 2 \}/.test(script) && /\$c -eq 5 -or \$c -eq 225 -or \$c -eq 226\) \{ exit 3 \}/.test(script) && /\$c -eq 2 -or \$c -eq 3\) \{ exit 4 \}/.test(script),
      'declined: 2; refused (5, 225, 226): 3; not there (2, 3): 4');
    const am = new AdvancedMode(() => {});
    am._badFile = () => null;
    am._launched({ code: 0, stdout: '\r\n4321\r\n', stderr: '' });
    t.ok(am.pid === 4321, 'its process id kept');
    am._launched({ code: 0, stdout: '', stderr: '' });
    t.ok(am.pid === null, 'none written: no check, the time limit as before');
    const as = (r) => { try { am._launched(r); return null; } catch (e) { return e; } };
    t.ok(as({ code: 2, stdout: '', stderr: '' }).code === 'declined', 'exit 2: declined');
    const e3 = as({ code: 3, stdout: '', stderr: '' });
    t.ok(e3.code === 'security_blocked' && e3.info.kind === 'denied', 'exit 3: security_blocked (refused)');
    t.ok(as({ code: 4, stdout: '', stderr: '' }).code === 'files_missing', 'exit 4: files_missing');
    t.ok(as({ code: 1, stdout: '', stderr: 'Something else' }).code === 'start_failed', 'anything else: start_failed');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`advanced: ${t.count} passed`);
})();
