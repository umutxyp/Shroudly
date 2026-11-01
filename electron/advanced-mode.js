'use strict';

/*
 * AdvancedMode — the optional packet-layer backend for STATEFUL DPI (Iran/China).
 *
 * The default engine (userspace proxy, split/disorder) defeats stateless DPI and
 * needs no privileges. When a probe reports a site stays blocked ("suggest":
 * "advanced"), the UI offers this mode. It is privileged and platform-specific:
 *
 *   Windows x64: WinDivert driver, bundled next to shroudly-core-adv.exe.
 *                Started through a UAC prompt.
 *   Linux      : NFQUEUE (over netlink: no library needed) + raw sockets. Started
 *                through pkexec; the engine installs and removes its own
 *                iptables/nftables rule.
 *   macOS      : not possible — pf has no divert-to rule and the kernel no
 *                divert sockets; it would need a signed Network Extension.
 *
 * The elevated engine can't be piped or signalled by this unprivileged process,
 * so it talks through files (see core/src/supervise.h): it writes JSON lines to
 * a status file, exits when a ".stop" file appears, and also exits by itself
 * when this process dies. Its packet hook is released whenever it exits.
 *
 * An antivirus is what most often stands in the way here (WinDivert is a
 * packet driver, and many of them flag it): it removes Advanced mode's
 * files, refuses to start the engine, refuses the driver, or ends the engine
 * without a word. Each is told as what it is (codes 'files_missing' and
 * 'security_blocked', with the details security-block.js and main.js use),
 * not as "did not respond in time" after two minutes. On Windows the engine
 * is no child of ours, so the launcher hands back its process id, and a
 * check that the process is still there notices one ended from outside,
 * while it starts (in about a second) and while it runs.
 */

const { spawn, execFile } = require('child_process');
const { envFor } = require('./win-powershell');
const SecurityBlock = require('./security-block');
const path = require('path');
const fs = require('fs');
const os = require('os');

const QUEUE_NUM = 200;
const READY_TIMEOUT_MS = 120000; // includes the time the user spends on the prompt
const STOP_TIMEOUT_MS = 4000;
// While it runs, whether its process is still there is looked at this often:
// each look asks Windows for a handle to an elevated process (refused, which
// is the answer), and a security program watching such requests should not
// see one every second for hours.
const ALIVE_CHECK_MS = 5000;

function archKey() { return process.arch === 'arm64' ? 'arm64' : 'x64'; }

/* The machine's own processor, not this build's: the x64 build runs on
 * Windows on ARM too (emulated), where process.arch says x64 but the WinDivert
 * driver, a kernel driver, cannot load. Windows records the real one for the
 * whole system. */
let hostArmCache = null;
function windowsHostIsArm() {
  if (process.platform !== 'win32') return false;
  if (process.arch === 'arm64') return true;
  if (hostArmCache !== null) return hostArmCache;
  hostArmCache = false;
  try {
    const out = require('child_process').execFileSync('reg', ['query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'PROCESSOR_ARCHITECTURE'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    hostArmCache = /PROCESSOR_ARCHITECTURE\s+REG_SZ\s+ARM64/i.test(out);
  } catch {}
  return hostArmCache;
}

function advBinaryPath() {
  const plat = process.platform;
  const name = plat === 'win32' ? 'shroudly-core-adv.exe' : 'shroudly-core-adv';
  const rel = path.join('electron', 'tools', 'core', `${plat}-${archKey()}`, name);
  const packaged = __dirname.includes('app.asar');
  if (packaged) {
    const res = process.resourcesPath || path.join(__dirname, '..', '..', '..');
    return path.join(res, 'app.asar.unpacked', rel);
  }
  return path.join(__dirname, 'tools', 'core', `${process.platform}-${archKey()}`, name);
}

/* Where the status file (and an AppImage's copy of the engine) is kept: on
 * Linux the user's own runtime folder (/run/user/<uid>, 0700), not /tmp,
 * where a program asking for administrator permission looks like anything
 * but Shroudly. /tmp when there is none that is this user's, or when it is
 * mounted noexec (the copy could not run from it). */
function workBase(platform = process.platform, env = process.env, mounts = null) {
  const run = env.XDG_RUNTIME_DIR;
  if (platform === 'linux' && run && path.isAbsolute(run)) {
    try {
      const st = fs.statSync(run);
      if (st.isDirectory() && (typeof process.getuid !== 'function' || st.uid === process.getuid()) && !noexec(run, mounts)) return run;
    } catch {}
  }
  return os.tmpdir();
}

/* Is the folder on a filesystem mounted noexec? From /proc/self/mounts (or
 * the text given): the longest mount point it is under decides. */
function noexec(dir, mounts = null) {
  let text = mounts;
  if (text == null) { try { text = fs.readFileSync('/proc/self/mounts', 'utf8'); } catch { return false; } }
  let best = null;
  for (const line of String(text).split('\n')) {
    const f = line.split(' ');
    if (f.length < 4) continue;
    const mp = f[1].replace(/\\(\d{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
    const under = mp === '/' || dir === mp || dir.startsWith(`${mp}/`);
    if (under && (!best || mp.length >= best.mp.length)) best = { mp, opts: f[3].split(',') };
  }
  return !!(best && best.opts.includes('noexec'));
}

const REASONS = {
  mac_unsupported: 'Advanced mode is not available on macOS: the system offers no packet-divert interface without a signed Network Extension. The default engine still works.',
  arch_unsupported: 'Advanced mode is not available on this processor architecture (the WinDivert driver has no ARM64 build).',
  platform_unsupported: `Advanced mode is not available on ${process.platform}.`,
  not_built: 'The advanced engine is not included in this build. Run: npm run build:core:advanced',
  windivert_missing: 'WinDivert.dll / WinDivert64.sys are missing next to the advanced engine. Reinstall Shroudly.',
  files_missing: "Advanced mode's files are missing or cannot be read; an antivirus may have removed them. Restore them from its quarantine, or install Shroudly again.",
};

/* info: for 'security_blocked' and 'files_missing', what main.js tells
 * (security-block.js). */
class AdvError extends Error {
  constructor(code, message, info = null) { super(message); this.code = code; this.info = info; }
}

/* Is the process still there? Windows refuses an unelevated process a
 * handle to an elevated one (EPERM): that one is there too. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

/*
 * The packet-layer options, passed to the engine the same way the fake TTL is.
 * Sensible defaults: the strictly-additive, always-safe protections are on
 * (drop the forged RSTs a censor injects to tear a blocked connection down,
 * set the decoy's TTL from the measured hop distance to the server, and cut
 * the real first segment after the decoy, which every TCP receiver puts back
 * together); the decoy itself stays the proven low-TTL/bad-checksum fake,
 * with sequence overlap off. Each is a flag, so a future UI (or a probe
 * result) can switch them per network.
 */
const ADV_DEFAULTS = { dropRst: true, autottl: true, seqovl: 0, desyncMode: 'fake', split: 'on', tlsrec: false };
const DESYNC_MODES = ['fake', 'fakedsplit', 'fakeddisorder'];
/* After the decoy the real first segment is cut so no part carries the whole
 * name ('on'), or cut and sent last part first ('disorder'): what programs
 * that ignore the proxy get instead of its techniques (core/src/tcpdpi.h). */
const SPLIT_MODES = ['off', 'on', 'disorder'];

function resolveAdvOpts(opts) {
  const o = { ...ADV_DEFAULTS, ...(opts || {}) };
  o.dropRst = !!o.dropRst;
  o.autottl = !!o.autottl;
  o.seqovl = Math.max(0, Math.floor(Number(o.seqovl) || 0));
  o.desyncMode = DESYNC_MODES.includes(o.desyncMode) ? o.desyncMode : 'fake';
  o.split = o.split === false ? 'off' : SPLIT_MODES.includes(o.split) ? o.split : 'on';
  o.tlsrec = !!o.tlsrec;
  return o;
}

/* The command line for the elevated engine. QUIC forced to TCP and decoys for
 * Discord voice UDP are on by default in Advanced mode; their opt-out flags are
 * passed only when a caller explicitly turns a feature off. The TCP options
 * (opts) always go, resolved against ADV_DEFAULTS. Pure so it can be tested
 * without elevating anything (tests/net/advanced.test.js). */
function buildArgs(o) {
  const t = resolveAdvOpts(o.opts);
  const ttl = Number(o.ttl) > 0 ? Number(o.ttl) : 4;
  const args = ['--advanced', '--fake-ttl', String(ttl),
    '--status-file', String(o.statusFile), '--parent-pid', String(o.parentPid),
    '--drop-rst', t.dropRst ? '1' : '0',
    '--autottl', t.autottl ? '1' : '0',
    '--seqovl', String(t.seqovl),
    '--split', t.split,
    '--desync-mode', t.desyncMode];
  // Split the ClientHello's TLS record for a network that reassembles the
  // stream before it inspects (#48, Superonline and the like). On by default
  // in Advanced mode — it is the technique that actually gets through such
  // networks, and the stronger one (it also does what the TCP cut does). It
  // costs a little more (every 443 packet of a connection passes through, to
  // keep its sequence numbers in step); a user can turn it off with
  // advancedTlsRec:false.
  if (t.tlsrec) args.push('--tlsrec', '1');
  // Windows: another program uses the WinDivert driver too (rivals.js), so
  // the engine leaves it loaded at stop instead of unloading it (#56).
  if (o.platform === 'win32' && o.opts && o.opts.keepDriver) args.push('--keep-driver', '1');
  if (o.platform === 'linux') args.push('--queue', String(o.queueNum != null ? o.queueNum : QUEUE_NUM));
  if (o.quicBlock === false) args.push('--no-quic-block');
  if (o.udpFake === false) args.push('--no-udp-fake');
  if (Number(o.fakeRepeats) > 0) args.push('--fake-repeats', String(Math.floor(Number(o.fakeRepeats))));
  // Other programs' DNS answered from the app's encrypted-DNS forwarder
  // (core/src/dnsgate.h), when there is one.
  const gate = Math.floor(Number(o.dnsGate));
  if (gate > 0 && gate < 65536) args.push('--dns-gate', String(gate));
  return args;
}

/* One argument as Windows reads it back (CommandLineToArgvW, the C runtime):
 * left alone when it has no space, tab or quote; otherwise quoted, with the
 * backslashes before a quote doubled and the quote escaped, and backslashes
 * at the end doubled so they do not escape the closing quote. The engine is
 * started elevated from these, so they must arrive exactly as given. */
function winQuoteArg(a) {
  const s = String(a);
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"';
  let bs = 0;
  for (const ch of s) {
    if (ch === '\\') { bs++; continue; }
    if (ch === '"') { out += `${'\\'.repeat(bs * 2 + 1)}"`; bs = 0; continue; }
    out += '\\'.repeat(bs) + ch;
    bs = 0;
  }
  return `${out}${'\\'.repeat(bs * 2)}"`;
}

/* Windows: PowerShell's arguments that start the engine elevated (a UAC
 * prompt). Start-Process passes a single ArgumentList string through
 * verbatim, so each argument is quoted here. -PassThru gives the elevated
 * engine's process id, written out for the checks that it is still there
 * (on its own, so that a process id that cannot be read never fails an
 * engine that did start). Exit 2: 1223 = ERROR_CANCELLED (UAC declined).
 * Exit 3: Windows or an antivirus refused to start it (5 = access denied,
 * 225/226 = "contains a virus"). Exit 4: its file is not there (2, 3). The
 * script stays encoded (-EncodedCommand): a user folder with letters outside
 * the console's code page (C:\Users\Ümit) would not survive any other way
 * in. */
function launcherArgs(bin, args) {
  const argLine = args.map(winQuoteArg).join(' ');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script =
    `try { $p = Start-Process -FilePath ${q(bin)} -ArgumentList ${q(argLine)} -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop } ` +
    'catch { $e = $_.Exception; while ($e) { $c = $e.NativeErrorCode; if ($c -eq 1223) { exit 2 }; ' +
    'if ($c -eq 5 -or $c -eq 225 -or $c -eq 226) { exit 3 }; if ($c -eq 2 -or $c -eq 3) { exit 4 }; $e = $e.InnerException }; ' +
    '[Console]::Error.WriteLine($_.Exception.Message); exit 1 }; ' +
    'try { if ($p) { [Console]::Out.WriteLine($p.Id) } } catch {}';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

/* A program that could not be started at all (ENOENT...) or ran out of
 * time says so in stderr: "PowerShell exited with -1" alone told nobody why. */
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, env: envFor(cmd) }, (err, stdout, stderr) => {
      if (!err) { resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') }); return; }
      if (typeof err.code === 'number') { resolve({ code: err.code, stdout: String(stdout || ''), stderr: String(stderr || '') }); return; }
      const why = err.killed ? `${path.basename(cmd)} did not finish in time` : `${path.basename(cmd)} could not be started (${err.code || err.message})`;
      resolve({ code: -1, stdout: '', stderr: String(stderr || '').trim() || why });
    });
  });
}

class AdvancedMode {
  constructor(log) {
    this.log = log || (() => {});
    this.platform = process.platform;
    this.active = false;
    this.dir = null;
    this.statusFile = null;
    this.child = null;      // pkexec / direct child on Linux; none on Windows
    this.childExit = null;  // exit code of that child, once it has exited
    this.pid = null;        // Windows: the elevated engine's process, from the launcher
    this.alive = alive;     // the tests bring their own
    this.aliveCheckMs = ALIVE_CHECK_MS;
    this.monitor = null;
    // An installed Shroudly: Advanced mode's files are always part of it
    // where it has Advanced mode (release.yml builds them for Windows x64
    // and Linux), so one gone was taken, most likely by an antivirus.
    this.packaged = __dirname.includes('app.asar');
    // A block found while it runs (main.js securityBlocked).
    this.onSecurityBlock = null;
  }

  /* Advanced mode's own files here: the engine, and WinDivert's on Windows. */
  _files() {
    const bin = advBinaryPath();
    if (this.platform !== 'win32') return [bin];
    const dir = path.dirname(bin);
    return [bin, path.join(dir, 'WinDivert.dll'), path.join(dir, 'WinDivert64.sys')];
  }

  /* The first of them that is gone (SecurityBlock.fileState): { file, state }, or null. */
  _badFile() {
    for (const file of this._files()) {
      const state = SecurityBlock.fileState(file, { platform: this.platform });
      if (SecurityBlock.isGone(state)) return { file, state };
    }
    return null;
  }

  /* What main.js tells about a block of Advanced mode (security-block.js). */
  _info(kind, { file = null, certain = true, detail = null, win32 = null } = {}) {
    const folder = this.packaged ? SecurityBlock.installFolder({ platform: this.platform }) : path.dirname(advBinaryPath());
    return { part: 'advanced', kind, certain, file: file || path.basename(advBinaryPath()), folder, detail, win32 };
  }

  _blockError(code, kind, opts = {}) {
    const info = this._info(kind, opts);
    const message = code === 'files_missing' ? REASONS.files_missing : SecurityBlock.logLine(info).replace(/^Security software: /, 'Blocked by security software: ');
    return new AdvError(code, message, info);
  }

  reasonCode() {
    if (this.platform === 'darwin') return 'mac_unsupported';
    if (this.platform !== 'win32' && this.platform !== 'linux') return 'platform_unsupported';
    if (this.platform === 'win32' && (archKey() !== 'x64' || windowsHostIsArm())) return 'arch_unsupported';
    if (this.packaged) return this._badFile() ? 'files_missing' : null;
    if (!fs.existsSync(advBinaryPath())) return 'not_built';
    if (this.platform === 'win32') {
      const dir = path.dirname(advBinaryPath());
      if (!fs.existsSync(path.join(dir, 'WinDivert.dll')) || !fs.existsSync(path.join(dir, 'WinDivert64.sys'))) {
        return 'windivert_missing';
      }
    }
    return null;
  }

  reason() {
    const code = this.reasonCode();
    return code ? REASONS[code] : null;
  }

  available() { return this.reasonCode() === null; }

  _readStatus() {
    let text = '';
    try { text = fs.readFileSync(this.statusFile, 'utf8'); } catch { return { ready: null, stopped: false, errors: [] }; }
    let ready = null;
    let stopped = false;
    const errors = [];
    // The last error that carries Windows' own code (core/src/raw_windows.c):
    // what SecurityBlock.classifyWinDivert reads.
    let fault = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.type === 'raw_ready') ready = m;
        else if (m.type === 'stopped') stopped = true;
        else if (m.type === 'error') {
          if (m.msg) errors.push(m.msg);
          if (m.code && Number.isFinite(Number(m.win32))) fault = { code: String(m.code), win32: Number(m.win32) };
        }
      } catch { errors.push(line); }
    }
    return { ready, stopped, errors, fault };
  }

  /* The engine ended before it was ready: why, as an AdvError. A WinDivert
   * error with Windows' code says whether a file is missing or Windows or
   * an antivirus refused the driver; anything else is 'start_failed' with
   * the engine's own last lines. */
  _failure(s, fallback) {
    const said = (s.errors || []).slice(-3).join(' | ');
    const c = SecurityBlock.classifyWinDivert(s.fault);
    if (c && (c.code === 'security_blocked' || c.code === 'files_missing')) {
      const load = s.fault.code === 'windivert_load';
      return this._blockError(c.code, c.kind, {
        file: load ? 'WinDivert.dll' : 'WinDivert64.sys', win32: s.fault.win32,
        detail: `${load ? 'loading WinDivert.dll' : 'WinDivertOpen'}: error ${s.fault.win32}`,
      });
    }
    if (c && c.code === 'rival') return new AdvError('start_failed', 'Another program has a different version of the WinDivert driver loaded (error 654). Close it (GoodbyeDPI, zapret and the like), or restart Windows.');
    if (c && c.code === 'bfe_off') return new AdvError('start_failed', "Windows' Base Filtering Engine service is off (error 1753); Advanced mode needs it.");
    return new AdvError('start_failed', said || fallback);
  }

  async _launchWindows(bin, args) {
    this._launched(await run('powershell.exe', launcherArgs(bin, args), 180000));
  }

  /* What the launcher's exit says (launcherArgs): the engine's process id
   * kept, or the AdvError it stands for. */
  _launched(r) {
    if (r.code === 2) throw new AdvError('declined', 'Administrator permission was not granted.');
    if (r.code === 3) throw this._blockError('security_blocked', 'denied', { detail: 'elevated start' });
    if (r.code === 4) {
      const bad = this._badFile();
      throw this._blockError('files_missing', bad ? bad.state : 'missing', { file: bad ? path.basename(bad.file) : null });
    }
    if (r.code !== 0) throw new AdvError('start_failed', r.stderr.trim() || `PowerShell exited with ${r.code}`);
    const pid = Number(String(r.stdout || '').trim().split(/\s+/).pop());
    this.pid = Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  _launchLinux(bin, args) {
    let exe = bin;
    if (process.env.APPIMAGE) {
      // Root cannot read the user's FUSE mount of the AppImage, so run a copy
      // from our private (0700) temp dir instead.
      exe = path.join(this.dir, path.basename(bin));
      fs.copyFileSync(bin, exe);
      fs.chmodSync(exe, 0o755);
    }
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const [cmd, argv] = isRoot ? [exe, args] : ['pkexec', [exe, ...args]];
    return new Promise((resolve, reject) => {
      // pkexec's own words tell its endings apart (_pkexecEnd).
      const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', isRoot ? 'ignore' : 'pipe'] });
      this.childErr = '';
      this.viaPkexec = !isRoot;
      if (child.stderr) child.stderr.on('data', (d) => { this.childErr = (this.childErr + d).slice(-2000); });
      child.once('error', (e) => {
        if (e.code === 'ENOENT' && !isRoot) reject(new AdvError('elevation_unavailable', 'pkexec (polkit) was not found. Install the polkit package (pkexec), then try again.'));
        else reject(new AdvError('start_failed', e.message));
      });
      child.once('spawn', () => {
        this.child = child;
        this.childExit = null;
        child.once('exit', (code) => { this.childExit = code === null ? -1 : code; });
        resolve();
      });
    });
  }

  /* What pkexec's ending means. 126: the password window was dismissed, the
   * user's no. 127: not allowed (also the user's no), or no window could be
   * shown at all (no polkit agent in the session: Sway, Hyprland, i3, a
   * minimal desktop), or the program could not be started (/tmp mounted
   * noexec): those were taken for a no too, and the autopilot kept quiet
   * for two weeks about a question nobody was asked. */
  _pkexecEnd(code, stderr = '') {
    const why = String(stderr || '');
    if (code === 126) return new AdvError('declined', 'Administrator permission was not granted.');
    if (code !== 127) return null;
    if (/no authentication agent|textual authentication agent/i.test(why)) {
      return new AdvError('no_agent', 'No password window could be shown: no polkit authentication agent runs in this session.');
    }
    if (/not authori[sz]ed|request dismissed/i.test(why) || !why.trim()) return new AdvError('declined', 'Administrator permission was not granted.');
    return new AdvError('start_failed', `The advanced engine could not be started as administrator: ${why.trim().split('\n').pop().slice(0, 200)}`);
  }

  /* The time limit counts only time the computer was awake: the prompt may
   * be on screen when the lid closes, and its answer after the wake is no
   * timeout. A step much longer than the poll (asleep, frozen, a clock
   * change) counts as one second. */
  async _waitReady() {
    const limit = this.readyTimeoutMs || READY_TIMEOUT_MS;
    let waited = 0;
    let last = Date.now();
    while (waited < limit) {
      const s = this._readStatus();
      if (s.ready) return s.ready;
      if (s.stopped) throw this._failure(s, 'The advanced engine exited.');
      if (this.childExit !== null) {
        const end = this.viaPkexec ? this._pkexecEnd(this.childExit, this.childErr) : null;
        if (end) throw end;
        throw this._failure(s, `The advanced engine exited with code ${this.childExit}.`);
      }
      // Windows: its process is gone, and it said nothing (an engine that
      // fails writes why, then "stopped"): ended from outside. An
      // antivirus, for certain when it took a file too.
      if (this.pid && !this.alive(this.pid)) {
        const last = this._readStatus();
        if (last.ready) return last.ready;
        if (last.stopped || last.errors.length) throw this._failure(last, 'The advanced engine exited.');
        const bad = this._badFile();
        throw this._blockError('security_blocked', bad ? bad.state : 'killed', { certain: !!bad, file: bad ? path.basename(bad.file) : null });
      }
      await new Promise((r) => setTimeout(r, 250));
      const now = Date.now();
      waited += Math.min(Math.max(now - last, 0), 1000);
      last = now;
    }
    throw new AdvError('timeout', 'The advanced engine did not respond in time.');
  }

  /* One start at a time: a second one while the first is still waiting for
   * the permission prompt (the autopilot's, then a click in Settings) gets
   * the first one's answer instead of a second prompt that would undo it. */
  start(fakeTtl, opts) {
    if (this.active) return Promise.resolve({ success: true, alreadyActive: true });
    if (!this._starting) this._starting = this._start(fakeTtl, opts).finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start(fakeTtl, opts) {
    if (this.active) return { success: true, alreadyActive: true };
    const code = this.reasonCode();
    if (code === 'files_missing') {
      const bad = this._badFile();
      throw this._blockError(code, bad ? bad.state : 'missing', { file: bad ? path.basename(bad.file) : null });
    }
    if (code) throw new AdvError(code, REASONS[code]);
    const ttl = Number(fakeTtl) > 0 ? Number(fakeTtl) : 4;
    const o = opts || {};

    this._removeDir();
    this.dir = fs.mkdtempSync(path.join(workBase(this.platform), 'shroudly-adv-'));
    this.statusFile = path.join(this.dir, 'status.log');
    const args = buildArgs({
      ttl, statusFile: this.statusFile, parentPid: process.pid, platform: this.platform,
      queueNum: QUEUE_NUM, quicBlock: o.quicBlock, udpFake: o.udpFake, fakeRepeats: o.fakeRepeats, dnsGate: o.dnsGate, opts: o,
    });

    this.log('info', 'Advanced mode: asking for administrator permission');
    try {
      if (this.platform === 'win32') await this._launchWindows(advBinaryPath(), args);
      else await this._launchLinux(advBinaryPath(), args);
      const ready = await this._waitReady();
      this.active = true;
      this.log('success', `Advanced backend active (fake TTL ${ready.ttl})`);
      // The engine takes only the first datagrams of a call where the
      // system's packet filter can look inside them (udpdpi.h); where it
      // cannot, every datagram on the voice ports passes through the engine.
      if (ready.udp_match === 0 && (ready.udp_fake || ready.quic_block)) {
        this.log('info', 'Advanced mode: the packet filter here cannot look inside UDP datagrams, so calls on the voice ports pass through the engine');
      }
      if (o.dropRst && o.autottl) this.log('info', 'Advanced mode also drops injected resets and measures the decoy TTL');
      if (ready.dns_gate === 1) this.log('info', 'Advanced mode also answers the DNS of programs that ignore the proxy with encrypted DNS');
      this._startMonitor();
      return { success: true };
    } catch (e) {
      // main.js logs the failure ("Advanced mode failed: ...")
      await this._requestStop();
      this._removeDir();
      throw e;
    }
  }

  _startMonitor() {
    clearInterval(this.monitor);
    let looked = Date.now();
    this.monitor = setInterval(() => {
      if (!this.active) return;
      const s = this._readStatus();
      // Windows: ended from outside while it ran leaves no "stopped" line,
      // and would otherwise be taken for on for the rest of the session.
      const look = !!this.pid && Date.now() - looked >= this.aliveCheckMs;
      if (look) looked = Date.now();
      const gone = look && !s.stopped && this.childExit === null && !this.alive(this.pid);
      if (s.stopped || this.childExit !== null || gone) {
        this.active = false;
        clearInterval(this.monitor);
        this.log('warning', gone ? 'Advanced backend was ended from outside (no stop was asked)' : 'Advanced backend exited');
        if (typeof this.onExit === 'function') { try { this.onExit(); } catch {} }
        if (s.errors.length) this.log('warning', s.errors[s.errors.length - 1]);
        // Its files gone with it: an antivirus took them (main.js tells it).
        const bad = gone ? this._badFile() : null;
        if (bad && typeof this.onSecurityBlock === 'function') {
          try { this.onSecurityBlock(this._info('vanished', { file: path.basename(bad.file) })); } catch {}
        }
        this._removeDir();
      }
    }, 1000);
  }

  async _requestStop() {
    if (!this.statusFile) return;
    try { fs.writeFileSync(`${this.statusFile}.stop`, ''); } catch {}
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this._readStatus().stopped || this.childExit !== null) return;
      if (this.pid && !this.alive(this.pid)) return; // ended already
      if (!fs.existsSync(this.statusFile)) return; // never started
      await new Promise((r) => setTimeout(r, 150));
    }
    this.log('warning', 'Advanced backend did not confirm stop; it exits on its own when Shroudly quits');
  }

  _removeDir() {
    if (!this.dir) return;
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {}
    this.dir = null;
    this.statusFile = null;
    this.child = null;
    this.pid = null;
  }

  async stop() {
    clearInterval(this.monitor);
    await this._requestStop();
    this.active = false;
    this._removeDir();
    this.log('success', 'Advanced mode stopped');
    return { success: true };
  }

  cleanupSync() {
    // The engine also exits on its own once this process is gone.
    clearInterval(this.monitor);
    if (this.statusFile) { try { fs.writeFileSync(`${this.statusFile}.stop`, ''); } catch {} }
  }
}

module.exports = AdvancedMode;
module.exports.buildArgs = buildArgs;
module.exports.winQuoteArg = winQuoteArg;
/* The TCP options' own name for the same argv (fakeTtl, opts). */
module.exports.buildAdvancedArgs = ({ fakeTtl, opts, ...rest }) => buildArgs({ ...rest, ttl: fakeTtl, opts });
module.exports.ADV_DEFAULTS = ADV_DEFAULTS;
module.exports.AdvError = AdvError;
module.exports.launcherArgs = launcherArgs;
module.exports.workBase = workBase;
