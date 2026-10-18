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
 *  Windows  the session's part of the user's environment (HKCU\Volatile
 *           Environment), plus the broadcast that makes Explorer pick it up:
 *           programs started from the Start menu, the desktop or File
 *           Explorer get it. One that was already running — a browser
 *           included — keeps the environment it started with until it is
 *           restarted. Windows empties that key at logoff and it is never
 *           saved to disk, so the value cannot outlive the session: not a
 *           kill, not a power cut, not a disk image taken while it was set
 *           (shared computers that are reset at every restart). Up to 2.5.12
 *           it went to HKCU\Environment, which is kept: values of ours left
 *           there are still removed (marked, as below), and nothing is
 *           written there any more.
 *  Linux    not offered: there is no one place every desktop reads it from.
 *
 * Only our own values are ever removed. A proxy the user set themselves, for
 * their session or (Windows) for the whole machine, is never replaced.
 * SHROUDLY_APP_PROXY, set alongside, is what marks the value as ours, so even
 * another local proxy (Clash, Fiddler) on 127.0.0.1 is left alone.
 *
 * The value must not outlive Shroudly, or programs would be pointed at a
 * proxy that is gone. It is removed when Shroudly quits or the mode is turned
 * off, by the watchdog when Shroudly is killed, by the end of the session
 * (Windows) or a restart, when Shroudly next starts, and by the uninstaller.
 */

const { execFileSync, spawn } = require('child_process');
const { envFor } = require('./win-powershell');
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
// Where Shroudly writes: emptied by Windows at logoff, never saved.
const WIN_SESSION_ENV = 'HKCU\\Volatile Environment';
// Kept across restarts; where versions up to 2.5.12 wrote. Only read now (a
// proxy of the user's own, our leftovers), and only our leftovers deleted.
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

function regAll(key) { return regKey(key) || new Map(); }

/* The same, or null when the key is not there (or cannot be read). */
function regKey(key) {
  try { return parseRegQuery(runSync('reg.exe', ['query', key])); }
  catch { return null; }
}

/* Windows: tell Explorer and the other running programs that the
 * environment changed (WM_SETTINGCHANGE "Environment"), on which Explorer
 * builds its environment again from the registry, Volatile Environment
 * included. .NET's SetEnvironmentVariable sends that message itself after
 * writing HKCU\Environment: no code to compile, unlike calling
 * SendMessageTimeout from PowerShell. Asked to remove a name that is never
 * set there, it writes nothing and still sends the message (.NET Framework
 * and .NET alike), so nothing is kept. Fire and forget: PowerShell takes a
 * moment to start, and the registry is already right. Returns the process
 * (tests wait for it). */
const BROADCAST_NAME = 'SHROUDLY_ENV_BROADCAST';
function winBroadcast() {
  const ps = `[Environment]::SetEnvironmentVariable('${BROADCAST_NAME}', $null, 'User')`;
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { detached: true, stdio: 'ignore', windowsHide: true, env: envFor('powershell.exe') });
    p.on('error', () => {});
    p.unref();
    return p;
  } catch { return null; }
}

/* Where the variables live on this OS: get/set/del for the user's session;
 * what a machine-wide setting already says (Windows only); and `persistent`,
 * the user's kept environment (Windows), read for a proxy of the user's own
 * and for values an older Shroudly left there, from which only those of ours
 * are ever deleted. */
function backend(platform = process.platform) {
  if (platform === 'darwin') {
    return {
      names: { proxy: ['HTTPS_PROXY', 'https_proxy'], noProxy: ['NO_PROXY', 'no_proxy'] },
      get: (k) => { try { return runSync('launchctl', ['getenv', k]).trim() || null; } catch { return null; } },
      set: (k, v) => { runSync('launchctl', ['setenv', k, v]); },
      del: (k) => { try { runSync('launchctl', ['unsetenv', k]); } catch {} },
      machine: () => null,
      persistent: null,
      commit: () => {},
    };
  }
  if (platform === 'win32') {
    // Read once per operation (refresh), not once per value: each reg.exe
    // call blocks the app for tens of milliseconds. undefined: not read yet;
    // session null: the key is not there.
    let session; let user; let machine;
    const sessionKey = () => { if (session === undefined) session = regKey(WIN_SESSION_ENV); return session; };
    const userKey = () => { if (user === undefined) user = regAll(WIN_USER_ENV); return user; };
    return {
      names: { proxy: ['HTTPS_PROXY'], noProxy: ['NO_PROXY'] },
      refresh: () => { session = undefined; user = undefined; machine = undefined; },
      get: (k) => (sessionKey() || new Map()).get(k.toUpperCase()) || null,
      set: (k, v) => {
        // Windows creates the key at logon, volatile. reg.exe would create a
        // missing one as an ordinary, kept key: never written then.
        if (!sessionKey()) throw Object.assign(new Error('this session has no volatile environment'), { code: 'ENOTSUP' });
        runSync('reg.exe', ['add', WIN_SESSION_ENV, '/v', k, '/t', 'REG_SZ', '/d', v, '/f']);
        session.set(k.toUpperCase(), v);
      },
      del: (k) => {
        try { runSync('reg.exe', ['delete', WIN_SESSION_ENV, '/v', k, '/f']); } catch {}
        if (session) session.delete(k.toUpperCase());
      },
      machine: (k) => { if (machine === undefined) machine = regAll(WIN_MACHINE_ENV); return machine.get(k.toUpperCase()) || null; },
      persistent: {
        get: (k) => userKey().get(k.toUpperCase()) || null,
        del: (k) => {
          try { runSync('reg.exe', ['delete', WIN_USER_ENV, '/v', k, '/f']); } catch {}
          if (user) user.delete(k.toUpperCase());
        },
      },
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

/* Is that process still the program named `exe` (Shroudly)? A process id
 * from an earlier run may belong to something else by now: Windows' fast
 * startup keeps the boot time across a shutdown, and ids are reused. Taken
 * to be when the name cannot be read or was not recorded. */
function sameProgram(pid, exe, platform = process.platform) {
  const name = String(exe || '').toLowerCase().slice(0, 15); // ps shows 15 characters on Linux
  if (!name) return true;
  let out;
  try {
    out = platform === 'win32'
      ? runSync('tasklist.exe', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], 3000)
      : runSync('ps', ['-o', 'comm=', '-p', String(pid)], 3000);
  } catch { return true; }
  return String(out).toLowerCase().includes(name);
}

/* Take the values marked as ours out of one store ({ get, del }): the proxy
 * names that still hold our address, NO_PROXY if it is ours and no proxy is
 * left, and the mark. True if there was a mark. */
function removeOurs(store, names) {
  const mark = store.get(MARK);
  if (!mark) return false;
  for (const k of names.proxy) if (store.get(k) === mark) store.del(k);
  if (names.proxy.every((k) => !store.get(k))) {
    for (const k of names.noProxy) if (store.get(k) === NO_PROXY_VALUE) store.del(k);
  }
  store.del(MARK);
  return true;
}

class AppEnv {
  /*
   * opts.stateFile      kept while our values are set, for crash recovery
   * opts.watchdog       watchdog.js options (the engine binary in its watchdog
   *                     mode and the restore command it runs)
   * opts.backend        stands in for the real OS (tests)
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.platform = opts.platform || process.platform;
    this.b = opts.backend !== undefined ? opts.backend : backend(this.platform);
    this.applied = false;   // our values were set by this run
    this.broadcast = null;  // what the last change announcement returned (Windows: its process)
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

  /* A proxy someone else set: for this session, kept in the user's
   * environment, or for the whole machine. */
  _foreign(mark) {
    const b = this.b;
    for (const k of b.names.proxy) {
      const v = b.get(k);
      if (v && v !== mark) return true;
      if (this._elsewhere(k)) return true;
    }
    return false;
  }

  /* What the places we never write to say about k. */
  _elsewhere(k) {
    const b = this.b;
    return b.machine(k) || (b.persistent && b.persistent.get(k)) || null;
  }

  /* Values of ours that versions up to 2.5.12 kept in the user's environment
   * (Windows): removed, the user's own left alone. True if any were. */
  _migrate() {
    const p = this.b && this.b.persistent;
    return p ? removeOurs(p, this.b.names) : false;
  }

  /* Point new programs at url. Returns 'changed', 'unchanged' or 'foreign'
   * (another proxy is set; nothing was touched). Throws if the OS refuses. */
  applySync(url) {
    const b = this.b;
    if (!b) throw Object.assign(new Error('not supported on this system'), { code: 'ENOTSUP' });
    if (!OURS.test(url)) throw new Error(`not a local proxy address: ${url}`);
    if (b.refresh) b.refresh();
    // An older Shroudly's leftovers first, so they are neither taken for the
    // user's own proxy nor kept next to the new values.
    const migrated = this._migrate();
    const mark = b.get(MARK);
    if (this._foreign(mark && OURS.test(mark) ? mark : null)) {
      if (migrated) this._commit(null);
      return 'foreign';
    }
    if (this._current() === url) {
      if (migrated) this._commit(url);
      this._arm(url); this.applied = true; return 'unchanged';
    }

    this._arm(url);
    // From here on something may be written, so quitting must clean up even if
    // a later step fails.
    this.applied = true;
    // The mark first: whatever happens after it, the cleanup can tell which
    // values are ours.
    b.set(MARK, url);
    for (const k of b.names.proxy) b.set(k, url);
    const noProxyFree = b.names.noProxy.every((k) => { const v = b.get(k); return !v || v === NO_PROXY_VALUE; }) &&
                        !b.names.noProxy.some((k) => this._elsewhere(k));
    if (noProxyFree) for (const k of b.names.noProxy) b.set(k, NO_PROXY_VALUE);
    this._commit(url);
    this.applied = true;
    return 'changed';
  }

  /* Remove our values, and an older Shroudly's from the user's kept
   * environment; anything else is left as it is. Returns 'changed' or
   * 'unchanged'. Synchronous and quick: also used while exiting. */
  clearSync() {
    const b = this.b;
    let changed = false;
    if (b) {
      if (b.refresh) b.refresh();
      changed = removeOurs(b, b.names);
      if (this._migrate()) changed = true;
      if (changed) this._commit(null);
    }
    this._disarm();
    this.applied = false;
    return changed ? 'changed' : 'unchanged';
  }

  _commit(url) { this.broadcast = this.b.commit(url) || null; }

  // ── crash safety ──────────────────────────────────────────────────────────
  _arm(url) {
    const { stateFile, watchdog } = this.opts;
    if (stateFile) {
      try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({ v: 1, platform: this.platform, pid: process.pid, boot: bootId(), exe: path.basename(process.execPath), url }));
      } catch {}
    }
    if (watchdog && stateFile) Watchdog.watch(watchdog, 'env', stateFile);
    // Nothing for the next login (Windows): the session's environment is
    // gone by then. Versions up to 2.5.12 left a login entry, taken out below.
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
        return sameBoot && st.pid && st.pid !== process.pid && alive(st.pid) && sameProgram(st.pid, st.exe);
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
module.exports.BROADCAST_NAME = BROADCAST_NAME;
