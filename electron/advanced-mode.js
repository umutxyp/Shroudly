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
 *   Linux      : NFQUEUE + raw sockets (needs libnetfilter-queue1). Started
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

const LINUX_LIB_DIRS = ['/usr/lib/x86_64-linux-gnu', '/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu',
  '/lib/aarch64-linux-gnu', '/usr/lib64', '/lib64', '/usr/lib', '/lib'];

function linuxHasNfqueueLib() {
  return LINUX_LIB_DIRS.some((d) => fs.existsSync(path.join(d, 'libnetfilter_queue.so.1')));
}

/* The command that installs libnetfilter_queue on this distribution: the
 * package has a different name, and a different installer, on each family. */
function linuxInstallCommand(osRelease) {
  let text = osRelease;
  if (text === undefined) { try { text = fs.readFileSync('/etc/os-release', 'utf8'); } catch { text = ''; } }
  const field = (k) => ((text.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '').replace(/["']/g, '').toLowerCase();
  const ids = `${field('ID')} ${field('ID_LIKE')}`;
  if (/\b(arch|manjaro|endeavouros|garuda|artix)\b/.test(ids)) return 'sudo pacman -S libnetfilter_queue';
  if (/\b(opensuse|suse|sles)\b/.test(ids) || /opensuse/.test(ids)) return 'sudo zypper install libnetfilter_queue1';
  if (/\b(fedora|rhel|centos|rocky|almalinux|nobara)\b/.test(ids)) return 'sudo dnf install libnetfilter_queue';
  return 'sudo apt install libnetfilter-queue1';
}

const REASONS = {
  mac_unsupported: 'Advanced mode is not available on macOS: the system offers no packet-divert interface without a signed Network Extension. The default engine still works.',
  arch_unsupported: 'Advanced mode is not available on this processor architecture (the WinDivert driver has no ARM64 build).',
  platform_unsupported: `Advanced mode is not available on ${process.platform}.`,
  not_built: 'The advanced engine is not included in this build. Run: npm run build:core:advanced',
  windivert_missing: 'WinDivert.dll / WinDivert64.sys are missing next to the advanced engine. Reinstall Shroudly.',
  linux_lib_missing: 'Advanced mode needs libnetfilter_queue. Install it with: ' + (process.platform === 'linux' ? linuxInstallCommand() : 'sudo apt install libnetfilter-queue1'),
};

class AdvError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* The command line for the elevated engine. QUIC forced to TCP and decoys for
 * Discord voice UDP are on by default in Advanced mode; the opt-out flags are
 * passed only when a caller explicitly turns a feature off, so an old engine
 * (which does not know them) still runs with both on. Pure so it can be tested
 * without elevating anything (tests/net/advanced.test.js). */
function buildArgs(o) {
  const ttl = Number(o.ttl) > 0 ? Number(o.ttl) : 4;
  const args = ['--advanced', '--fake-ttl', String(ttl),
    '--status-file', String(o.statusFile), '--parent-pid', String(o.parentPid)];
  if (o.platform === 'linux') args.push('--queue', String(o.queueNum != null ? o.queueNum : QUEUE_NUM));
  if (o.quicBlock === false) args.push('--no-quic-block');
  if (o.udpFake === false) args.push('--no-udp-fake');
  if (Number(o.fakeRepeats) > 0) args.push('--fake-repeats', String(Math.floor(Number(o.fakeRepeats))));
  return args;
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
    if (this.platform === 'linux' && !linuxHasNfqueueLib()) return 'linux_lib_missing';
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
    const argLine = args.map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a))).join(' ');
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

  async _waitReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const s = this._readStatus();
      if (s.ready) return s.ready;
      if (s.stopped) throw new AdvError('start_failed', s.errors.slice(-3).join(' | ') || 'The advanced engine exited.');
      if (this.childExit !== null) {
        // pkexec: 126 = dialog dismissed, 127 = not authorized
        if (this.childExit === 126 || this.childExit === 127) throw new AdvError('declined', 'Administrator permission was not granted.');
        throw new AdvError('start_failed', s.errors.slice(-3).join(' | ') || `The advanced engine exited with code ${this.childExit}.`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new AdvError('timeout', 'The advanced engine did not respond in time.');
  }

  async start(fakeTtl, opts) {
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
      queueNum: QUEUE_NUM, quicBlock: o.quicBlock, udpFake: o.udpFake, fakeRepeats: o.fakeRepeats,
    });

    this.log('info', 'Advanced mode: asking for administrator permission');
    try {
      if (this.platform === 'win32') await this._launchWindows(advBinaryPath(), args);
      else await this._launchLinux(advBinaryPath(), args);
      const ready = await this._waitReady();
      this.active = true;
      this.log('success', `Advanced backend active (fake TTL ${ready.ttl})`);
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
module.exports.linuxInstallCommand = linuxInstallCommand;
module.exports.buildArgs = buildArgs;
