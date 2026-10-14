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
const os = require('os');
const path = require('path');
const Watchdog = require('./watchdog');

const MARK = 'SHROUDLY_APP_PROXY';
// This machine and the local network never go through the proxy. The CIDR
// forms are understood by curl, Go and Python; anything that does not know
// them treats them as names that never match, which is harmless.
const NO_PROXY_VALUE = 'localhost,127.0.0.1,::1,.local,.localhost,.lan,.internal,.home.arpa,.home,.fritz.box,' +
  '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10';
const OURS = /^http:\/\/127\.0\.0\.1:\d+$/;
const WIN_USER_ENV = 'HKCU\\Environment';
const WIN_MACHINE_ENV = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const WIN_RUNONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const WIN_RUNONCE_VALUE = 'ShroudlyAppEnvRestore';

function runSync(cmd, args, timeout = 4000) {
  return String(execFileSync(cmd, args, { timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || '');
}

/* Every string value under a key, read with one reg.exe call (names upper-
 * cased: Windows variable names are not case-sensitive). reg.exe prints
 * "    NAME    REG_SZ    data" whatever the system language. */
function parseRegQuery(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
    if (m && m[2].trim()) out.set(m[1].toUpperCase(), m[2].trim());
  }
  return out;
}

function regAll(key) {
  try { return parseRegQuery(runSync('reg.exe', ['query', key])); }
  catch { return new Map(); } // key absent or unreadable: nothing set
}

/* Windows: tell Explorer and the other running programs that the
 * environment changed, by writing the mark one last time through .NET's
 * SetEnvironmentVariable, which sends WM_SETTINGCHANGE itself: no code to
 * compile, unlike calling SendMessageTimeout from PowerShell. markValue is
 * our own loopback address or null (the mark removed). Fire and forget:
 * PowerShell takes a moment to start, and the registry is already right. */
function winBroadcast(markValue) {
  const v = markValue && OURS.test(markValue) ? `'${markValue}'` : '$null';
  const ps = `[Environment]::SetEnvironmentVariable('${MARK}', ${v}, 'User')`;
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
    // Read once per operation (refresh), not once per value: each reg.exe
    // call blocks the app for tens of milliseconds.
    let user = null; let machine = null;
    return {
      names: { proxy: ['HTTPS_PROXY'], noProxy: ['NO_PROXY'] },
      refresh: () => { user = null; machine = null; },
      get: (k) => { if (!user) user = regAll(WIN_USER_ENV); return user.get(k.toUpperCase()) || null; },
      set: (k, v) => {
        runSync('reg.exe', ['add', WIN_USER_ENV, '/v', k, '/t', 'REG_SZ', '/d', v, '/f']);
        if (user) user.set(k.toUpperCase(), v);
      },
      del: (k) => {
        try { runSync('reg.exe', ['delete', WIN_USER_ENV, '/v', k, '/f']); } catch {}
        if (user) user.delete(k.toUpperCase());
      },
      machine: (k) => { if (!machine) machine = regAll(WIN_MACHINE_ENV); return machine.get(k.toUpperCase()) || null; },
      commit: winBroadcast,
    };
  }
  return null;
}

/* When this machine last started, to the minute: a state file from another
 * boot belongs to a Shroudly that cannot still be running, whatever process
 * has its old pid now. */
function bootId() { return Math.round((Date.now() - os.uptime() * 1000) / 60000); }

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class AppEnv {
  /*
   * opts.stateFile      kept while our values are set, for crash recovery
   * opts.watchdog       watchdog.js options (the engine binary in its watchdog
   *                     mode and the restore command it runs)
   * opts.restoreCommand { exe, args } run once at the next Windows login
   * opts.backend        stands in for the real OS (tests)
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.platform = opts.platform || process.platform;
    this.b = opts.backend !== undefined ? opts.backend : backend(this.platform);
    this.applied = false;   // our values were set by this run
  }

  static supported(platform = process.platform) { return platform === 'darwin' || platform === 'win32'; }

  /* Our address if our values are in place, else null. */
  current() {
    if (this.b && this.b.refresh) this.b.refresh();
    return this._current();
  }

  _current() {
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
    if (b.refresh) b.refresh();
    const mark = b.get(MARK);
    if (this._foreign(mark && OURS.test(mark) ? mark : null)) return 'foreign';
    if (this._current() === url) { this._arm(url); this.applied = true; return 'unchanged'; }

    this._arm(url);
    // From here on something may be written, so quitting must clean up even if
    // a later step fails.
    this.applied = true;
    // The mark first: whatever happens after it, the cleanup can tell which
    // values are ours.
    b.set(MARK, url);
    for (const k of b.names.proxy) b.set(k, url);
    const noProxyFree = b.names.noProxy.every((k) => { const v = b.get(k); return !v || v === NO_PROXY_VALUE; }) &&
                        !b.names.noProxy.some((k) => b.machine(k));
    if (noProxyFree) for (const k of b.names.noProxy) b.set(k, NO_PROXY_VALUE);
    b.commit(url);
    this.applied = true;
    return 'changed';
  }

  /* Remove our values; anything else is left as it is. Returns 'changed' or
   * 'unchanged'. Synchronous and quick: also used while exiting. */
  clearSync() {
    const b = this.b;
    let changed = false;
    if (b) {
      if (b.refresh) b.refresh();
      const mark = b.get(MARK);
      if (mark) {
        for (const k of b.names.proxy) if (b.get(k) === mark) { b.del(k); changed = true; }
        if (b.names.proxy.every((k) => !b.get(k))) {
          for (const k of b.names.noProxy) if (b.get(k) === NO_PROXY_VALUE) b.del(k);
        }
        b.del(MARK);
        changed = true;
      }
      if (changed) b.commit(null);
    }
    this._disarm();
    this.applied = false;
    return changed ? 'changed' : 'unchanged';
  }

  // ── crash safety ──────────────────────────────────────────────────────────
  _arm(url) {
    const { stateFile, watchdog, restoreCommand } = this.opts;
    if (stateFile) {
      try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({ v: 1, platform: this.platform, pid: process.pid, boot: bootId(), url }));
      } catch {}
    }
    if (watchdog && stateFile) Watchdog.watch(watchdog, 'env', stateFile);
    // Windows keeps the user's environment across restarts: if the machine
    // goes down with our value set, take it out at the next login.
    if (this.platform === 'win32' && restoreCommand && this.b && this.opts.backend === undefined) {
      const line = [restoreCommand.exe, ...restoreCommand.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
      try { runSync('reg.exe', ['add', WIN_RUNONCE_KEY, '/v', WIN_RUNONCE_VALUE, '/t', 'REG_SZ', '/d', line, '/f']); } catch {}
    }
  }

  _disarm() {
    const { stateFile } = this.opts;
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
    // Is the Shroudly that wrote the state file still running? A file from
    // another boot never is, whatever process holds its old pid now.
    const owned = () => {
      try {
        const st = JSON.parse(fs.readFileSync(opts.stateFile, 'utf8'));
        const sameBoot = st.boot == null || Math.abs(st.boot - bootId()) <= 2;
        return sameBoot && st.pid && st.pid !== process.pid && alive(st.pid);
      } catch { return false; }
    };
    if (onlyIfDead && opts.stateFile && owned()) return false;
    const env = new AppEnv(opts);
    // Asked again right before acting: a Shroudly starting at login at this
    // very moment may just have taken the file over.
    if (onlyIfDead && opts.stateFile && owned()) return false;
    return env.clearSync() === 'changed';
  }
}

module.exports = AppEnv;
module.exports.MARK = MARK;
module.exports.NO_PROXY_VALUE = NO_PROXY_VALUE;
module.exports.backend = backend;
module.exports.parseRegQuery = parseRegQuery;
