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
 */

const { spawn, execFile } = require('child_process');
const { envFor } = require('./win-powershell');
const path = require('path');
const fs = require('fs');
const os = require('os');

const QUEUE_NUM = 200;
const READY_TIMEOUT_MS = 120000; // includes the time the user spends on the prompt
const STOP_TIMEOUT_MS = 4000;

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

const REASONS = {
  mac_unsupported: 'Advanced mode is not available on macOS: the system offers no packet-divert interface without a signed Network Extension. The default engine still works.',
  arch_unsupported: 'Advanced mode is not available on this processor architecture (the WinDivert driver has no ARM64 build).',
  platform_unsupported: `Advanced mode is not available on ${process.platform}.`,
  not_built: 'The advanced engine is not included in this build. Run: npm run build:core:advanced',
  windivert_missing: 'WinDivert.dll / WinDivert64.sys are missing next to the advanced engine. Reinstall Shroudly.',
};

class AdvError extends Error {
  constructor(code, message) { super(message); this.code = code; }
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
  // Split the ClientHello's TLS record for a DPI that reassembles the stream
  // before it inspects (#48); off unless turned on, since it takes every 443
  // packet of a connection to keep its sequence numbers in step.
  if (t.tlsrec) args.push('--tlsrec', '1');
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

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, env: envFor(cmd) }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stderr: String(stderr || '') }));
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
    this.monitor = null;
  }

  reasonCode() {
    if (this.platform === 'darwin') return 'mac_unsupported';
    if (this.platform !== 'win32' && this.platform !== 'linux') return 'platform_unsupported';
    if (this.platform === 'win32' && (archKey() !== 'x64' || windowsHostIsArm())) return 'arch_unsupported';
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
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.type === 'raw_ready') ready = m;
        else if (m.type === 'stopped') stopped = true;
        else if (m.type === 'error' && m.msg) errors.push(m.msg);
      } catch { errors.push(line); }
    }
    return { ready, stopped, errors };
  }

  async _launchWindows(bin, args) {
    // Start-Process passes a single ArgumentList string through verbatim, so
    // quote each argument ourselves. 1223 = ERROR_CANCELLED (UAC declined).
    const argLine = args.map(winQuoteArg).join(' ');
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const script =
      `try { Start-Process -FilePath ${q(bin)} -ArgumentList ${q(argLine)} -Verb RunAs -WindowStyle Hidden -ErrorAction Stop } ` +
      'catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 2 }; $e = $e.InnerException }; ' +
      '[Console]::Error.WriteLine($_.Exception.Message); exit 1 }';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 180000);
    if (r.code === 2) throw new AdvError('declined', 'Administrator permission was not granted.');
    if (r.code !== 0) throw new AdvError('start_failed', r.stderr.trim() || `PowerShell exited with ${r.code}`);
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
      const child = spawn(cmd, argv, { stdio: 'ignore' });
      child.once('error', (e) => {
        if (e.code === 'ENOENT' && !isRoot) reject(new AdvError('elevation_unavailable', 'pkexec (polkit) was not found. Install polkit or run Shroudly as root.'));
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
      if (s.stopped) throw new AdvError('start_failed', s.errors.slice(-3).join(' | ') || 'The advanced engine exited.');
      if (this.childExit !== null) {
        // pkexec: 126 = dialog dismissed, 127 = not authorized
        if (this.childExit === 126 || this.childExit === 127) throw new AdvError('declined', 'Administrator permission was not granted.');
        throw new AdvError('start_failed', s.errors.slice(-3).join(' | ') || `The advanced engine exited with code ${this.childExit}.`);
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
    if (code) throw new AdvError(code, REASONS[code]);
    const ttl = Number(fakeTtl) > 0 ? Number(fakeTtl) : 4;
    const o = opts || {};

    this._removeDir();
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-adv-'));
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
    this.monitor = setInterval(() => {
      if (!this.active) return;
      const s = this._readStatus();
      if (s.stopped || this.childExit !== null) {
        this.active = false;
        clearInterval(this.monitor);
        this.log('warning', 'Advanced backend exited');
        if (typeof this.onExit === 'function') { try { this.onExit(); } catch {} }
        if (s.errors.length) this.log('warning', s.errors[s.errors.length - 1]);
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
