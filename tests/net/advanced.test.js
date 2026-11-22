'use strict';

/* The command shown when Advanced mode's library is missing on Linux must be
 * the right one for the distribution: the package name and the installer
 * differ per family. (CI installs exactly these packages on each.)
 * And an antivirus in the way (security-block.js): the engine's WinDivert
 * errors with Windows' code, the launcher's exits, an elevated engine ended
 * from outside while it starts (told in about a second, not after two
 * minutes) and while it runs, and Advanced mode's files gone from an
 * installed Shroudly. Linux's password window names Shroudly and says why,
 * in the user's language, for the engine the packages install, and an
 * AppImage's copy runs from the user's runtime folder, not /tmp (VML-4). */

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
  // A server cut after its handshake (engine-manager.js, cut_addr): written to
  // status.log.escalate for the running engine, one address a line, once a
  // minute per address, only an internet IPv4 address, nothing when off.
  {
    const ae = new AdvancedMode(() => {});
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-esc-'));
    ae.statusFile = path.join(d, 'status.log');
    const file = `${ae.statusFile}.escalate`;
    const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
    t.ok(ae.escalate('104.244.42.1') === false && read() === '', 'Advanced mode off: nothing written');
    ae.active = true;
    t.ok(ae.escalate('104.244.42.1') === true && read() === '104.244.42.1\n', 'on: the address is written for the engine');
    t.ok(ae.escalate('104.244.42.1') === false && read() === '104.244.42.1\n', 'the same address within a minute: not again');
    t.ok(ae.escalate('162.159.135.232') === true && read() === '104.244.42.1\n162.159.135.232\n', 'another address: appended');
    const bad = ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.1.1', '100.64.0.1', '0.1.2.3', '224.0.0.1',
      '256.1.1.1', '1.2.3', '1.2.3.4\n5.6.7.8', '::1', '', null, 'x.com'];
    t.ok(bad.every((a) => ae.escalate(a) === false) && read() === '104.244.42.1\n162.159.135.232\n',
      'local, private, special or malformed addresses are never written');
    const realNow2 = Date.now; const t0 = realNow2();
    Date.now = () => t0 + 61000;
    t.ok(ae.escalate('104.244.42.1') === true, 'a minute later the same address is told again');
    Date.now = realNow2;
    // Told in the log once per address, naming the site.
    const said = [];
    const al = new AdvancedMode((l, m) => said.push(m));
    al.statusFile = ae.statusFile; al.active = true;
    al.escalate('8.8.4.4', 'x.com'); al._escalated.clear(); al.escalate('8.8.4.4', 'x.com'); al.escalate('9.9.9.9', 'bad name!');
    t.ok(said.filter((m) => m.includes('x.com (8.8.4.4)')).length === 1 && said.some((m) => m.startsWith('Advanced mode: 9.9.9.9 cut')),
      `the log says it once per address, with the site's name when it is one (${said.join(' | ')})`);
    // Its counters for a report: the last raw_stats line, its known numbers only.
    fs.writeFileSync(ae.statusFile, '{"type":"raw_ready","ttl":4}\n{"type":"raw_stats","desynced":1,"strong":0,"cut_asked":0}\nnot json\n{"type":"raw_stats","desynced":9,"escalated":2,"strong":5,"strong_ts":5,"cut_asked":3,"x":"y"}\n');
    const st = ae.stats();
    t.ok(st && st.desynced === 9 && st.strong === 5 && st.strong_ts === 5 && st.cut_asked === 3 && st.escalated === 2 && !('x' in st),
      `the report gets the last counters (${JSON.stringify(st)})`);
    fs.writeFileSync(ae.statusFile, '{"type":"raw_ready"}\n');
    t.ok(ae.stats() === null, 'none yet: nothing');
    ae.statusFile = null;
    t.ok(ae.escalate('1.1.1.1') === false && ae.stats() === null, 'no status file: nothing');
    fs.rmSync(d, { recursive: true, force: true });
  }
  // Standby (pause / start from standby): an engine stand-in that answers the
  // standby file as supervise.c does.
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-standby-'));
    const said = [];
    const am = new AdvancedMode((l, m) => said.push(m));
    am.statusFile = path.join(d, 'status.log');
    fs.writeFileSync(am.statusFile, '{"type":"raw_ready","ttl":4}\n');
    am.active = true; am.standbyWaitMs = 3000;
    let resumeWorks = true, inStandby = false;
    const engine = setInterval(() => {
      const want = fs.existsSync(`${am.statusFile}.standby`);
      if (want && !inStandby) { inStandby = true; fs.appendFileSync(am.statusFile, '{"type":"raw_paused"}\n'); }
      else if (!want && inStandby) { inStandby = false; fs.appendFileSync(am.statusFile, resumeWorks ? '{"type":"raw_resumed","n":1}\n' : '{"type":"raw_resume_failed"}\n'); }
    }, 50);
    t.ok(await am.pause() === true && am.standby && !am.active, 'pause: on standby once the engine says so (active off meanwhile)');
    let started = 0;
    am._start = async () => { started++; am.active = true; return { success: true, prompted: true }; };
    am._requestStop = async () => {};
    const r = await am.start(4, {});
    t.ok(r.success && am.active && !am.standby && started === 0 && said.includes('Advanced mode back on (no new permission prompt)'),
      'start from standby: back, no new start (no permission prompt)');
    t.ok(await am.pause() === true, 'standby again');
    resumeWorks = false;
    const r2 = await am.start(4, {});
    t.ok(r2.success && started === 1 && am.active, 'the engine cannot take the hook again: stopped and started anew (one prompt)');
    // An engine that never answers the standby: stopped for good, not left half-way.
    clearInterval(engine);
    am.active = true; am.standby = false; am.standbyWaitMs = 400;
    let stopped = 0; am.stop = async () => { stopped++; am.active = false; am.standby = false; };
    t.ok(await am.pause() === false && stopped === 1 && !am.standby, 'no answer to the standby: stopped for good');
    am.active = false; am.standby = false;
    t.ok(await am.pause() === false, 'off: nothing to put on standby');
    fs.rmSync(d, { recursive: true, force: true });
  }
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
    am._badFile = () => ({ file: path.join(tmp, 'WinDivert.dll'), state: 'missing' });
    statusOf(am, [{ type: 'error', code: 'windivert_load', win32: 126, msg: 'Loading WinDivert.dll failed (126)' }, { type: 'stopped' }]);
    const { e } = await failOf(am);
    t.ok(e && e.code === 'files_missing' && e.info.file === 'WinDivert.dll', 'WinDivert.dll not there (126): files_missing, naming it');
  }
  {
    // Every file in place, Windows still says "not found" (#69: no antivirus
    // running, the folder an exception): neither a missing file nor an
    // antivirus is claimed, and Windows' own code is said.
    const shown = fresh('there');
    statusOf(shown, [{ type: 'error', code: 'windivert_open', win32: 2, msg: 'WinDivertOpen failed (2)' }, { type: 'stopped' }]);
    const { e } = await failOf(shown);
    t.ok(e && e.code === 'start_failed' && !e.info && /start the WinDivert driver \(error 2\) although Advanced mode's files are all in place/.test(e.message),
      `files in place, WinDivertOpen 2: start_failed, not files_missing (${e && e.code})`);
    const st0 = fresh('stale0');
    statusOf(st0, [{ type: 'driver', stale: 0 }, { type: 'error', code: 'windivert_open', win32: 3, msg: 'WinDivertOpen failed (3)' }, { type: 'stopped' }]);
    const z = await failOf(st0);
    t.ok(z.e && /\(error 3\)[^.]*no WinDivert service left behind was found/.test(z.e.message),
      'error 3 after the engine looked for a service left behind and found none: said in the log');
    const st1 = fresh('stale1');
    statusOf(st1, [{ type: 'driver', stale: 1 }, { type: 'error', code: 'windivert_open', win32: 3, msg: 'WinDivertOpen failed (3)' }, { type: 'stopped' }]);
    const o = await failOf(st1);
    t.ok(o.e && /a WinDivert service left behind was removed/.test(o.e.message), '…and one it removed, too');
    const st2 = fresh('copy0');
    statusOf(st2, [{ type: 'driver', stale: 1, file_gone: 0 }, { type: 'driver', copy: 0 }, { type: 'error', code: 'windivert_open', win32: 3, msg: 'WinDivertOpen failed (3)' }, { type: 'stopped' }]);
    const q = await failOf(st2);
    t.ok(q.e && /could not be copied to Common Files\\Shroudly/.test(q.e.message), '…and a copy it could not make');
    const dll = fresh('there-dll');
    statusOf(dll, [{ type: 'error', code: 'windivert_load', win32: 126, msg: 'Loading WinDivert.dll failed (126)' }, { type: 'stopped' }]);
    const r = await failOf(dll);
    t.ok(r.e && r.e.code === 'start_failed' && /load WinDivert\.dll \(error 126\)/.test(r.e.message), 'files in place, loading WinDivert.dll 126: start_failed, with the code');
  }
  {
    const am = fresh('rival');
    statusOf(am, [{ type: 'error', code: 'windivert_open', win32: 654, msg: 'WinDivertOpen failed (654)' }, { type: 'stopped' }]);
    const { e } = await failOf(am);
    t.ok(e && e.code === 'start_failed' && /different version of the WinDivert driver/.test(e.message), 'another WinDivert loaded (654): start_failed, saying so');
  }
  {
    // The 32-bit Shroudly on a 64-bit Intel/AMD Windows (WOW64): the 64-bit
    // one has Advanced mode, said as that rather than "this processor".
    const wb = AdvancedMode.wrongBuild;
    t.ok(wb({ platform: 'win32', arch: 'ia32', env: { PROCESSOR_ARCHITEW6432: 'AMD64' } }), 'ia32 on 64-bit Intel/AMD Windows: the wrong build');
    t.ok(!wb({ platform: 'win32', arch: 'ia32', env: {} }) && !wb({ platform: 'win32', arch: 'ia32', env: { PROCESSOR_ARCHITEW6432: 'ARM64' } })
      && !wb({ platform: 'win32', arch: 'x64', env: { PROCESSOR_ARCHITEW6432: 'AMD64' } }) && !wb({ platform: 'linux', arch: 'ia32', env: { PROCESSOR_ARCHITEW6432: 'AMD64' } }),
    'a 32-bit Windows, Windows on ARM, the 64-bit build, another system: not that');
  }
  {
    // Windows 7 without Microsoft's SHA-2 update refuses the driver's
    // signature (577): the update is the fix, no antivirus is to blame.
    const am = fresh('sha2');
    am.osRelease = '6.1.7601';
    statusOf(am, [{ type: 'error', code: 'windivert_open', win32: 577, msg: 'WinDivertOpen failed (577)' }, { type: 'stopped' }]);
    const { e } = await failOf(am);
    t.ok(e && e.code === 'needs_sha2' && /KB4474419/.test(e.message) && !e.info, 'Windows 7, 577: needs_sha2, naming the update, not a security block');
    const ten = fresh('sha2-10');
    ten.osRelease = '10.0.19045';
    statusOf(ten, [{ type: 'error', code: 'windivert_open', win32: 577, msg: 'WinDivertOpen failed (577)' }, { type: 'stopped' }]);
    const r = await failOf(ten);
    t.ok(r.e && r.e.code === 'security_blocked', 'Windows 10, 577: a security block, as before');
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

  // Windows: the permission given once (advanced-task.js, core/src/advtask.h).
  // The engine is started by its task, without a prompt, only while the
  // copies an administrator's folder holds are the engine this Shroudly
  // brings; anything else ends in the prompt, which also keeps the
  // permission for the next start.
  {
    const AdvTask = require(path.join(ROOT, 'electron', 'advanced-task.js'));
    t.ok(AdvTask.adminDir({ CommonProgramFiles: 'C:\\Program Files\\Common Files' }) === 'C:\\Program Files\\Common Files\\Shroudly\\advanced'
      && AdvTask.adminDir({ CommonProgramW6432: 'D:\\PF\\Common Files', CommonProgramFiles: 'C:\\x86' }) === 'D:\\PF\\Common Files\\Shroudly\\advanced'
      && AdvTask.adminDir({}) === null && AdvTask.adminDir({ CommonProgramFiles: 'relative\\x' }) === null,
    'the copies: <Common Files>\\Shroudly\\advanced (none where Windows names no such folder)');
    t.ok(AdvTask.userDir({ LOCALAPPDATA: 'C:\\Users\\Ümit\\AppData\\Local' }) === 'C:\\Users\\Ümit\\AppData\\Local\\Shroudly\\advanced' && AdvTask.userDir({}) === null,
      'the request: the user\'s own %LOCALAPPDATA%\\Shroudly\\advanced');
    t.ok(AdvTask.userName(() => 'Ümit Yılmaz') === 'Ümit Yılmaz' && AdvTask.userName(() => '', { USERNAME: 'sleax' }) === 'sleax'
      && AdvTask.userName(() => { throw new Error('x'); }, { USERNAME: 'a' }) === 'a'
      && AdvTask.userName(() => 'a"b') === null && AdvTask.userName(() => 'a\\b') === null && AdvTask.userName(() => '', {}) === null && AdvTask.userName(() => ' x') === null,
    'the user\'s name as Windows has it; one that could not go on a command line: none (the prompt as before)');
    t.ok(AdvTask.taskName('sleax') === 'Shroudly Advanced mode (sleax)', 'the task is named after the user (one each on a shared PC)');

    // A request carries the engine's options and never where it writes.
    const full = buildArgs({ ttl: 4, statusFile: 'C:\\x\\status.log', parentPid: 4242, platform: 'win32', quicBlock: false, udpFake: false, fakeRepeats: 6, dnsGate: 56148,
      decoyNames: ['www.turkiye.gov.tr'], opts: { tlsrec: true, keepDriver: true, split: 'disorder', desyncMode: 'fakedsplit', seqovl: 3 } });
    const req = AdvTask.requestArgs(full);
    t.ok(Array.isArray(req) && !req.includes('--status-file') && !req.some((a) => /status\.log/.test(a)) && req.length === full.length - 2
      && argval(req, '--parent-pid') === '4242' && argval(req, '--decoy-name') === 'www.turkiye.gov.tr' && req.includes('--no-quic-block'),
    'a request: every option of the engine\'s command line, without the status file');
    t.ok(AdvTask.requestArgs([...full, '--queue', '200']) === null && AdvTask.requestArgs(['--auth-file', 'x']) === null && AdvTask.requestArgs(['--fake-ttl']) === null,
      'an option the engine would refuse from a request: no request (the prompt as before)');
    const id = AdvTask.newId();
    t.ok(/^[0-9a-f]{32}$/.test(id) && AdvTask.newId() !== id, 'an id: 32 hex digits, new each time');
    t.ok(AdvTask.requestText(id, ['--advanced', '--fake-ttl', '4']) === `shroudly-advanced 1\nid ${id}\n--advanced\n--fake-ttl\n4\n` && AdvTask.UNINSTALL_TEXT === 'shroudly-advanced 1\nuninstall\n',
      'its text: a head line, the id, one argument a line (and the uninstaller\'s)');
    // What the app may ask is what the engine takes: the two lists agree.
    {
      const c = fs.readFileSync(path.join(ROOT, 'core', 'src', 'advtask.c'), 'utf8');
      const table = c.slice(c.indexOf('} OPTS[] = {'), c.indexOf('};', c.indexOf('} OPTS[] = {')));
      const inC = [...table.matchAll(/\{ "(--[a-z-]+)", '([fnwh])' \}/g)].map((m) => [m[1], m[2]]);
      const flags = inC.filter((o) => o[1] === 'f').map((o) => o[0]);
      const values = inC.filter((o) => o[1] !== 'f').map((o) => o[0]);
      t.ok(inC.length === 15 && flags.every((f) => AdvTask.requestArgs([f]) !== null) && values.every((v) => AdvTask.requestArgs([v, '1']) !== null && AdvTask.requestArgs([v]) === null)
        && req.filter((a) => a.startsWith('--')).every((a) => inC.some((o) => o[0] === a)),
      `the engine's list of what a request may carry is the app's (${inC.length} options), and covers every option the app sends`);
      t.ok(!inC.some((o) => /file|base|task|listen|auth|adblock|upstream|fallback/.test(o[0])), 'nothing in it names a file');
    }

    const work = fs.mkdtempSync(path.join(tmp, 'task-'));
    const bundled = path.join(work, 'bundled');
    const admin = path.join(work, 'admin');
    const userDir = path.join(work, 'user', 'advanced');
    fs.mkdirSync(bundled); fs.mkdirSync(path.join(admin, 'run'), { recursive: true });
    for (const f of AdvTask.FILES) fs.writeFileSync(path.join(bundled, f), `bytes of ${f}`);
    t.ok(AdvTask.current(bundled, admin) === false, 'no copies yet: not current');
    for (const f of AdvTask.FILES) fs.writeFileSync(path.join(admin, f), `bytes of ${f}`);
    t.ok(AdvTask.current(bundled, admin) === true, 'the copies byte for byte this Shroudly\'s engine: current');
    fs.writeFileSync(path.join(admin, 'WinDivert.dll'), 'bytes of another');
    t.ok(AdvTask.current(bundled, admin) === false && AdvTask.current(bundled, null) === false, 'one file different (an update, or tampered with): not current');
    fs.writeFileSync(path.join(admin, 'WinDivert.dll'), 'bytes of WinDivert.dll');
    t.ok(AdvTask.installResult(admin) === null, 'no installer result yet');
    fs.writeFileSync(path.join(admin, 'run', 'install.log'), '{"type":"task_install","ok":0,"why":"register","hr":"0x80070005"}\n');
    t.ok(JSON.stringify(AdvTask.installResult(admin)) === '{"ok":false,"why":"register","hr":"0x80070005"}', 'the installer\'s result read back');
    t.ok(AdvTask.pidLine(path.join(admin, 'run', 'none.log')) === null, 'no status yet: no process id');

    // An engine stand-in: what the task would start. It reads the request as
    // advtask.c does and writes its status where only it can.
    const said = [];
    const tools = [];
    let engine = 'ok';         // 'ok', 'silent', 'notask'
    let stops = 0;
    const mk = () => {
      const am = new AdvancedMode((l, m) => said.push(m));
      am.platform = 'win32';
      am.reasonCode = () => null;
      am.bundledDir = () => bundled;
      am._task = () => ({ admin, userDir, user: 'Ümit', name: AdvTask.taskName('Ümit') });
      am.alive = () => true;
      am.taskWaitMs = 600;
      am.installNoteMs = 50;
      am.runTool = async (cmd, args) => {
        tools.push([cmd, ...args]);
        if (/schtasks/i.test(cmd)) {
          if (engine === 'notask') return { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
          const lines = fs.readFileSync(path.join(userDir, 'request'), 'utf8').split('\n');
          const rid = lines[1].slice(3);
          if (engine === 'ok') {
            const status = path.join(admin, 'run', `${rid}.log`);
            fs.writeFileSync(status, `${JSON.stringify({ type: 'task', pid: 5150 })}\n${JSON.stringify({ type: 'raw_ready', ttl: 4, dns_gate: 0 })}\n`);
            const timer = setInterval(() => {
              if (fs.existsSync(path.join(userDir, `${rid}.stop`))) { stops++; fs.appendFileSync(status, '{"type":"stopped"}\n'); clearInterval(timer); }
            }, 20);
            if (timer.unref) timer.unref();
          }
          return { code: 0, stdout: 'SUCCESS', stderr: '' };
        }
        // The prompt's launcher.
        return { code: 2, stdout: '', stderr: '' };
      };
      return am;
    };

    let am = mk();
    const r = await am._start(4, { dnsGate: 0 });
    const sch = tools.find((x) => /schtasks\.exe$/i.test(x[0]));
    t.ok(r.success && am.active && am.viaTask && am.pid === 5150 && sch && sch[1] === '/Run' && sch[2] === '/TN' && sch[3] === 'Shroudly Advanced mode (Ümit)'
      && !tools.some((x) => /powershell/i.test(x[0])),
    'copies current: started by its task (schtasks /Run), no PowerShell, no prompt; its process id from the engine itself');
    t.ok(said.includes('Advanced mode: starting with the administrator permission given before (no prompt)') && !said.includes('Advanced mode: asking for administrator permission'),
      'and the log says it was the kept permission, not a new ask');
    const reqText = fs.readFileSync(path.join(userDir, 'request'), 'utf8');
    t.ok(/^shroudly-advanced 1\nid [0-9a-f]{32}\n--advanced\n--fake-ttl\n4\n/.test(reqText) && reqText.includes(`\n--parent-pid\n${process.pid}\n`) && !/status/.test(reqText),
      'the request it left: the options and this process, no file named');
    t.ok(path.dirname(am.statusFile) === path.join(admin, 'run') && path.dirname(am.ctl) === userDir && am.dir === userDir,
      'its status is read from the administrator\'s folder; what controls it is written in the user\'s');
    // Standby and back go through the user's folder too.
    {
      const status = am.statusFile;
      const ctl = am.ctl;
      am.standbyWaitMs = 2000;
      const timer = setInterval(() => {
        const want = fs.existsSync(`${ctl}.standby`);
        const text = fs.readFileSync(status, 'utf8');
        const paused = (text.match(/raw_paused/g) || []).length;
        const resumed = (text.match(/raw_resumed/g) || []).length;
        if (want && paused === resumed) fs.appendFileSync(status, '{"type":"raw_paused"}\n');
        if (!want && paused > resumed) fs.appendFileSync(status, '{"type":"raw_resumed","n":1}\n');
      }, 20);
      const paused = await am.pause();
      const back = await am.start(4, {});
      clearInterval(timer);
      t.ok(paused === true && back.success && am.active && !am.standby && !fs.existsSync(`${status}.standby`),
        'standby and back: asked through the user\'s folder, nothing written by the app next to the status');
    }
    await am.stop();
    t.ok(stops === 1 && !am.active && !fs.existsSync(userDir), 'stopped through the user\'s folder (.stop), which is then removed');

    // The task is not there (never allowed, or removed): the prompt, which
    // also keeps the permission (--task-install with the user's name).
    engine = 'notask'; tools.length = 0; said.length = 0;
    am = mk();
    let e = await am._start(4, {}).then(() => null, (x) => x);
    const ps = tools.find((x) => /powershell/i.test(x[0]));
    const script = ps ? Buffer.from(ps[ps.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le') : '';
    t.ok(e && e.code === 'declined' && said.includes('Advanced mode: asking for administrator permission') && /--task-install Ümit'/.test(script),
      'no task: the prompt as before, and the engine started through it is told to keep the permission');
    t.ok(!fs.existsSync(userDir), 'nothing left in the user\'s folder');

    // The task started but its engine never said anything: the prompt, and a
    // stop left for an engine that might still come.
    engine = 'silent'; tools.length = 0; said.length = 0;
    am = mk();
    e = await am._start(4, {}).then(() => null, (x) => x);
    t.ok(e && e.code === 'declined' && tools.some((x) => /powershell/i.test(x[0])) && said.includes('Advanced mode: the permission given before could not be used this time, so it is asked for again')
      && fs.readdirSync(userDir).some((f) => f.endsWith('.stop')),
    'the task ran but no engine answered: the prompt, and a stop waits for an engine that comes late');

    // The copies are not this Shroudly's engine (an update): the task is not even tried.
    engine = 'ok'; tools.length = 0;
    fs.writeFileSync(path.join(bundled, 'shroudly-core-adv.exe'), 'the engine of a newer Shroudly');
    am = mk();
    e = await am._start(4, {}).then(() => null, (x) => x);
    t.ok(e && e.code === 'declined' && !tools.some((x) => /schtasks/i.test(x[0])) && tools.some((x) => /powershell/i.test(x[0])),
      'after an update that changed the engine: the old copy is never started; the prompt once, for the new one');

    // Whether the permission is kept now, said once after a start through the prompt.
    said.length = 0;
    fs.writeFileSync(path.join(admin, 'run', 'install.log'), '{"type":"task_install","ok":1,"why":"ok","hr":"0x00000000"}\n');
    for (const f of AdvTask.FILES) fs.copyFileSync(path.join(bundled, f), path.join(admin, f));
    am = mk();
    am._noteInstall(); am._noteInstall();
    await new Promise((res) => setTimeout(res, 200));
    t.ok(said.filter((m) => /the permission is kept from now on/.test(m)).length === 1, 'kept: said once');
    said.length = 0;
    fs.writeFileSync(path.join(admin, 'run', 'install.log'), '{"type":"task_install","ok":0,"why":"register","hr":"0x80070005"}\n');
    fs.writeFileSync(path.join(admin, 'WinDivert.dll'), 'an older one');
    am = mk();
    am._noteInstall();
    await new Promise((res) => setTimeout(res, 200));
    t.ok(said.length === 1 && /could not be kept for the next start \(register, 0x80070005\)/.test(said[0]), 'not kept: said with the reason');

    // Other systems, and a Windows where no folder is named: only the prompt.
    const lin = new AdvancedMode(() => {});
    lin.platform = 'linux';
    const bare = new AdvancedMode(() => {});
    bare.platform = 'win32'; bare.env = {};
    t.ok(lin._task() === null && bare._task() === null && JSON.stringify(bare._withInstall(['--advanced'])) === '["--advanced"]', 'Linux, or no folders named: nothing of this is used');
  }

  // A prompt nobody answered, and PowerShell's own records, are told as what they are.
  {
    const { plainErr } = require(path.join(ROOT, 'electron', 'advanced-mode.js'));
    t.ok(plainErr('#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj></Objs>') === ''
      && plainErr('#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj') === '' && plainErr('  Access is denied  ') === 'Access is denied',
    'PowerShell\'s CLIXML records are no message ("Advanced mode failed: #< CLIXML"); its words stay');
    const am = new AdvancedMode(() => {});
    let e = null;
    try { am._launched({ code: -1, stdout: '', stderr: 'powershell.exe did not finish in time', timedOut: true }); } catch (x) { e = x; }
    t.ok(e && e.code === 'unanswered' && e.message === 'The administrator permission prompt was not answered.', 'the prompt left unanswered for three minutes: said so, not a failure with PowerShell\'s output');
    const a = launcherArgs('C:\\x\\shroudly-core-adv.exe', ['--advanced']);
    t.ok(Buffer.from(a[a.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le').startsWith("$ProgressPreference = 'SilentlyContinue'; try { $p = Start-Process"),
      'and PowerShell is told to write no progress records');
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
    const e4 = as({ code: 4, stdout: '', stderr: '' });
    t.ok(e4.code === 'start_failed' && !e4.info && /could not find the advanced engine/.test(e4.message), 'exit 4 with every file in place: start_failed, no antivirus named (#69)');
    am._badFile = () => ({ file: 'C:\\x\\shroudly-core-adv.exe', state: 'missing' });
    t.ok(as({ code: 4, stdout: '', stderr: '' }).code === 'files_missing', 'exit 4 with the engine gone: files_missing');
    am._badFile = () => null;
    t.ok(as({ code: 1, stdout: '', stderr: 'Something else' }).code === 'start_failed', 'anything else: start_failed');
  }
  {
    // Linux: pkexec's endings told apart. Only a dismissed window or a "not
    // authorized" is the user's no (the autopilot then waits two weeks); no
    // polkit agent in the session, or a program that could not start, is not.
    const AdvancedMode = require(path.join(ROOT, 'electron', 'advanced-mode.js'));
    const am = new AdvancedMode(() => {});
    const code = (c, err) => { const e = am._pkexecEnd(c, err); return e ? e.code : null; };
    t.ok(code(126, 'Error executing command as another user: Request dismissed') === 'declined'
      && code(127, 'Error executing command as another user: Not authorized\n\nThis incident has been reported.') === 'declined',
    'pkexec: the window dismissed, or not authorized: the user\'s no');
    t.ok(code(127, 'Error executing command as another user: No authentication agent found.') === 'no_agent'
      && code(127, '==== AUTHENTICATING FOR org.freedesktop.policykit.exec ====\nError creating textual authentication agent: Error opening current controlling terminal for the process (`/dev/tty\'): No such device or address') === 'no_agent',
    'pkexec: no polkit agent to show the window (Sway, Hyprland, i3): not a no, said as such');
    t.ok(code(127, 'Error executing command as another user: /tmp/shroudly-adv-x/shroudly-core-adv: Permission denied') === 'start_failed' && code(1, 'whatever') === null,
      'pkexec: a program that could not start is a failure to start; any other exit is the engine\'s own');
    const panel = fs.readFileSync(path.join(ROOT, 'components', 'SettingsPanel.js'), 'utf8');
    t.ok(/no_agent: 'advErrorNoAgent'/.test(panel), 'the window has its own words for it');
  }
  {
    // A site no method opened: the notification offers Advanced mode only
    // where this computer has it (never on macOS).
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    t.ok(/advanced\.available\(\)[\s\S]{0,300}notifySiteBlockedBodyNoAdvanced/.test(main), 'a blocked site: Advanced mode is not suggested where it is not available');
  }
  {
    // Windows "not found" (2, 3) with every file in place (Akbar, 2.6.55):
    // a stopped "WinDivert" service is deleted (another program's left
    // behind, or the one the failed open made), then the driver is started
    // from a copy where the kernel can read it and only an administrator
    // can write. The real driver: tests/lab/advanced-windows-repair.js.
    const c = fs.readFileSync(path.join(ROOT, 'core', 'src', 'raw_windows.c'), 'utf8');
    const fn = c.slice(c.indexOf('static int repair_stale_service'), c.indexOf('static int same_file'));
    t.ok(/SERVICE_STOPPED\) \{[\s\S]*DeleteService\(svc\)/.test(fn) && !/SERVICE_RUNNING/.test(fn),
      'only a stopped WinDivert service is deleted; a running one is someone\'s in use');
    const cp = c.slice(c.indexOf('static int use_system_copy'), c.indexOf('static int load_windivert'));
    t.ok(/RegGetValueW\(HKEY_LOCAL_MACHINE[^)]*CommonFilesDir/.test(cp) && !/getenv|GetEnvironmentVariable/.test(cp),
      'the copy goes to Common Files as the registry has it, never a folder the environment names');
    t.ok(/FILE_ATTRIBUTE_REPARSE_POINT/.test(cp) && /same_file\(from, to\)/.test(cp), 'not through a link, and used only when byte for byte the same');
    t.ok(/round < 3[\s\S]{0,400}ERROR_PATH_NOT_FOUND\) break;[\s\S]{0,120}round == 1 && !repair_stale_service\(\)[\s\S]{0,120}round == 2[\s\S]{0,80}use_system_copy\(\)/.test(c),
      'tried in that order, only for "not found"');
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
    t.ok(/node tests\/lab\/advanced-windows-repair\.js/.test(wf), 'and tried on the real driver in CI');
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // VML-4: the polkit action the deb, rpm and pacman packages install.
  {
    const { ENGINE, render } = require(path.join(ROOT, 'scripts', 'gen-polkit.js'));
    const file = path.join(ROOT, 'scripts', 'linux', 'me.codeshare.shroudly.policy');
    const policy = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const pkg = require(path.join(ROOT, 'package.json'));
    const langs = fs.readdirSync(path.join(ROOT, 'locales')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    t.ok(policy === render(), 'the polkit action is up to date with the translations (node scripts/gen-polkit.js)');
    t.ok(ENGINE === `/opt/${pkg.build.productName}/resources/app.asar.unpacked/electron/tools/core/linux-x64/shroudly-core-adv`
      && policy.includes(`<annotate key="org.freedesktop.policykit.exec.path">${ENGINE}</annotate>`),
    `it names the engine where the packages install it (${ENGINE})`);
    t.ok(langs.length === 31 && langs.filter((l) => l !== 'en').every((l) => policy.includes(`<message xml:lang="${l}">`)) && /<message>Shroudly needs administrator permission/.test(policy),
      'its message is in all 31 languages');
    const map = 'scripts/linux/me.codeshare.shroudly.policy=/usr/share/polkit-1/actions/me.codeshare.shroudly.policy';
    t.ok(['deb', 'rpm', 'pacman'].every((k) => { const f = pkg.build[k].fpm || []; return f[f.length - 1] === map; }),
      'deb, rpm and pacman install it (last in their fpm lists: fpm reads its options first)');
    t.ok(/check:translations": "[^"]*gen-polkit\.js --check/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      && /polkit-1\/actions\/me\.codeshare\.shroudly\.policy/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'ci-linux-package-test.sh'), 'utf8')),
    'CI checks it is up to date, and that each installed package has it');
  }
  // VML-4: an AppImage's copy of the engine runs from the user's runtime
  // folder, not /tmp; /tmp still where that is missing, someone else's, or
  // mounted noexec.
  {
    const { workBase } = require(path.join(ROOT, 'electron', 'advanced-mode.js'));
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-run-'));
    const plain = `tmpfs ${run} tmpfs rw,nosuid,nodev,relatime,mode=700 0 0\n/dev/sda1 / ext4 rw,relatime 0 0\n`;
    const locked = `tmpfs ${run} tmpfs rw,nosuid,nodev,noexec,relatime,mode=700 0 0\n/dev/sda1 / ext4 rw,relatime 0 0\n`;
    t.ok(workBase('linux', { XDG_RUNTIME_DIR: run }, plain) === run, 'Linux: the user\'s runtime folder');
    t.ok(workBase('linux', { XDG_RUNTIME_DIR: run }, locked) === os.tmpdir() && workBase('linux', {}, plain) === os.tmpdir()
      && workBase('linux', { XDG_RUNTIME_DIR: path.join(run, 'missing') }, plain) === os.tmpdir() && workBase('win32', { XDG_RUNTIME_DIR: run }, plain) === os.tmpdir(),
    'and /tmp where it is mounted noexec, not set, missing, or off Linux');
    fs.rmSync(run, { recursive: true, force: true });
  }
  console.log(`advanced: ${t.count} passed`);
})();
