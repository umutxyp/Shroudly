'use strict';

/*
 * Puts HTTPS_PROXY into the user's session, so that programs started from
 * then on — Roblox and its installer among them — reach the internet through
 * app-proxy.js. And takes it out again.
 *
 *  macOS    launchctl setenv. Every app the system starts afterwards gets it:
 *           from the Dock, from Finder, or from a browser opening a
 *           roblox-player:// link (Roblox closes and starts itself again to
 *           join a game, and the new copy gets it too). It is held in memory
 *           and gone after logout or a restart.
 *  Windows  the user's environment (HKCU\Environment), plus the broadcast that
 *           makes Explorer pick it up: programs started from the Start menu,
 *           the desktop or File Explorer get it. One that was already running
 *           — a browser included — keeps the environment it started with until
 *           it is restarted.
 *  Linux    not offered: there is no one place every desktop reads it from.
 *
 * Only our own values are ever removed. A proxy the user set themselves, for
 * their session or (Windows) for the whole machine, is never replaced.
 * SHROUDLY_APP_PROXY, set alongside, is what marks the value as ours, so even
 * another local proxy (Clash, Fiddler) on 127.0.0.1 is left alone.
 *
 * The value must not outlive Shroudly, or programs would be pointed at a
 * proxy that is gone. It is removed when Shroudly quits or the mode is turned
 * off, by the watchdog when Shroudly is killed, at the next login after a
 * power cut (Windows, where it would otherwise persist), when Shroudly next
 * starts, and by the uninstaller.
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MARK = 'SHROUDLY_APP_PROXY';
// This machine and the local network never go through the proxy. The CIDR
// forms are understood by curl, Go and Python; anything that does not know
// them treats them as names that never match, which is harmless.
const NO_PROXY_VALUE = 'localhost,127.0.0.1,::1,.local,.localhost,.lan,.internal,.home.arpa,' +
  '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10';
const OURS = /^http:\/\/127\.0\.0\.1:\d+$/;
const WIN_USER_ENV = 'HKCU\\Environment';
const WIN_MACHINE_ENV = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const WIN_RUNONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const WIN_RUNONCE_VALUE = 'ShroudlyAppEnvRestore';

function runSync(cmd, args, timeout = 4000) {
  return String(execFileSync(cmd, args, { timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || '');
}

function regGet(key, name) {
  try {
    const out = runSync('reg.exe', ['query', key, '/v', name]);
    const m = out.match(new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s*(.*)$`, 'mi'));
    return m ? m[1].trim() || null : null;
  } catch { return null; } // not present
}

/* Windows: tell Explorer and other running programs that the environment
 * changed. Fire and forget: PowerShell is slow to start, and the registry
 * change is what matters. */
function winBroadcast() {
  const ps = `
$sig = '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
$t = Add-Type -MemberDefinition $sig -Name Env -Namespace Shroudly -PassThru
$r = [UIntPtr]::Zero
[void]$t::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
`;
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

/* Where the variables live on this OS: get/set/del for the user's session,
 * and what a machine-wide setting already says (Windows only). */
function backend(platform = process.platform) {
  if (platform === 'darwin') {
    return {
      names: { proxy: ['HTTPS_PROXY', 'https_proxy'], noProxy: ['NO_PROXY', 'no_proxy'] },
      get: (k) => { try { return runSync('launchctl', ['getenv', k]).trim() || null; } catch { return null; } },
      set: (k, v) => { runSync('launchctl', ['setenv', k, v]); },
      del: (k) => { try { runSync('launchctl', ['unsetenv', k]); } catch {} },
      machine: () => null,
      commit: () => {},
    };
  }
  if (platform === 'win32') {
    return {
      // Windows variable names are not case-sensitive.
      names: { proxy: ['HTTPS_PROXY'], noProxy: ['NO_PROXY'] },
      get: (k) => regGet(WIN_USER_ENV, k),
      set: (k, v) => { runSync('reg.exe', ['add', WIN_USER_ENV, '/v', k, '/t', 'REG_SZ', '/d', v, '/f']); },
      del: (k) => { try { runSync('reg.exe', ['delete', WIN_USER_ENV, '/v', k, '/f']); } catch {} },
      machine: (k) => regGet(WIN_MACHINE_ENV, k),
      commit: winBroadcast,
    };
  }
  return null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class AppEnv {
  /*
   * opts.stateFile      kept while our values are set, for crash recovery
   * opts.watchdog       { execPath, script } to run proxy-watchdog.js detached
   * opts.restoreCommand { exe, args } run once at the next Windows login
   * opts.backend        stands in for the real OS (tests)
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.platform = opts.platform || process.platform;
    this.b = opts.backend !== undefined ? opts.backend : backend(this.platform);
    this.watchdog = null;
  }

  static supported(platform = process.platform) { return platform === 'darwin' || platform === 'win32'; }

  /* Our address if our values are in place, else null. */
  current() {
    const b = this.b;
    if (!b) return null;
    const mark = b.get(MARK);
    return mark && OURS.test(mark) && b.names.proxy.every((k) => b.get(k) === mark) ? mark : null;
  }

  /* A proxy someone else set, for this session or the whole machine. */
  _foreign(mark) {
    const b = this.b;
    for (const k of b.names.proxy) {
      const v = b.get(k);
      if (v && v !== mark) return true;
      if (b.machine(k)) return true;
    }
    return false;
  }

  /* Point new programs at url. Returns 'changed', 'unchanged' or 'foreign'
   * (another proxy is set; nothing was touched). Throws if the OS refuses. */
  applySync(url) {
    const b = this.b;
    if (!b) throw Object.assign(new Error('not supported on this system'), { code: 'ENOTSUP' });
    if (!OURS.test(url)) throw new Error(`not a local proxy address: ${url}`);
    const mark = b.get(MARK);
    if (this._foreign(mark && OURS.test(mark) ? mark : null)) return 'foreign';
    if (this.current() === url) { this._arm(url); return 'unchanged'; }

    this._arm(url);
    // The mark first: whatever happens after it, the cleanup can tell which
    // values are ours.
    b.set(MARK, url);
    for (const k of b.names.proxy) b.set(k, url);
    const noProxyFree = b.names.noProxy.every((k) => { const v = b.get(k); return !v || v === NO_PROXY_VALUE; }) &&
                        !b.names.noProxy.some((k) => b.machine(k));
    if (noProxyFree) for (const k of b.names.noProxy) b.set(k, NO_PROXY_VALUE);
    b.commit();
    return 'changed';
  }

  /* Remove our values; anything else is left as it is. Returns 'changed' or
   * 'unchanged'. Synchronous and quick: also used while exiting. */
  clearSync() {
    const b = this.b;
    let changed = false;
    if (b) {
      const mark = b.get(MARK);
      if (mark) {
        for (const k of b.names.proxy) if (b.get(k) === mark) { b.del(k); changed = true; }
        if (b.names.proxy.every((k) => !b.get(k))) {
          for (const k of b.names.noProxy) if (b.get(k) === NO_PROXY_VALUE) b.del(k);
        }
        b.del(MARK);
        changed = true;
      }
      if (changed) b.commit();
    }
    this._disarm();
    return changed ? 'changed' : 'unchanged';
  }

  // ── crash safety ──────────────────────────────────────────────────────────
  _arm(url) {
    const { stateFile, watchdog, restoreCommand } = this.opts;
    if (stateFile) {
      try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({ v: 1, platform: this.platform, pid: process.pid, url }));
      } catch {}
    }
    if (watchdog && stateFile && !this.watchdog) {
      try {
        this.watchdog = spawn(watchdog.execPath, [watchdog.script, stateFile, String(process.pid), 'env'], {
          detached: true, stdio: 'ignore', windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        this.watchdog.on('error', () => { this.watchdog = null; });
        this.watchdog.unref();
      } catch { this.watchdog = null; }
    }
    // Windows keeps the user's environment across restarts: if the machine
    // goes down with our value set, take it out at the next login.
    if (this.platform === 'win32' && restoreCommand && this.b && this.opts.backend === undefined) {
      const line = [restoreCommand.exe, ...restoreCommand.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
      try { runSync('reg.exe', ['add', WIN_RUNONCE_KEY, '/v', WIN_RUNONCE_VALUE, '/t', 'REG_SZ', '/d', line, '/f']); } catch {}
    }
  }

  _disarm() {
    const { stateFile } = this.opts;
    if (this.watchdog) { try { this.watchdog.kill(); } catch {} this.watchdog = null; }
    if (stateFile) { try { fs.rmSync(stateFile, { force: true }); } catch {} }
    if (this.platform === 'win32' && this.opts.backend === undefined) {
      try { runSync('reg.exe', ['delete', WIN_RUNONCE_KEY, '/v', WIN_RUNONCE_VALUE, '/f']); } catch {}
    }
  }

  /*
   * Take out values a previous run left behind (crash, kill, power loss).
   * onlyIfDead: leave them if the Shroudly that set them is still running —
   * the login hook can run after Shroudly has already started again.
   */
  static recoverSync(opts = {}, { onlyIfDead = false } = {}) {
    if (onlyIfDead && opts.stateFile) {
      try {
        const st = JSON.parse(fs.readFileSync(opts.stateFile, 'utf8'));
        if (st.pid && st.pid !== process.pid && alive(st.pid)) return false;
      } catch {}
    }
    return new AppEnv(opts).clearSync() === 'changed';
  }
}

module.exports = AppEnv;
module.exports.MARK = MARK;
module.exports.NO_PROXY_VALUE = NO_PROXY_VALUE;
module.exports.backend = backend;
