'use strict';

/*
 * Cross-platform system proxy control.
 *
 * The engine exposes a local SOCKS5 proxy on 127.0.0.1:<port>. To route traffic
 * through it we point the OS/browser proxy at it. If that setting outlives the
 * engine, the user has no internet, so restoring it is the most important job
 * here, and it must survive every way Shroudly can end:
 *
 *   clean stop / quit       restore() with the snapshot taken before applying
 *   engine crash            EngineManager restores before restarting it
 *   app killed / crashed    a detached watchdog (the engine binary's watchdog
 *                           mode, see watchdog.js) learns the app is gone at
 *                           once (the pipe to it closes) and starts
 *                           "Shroudly --restore-proxy" within a second
 *   reboot / power loss     a run-once login hook starts "Shroudly --restore-proxy"
 *                           (Windows RunOnce, Linux autostart, macOS LaunchAgent)
 *   next launch             EngineManager.recover() restores from the state file
 *   uninstall / update      the NSIS installer resets a leftover Shroudly proxy
 *
 * The snapshot lives in a state file so any of these can restore the user's
 * exact previous settings. A restore puts back only what still points at our
 * proxy, so it never undoes a change the user (or another program) made since.
 *
 * While protection is on, the setting is read back every so often. Another
 * program removing it, or putting a PAC of its own on this computer in its
 * place, has it set back, every time, and one line says so; a manual proxy or
 * a PAC elsewhere chosen meanwhile is left alone and reported; a program that
 * answers every set-back by taking it again at once is left to it after the
 * third time in a row, and named when it can be (checkOwnership).
 *
 * A user's own PAC or manual proxy from before Shroudly that is served on
 * this computer is put back only while something still listens there: one
 * whose program has gone is switched off instead, its address kept, never
 * left pointing at nothing (macOS, GNOME, KDE; _pacGone).
 *
 * Every system is pointed at the same thing: a PAC file served over loopback
 * HTTP, set as the system's automatic proxy configuration. It is the one
 * setting through which every browser speaks SOCKS5 to us with the name, not
 * an address looked up on the censored network: Firefox reads a system
 * "SOCKS proxy" as SOCKS4 with local DNS, and WinINET as SOCKS4, which is why
 * the earlier direct SOCKS settings are no longer used.
 *
 * Windows : WinINET per-user AutoConfigURL (HKCU, no admin), via reg.exe (fast
 *           and synchronous, unlike PowerShell, so it also works while
 *           exiting). WinINET refuses file:// PAC URLs, hence the HTTP server.
 * macOS   : `networksetup -setautoproxyurl` on every service. An administrator
 *           account may do this without a password; a Standard account may
 *           not, and is told so ('needs_admin') instead of being reported
 *           routed. applyAsAdmin() then does it once with the administrator's
 *           password, and leaves behind a root helper that puts the settings
 *           back when Shroudly stops, so stopping needs no second password.
 * Linux   : GNOME-family desktops through gsettings, KDE Plasma through
 *           kioslaverc: the desktops on which Chromium reads those. XFCE,
 *           LXQt and other desktops have no system proxy. Chromium browsers
 *           there read the auto_proxy environment variable, once, when they
 *           start, so it is written where the next login picks it up (see
 *           "Linux desktops without a proxy setting" below). GNOME's setting
 *           is set there too, for Firefox, which reads it on any desktop.
 */

const { execFile, execFileSync, spawn } = require('child_process');
const { envFor } = require('./win-powershell');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Watchdog = require('./watchdog');
const procnet = require('./procnet');

const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const WIN_VALUES = ['ProxyEnable', 'ProxyServer', 'AutoConfigURL', 'ProxyOverride'];
const WIN_RUNONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const WIN_RUNONCE_VALUE = 'ShroudlyProxyRestore';
// What 2.5.4 and earlier wrote in 'all' mode besides the PAC. Still recognised
// so a proxy left by those versions is taken out.
const WIN_LEGACY_SERVER = /^socks=127\.0\.0\.1:\d+$/;
const WIN_LEGACY_OVERRIDE = '<local>;127.*;10.*;172.16.*;192.168.*;localhost';
const MAC_AGENT_LABEL = 'me.codeshare.shroudly.proxy-restore';
const MAC_NETWORKSETUP = '/usr/sbin/networksetup';
// The only networksetup verbs ever run with the administrator's password.
const MAC_ELEVATED_VERBS = new Set(['-setautoproxyurl', '-setautoproxystate', '-setsocksfirewallproxy', '-setsocksfirewallproxystate']);
// The manual proxies of a service, as read for the record (prevManual).
const MAC_MANUAL = [['secure', '-getsecurewebproxy'], ['web', '-getwebproxy'], ['socks', '-getsocksfirewallproxy']];
// Whether something still listens where the user's own PAC was served, in the
// root helper's restore (see _pacGone).
const MAC_NC = '/usr/bin/nc';
const KDE_GROUP = 'Proxy Settings';
const KDE_TYPE = 'ProxyType';
const KDE_SCRIPT = 'Proxy Config Script';
// Any case: a settings window that writes the address back in capitals is
// still pointing at us.
const OUR_PAC = /^http:\/\/127\.0\.0\.1:\d+\/proxy\.pac$/i;
// The PAC's port: the first free one of these. Below the ports every system
// hands out at random (Linux 32768 and up, Windows and macOS 49152 and up),
// so a program that happens to hold one at the next login cannot move an
// address written for that login, and clear of Shroudly's own (the engine's
// 10808 and the 20 after it, the Discord relay's 10809, Games and apps'
// 10810). Each user of the computer starts at another place in it, so two
// people's Shroudly rarely meet on one port.
const PAC_PORT_FIRST = 10840;
const PAC_PORT_COUNT = 20;
// What the PAC answers while protection is off and Shroudly still runs, on
// desktops where browsers keep its address (see _parkPacServer).
const PAC_DIRECT = 'function FindProxyForURL(url, host) {\n  return "DIRECT";\n}\n';
// How often the setting is read back while applied. Windows: one reg.exe
// query, so often, which keeps the time traffic goes around Shroudly after a
// takeover short; elsewhere one or more networksetup or gsettings calls.
const OWNERSHIP_INTERVAL_MS = 60000;
const OWNERSHIP_INTERVAL_WIN_MS = 20000;
// Another program taking the setting over is answered by setting it back,
// every time, unless it is answering Shroudly: it took it again within
// FIGHT_WINDOW_MS of each set-back, RETAKE_LIMIT times in a row. Then it is
// fighting for it, and Shroudly stops and says so instead of trading places
// with it for as long as both run. A program that answers a change does so
// as soon as it sees it: one that watches the setting at once, one that reads
// it every few seconds within those seconds, and after a set-back the setting
// is read again within the window (RETAKE_LOOKS_MS) to see it. The takeovers
// in issue #27, each by something starting with Discord, came a minute and
// more apart, 66 s at the closest: 30 s stays well clear of them, and a
// takeover that follows a program start Shroudly saw (checkSoon) never counts.
const FIGHT_WINDOW_MS = 30000;
const RETAKE_LIMIT = 3;
const RETAKE_LOOKS_MS = [3000, 12000, 25000];
// A takeover is read again this long after it was first seen, before
// anything is set back: a program in the middle of changing several values
// has finished by then, and a value that was only gone for a moment is back.
const TAKEOVER_CONFIRM_MS = 1500;
// What is set back by itself (see checkOwnership).
const RETAKE_KINDS = new Set(['cleared', 'local', 'ours']);
// macOS, administrator path: how long a restore waits for the root helper
// before doing anything itself (it never asks for the password while the
// helper is still at work), and how long the exit path waits at most: it
// never asks at all, and the helper finishes on its own once the app is gone.
const MAC_HELPER_WAIT_MS = 30000;
const MAC_HELPER_WAIT_SYNC_MS = 1000;
// The administrator password dialog says who asks and why; without it macOS
// shows "osascript wants to make changes".
const MAC_ADMIN_PROMPT = {
  apply: 'Shroudly needs an administrator\'s password to point this Mac\'s network proxy settings at it. Stopping protection will not ask again.',
  restore: 'Shroudly needs an administrator\'s password to put this Mac\'s network proxy settings back.',
};
// Linux desktops on which Chromium reads only the environment (see
// linuxDesktop), and what is written for them.
const ENV_DESKTOPS = new Set(['xfce', 'lxqt', 'other']);
const ENV_VAR = 'auto_proxy';
const ENVD_FILE = '90-shroudly.conf';
const XPROFILE_BEGIN = '# >>> Shroudly (removed automatically) >>>';
const XPROFILE_END = '# <<< Shroudly <<<';
const XPROFILE_EXPORT = /^export auto_proxy='http:\/\/127\.0\.0\.1:\d+\/proxy\.pac'$/;
// Our block in ~/.xprofile, whole: the three lines in a row (_xprofileRange).
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const XPROFILE_BLOCK = new RegExp(`(^|\\n)(${reEsc(XPROFILE_BEGIN)}\\n${XPROFILE_EXPORT.source.slice(1, -1)}\\n${reEsc(XPROFILE_END)}(?:\\n|$))`);
const LXQT_GROUP = 'Environment';

/* onChild(child) is handed the process: a restore that comes while a
 * set-back's command runs stops it, so it cannot write after the restore
 * (_retake). */
function run(cmd, args, timeout = 8000, onChild = null) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve(String(stdout || ''));
    });
    if (onChild) onChild(child);
  });
}

function runSync(cmd, args, timeout = 4000) {
  return String(execFileSync(cmd, args, { timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || '');
}

function spawnDetached(cmd, args) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env: envFor(cmd) });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

/* A process of another user (the root helper) answers kill(0) with EPERM.
 * One that has exited but was never waited for (its parent gone, and a first
 * process that reaps nothing, as in a container) answers too: it is not
 * running. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s[s.lastIndexOf(')') + 2] !== 'Z'; } catch { return true; }
}

/* Waiting without an event loop, for the exit and recovery paths. */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/* Linux: which boot of the machine this is. */
function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; }
}

/* Everything that reaches outside the process goes through here, so the tests
 * can stand in for reg.exe, networksetup, gsettings and kwriteconfig, and for
 * what listens on this computer (listening: true, false, or null when it
 * cannot be told). */
const REAL_EXEC = { run, runSync, spawnDetached, alive, sleepSync, bootId, listening: (port) => procnet.listeningSync(port) };
let exec = REAL_EXEC;

/* Shell-quote one argument for /bin/sh: everything literal. */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/* When this machine started, in seconds: a process id recorded before a
 * restart of the Mac names some other process now. */
function bootTime() { return Math.round(Date.now() / 1000 - os.uptime()); }

/* A file only one process at a time may hold (the restore's password
 * dialog). Taken over when the process that made it is gone. */
function takeLock(file) {
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') return false;
      const pid = parseInt(String(fs.readFileSync(file, 'utf8')), 10) || 0;
      if (pid && (pid === process.pid || exec.alive(pid))) return false;
      try { fs.rmSync(file, { force: true }); } catch { return false; }
    }
  }
  return false;
}

function dropLock(file) {
  try { if (parseInt(fs.readFileSync(file, 'utf8'), 10) === process.pid) fs.rmSync(file, { force: true }); } catch {}
}

/* Read a file, null when it is not there. */
function readOrNull(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

/* Write a file whole or not at all: a temporary file next to it, flushed to
 * the disk, then renamed over it. A full disk, a quota or a power cut can
 * then never leave half of ~/.xprofile (which the login runs) or of the
 * state file behind. A symbolic link (a dotfile manager's) is followed, so
 * the file it points at is the one replaced, and a file that is there keeps
 * its permissions. Throws when it could not be written; the file is then as
 * it was. */
function writeAtomic(file, text, mode = 0o644) {
  let target = file;
  try { target = fs.realpathSync(file); } catch {}
  try { mode = fs.statSync(target).mode & 0o7777; } catch {}
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.shroudly-${process.pid}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try { fs.chmodSync(tmp, mode); } catch {} // the mode open() gave was cut by the umask
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, target); break; } catch (e) {
        // Windows: a virus scanner or the indexer holding the old file a moment.
        if (process.platform !== 'win32' || i >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        exec.sleepSync(50);
      }
    }
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  // The rename reaches the disk with the folder's own entry.
  try { const d = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {}
}

// ── Windows registry (reg.exe) ───────────────────────────────────────────
function regParse(name, out) {
  const m = String(out).match(new RegExp(`^\\s*${name}\\s+(REG_\\w+)\\s*(.*)$`, 'mi'));
  return m ? { type: m[1], data: m[2].trim() } : null;
}
function regGet(name) {
  try { return regParse(name, exec.runSync('reg.exe', ['query', WIN_KEY, '/v', name])); }
  catch { return null; } // value not present
}
function regSet(name, type, data) {
  exec.runSync('reg.exe', ['add', WIN_KEY, '/v', name, '/t', type, '/d', String(data), '/f']);
}
function regDel(name) {
  try { exec.runSync('reg.exe', ['delete', WIN_KEY, '/v', name, '/f']); } catch {}
}

class SystemProxy {
  /*
   * opts.stateFile      where the snapshot is kept while the proxy is applied
   * opts.watchdog       watchdog.js options (the engine binary in its watchdog
   *                     mode and the restore command it runs)
   * opts.restoreCommand { exe, args } run once at next login if we never restore
   * opts.onOwnership    (owned, { lost, takeover, gaveUp, by }) when another
   *                     program takes the system proxy over while we are
   *                     applied and it is left to it, and when it comes back
   *                     (see checkOwnership)
   * opts.whoTookIt      async (takeover) => names of the programs that most
   *                     likely did it, for the line said when Shroudly stops
   *                     setting it back
   * opts.autoRetake     false: a takeover is only reported, never set back
   * opts.portStore      { get(), set(port) }: the PAC's port, kept from run to
   *                     run on Linux desktops where its address is written for
   *                     the next login
   * opts.envStateFile   what was written for the next login (default: next to
   *                     stateFile)
   * opts.adminPrompt    (kind: 'apply' | 'restore') => the sentence macOS's
   *                     password dialog shows; English when it returns nothing
   * opts.helperWaitMs   how long a restore waits for the macOS root helper
   */
  constructor(log, opts = {}) {
    this.log = log || (() => {});
    this.platform = opts.platform || process.platform;
    this.env = opts.env || process.env;
    this.stateFile = opts.stateFile || null;
    this.watchdogOpts = opts.watchdog || null;
    this.restoreCommand = opts.restoreCommand || null;
    this.onOwnership = opts.onOwnership || null;
    this.whoTookIt = opts.whoTookIt || null;
    this.autoRetake = opts.autoRetake !== false;
    this.ownershipIntervalMs = opts.ownershipIntervalMs || (this.platform === 'win32' ? OWNERSHIP_INTERVAL_WIN_MS : OWNERSHIP_INTERVAL_MS);
    this.takeoverConfirmMs = opts.takeoverConfirmMs ?? TAKEOVER_CONFIRM_MS;
    this.fightWindowMs = opts.fightWindowMs || FIGHT_WINDOW_MS;
    this.retakeLimit = opts.retakeLimit || RETAKE_LIMIT;
    this.retakeLooksMs = opts.retakeLooksMs || RETAKE_LOOKS_MS;
    this._now = opts.now || Date.now; // tests: the clock a fight is timed by
    this.portStore = opts.portStore || null;
    this.envStateFile = opts.envStateFile || SystemProxy._envStateFileFor(opts.stateFile);
    this.adminPrompt = opts.adminPrompt || null;
    this.helperWaitMs = opts.helperWaitMs || MAC_HELPER_WAIT_MS;
    this._restoring = false;        // a restore is under way: the takeover check keeps quiet
    this._adminInFlight = null;     // the administrator password dialog is open
    this._adminDeclined = false;    // the last restore's password dialog was dismissed or refused
    this._inherited = null;         // a state file this run found, not made
    this._queue = Promise.resolve(); // apply() and restore(), one at a time
    this._lost = [];                // what another program took over (see checkOwnership)
    this.applied = false;
    this.snapshot = null;
    this.status = null;
    this.pacServer = null;
    this.pacPort = 0;
    this.pacUrl = null;
    this.socksPort = 0;
    this.mode = 'all';   // 'all' | 'listed'
    this.list = [];      // domains routed through the proxy in 'listed' mode
    this._ownTimer = null;
    this._owned = true;
    this._fight = 0;        // takeovers in a row, each an answer to a set-back (see checkOwnership)
    this._retakenAt = 0;    // when Shroudly last set it back
    this._gaveUp = false;   // it kept answering, and is no longer answered
    this._soon = [];        // checks asked for ahead of the timer (checkSoon)
    this._retaking = null;  // a set-back under way (see _retake)
    this._gone = new Map(); // the user's PACs found no longer served (see _pacGone)
  }

  /* Tests only: stand-ins for the commands above. null puts the real ones back. */
  static _setExec(fake) { exec = fake ? { ...REAL_EXEC, ...fake } : REAL_EXEC; }

  /* A plain hostname: ASCII letters, digits, hyphens and dots, at least two
   * labels, each label 1-63 characters, 253 overall. Deliberately strict —
   * this is the same rule the settings screen shows the user, so what they see
   * accepted is exactly what ends up routing their traffic. */
  static isHostname(d) {
    if (typeof d !== 'string' || d.length < 3 || d.length > 253) return false;
    if (!/^[a-z0-9.-]+$/.test(d)) return false;
    if (d.startsWith('.') || d.endsWith('.') || d.includes('..')) return false;
    const labels = d.split('.');
    if (labels.length < 2) return false;
    return labels.every((l) => l.length >= 1 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-'));
  }

  /* What a routed host gets. No DIRECT where the system setting decides
   * (Windows, macOS, GNOME, KDE): with DIRECT as a fallback, any failed proxy
   * connection made Chromium quietly go around Shroudly and mark it bad for
   * five minutes, so blocked sites failed with no sign of why. Stopping puts
   * the system setting back there, and Chromium reads it again at once.
   *
   * XFCE, LXQt and other desktops are the exception: "...; DIRECT". There
   * Chromium browsers and apps (Chrome, Brave, VS Code, Slack, Discord) read
   * our PAC's address from the environment they started with, which nothing
   * can change while they run, and keep the PAC they fetched for up to
   * twelve hours. Without DIRECT, a stop, a quit or a crash would leave every
   * one of them without internet until restarted. With it, a dead SOCKS port
   * on 127.0.0.1 is refused at once and they go direct straight away; the
   * cost is the five minutes Chromium then avoids the proxy after a single
   * failed connection, which is accepted on these desktops only.
   *
   * A plain "SOCKS" entry follows the "SOCKS5" one everywhere, because many
   * clients do not understand "SOCKS5" in a PAC and need "SOCKS":
   *   - macOS CFNetwork apps (Safari, …) ignore "SOCKS5" but take "SOCKS",
   *     which they speak as SOCKS5 with the name resolved by us;
   *   - Java, WinINET and .NET on Windows only know "PROXY", "SOCKS" and
   *     "DIRECT" — given "SOCKS5" alone they fail. A Java program that reads
   *     the system proxy at start-up throws "unknown protocol: socket" on
   *     every boot, which users saw as Shroudly breaking their computer.
   * The engine accepts SOCKS4 and 4a (core/src/engine.c), so "SOCKS" works:
   * Chromium and Firefox read it as SOCKS4 and use it only after the "SOCKS5"
   * entry (which they prefer) fails. Its one weakness is that the client looks
   * the name up itself through the system resolver, so a forged answer is only
   * caught when the engine knows that address as a block page or sinkhole (it
   * then recovers the real name from the request). That is a fair trade for
   * routing every client instead of breaking Java/WinINET/.NET apps.
   *
   * DIRECT is added only on env desktops (XFCE, LXQt, …): see above. */
  pacProxy(port) {
    const both = `SOCKS5 127.0.0.1:${port}; SOCKS 127.0.0.1:${port}`;
    return this._envDesktop() ? `${both}; DIRECT` : both;
  }

  /* A Linux desktop on which Chromium reads only the environment. */
  _envDesktop() {
    return this.platform === 'linux' && ENV_DESKTOPS.has(SystemProxy.linuxDesktop(this.env));
  }

  /* A PAC that always sends local/private hosts direct. In 'all' mode every
   * other host goes through the proxy; in 'listed' mode only the domains in
   * this.list (and their subdomains) do, everything else goes direct. */
  pacBody(port) {
    const proxy = this.pacProxy(port);
    /* Anything on this machine or this network never goes through the engine.
     * The previous list only covered 172.16, leaving the other fifteen private
     * /16s inside 172.16/12 — plus link-local and carrier-grade NAT, which is
     * what a phone hotspot or a mobile router hands out — to be relayed for no
     * reason. isInNet is the right tool for ranges; the shExpMatch forms only
     * work for whole leading octets. */
    const local = `  if (isPlainHostName(host) ||
      shExpMatch(host, "localhost") || shExpMatch(host, "*.local") ||
      shExpMatch(host, "*.localhost") || shExpMatch(host, "*.home.arpa") ||
      shExpMatch(host, "*.internal") || shExpMatch(host, "*.lan")) {
    return "DIRECT";
  }
  if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host) && (
      isInNet(host, "127.0.0.0", "255.0.0.0") ||
      isInNet(host, "10.0.0.0", "255.0.0.0") ||
      isInNet(host, "172.16.0.0", "255.240.0.0") ||
      isInNet(host, "192.168.0.0", "255.255.0.0") ||
      isInNet(host, "169.254.0.0", "255.255.0.0") ||
      isInNet(host, "100.64.0.0", "255.192.0.0"))) {
    return "DIRECT";
  }
  if (host.indexOf(":") !== -1) { return "DIRECT"; }`;
    if (this.mode === 'listed') {
      // Clean the list to bare domains, dedupe, and embed as a JS array.
      // Anything that is not a plain hostname is dropped rather than embedded:
      // this file decides the route for EVERY request the browser makes, so an
      // entry that broke its syntax would not merely be ignored — it would stop
      // the browser resolving a proxy at all, and all browsing with it.
      const domains = [...new Set((this.list || [])
        .map((d) => String(d).trim().toLowerCase().replace(/^\*?\.?/, '').replace(/\/.*$/, ''))
        .filter((d) => SystemProxy.isHostname(d)))];
      // A lookup table, checked once per label of the host (a.b.example.com,
      // b.example.com, example.com, com): a few lookups per request however
      // long the list is, where a scan of thousands of names would run on
      // every single request the browser makes.
      const table = {};
      for (const d of domains) table[d] = 1;
      return `var SHROUDLY_LIST = ${JSON.stringify(table)};
function FindProxyForURL(url, host) {
${local}
  var h = ("" + host).toLowerCase();
  while (true) {
    if (SHROUDLY_LIST.hasOwnProperty(h)) return "${proxy}";
    var i = h.indexOf(".");
    if (i < 0) break;
    h = h.substring(i + 1);
  }
  return "DIRECT";
}
`;
    }
    return `function FindProxyForURL(url, host) {
${local}
  return "${proxy}";
}
`;
  }

  /* The PAC's ports, in the order tried (see PAC_PORT_FIRST). */
  static pacPorts() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    return Array.from({ length: PAC_PORT_COUNT }, (_, i) => PAC_PORT_FIRST + ((uid + i) % PAC_PORT_COUNT));
  }

  /* Serve the PAC over loopback HTTP so WinINET (and others) will load it.
   * On `prefer` when it is free (an address written for the next login has
   * to stay right), otherwise on the first free one of pacPorts(), and only
   * when all of those are taken on any free port. A server still up from
   * before (kept answering DIRECT while protection was off) is the same
   * address, and serves the new PAC. Returns the PAC URL. */
  async startPacServer(socksPort, prefer = 0) {
    this.pacText = this.pacBody(socksPort);
    if (this.pacServer && this.pacServer.listening && (!prefer || prefer === this.pacPort)) return this.pacUrl;
    this.stopPacServer();
    const listen = (port) => new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
        res.end(this.pacText);
      });
      server.once('error', reject);
      // bound to loopback only; port 0 => the OS picks a free one
      server.listen(port, '127.0.0.1', () => resolve(server));
    });
    const tries = [...new Set([prefer, ...SystemProxy.pacPorts()].filter((p) => p > 0 && p < 65536)), 0];
    let server = null;
    for (const p of tries) {
      try { server = await listen(p); break; } catch (e) { if (p === 0) throw e; }
    }
    server.on('error', () => {});
    this.pacServer = server;
    this.pacPort = server.address().port;
    this.pacUrl = `http://127.0.0.1:${this.pacPort}/proxy.pac`;
    return this.pacUrl;
  }

  stopPacServer() {
    if (this.pacServer) { try { this.pacServer.close(); } catch {} this.pacServer = null; }
  }

  /* Protection is off and Shroudly runs on. On XFCE, LXQt and other desktops
   * Chromium browsers and apps keep our PAC's address from the environment
   * they started with: the PAC stays up there, answering DIRECT for
   * everything, so one that reads it again goes straight out. Elsewhere the
   * system setting is back, and it closes. */
  _parkPacServer() {
    if (this.pacServer && this._envDesktop()) { this.pacText = PAC_DIRECT; return; }
    this.stopPacServer();
  }

  /* A new site list while "only listed sites" is applied: the PAC at the same
   * address now answers with it. Nothing in the system settings changes, so
   * nothing is switched off and on; browsers read the PAC again on their own
   * schedule (Chromium within hours, and on any network change). */
  updateList(list) {
    if (!this.applied || this.mode !== 'listed' || !this.pacServer) return false;
    this.list = Array.isArray(list) ? list : [];
    this.pacText = this.pacBody(this.socksPort);
    return true;
  }

  /* A new route mode or list served from the same PAC, with no system change.
   * Both modes are the same system setting now; EngineManager uses this where
   * re-applying would cost something, such as a second administrator
   * password on macOS. */
  updateRouting(mode, list) {
    if (!this.applied || !this.pacServer) return false;
    this.mode = mode === 'listed' ? 'listed' : 'all';
    this.list = Array.isArray(list) ? list : [];
    this.pacText = this.pacBody(this.socksPort);
    if (this.snapshot) this.snapshot.appliedMode = this.mode;
    return true;
  }

  /* The engine came back on another port while the system setting was kept
   * (a macOS setting made with an administrator's password survives engine
   * restarts, see EngineManager): the PAC, at the same address, now names
   * the new port. */
  updatePort(port) {
    if (!this.applied || !this.pacServer || !(port > 0)) return false;
    this.socksPort = port;
    this.pacText = this.pacBody(port);
    if (this.status) this.status = { ...this.status, socks: `127.0.0.1:${port}` };
    this._saveState();
    return true;
  }

  /*
   * Point the system at the engine. Returns what happened, for the window to
   * act on:
   *   { ok, code, system, pacUrl, socks, partial?, detail?, ... }
   *   code 'ok'               the system proxy points at Shroudly (on XFCE,
   *                           LXQt and other desktops: Firefox through GNOME's
   *                           setting, and Chromium browsers because this
   *                           session already has our auto_proxy)
   *        'partial_env'      XFCE, LXQt and other desktops, some of it:
   *                           { firefox, chromiumNow, chromiumAfterRelogin,
   *                           chromiumNotTaken }
   *        'no_system_proxy'  one of those desktops, and nothing could be set
   *                           (chromiumNotTaken: this session does not read
   *                           what is written for the next login)
   *        'needs_admin'      macOS Standard account: applyAsAdmin() asks for
   *                           an administrator's password and does it
   *        'apply_failed'     the desktop refused the change; nothing is left
   *                           changed
   *   chromiumRestart, with 'ok' and 'partial_env' on those desktops: see
   *   _envStatus
   * The PAC server and SOCKS address stay up in every case, for programs
   * pointed at them by hand. Throws only when nothing could be undone either.
   *
   * Called while already applied (an engine restart that kept the system
   * setting): the PAC at the same address answers with the new port and
   * routing, and nothing else changes. A setting another program took over
   * meanwhile is still reported as such ('replaced'), not as set.
   *
   * apply() and restore() run one at a time, in the order they were called:
   * a Stop during a re-apply restores after it, never in the middle of it,
   * and two calls at once can never start two PAC servers.
   */
  apply(port, mode = 'all', list = []) { return this._serial(() => this._apply(port, mode, list)); }

  restore(opts = {}) { return this._serial(() => this._restore(opts)); }

  _serial(fn) {
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async _apply(port, mode, list) {
    if (this.applied) {
      if (port && port !== this.socksPort) this.updatePort(port);
      this.updateRouting(mode, list);
      if (this._owned === false && this.status) return { ...this.status, ok: false, code: 'replaced', lost: this._lost, replacedFrom: this.status };
      return this.status;
    }
    this.socksPort = port;
    this.mode = mode === 'listed' ? 'listed' : 'all';
    this.list = Array.isArray(list) ? list : [];
    // A state file still here was left by a restore that needed a password
    // nobody gave, or a crash recovery could not undo: it is the only record
    // of the user's own settings while our old PAC is still set. The new
    // snapshot carries those values over, and it is never deleted unless
    // this run takes over everything in it (see _unarm).
    this._inherited = this._readState();
    if (this.platform === 'darwin') await this._settleInheritedHelper();
    // Where the PAC's address is written for the next login, it keeps its
    // port from run to run.
    const desktop = this.platform === 'linux' ? SystemProxy.linuxDesktop(this.env) : null;
    const stable = ENV_DESKTOPS.has(desktop) && !!this.portStore;
    let want = 0;
    if (stable) { try { want = Number(this.portStore.get()) | 0; } catch {} }
    await this.startPacServer(port, want);
    if (stable && this.pacPort !== want) {
      try { this.portStore.set(this.pacPort); } catch {}
      if (want) this.log('warning', 'The address browsers use to reach Shroudly had to change; Chrome and other Chromium browsers follow the new one after you log out and back in');
    }
    let status;
    try {
      if (this.platform === 'win32') status = this._applyWindows();
      else if (this.platform === 'darwin') status = await this._applyMac();
      else status = await this._applyLinux();
    } catch (e) {
      // Undo whatever part was applied before failing.
      this.applied = true;
      this.restoreSync();
      throw e;
    }
    this.applied = true;
    this.status = { ...status, pacUrl: this.pacUrl, socks: `127.0.0.1:${port}` };
    if (status.ok) this.log('success', `System routed through local proxy on port ${port}`);
    // Some browsers covered now or after the next login: information. Chrome
    // and its kind not at all: a warning.
    else if (status.code === 'partial_env') this.log(status.chromiumNow || status.chromiumAfterRelogin ? 'info' : 'warning', status.detail);
    else this.log('warning', `${status.detail || 'The system proxy was not set.'} Apps can still use SOCKS5 127.0.0.1:${port} directly (PAC: ${this.pacUrl}).`);
    if (status.ok || status.partial) this._startOwnershipWatch();
    return this.status;
  }

  /* Returns false when something could not be put back; the state file then
   * stays, so the watchdog or the next start tries again.
   * opts.interactive: the user pressed Stop, so a macOS restore that needs
   * the administrator's password may ask for it. Never while quitting or
   * after a crash: the state file stays and the next start asks. A dialog
   * the user dismissed is remembered in the state file: from then on only
   * the window's button asks again (see recoverAsAdmin). */
  async _restore(opts = {}) {
    if (!this.applied) { this._parkPacServer(); return true; }
    // From here on what the system shows is ours going away, not someone
    // else taking it over.
    this._restoring = true;
    this._stopOwnershipWatch();
    const interactive = opts.interactive === true && !this._adminInFlight;
    this._adminDeclined = false;
    let done = true;
    try {
      try {
        if (this.platform === 'win32') this._restoreWindows();
        else if (this.platform === 'darwin') done = await this._restoreMac(interactive);
        else await this._restoreLinux();
      } catch (e) {
        this.log('warning', `Proxy restore issue: ${e.message}`);
      }
      if (done && this._stillOursQuiet()) done = false;
      if (done) this.log('success', 'System proxy settings restored');
      else if (this._adminDeclined) { this.log('warning', 'Administrator password not given; the proxy settings were not put back'); this._markDeclined(); }
      else this.log('warning', 'System proxy settings could not be restored yet; they will be at the next start');
    } finally {
      this._disarm({ keepState: !done });
      this._restoring = false;
    }
    return done;
  }

  /* Synchronous restore, for process exit and session end. Never asks for a
   * password and never waits long.
   * A set-back of a takeover still writing (macOS, Linux, where its commands
   * are awaited; restore() waits for it, this cannot) is cut short: it
   * writes nothing more, the command it is in is stopped, and every setting
   * it began to write is put back with the rest, whatever it shows now (it
   * was about to show our PAC). The restore wins: nothing of ours is left
   * set after it, and nothing without its record. */
  restoreSync() {
    if (!this.applied) { this._parkPacServer(); return true; }
    this._restoring = true;
    this._stopOwnershipWatch();
    const job = this._retaking;
    if (job) {
      job.cancelled = true;
      // TERM, which sudo passes on to the networksetup it runs.
      try { if (job.child) job.child.kill('SIGTERM'); } catch {}
    }
    const force = job ? job.touched : new Set();
    let done = true;
    try {
      if (this.platform === 'win32') this._restoreWindows();
      else if (this.platform === 'darwin') done = this._restoreMacSync(force);
      else this._restoreLinuxSync(force);
    } catch {}
    if (done && this._stillOursQuiet()) done = false;
    this._disarm({ keepState: !done });
    this._restoring = false;
    return done;
  }

  /* After a restore: is anything of ours still set? What counts is what the
   * system shows, not what the commands said (reg.exe, gsettings and
   * kwriteconfig failing were not noticed before): a setting still ours keeps
   * its record, the only one of the user's own settings. Unknown when it
   * cannot be read: then the commands' word stands. */
  _stillOursQuiet() {
    try { return this._stillOursSync(); } catch { return false; }
  }

  /* The user dismissed the password dialog of a restore: remembered with the
   * state file, so neither a login nor a start asks by itself again. */
  _markDeclined() {
    const s = this._readState();
    if (s) this._writeState({ ...s, declined: Date.now() });
  }

  // ── state file + safety nets ───────────────────────────────────────────
  /* Called once the snapshot is taken and before the first setting changes:
   * from here on every exit path can find what to put back. */
  _arm() {
    this._armed = true;
    this._saveState();
    this._installLoginHook();
    this._startWatchdog();
  }

  /* owner: the Shroudly that wrote it, so the login hook's restore can tell a
   * live session (started at login next to it) from a leftover. */
  _saveState() {
    if (!this.stateFile || !this._armed) return;
    this._writeState({ v: 2, platform: this.platform, port: this.socksPort, pacUrl: this.pacUrl, snapshot: this.snapshot, owner: SystemProxy._owner() });
  }

  _writeState(state) {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeAtomic(this.stateFile, JSON.stringify(state), 0o600);
    } catch (e) { this.log('warning', `Could not save proxy state: ${e.message}`); }
  }

  static _owner() { return { pid: process.pid, boot: bootTime(), exe: path.basename(process.execPath) }; }

  /* Is the Shroudly that wrote a state file still running? Its process, on
   * this boot of the machine, under the same program name: a process id from
   * before a restart, or one some other program has taken since, is not it.
   * Assumed running when the name cannot be read. */
  static _ownerAlive(owner, platform = process.platform) {
    if (!owner || !(owner.pid > 0) || owner.pid === process.pid) return false;
    if (!owner.boot || Math.abs(owner.boot - bootTime()) > 120) return false;
    if (!exec.alive(owner.pid)) return false;
    const name = String(owner.exe || '').toLowerCase().slice(0, 15); // ps shows 15 characters on Linux
    if (!name) return true;
    let out;
    try {
      out = platform === 'win32'
        ? exec.runSync('tasklist.exe', ['/fi', `PID eq ${owner.pid}`, '/fo', 'csv', '/nh'], 3000)
        : exec.runSync('ps', ['-o', 'comm=', '-p', String(owner.pid)], 3000);
    } catch { return true; }
    return String(out).toLowerCase().includes(name);
  }

  /* The state file of an earlier run, if it is there and for this system. */
  _readState() {
    if (!this.stateFile) return null;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return s && s.platform === this.platform && s.snapshot ? s : null;
    } catch { return null; }
  }

  /* This run's snapshot now records everything the inherited state file did
   * (it was merged in, and applied): that file is ours from here on. */
  _takeOverInherited() { this._inherited = null; }

  /* Nothing was changed after all (no desktop proxy, no permission): nothing
   * to recover later either — unless the state file was found, not made, by
   * this run. Then it goes back as it was, login hook and all: it still
   * records the user's own settings under our old PAC. */
  _unarm() {
    this._armed = false;
    if (this._inherited) {
      if (this.stateFile) this._writeState(this._inherited);
      return;
    }
    this._stopWatchdog();
    this._removeLoginHook();
    if (this.stateFile) { try { fs.rmSync(this.stateFile, { force: true }); } catch {} }
  }

  _disarm({ keepState = false } = {}) {
    this.applied = false;
    this.snapshot = null;
    this.status = null;
    this._parkPacServer();
    this._stopOwnershipWatch();
    this._owned = true;   // a takeover belongs to the session it happened in
    this._lost = [];
    this._fight = 0;
    this._retakenAt = 0;
    this._gaveUp = false;
    this._gone = new Map();
    if (keepState) { this._armed = false; return; }
    this._unarm();
  }

  /* The shared watchdog (watchdog.js) looks after the state file from now on;
   * it does nothing once the file is gone, which is what restoring does. */
  _startWatchdog() {
    if (!this.watchdogOpts || !this.stateFile) return;
    if (!Watchdog.watch(this.watchdogOpts, 'proxy', this.stateFile)) this.log('warning', 'Proxy watchdog not started');
  }

  _stopWatchdog() {}

  /* Run "Shroudly --restore-proxy" once at the next login, in case the machine
   * goes down (power loss, forced reboot) while the proxy is applied. */
  _installLoginHook() {
    const cmd = this.restoreCommand;
    if (!cmd) return;
    try {
      if (this.platform === 'win32') {
        const line = [cmd.exe, ...cmd.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
        exec.runSync('reg.exe', ['add', WIN_RUNONCE_KEY, '/v', WIN_RUNONCE_VALUE, '/t', 'REG_SZ', '/d', line, '/f']);
      } else if (this.platform === 'darwin') {
        const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_AGENT_LABEL}.plist`);
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const argsXml = [cmd.exe, ...cmd.args].map((a) => `    <string>${esc(a)}</string>`).join('\n');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`);
      } else {
        const file = path.join(os.homedir(), '.config', 'autostart', 'shroudly-proxy-restore.desktop');
        const q = (a) => `"${String(a).replace(/(["`$\\])/g, '\\$1')}"`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, `[Desktop Entry]\nType=Application\nName=Shroudly proxy restore\nExec=${[cmd.exe, ...cmd.args].map(q).join(' ')}\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`);
      }
    } catch (e) { this.log('warning', `Could not install proxy restore hook: ${e.message}`); }
  }

  _removeLoginHook() {
    if (!this.restoreCommand && !this.stateFile) return;
    try {
      if (this.platform === 'win32') exec.runSync('reg.exe', ['delete', WIN_RUNONCE_KEY, '/v', WIN_RUNONCE_VALUE, '/f']);
      else if (this.platform === 'darwin') fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_AGENT_LABEL}.plist`), { force: true });
      else fs.rmSync(path.join(os.homedir(), '.config', 'autostart', 'shroudly-proxy-restore.desktop'), { force: true });
    } catch {}
  }

  // ── is it still ours? ──────────────────────────────────────────────────
  /* While applied, every 20 s on Windows and every minute elsewhere: the
   * same settings a recovery reads, so a VPN client, another bypass tool or
   * the user taking the system proxy over is noticed, instead of Shroudly
   * showing itself as protecting traffic that no longer reaches it.
   * Asynchronous and one small read per setting (reg.exe, networksetup,
   * gsettings, or a file on KDE). What is done about it: checkOwnership. */
  _startOwnershipWatch() {
    if (!this.onOwnership || this._ownTimer) return;
    this._owned = true;
    this._ownTimer = setInterval(() => { this.checkOwnership().catch(() => {}); }, this.ownershipIntervalMs);
    if (this._ownTimer.unref) this._ownTimer.unref();
  }

  _stopOwnershipWatch() {
    if (this._ownTimer) { clearInterval(this._ownTimer); this._ownTimer = null; }
    for (const t of this._soon) clearTimeout(t);
    this._soon = [];
  }

  /* A look ahead of the timer, at the moments another program most often
   * takes the setting (a Discord starting, a program restarted): traffic
   * then goes around Shroudly for seconds, not for up to a whole interval.
   * A program has just started: a takeover that follows is that start's
   * doing, not an answer to Shroudly setting it back, and starts no fight
   * (in issue #27 Discord started again and again, some starts seconds
   * apart, and something started with it took the setting each time). */
  checkSoon(delays = [3000, 12000]) {
    if (!this._ownTimer) return;
    this._fight = 0;
    this._retakenAt = 0;
    this._lookAgain(delays);
  }

  _lookAgain(delays) {
    if (!this._ownTimer) return;
    for (const ms of delays) {
      const t = setTimeout(() => {
        this._soon = this._soon.filter((x) => x !== t);
        this.checkOwnership().catch(() => {});
      }, ms);
      if (t.unref) t.unref();
      this._soon.push(t);
    }
  }

  /*
   * Returns the settings no longer ours ([] when all are, or once they were
   * set back), or null when they could not be read.
   *
   * Taken over while protection is on, the setting is set back (retake), and
   * one line says so, when what is there now is no choice of the user's
   * (_takeoverInfo):
   *   'cleared'  our PAC removed, nothing in its place
   *   'local'    another PAC served on this computer: another proxy tool's
   *   'ours'     a PAC of Shroudly's at another address
   * It is left alone, and reported as before (the window offers "Set
   * Shroudly again"), when it is:
   *   'manual'   a manual proxy server switched on or changed since Shroudly
   *              applied: the user's, or a VPN's they started
   *   'pac'      a PAC file somewhere else: a company's, or the user's own,
   *              or (GNOME) one found on the network
   * or when it cannot be read. What is left alone is read again at every
   * check, and set back once it is gone: a VPN that switches its manual proxy
   * off when it disconnects leaves nothing behind it.
   *
   * It is set back every time, however often other programs take it, as
   * long as each takeover is one of its own (a program starting, a tool
   * cleaning up). Only a program that answers Shroudly is fought no more:
   * one that takes it again within FIGHT_WINDOW_MS of each set-back,
   * RETAKE_LIMIT times in a row (it sets its own whenever the setting
   * changes). The setting is read again within the window after every
   * set-back (RETAKE_LOOKS_MS), so such an answer is seen in time. Then
   * Shroudly stops setting it back, names the program when it can
   * (whoTookIt), and leaves it to the user, until the setting is ours again
   * or the user sets it again (a new session). A takeover that comes later
   * than the window, or after a program start (checkSoon), begins a new
   * count, and so does the setting staying ours.
   *
   * Setting it back changes only the setting: the snapshot, the state file
   * and the PAC server stay, so Stop still puts back what the user had
   * before Shroudly. Tells onOwnership when what the window shows changes.
   */
  async checkOwnership() {
    if (!this.applied || this._checking || this._restoring) return null;
    this._checking = true;
    // What this check compares against: a re-apply while it reads (a new
    // snapshot, maybe a new address) makes its answer half old, half new.
    const snap = this.snapshot;
    const url = this.pacUrl;
    // A stop that began while this was reading is ours going away, and a
    // re-apply meanwhile is not anyone else's doing either.
    const stale = () => !this.applied || this._restoring || this.snapshot !== snap || this.pacUrl !== url;
    const tell = (owned, info) => { if (this.onOwnership) { try { this.onOwnership(owned, info); } catch {} } };
    try {
      let lost = await this._lostSettings(snap || {}, url);
      if (lost === null || stale()) return lost;
      // When it was seen taken: what a fight is timed by.
      const seenAt = this._now();
      if (lost.length && this._owned && this.takeoverConfirmMs > 0) {
        await new Promise((r) => setTimeout(r, this.takeoverConfirmMs));
        if (stale()) return null;
        lost = await this._lostSettings(snap || {}, url);
        if (lost === null || stale()) return lost;
      }
      if (!lost.length) {
        // Ours for longer than the window since it was set back: nothing
        // answered that, whatever came before.
        if (this._retakenAt && seenAt - this._retakenAt > this.fightWindowMs) { this._fight = 0; this._retakenAt = 0; }
        if (!this._owned) {
          this._owned = true;
          this._gaveUp = false;
          this._fight = 0;
          this._retakenAt = 0;
          this._lost = [];
          this.log('info', 'The system proxy points at Shroudly again');
          tell(true, { lost: [] });
        }
        return lost;
      }
      this._lost = lost;
      // Left to the program that kept taking it, until it is ours again.
      if (this._gaveUp) return lost;
      const what = lost.join(', ');
      const takeover = await this._takeoverInfo(snap || {}, url);
      if (stale()) return null;
      if (this.autoRetake && this._canRetake(snap) && takeover && RETAKE_KINDS.has(takeover.kind)) {
        // Taken again soon after Shroudly set it back: one more answer in a
        // row. Anything else is a takeover of its own, and counts from one.
        const answer = this._retakenAt > 0 && seenAt - this._retakenAt <= this.fightWindowMs;
        this._fight = answer ? this._fight + 1 : 1;
        if (this._fight < this.retakeLimit) {
          const r = await this._serial(() => this._retake(snap, url, lost));
          if (stale()) return null;
          // Not written at all (refused): nothing to answer, and tried again
          // next time.
          if (r === 'failed') this._fight -= 1;
          // Written: read again soon, to see whether something answers it.
          if (r === 'ok' || r === 'reverted') { this._retakenAt = this._now(); this._lookAgain(this.retakeLooksMs); }
          if (r === 'ok') {
            const was = this._owned;
            this._owned = true;
            this._lost = [];
            this.log('info', `Autopilot: another program changed the system proxy (${what}); set it back to Shroudly`);
            if (!was) tell(true, { lost: [], retaken: true });
            return [];
          }
        } else {
          this._gaveUp = true;
          let by = [];
          try { by = this.whoTookIt ? (await this.whoTookIt(takeover)) || [] : []; } catch {}
          if (stale()) return null;
          by = [...new Set(by.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()))].slice(0, 3);
          this._owned = false;
          this.log('warning', by.length
            ? `Another program keeps changing the system proxy (${what}), probably ${by.join(', ')}; Shroudly stopped setting it back. Close it or turn off its proxy setting, then set Shroudly again.`
            : `Another program keeps changing the system proxy (${what}); Shroudly stopped setting it back. Close the other proxy or VPN program, then set Shroudly again.`);
          tell(false, { lost, takeover, gaveUp: true, by });
          return lost;
        }
      }
      if (this._owned) {
        this._owned = false;
        this.log('warning', `Another program changed the system proxy (${what}): that traffic no longer goes through Shroudly`);
        tell(false, { lost, takeover });
      }
      return lost;
    } finally { this._checking = false; }
  }

  /* "Set Shroudly again", pressed by the user over a takeover Shroudly sets
   * back by itself ('cleared', 'local', 'ours'): set back at once, the same
   * way, and any fight forgotten. The snapshot stays, so Stop still puts
   * back what the user had before Shroudly. Resolves to the status (code
   * 'replaced' when it was taken again at once), or null when it is none of
   * those (a manual proxy, a PAC elsewhere, a macOS setting that needs the
   * administrator's password): EngineManager then sets it again with a new
   * snapshot, so that Stop brings that newer choice back. */
  async retakeNow() {
    const snap = this.snapshot;
    const url = this.pacUrl;
    if (!this.applied || this._restoring || !this._canRetake(snap)) return null;
    const lost = await this._lostSettings(snap, url);
    if (lost === null) return null;
    if (lost.length) {
      const takeover = await this._takeoverInfo(snap, url);
      if (!takeover || !RETAKE_KINDS.has(takeover.kind)) return null;
      const r = await this._serial(() => this._retake(snap, url, lost));
      if (r === 'stale' || r === 'failed' || this.snapshot !== snap) return null;
      // Something may answer this too: it counts from here.
      this._retakenAt = this._now();
      this._lookAgain(this.retakeLooksMs);
      if (r === 'reverted') {
        this._gaveUp = false;
        this._fight = 1;
        this._owned = false;
        this._lost = lost;
        return { ...this.status, ok: false, code: 'replaced', lost, takeover, replacedFrom: this.status };
      }
    }
    this._owned = true;
    this._gaveUp = false;
    this._fight = 0;
    this._lost = [];
    return this.status;
  }

  /* Setting it back can be done without asking anyone: everywhere except a
   * macOS setting made with an administrator's password. */
  _canRetake(snap) {
    if (!snap) return false;
    if (this.platform === 'win32') return snap.form === 'pac';
    if (this.platform === 'darwin') return snap.mode === 'system';
    return snap.mode === 'desktop';
  }

  /* Our PAC set again where it was lost, and read back: 'ok', 'reverted'
   * (taken again at once), 'failed' (could not be written or read) or
   * 'stale' (a stop or a re-apply came first: nothing left done).
   *
   * One command at a time, each only while protection is still on with this
   * record: a restore (restore() waits for this; restoreSync(), at a session
   * end or a quit, cannot) wins over it. restoreSync() marks it cancelled,
   * stops the command it is in, and puts back every setting it began to
   * write; this then writes nothing more, and what landed after the restore
   * all the same is put back from the same record (_undoRetake). So our PAC
   * is never left set once the record of the user's own settings is gone,
   * and a restore is never undone. */
  async _retake(snap, url, lost) {
    const job = { cancelled: false, child: null, touched: new Set() };
    const live = () => !job.cancelled && this.applied && !this._restoring && this.snapshot === snap && this.pacUrl === url;
    if (!live()) return 'stale';
    const STALE = new Error('stale');
    const write = async (what, cmd, args, timeout) => {
      if (!live()) throw STALE;
      job.touched.add(what);
      try { await exec.run(cmd, args, timeout, (child) => { job.child = child; }); } finally { job.child = null; }
      if (!live()) throw STALE;
    };
    this._retaking = job;
    try {
      try {
        if (this.platform === 'win32') {
          job.touched.add('AutoConfigURL');
          regSet('AutoConfigURL', 'REG_SZ', url);
          this._refreshWinInet();
        } else if (this.platform === 'darwin') {
          const sudoOk = await this._macSudoNonInteractive();
          for (const s of (snap.services || []).filter((x) => x.applied && lost.includes(x.name))) {
            for (const args of SystemProxy._macApplyArgs(s.name, url)) {
              await (sudoOk ? write(s.name, 'sudo', ['-n', 'networksetup', ...args], 6000) : write(s.name, 'networksetup', args, 6000));
            }
          }
        } else {
          if (snap.gnome && lost.includes('GNOME')) {
            await write('GNOME', 'gsettings', ['set', 'org.gnome.system.proxy', 'autoconfig-url', url], 8000);
            await write('GNOME', 'gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'auto'], 8000);
          }
          if (snap.kde && lost.includes('KDE')) {
            if (!live()) throw STALE;
            job.touched.add('KDE');
            this._kdeWriteSync(snap.kde.file, { [KDE_TYPE]: '2', [KDE_SCRIPT]: url });
            this._kdeNotify();
          }
        }
      } catch (e) {
        if (e === STALE || !live()) { this._undoRetake(snap, job); return 'stale'; }
        return 'failed';
      }
      // The record to put things back by goes with every setting of ours: one
      // that was taken away meanwhile is written again. Never after a
      // restore, which took it away on purpose.
      if (this._armed && this.stateFile && !fs.existsSync(this.stateFile)) { this._saveState(); this._installLoginHook(); }
      const after = await this._lostSettings(snap, url);
      if (!live()) { this._undoRetake(snap, job); return 'stale'; }
      if (after === null) return 'failed';
      return after.length ? 'reverted' : 'ok';
    } finally {
      if (this._retaking === job) this._retaking = null;
    }
  }

  /* A set-back cut short by a restore (see _retake): a command of it that
   * landed after the restore all the same (our address, or a PAC switched
   * on again) is undone by writing the record back once more over every
   * setting it touched, as the restore did, whatever it shows now. A
   * separate SystemProxy does it, holding only that record: this one's
   * state file and login hook are the restore's business. */
  _undoRetake(snap, job) {
    if (!job.touched.size || (this.applied && !job.cancelled)) return;
    const p = new SystemProxy(this.log, { platform: this.platform, env: this.env });
    p.snapshot = snap;
    p.socksPort = this.socksPort;
    p._kdeToolName = this._kdeToolName;
    p._gone = this._gone;
    p.applied = true;
    p._retaking = { cancelled: false, child: null, touched: job.touched };
    try { p.restoreSync(); } catch {}
  }

  /* reg.exe ended with 1: the value is not there. Anything else (it did not
   * start, it was stopped after its time, a virus scanner held it) says
   * nothing about the value. */
  static _regMissing(e) {
    return !!e && !e.killed && (e.code === 1 || e.status === 1);
  }

  /* The same PAC address, whatever case or trailing slash a settings window
   * wrote it back with. */
  static _samePac(a, b) {
    const n = (s) => String(s || '').trim().toLowerCase().replace(/\/+$/, '');
    return !!n(b) && n(a) === n(b);
  }

  /* A PAC address that is not ours, by where it is served (see
   * checkOwnership). */
  static _pacKind(u) {
    const pac = String(u || '').trim();
    if (!pac) return { kind: 'cleared' };
    if (OUR_PAC.test(pac)) return { kind: 'ours', pac };
    let host = '';
    let port = 0;
    try {
      const p = new URL(pac);
      host = p.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      port = Number(p.port) || (p.protocol === 'https:' ? 443 : p.protocol === 'http:' ? 80 : 0);
    } catch { return { kind: 'pac', pac }; }
    if (/^127\./.test(host) || host === 'localhost' || host === '::1') return { kind: 'local', pac, port, host };
    return { kind: 'pac', pac };
  }

  /* The user's own proxy from before Shroudly, about to be put back, is
   * served on this computer and nothing listens there any more: the program
   * that served it has gone (it often removed it as it went, which had
   * Shroudly set its own back meanwhile). Put back, a manual proxy would cut
   * every program off (there is no going around one that does not answer),
   * and a PAC would point at nothing. It is switched off instead, its
   * address kept where it was, so turning it on again is all it takes; one
   * line says so. A proxy elsewhere, one something still listens for, and
   * one that cannot be told about come back as before. The same at Stop, a
   * quit, a session end and after a crash (the watchdog, the login hook, the
   * next start): at a session end its program may be ending too, and off,
   * the address kept, is then the safe side.
   * macOS, GNOME and KDE. Not Windows: its PAC setting is only the address,
   * which switching off would lose for good, and WinINET and Chromium go on
   * without a PAC they cannot fetch (direct, or the manual proxy put back
   * with it). */
  _pacGone(u) {
    const k = SystemProxy._pacKind(u);
    if (k.kind !== 'local' || !k.port) return false;
    return this._localGone(k.pac, [{ host: k.host, port: k.port }]);
  }

  /* Every one of these servers is on this computer and none is listening:
   * true only when that is known (see _pacGone). `shown` names them in the
   * log line. */
  _localGone(shown, servers) {
    if (this._gone.has(shown)) return this._gone.get(shown);
    const loop = (h) => /^127\./.test(h) || h === 'localhost' || h === '::1';
    let gone = servers.length > 0 && servers.every((x) => loop(String(x.host || '').replace(/^\[|\]$/g, '').toLowerCase()) && x.port > 0);
    for (const x of gone ? servers : []) {
      let on = null;
      try { on = exec.listening(x.port); } catch {}
      if (on !== false) { gone = false; break; }
    }
    this._gone.set(shown, gone);
    if (gone) this.log('info', `The proxy setting from before Shroudly (${shown}) points at a program on this computer that is no longer running; it was switched off instead of put back`);
    return gone;
  }

  /* Of what several services or desktops show, the most deliberate. */
  static _mostDeliberate(found) {
    const rank = ['manual', 'pac', 'local', 'ours', 'cleared'];
    return [...found].sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind))[0] || { kind: 'cleared' };
  }

  /* What is set now where our PAC was: { kind, pac?, port?, server? } (see
   * checkOwnership), or null when it could not be read. */
  async _takeoverInfo(snap = this.snapshot || {}, url = this.pacUrl) {
    try {
      if (this.platform === 'win32') {
        const read = async (name) => {
          try { return regParse(name, await exec.run('reg.exe', ['query', WIN_KEY, '/v', name], 4000)); }
          catch (e) { if (SystemProxy._regMissing(e)) return null; throw e; }
        };
        const pac = await read('AutoConfigURL');
        const on = await read('ProxyEnable');
        const server = await read('ProxyServer');
        const enabled = (v) => !!v && /^(0x)?0*1$/i.test(String(v.data).trim());
        const now = enabled(on) && server ? String(server.data).trim() : '';
        // The user's own manual proxy, kept under our PAC all along, is not
        // a new choice: only one switched on or changed since.
        const before = enabled(snap.ProxyEnable) && snap.ProxyServer ? String(snap.ProxyServer.data).trim() : '';
        if (now && now !== before) return { kind: 'manual', server: now };
        return SystemProxy._pacKind(pac && pac.data);
      }
      const found = [];
      if (this.platform === 'darwin') {
        for (const s of (snap.services || []).filter((x) => x.applied)) {
          const auto = SystemProxy._macParseAuto(await exec.run('networksetup', ['-getautoproxyurl', s.name], 4000));
          if (auto.enabled && SystemProxy._samePac(auto.url, url)) continue;
          // The user's own manual proxy, kept under our PAC all along, is not
          // a new choice: only one switched on or changed since (prevManual,
          // read at apply; a record without it counts every one, as before).
          let manual = '';
          for (const [key, verb] of MAC_MANUAL) {
            let p = null;
            try { p = SystemProxy._macParseSocks(await exec.run('networksetup', [verb, s.name], 4000)); } catch {}
            const cur = p && p.enabled && p.server ? `${p.server}:${p.port}` : '';
            const was = s.prevManual && typeof s.prevManual[key] === 'string' ? s.prevManual[key] : null;
            if (cur && cur !== was) { manual = cur; break; }
          }
          found.push(manual ? { kind: 'manual', server: manual } : SystemProxy._pacKind(auto.enabled ? auto.url : ''));
        }
        return SystemProxy._mostDeliberate(found);
      }
      const unq = (v) => String(v || '').trim().replace(/^'(.*)'$/, '$1');
      if (snap.gnome && snap.desktop !== 'kde') {
        const mode = unq(await exec.run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], 4000));
        const auto = unq(await exec.run('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url'], 4000));
        // Automatic with no address: the PAC is found on the network (WPAD),
        // a choice as deliberate as KDE's 3 below, never "cleared".
        found.push(mode === 'manual' ? { kind: 'manual' }
          : mode === 'auto' && !auto ? { kind: 'pac' } : SystemProxy._pacKind(mode === 'auto' ? auto : ''));
      }
      if (snap.kde) {
        const cur = SystemProxy._kdeRead(await fs.promises.readFile(snap.kde.file, 'utf8').catch(() => ''));
        // 1: manual; 2: a PAC; 3: found on the network; 4: from the
        // environment. 3 and 4 are choices of the user's too.
        found.push(cur.type === '1' ? { kind: 'manual' }
          : cur.type === '2' ? SystemProxy._pacKind(cur.script)
            : cur.type === '3' || cur.type === '4' ? { kind: 'pac' } : { kind: 'cleared' });
      }
      return SystemProxy._mostDeliberate(found);
    } catch { return null; }
  }

  async _lostSettings(snap = this.snapshot || {}, url = this.pacUrl) {
    try {
      if (this.platform === 'win32') {
        let out = '';
        try { out = await exec.run('reg.exe', ['query', WIN_KEY, '/v', 'AutoConfigURL'], 4000); }
        catch (e) { if (!SystemProxy._regMissing(e)) return null; } // exit code 1: the value is gone
        const cur = regParse('AutoConfigURL', out);
        return cur && SystemProxy._samePac(cur.data, url) ? [] : ['AutoConfigURL'];
      }
      if (this.platform === 'darwin') {
        if (snap.mode !== 'system' && snap.mode !== 'admin') return [];
        const lost = [];
        for (const s of (snap.services || []).filter((x) => x.applied)) {
          const cur = SystemProxy._macParseAuto(await exec.run('networksetup', ['-getautoproxyurl', s.name], 4000));
          if (!(cur.enabled && SystemProxy._samePac(cur.url, url))) lost.push(s.name);
        }
        return lost;
      }
      const lost = [];
      // On Plasma only KDE's setting routes the browsers; GNOME's, set there
      // for the odd GTK program, changing is nobody's takeover.
      if (snap.gnome && snap.desktop !== 'kde') {
        const mode = (await exec.run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], 4000)).trim();
        const auto = (await exec.run('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url'], 4000)).trim().replace(/^'(.*)'$/, '$1');
        if (mode !== "'auto'" || !SystemProxy._samePac(auto, url)) lost.push('GNOME');
      }
      if (snap.kde) {
        const cur = SystemProxy._kdeRead(await fs.promises.readFile(snap.kde.file, 'utf8').catch(() => ''));
        if (cur.type !== '2' || !SystemProxy._samePac(cur.script, url)) lost.push('KDE');
      }
      return lost;
    } catch { return null; }

  }

  /*
   * Restore a proxy left behind by a run that never got to restore it (crash,
   * kill, power loss). Reads the state file; restores only if the system still
   * points at our proxy. Synchronous: used by the watchdog, the login hook
   * and at startup. Never asks for a password. Returns
   *   true    something was restored
   *   false   nothing of ours was left
   *   'kept'  something of ours is still set and needs the administrator's
   *           password (macOS), or the root helper is still at it: the state
   *           file stays, and recoverAsAdmin() finishes it once Shroudly's
   *           window is up
   *   'running'  (opts.skipIfOwnerAlive) the Shroudly that wrote the state
   *           file is running: what is set is its live session, left alone
   * opts.helperWaitMs: how long to wait for the root helper (the app's own
   * start passes a short one; the restore process may wait).
   * opts.skipIfOwnerAlive: the restore process (--restore-proxy). The login
   * hook left by a power cut runs while Shroudly may be starting at the same
   * login; its state file is not a leftover. The app's own start never
   * passes it: it is the only Shroudly then.
   * What was written for the next login on XFCE, LXQt and other desktops is
   * not touched here: a crash or a power cut is not the user stopping
   * protection (see clearEnvSync).
   */
  static recoverSync(opts = {}, log = () => {}) {
    const raw = opts.stateFile ? readOrNull(opts.stateFile) : null;
    let state = null;
    try { state = raw === null ? null : JSON.parse(raw); } catch {}
    const p = new SystemProxy(log, opts);
    if (opts.skipIfOwnerAlive && state && SystemProxy._ownerAlive(state.owner, p.platform)) return 'running';
    if (!state || typeof state !== 'object' || state.platform !== p.platform) {
      // A state file that cannot be read says nothing about what to put
      // back: whatever of ours is still set is at least switched off.
      if (raw !== null && (!state || typeof state !== 'object')) { try { SystemProxy.resetLegacySync(log, opts); } catch {} }
      p._removeLoginHook();
      if (opts.stateFile) { try { fs.rmSync(opts.stateFile, { force: true }); } catch {} }
      return false;
    }
    p.socksPort = state.port;
    p.pacUrl = state.pacUrl || null;
    p.snapshot = state.snapshot;
    // A root helper may still be on its way to restoring (macOS, admin):
    // let it, and never ask for the password over it.
    if (p.platform === 'darwin' && p.snapshot && p.snapshot.mode === 'admin'
        && !p._macReleaseHelperSync(opts.helperWaitMs || MAC_HELPER_WAIT_MS)) {
      log('warning', 'System proxy from the previous session could not be restored yet');
      return 'kept';
    }
    let ours = false;
    try { ours = p._stillOursSync(); } catch {}
    if (ours) {
      // Read again right before acting: a Shroudly that started meanwhile
      // (at the same login) has written its own, and its setting is live.
      if (opts.skipIfOwnerAlive && readOrNull(opts.stateFile) !== raw) return 'running';
      p.applied = true;
      if (!p.restoreSync()) { // also clears the state file and login hook
        log('warning', 'System proxy from the previous session could not be restored yet');
        return 'kept';
      }
      log('success', 'System proxy from the previous session restored');
      return true;
    }
    p._disarm();
    return false;
  }

  /*
   * macOS, once Shroudly's window is up: a setting made with an
   * administrator's password that recoverSync() had to leave (the root
   * helper went with a restart of the Mac). Asks for the password once,
   * asynchronously, and only in one process at a time (a lock file next to
   * the state file), so the login hook and the app never both ask. True when
   * restored.
   * A dialog the user dismissed (here or at Stop) is remembered in the state
   * file: from then on only the window's button (opts.userAsked) asks, never
   * a login or an app start, which would otherwise ask at every one of them.
   */
  static async recoverAsAdmin(opts = {}, log = () => {}) {
    const p = new SystemProxy(log, opts);
    if (p.platform !== 'darwin' || !opts.stateFile) return false;
    const lock = `${opts.stateFile}.lock`;
    if (!takeLock(lock)) return false;
    try {
      const state = p._readState();
      if (!state || state.snapshot.mode !== 'admin') return false;
      if (state.declined && !opts.userAsked) return false;
      p.socksPort = state.port;
      p.pacUrl = state.pacUrl || null;
      p.snapshot = state.snapshot;
      if (!(await p._macReleaseHelper(p.helperWaitMs))) return false; // still at it
      let ours = false;
      try { ours = p._stillOursSync(); } catch {}
      if (!ours) { p._disarm(); return false; }
      p.applied = true;
      const done = await p._restoreMacAdmin(false, true);
      if (!done && p._adminDeclined) p._writeState({ ...state, declined: Date.now() });
      p._disarm({ keepState: !done });
      if (done) log('success', 'System proxy from the previous session restored');
      else if (p._adminDeclined) log('warning', 'Administrator password not given; the proxy settings were not put back');
      else log('warning', 'System proxy from the previous session could not be restored yet');
      return done;
    } finally {
      dropLock(lock);
    }
  }

  /* macOS, for the window: a setting made with an administrator's password
   * that is still waiting to be put back (recoverAsAdmin), or null.
   * { declined }: the user already dismissed its dialog once. */
  static pendingAdminRecovery(opts = {}) {
    const p = new SystemProxy(() => {}, opts);
    if (p.platform !== 'darwin') return null;
    const state = p._readState();
    if (!state || !state.snapshot || state.snapshot.mode !== 'admin') return null;
    return { declined: !!state.declined };
  }

  /* The restore process (--restore-proxy) on macOS: may it ask for the
   * administrator's password itself? Only with something waiting for it,
   * never once the user has declined (the window's button asks then), and
   * not when Shroudly starts at this login with protection on: its own
   * password request covers it. */
  static restoreProcessAsks({ pending, autoStartWithProtection = false } = {}) {
    return !!pending && !pending.declined && !autoStartWithProtection;
  }

  /*
   * 2.0.0 kept no state file: if it left the system pointing at a local
   * Shroudly proxy, switch that proxy off (its previous values are unknown).
   * Recognises both what 2.5.4 and earlier set and the PAC set since.
   */
  static resetLegacySync(log = () => {}, opts = {}) {
    const platform = opts.platform || process.platform;
    try {
      if (platform === 'win32') {
        const server = regGet('ProxyServer');
        const pac = regGet('AutoConfigURL');
        const ourServer = server && WIN_LEGACY_SERVER.test(server.data);
        const ourPac = pac && OUR_PAC.test(pac.data);
        if (!ourServer && !ourPac) return false;
        // Only the manual proxy we set is switched off; a PAC alone never
        // needed ProxyEnable, and the user's own manual proxy stays as it is.
        if (ourServer) {
          regSet('ProxyEnable', 'REG_DWORD', '0');
          regDel('ProxyServer');
          const ov = regGet('ProxyOverride');
          if (ov && ov.data === WIN_LEGACY_OVERRIDE) regDel('ProxyOverride');
        }
        if (ourPac) regDel('AutoConfigURL');
      } else if (platform === 'darwin') {
        const out = exec.runSync('networksetup', ['-listallnetworkservices']);
        let found = false;
        let failed = false;
        // True when the change was made: a Standard account is refused it.
        const set = (args) => {
          try { exec.runSync('networksetup', args, 3000); return true; } catch {}
          try { exec.runSync('sudo', ['-n', 'networksetup', ...args], 3000); return true; } catch {}
          return false;
        };
        for (const svc of SystemProxy._macParseServices(out)) {
          const cur = SystemProxy._macReadSync(svc);
          if (cur.enabled && cur.server === '127.0.0.1') { found = true; if (!set(['-setsocksfirewallproxystate', svc, 'off'])) failed = true; }
          const auto = SystemProxy._macReadAutoSync(svc);
          if (auto.enabled && OUR_PAC.test(auto.url)) { found = true; if (!set(['-setautoproxystate', svc, 'off'])) failed = true; }
        }
        if (!found) return false;
        if (failed) {
          log('warning', 'A system proxy left by an earlier version could not be switched off');
          return false;
        }
      } else {
        let any = false;
        try {
          const host = exec.runSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host']).trim();
          const mode = exec.runSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode']).trim();
          const auto = exec.runSync('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url']).trim().replace(/^'(.*)'$/, '$1');
          if ((host === "'127.0.0.1'" && mode === "'manual'") || (mode === "'auto'" && OUR_PAC.test(auto))) {
            exec.runSync('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'none']);
            any = true;
          }
        } catch {}
        const p = new SystemProxy(log, { platform, env: opts.env });
        const file = p._kdeFile();
        let text = null;
        try { text = fs.readFileSync(file, 'utf8'); } catch {}
        const cur = SystemProxy._kdeRead(text || '');
        if (cur.type === '2' && OUR_PAC.test(cur.script || '')) {
          p._kdeWriteSync(file, { [KDE_TYPE]: '0' });
          p._kdeNotify();
          any = true;
        }
        if (!any) return false;
      }
      log('success', 'System proxy left by an earlier version switched off');
      return true;
    } catch { return false; }
  }

  _stillOursSync() {
    const port = String(this.socksPort);
    if (this.platform === 'win32') {
      const server = regGet('ProxyServer');
      const pac = regGet('AutoConfigURL');
      return !!((server && server.data === `socks=127.0.0.1:${port}`) || (pac && OUR_PAC.test(pac.data)));
    }
    if (this.platform === 'darwin') {
      const snap = this.snapshot || {};
      if (snap.mode !== 'system' && snap.mode !== 'admin') return false;
      return (snap.services || []).some((s) => {
        if (s.prev) { // set by 2.5.4 and earlier: the SOCKS proxy
          const cur = SystemProxy._macReadSync(s.name);
          if (cur.enabled && cur.server === '127.0.0.1' && cur.port === port) return true;
        }
        return SystemProxy._macOwnedAutoSync(s.name);
      });
    }
    const snap = this.snapshot || {};
    if (snap.gnome && this._gnomeOwnedSync()) return true;
    if (snap.kde && this._kdeOwnedSync()) return true;
    return false;
  }

  // ── Windows (WinINET, HKCU, no admin) ──────────────────────────────────
  _applyWindows() {
    // All four values are kept, although only the PAC is written: an older
    // Shroudly that finds this state file restores all four.
    const snap = {};
    for (const name of WIN_VALUES) snap[name] = regGet(name);
    // Our PAC still set by a run whose restore never happened: what that run
    // found there is the user's own value.
    const old = this._inherited && this._inherited.snapshot;
    if (old && old.form === 'pac' && 'AutoConfigURL' in old && snap.AutoConfigURL && OUR_PAC.test(snap.AutoConfigURL.data)) {
      snap.AutoConfigURL = old.AutoConfigURL;
    }
    this.snapshot = snap;
    this.snapshot.appliedMode = this.mode;
    this.snapshot.form = 'pac';
    this._arm();
    // WinINET loads the PAC over HTTP (file:// PACs are rejected). The user's
    // manual proxy is left as it is: WinINET and Chromium use the PAC first.
    regSet('AutoConfigURL', 'REG_SZ', this.pacUrl);
    this._takeOverInherited();
    this._refreshWinInet();
    return { ok: true, code: 'ok', system: 'windows' };
  }

  _restoreWindows() {
    const snap = this.snapshot || {};
    if (snap.form === 'pac') {
      // Only the value we wrote, and only while it is still ours.
      const cur = regGet('AutoConfigURL');
      if (cur && OUR_PAC.test(cur.data)) {
        const v = snap.AutoConfigURL;
        // The user's own PAC is put back even when nothing serves it now (a
        // program that has gone, or not started yet): Windows keeps only
        // the address, which would be lost for good, and WinINET and
        // Chromium go on without a PAC they cannot fetch (see _pacGone).
        if (v && !OUR_PAC.test(v.data)) regSet('AutoConfigURL', v.type, v.data);
        else regDel('AutoConfigURL');
        this._refreshWinInet();
      }
      return;
    }
    // A state file from 2.5.4 or earlier, which also set the manual proxy.
    // ProxyEnable first, so traffic goes direct even if a later step fails.
    const order = ['ProxyEnable', 'AutoConfigURL', 'ProxyServer', 'ProxyOverride'];
    for (const name of order) {
      const v = snap[name];
      if (v) regSet(name, v.type, v.data);
      else if (name === 'ProxyEnable') regSet('ProxyEnable', 'REG_DWORD', '0');
      else regDel(name);
    }
    this._refreshWinInet();
  }

  /* Tell running WinINET apps to re-read the settings. Fire and forget:
   * PowerShell is slow to start and the registry change is what matters
   * (Chromium-based apps watch the registry themselves). */
  _refreshWinInet() {
    const ps = `
$sig = @'
[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@
$t = Add-Type -MemberDefinition $sig -Name WinINet -Namespace Net -PassThru
[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`;
    exec.spawnDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  }

  // ── macOS (networksetup) ───────────────────────────────────────────────
  static _macParseServices(out) {
    return String(out).split('\n').slice(1).map((s) => s.trim()).filter((s) => s && !s.startsWith('*'));
  }

  async _macServices() {
    return SystemProxy._macParseServices(await exec.run('networksetup', ['-listallnetworkservices']));
  }

  /* With no SOCKS server set, networksetup prints "Server: Port: 0" on one
   * line and "Port: 0" on the next; with no PAC, "URL: (null)". Both mean
   * none, and must not be put back as if they were settings. */
  static _macParseSocks(info) {
    const text = String(info);
    let server = ((text.match(/^Server:[ \t]*(.*)$/mi) || [])[1] || '').trim();
    let port = ((text.match(/^Port:[ \t]*(\d+)/mi) || [])[1] || '').trim();
    if (!/^[A-Za-z0-9._:[\]-]+$/.test(server) || /^Port:/i.test(server)) server = '';
    if (!(Number(port) > 0 && Number(port) < 65536)) port = '';
    if (!server || !port) { server = ''; port = ''; }
    return { enabled: /^Enabled:[ \t]*Yes/mi.test(text), server, port };
  }

  static _macParseAuto(info) {
    const text = String(info);
    let url = ((text.match(/^URL:[ \t]*(.*)$/mi) || [])[1] || '').trim();
    if (url === '(null)') url = '';
    return { enabled: /^Enabled:[ \t]*Yes/mi.test(text), url };
  }

  static _macReadSync(svc) {
    try { return SystemProxy._macParseSocks(exec.runSync('networksetup', ['-getsocksfirewallproxy', svc])); }
    catch { return { enabled: false, server: '', port: '' }; }
  }

  static _macReadAutoSync(svc) {
    try { return SystemProxy._macParseAuto(exec.runSync('networksetup', ['-getautoproxyurl', svc])); }
    catch { return { enabled: false, url: '' }; }
  }

  static _macOwnedAutoSync(svc) {
    const auto = SystemProxy._macReadAutoSync(svc);
    return auto.enabled && OUR_PAC.test(auto.url);
  }

  // Can we run networksetup without an interactive password prompt?
  async _macSudoNonInteractive() {
    try { await exec.run('sudo', ['-n', 'networksetup', '-version'], 3000); return true; }
    catch { return false; }
  }

  static _macApplyArgs(svc, pacUrl) {
    return [['-setautoproxyurl', svc, pacUrl], ['-setautoproxystate', svc, 'on']];
  }

  /* The services' PAC settings now, as the snapshot to restore. A service
   * still on our PAC from a run whose restore never happened keeps what that
   * run found there: the user's own setting, which would otherwise be
   * replaced by our stale address and lost. */
  _macSnapshotServices(names) {
    const old = this._inherited && this._inherited.snapshot;
    const before = new Map(((old && old.form === 'pac' && old.services) || []).map((s) => [s.name, s]));
    return names.map((name) => {
      const cur = SystemProxy._macReadAutoSync(name);
      const was = before.get(name);
      return { name, prevAuto: was && was.prevAuto && OUR_PAC.test(cur.url || '') ? was.prevAuto : cur };
    });
  }

  /* A service's manual proxies, each 'server:port' or '' when off; one that
   * could not be read is left out (counted as unknown). */
  async _macManual(name) {
    const out = {};
    for (const [key, verb] of MAC_MANUAL) {
      try {
        const p = SystemProxy._macParseSocks(await exec.run('networksetup', [verb, name], 4000));
        out[key] = p.enabled && p.server ? `${p.server}:${p.port}` : '';
      } catch {}
    }
    return out;
  }

  /* An earlier run's root helper may still be putting things back: let it
   * finish before this run reads what is set. */
  async _settleInheritedHelper() {
    const old = this._inherited && this._inherited.snapshot;
    if (!old || old.mode !== 'admin') return;
    const p = new SystemProxy(this.log, { platform: 'darwin', helperWaitMs: this.helperWaitMs });
    p.snapshot = old;
    await p._macReleaseHelper(this.helperWaitMs);
  }

  async _applyMac() {
    // networksetup may require admin. Try unprivileged first (works for an
    // administrator account and on managed Macs), then non-interactive sudo;
    // never a prompt here. A Standard account gets 'needs_admin'.
    const services = await this._macServices();
    this.snapshot = {
      services: this._macSnapshotServices(services),
      mode: 'system',
      form: 'pac',
      appliedMode: this.mode,
    };
    // The manual proxies each service has now, left as they are under our
    // PAC: one there already is no takeover later (see _takeoverInfo).
    for (const s of this.snapshot.services) s.prevManual = await this._macManual(s.name);
    this._arm();
    const sudoOk = await this._macSudoNonInteractive();
    let anyOk = false;
    for (const s of this.snapshot.services) {
      try {
        for (const args of SystemProxy._macApplyArgs(s.name, this.pacUrl)) {
          await (sudoOk ? exec.run('sudo', ['-n', 'networksetup', ...args], 6000) : exec.run('networksetup', args, 6000));
        }
        s.applied = true;
        anyOk = true;
      } catch { /* keep trying other services */ }
    }
    if (anyOk) {
      this._takeOverInherited();
      this._saveState();
      return { ok: true, code: 'ok', system: 'macos' };
    }
    // Nothing changed system-wide, so there is nothing to recover later
    // (and a state file found here goes back as it was).
    this.snapshot.mode = 'perapp';
    this._unarm();
    return {
      ok: false, code: 'needs_admin', system: 'macos',
      detail: 'This macOS account may not change the network settings without an administrator\'s password.',
    };
  }

  /* A PAC address read back from the state file, to hand back to
   * networksetup: the user's own, whatever its kind (file:///Library/... is
   * as common as http on managed Macs). It goes into a root shell only
   * single-quoted (shq), so only what no setting can hold is refused: a
   * control character (a line break would end the command) and a leading
   * "-" networksetup could take for an option. That, a stale Shroudly PAC
   * and 2.5.4's "(null)" count as nothing set. */
  static _macSafeUrl(u) {
    const url = String(u || '').trim();
    if (url === '(null)' || OUR_PAC.test(url)) return '';
    return url && !/[\x00-\x1f\x7f]/.test(url) && !url.startsWith('-') ? url : '';
  }

  /* The steps that put one service back exactly as it was. networksetup
   * switches a proxy on whenever its server or URL is set, so a proxy that was
   * off is switched off first, and again after its old value is written back:
   * off stays off. Junk read by 2.5.4 ("Port: 0", "(null)") and a stale
   * Shroudly PAC count as nothing set. */
  static _macRestoreArgs(s) {
    const steps = [];
    if (s.prev) { // only 2.5.4 and earlier set the SOCKS proxy
      const p = SystemProxy._macParseSocks(`Enabled: ${s.prev.enabled ? 'Yes' : 'No'}\nServer: ${s.prev.server || ''}\nPort: ${s.prev.port || ''}\n`);
      const off = ['-setsocksfirewallproxystate', s.name, 'off'];
      if (p.enabled && p.server) steps.push(['-setsocksfirewallproxy', s.name, p.server, p.port], ['-setsocksfirewallproxystate', s.name, 'on']);
      else if (p.server) steps.push(off, ['-setsocksfirewallproxy', s.name, p.server, p.port], off);
      else steps.push(off);
    }
    if (s.prevAuto) {
      const url = SystemProxy._macSafeUrl(s.prevAuto.url);
      const off = ['-setautoproxystate', s.name, 'off'];
      if (s.prevAuto.enabled && url) steps.push(['-setautoproxyurl', s.name, url], ['-setautoproxystate', s.name, 'on']);
      else if (url) steps.push(off, ['-setautoproxyurl', s.name, url], off);
      else steps.push(off);
    }
    return steps;
  }

  /* What to run to restore, per service: everything for a 2.5.4 state file
   * (recoverSync has checked it is ours), otherwise only the services whose
   * PAC is still ours, and those in `force` (a set-back was writing them,
   * see restoreSync). The user's own PAC served on this Mac by a program
   * that has gone comes back switched off (_pacGone). */
  _macRestorePlanSync(force = null) {
    const snap = this.snapshot || {};
    const plan = [];
    for (const s of (snap.services || [])) {
      if (snap.form === 'pac' && !(force && force.has(s.name)) && !SystemProxy._macOwnedAutoSync(s.name)) continue;
      const gone = s.prevAuto && s.prevAuto.enabled && this._pacGone(SystemProxy._macSafeUrl(s.prevAuto.url));
      plan.push(...SystemProxy._macRestoreArgs(gone ? { ...s, prevAuto: { ...s.prevAuto, enabled: false } } : s));
    }
    return plan;
  }

  async _restoreMac(interactive = false) {
    const snap = this.snapshot || {};
    if (snap.mode === 'admin') return this._restoreMacAdmin(false, interactive);
    if (snap.mode !== 'system') return true;
    const plan = this._macRestorePlanSync();
    const sudoOk = plan.length ? await this._macSudoNonInteractive() : false;
    for (const args of plan) {
      try { await (sudoOk ? exec.run('sudo', ['-n', 'networksetup', ...args], 6000) : exec.run('networksetup', args, 6000)); } catch {}
    }
    return true;
  }

  _restoreMacSync(force = null) {
    const snap = this.snapshot || {};
    if (snap.mode === 'admin') return this._restoreMacAdmin(true);
    if (snap.mode !== 'system') return true;
    for (const args of this._macRestorePlanSync(force)) {
      try { exec.runSync('networksetup', args, 3000); }
      catch { try { exec.runSync('sudo', ['-n', 'networksetup', ...args], 3000); } catch {} }
    }
    return true;
  }

  // ── macOS with an administrator's password ─────────────────────────────
  /*
   * For a Standard account ('needs_admin'): ask once for an administrator's
   * password (the system's own dialog, through osascript) and set the PAC on
   * every service. The same elevated script leaves a small root helper
   * behind: it waits while the hold file exists and Shroudly runs, then puts
   * back every service whose PAC is still ours, with the values snapshotted
   * now. So stopping, quitting, a crash, a kill or a logout restore without
   * asking again; only when the helper itself is gone (a restart of the Mac)
   * does a restore need the password once more, and that is asked once the
   * window is up (recoverAsAdmin), never while quitting. Nothing is
   * installed: no sudoers entry, no launch daemon. The helper runs only
   * networksetup, with arguments fixed here and quoted, never read from a
   * file, and nc, to see whether the user's own PAC is still served on this
   * Mac before putting it back (see _pacGone).
   *
   * One dialog at a time: a second call while it is open gets the first
   * one's answer. A stop (or a stop and a new start) while it is open leaves
   * its answer to nobody: the hold file goes, so a helper started by it puts
   * everything back at once.
   *
   * Returns the same kind of status as apply(): code 'ok', 'cancelled' (the
   * dialog was dismissed: nothing changed), 'needs_admin' (refused) or
   * 'not_active' (protection stopped meanwhile).
   */
  applyAsAdmin() {
    if (this.platform !== 'darwin') return Promise.resolve({ ok: false, code: 'unsupported' });
    if (this._adminInFlight) return this._adminInFlight;
    const p = this._applyAsAdmin().finally(() => { if (this._adminInFlight === p) this._adminInFlight = null; });
    this._adminInFlight = p;
    return p;
  }

  async _applyAsAdmin() {
    if (!this.applied || !this.snapshot || !this.pacUrl) return { ok: false, code: 'not_active' };
    if (this.snapshot.mode === 'system' || this.snapshot.mode === 'admin') return this.status;
    const session = this.snapshot;
    const services = await this._macServices();
    if (this.snapshot !== session || !this.applied) return { ok: false, code: 'not_active' };
    const holdFile = this._holdFile();
    const snap = {
      services: this._macSnapshotServices(services),
      mode: 'admin',
      form: 'pac',
      appliedMode: this.mode,
      holdFile,
      helperPid: 0,
      boot: bootTime(),
    };
    this.snapshot = snap;
    try { fs.mkdirSync(path.dirname(holdFile), { recursive: true }); fs.writeFileSync(holdFile, String(process.pid)); } catch {}
    this._arm();
    const script = SystemProxy._macAdminScript({
      services: snap.services, pacUrl: this.pacUrl, holdFile, appPid: process.pid,
    });
    let out = '';
    let err = null;
    try {
      out = await exec.run('osascript', ['-e', SystemProxy._appleScriptAdmin(script, true, this._prompt('apply'))], 300000);
    } catch (e) { err = e; }
    if (this.snapshot !== snap || !this.applied) {
      // Stopped while the dialog was open: this answer is nobody's. Without
      // its hold file, a helper it started restores straight away.
      try { fs.rmSync(holdFile, { force: true }); } catch {}
      return { ok: false, code: 'not_active' };
    }
    if (err) {
      // Dismissed or refused: nothing was changed.
      try { fs.rmSync(holdFile, { force: true }); } catch {}
      this.snapshot = { services: [], mode: 'perapp', form: 'pac', appliedMode: this.mode };
      this._unarm();
      const cancelled = /-128|cancel/i.test(`${err.stderr || ''} ${err.message || ''}`);
      this.log('warning', cancelled ? 'Administrator password not given; the system proxy was not changed' : `Could not change the system proxy as administrator: ${String(err.stderr || err.message).trim()}`);
      this.status = { ...this.status, ok: false, code: cancelled ? 'cancelled' : 'needs_admin' };
      return this.status;
    }
    snap.helperPid = parseInt(String(out).trim(), 10) || 0;
    for (const s of snap.services) s.applied = SystemProxy._macOwnedAutoSync(s.name);
    const ok = snap.services.some((s) => s.applied);
    if (ok) this._takeOverInherited();
    this._saveState();
    this.status = { ...this.status, ok, code: ok ? 'ok' : 'apply_failed', system: 'macos', admin: true, partial: false };
    if (ok) {
      this.log('success', `System routed through local proxy on port ${this.socksPort} (administrator)`);
      this._startOwnershipWatch();
    } else {
      this.log('warning', 'The system proxy did not change, although the administrator password was accepted');
    }
    return this.status;
  }

  /* One per password dialog, so a helper left by an abandoned one can never
   * be held by a later one. */
  _holdFile() {
    const id = `${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return this.stateFile ? `${this.stateFile}.${id}.hold` : path.join(os.tmpdir(), `shroudly-proxy-${id}.hold`);
  }

  /* What the password dialog says (opts.adminPrompt, in the user's
   * language when it has one). */
  _prompt(kind) {
    let s = null;
    try { s = this.adminPrompt ? this.adminPrompt(kind) : null; } catch {}
    return typeof s === 'string' && s.trim() ? s : MAC_ADMIN_PROMPT[kind];
  }

  /* The elevated script: apply, then start the restoring helper in the
   * background and print its pid. POSIX sh, every argument single-quoted.
   *
   * The helper waits while the hold file is there and Shroudly runs, then
   * puts back every service still on our PAC. A TERM or HUP (logout,
   * shutdown, launchd tearing the session down) puts back first and then
   * exits; without that it died with our PAC still set. The restore runs
   * once, whichever way it comes (r ignores both signals while it works). */
  static _macAdminScript({ services, pacUrl, holdFile, appPid, networksetup = MAC_NETWORKSETUP, nc = MAC_NC }) {
    const cmd = (args) => {
      if (!MAC_ELEVATED_VERBS.has(args[0])) throw new Error(`not an allowed networksetup call: ${args[0]}`);
      if (args.some((a) => /[\0\n\r]/.test(String(a)))) throw new Error('bad argument');
      return [networksetup, ...args].map(shq).join(' ');
    };
    if (!OUR_PAC.test(pacUrl)) throw new Error('not our PAC');
    const pid = Number(appPid) | 0;
    const apply = services.flatMap((s) => SystemProxy._macApplyArgs(s.name, pacUrl).map(cmd));
    // Per service: put it back only while it still has our PAC switched on.
    const back = services.map((s) => {
      let steps = SystemProxy._macRestoreArgs({ name: s.name, prevAuto: s.prevAuto }).map(cmd).join('; ');
      // The user's own PAC served on this Mac comes back only while
      // something still listens there, and switched off once its program has
      // gone (see _pacGone). Only nc failing to connect says gone: to the
      // address written, or for "localhost" to both of loopback's (a program
      // may serve on ::1 alone).
      const k = s.prevAuto && s.prevAuto.enabled ? SystemProxy._pacKind(SystemProxy._macSafeUrl(s.prevAuto.url)) : null;
      if (k && k.kind === 'local' && k.port) {
        const hosts = /^127\.\d+\.\d+\.\d+$/.test(k.host) || k.host === '::1' ? [k.host] : ['127.0.0.1', '::1'];
        const off = SystemProxy._macRestoreArgs({ name: s.name, prevAuto: { ...s.prevAuto, enabled: false } }).map(cmd).join('; ');
        const none = hosts.map((h) => `! ${shq(nc)} -z -G 2 ${shq(h)} ${Number(k.port) | 0} >/dev/null 2>&1`).join(' && ');
        steps = `if [ -x ${shq(nc)} ] && ${none}; then ${off}; else ${steps}; fi`;
      }
      return `case "$(${shq(networksetup)} -getautoproxyurl ${shq(s.name)})" in *${shq(`URL: ${pacUrl}`)}*${shq('Enabled: Yes')}*) ${steps};; esac`;
    });
    const restore = `r() { trap '' TERM HUP; ${back.length ? back.join('; ') : ':'}; }`;
    const wait = `while [ -e ${shq(holdFile)} ] && kill -0 ${pid} 2>/dev/null; do sleep 1; done`;
    return `${apply.map((c) => `${c} >/dev/null 2>&1`).join('; ')}; ( ${restore}; trap 'r; exit 0' TERM HUP; ${wait}; r ) </dev/null >/dev/null 2>&1 & echo $!`;
  }

  /* osascript source running a shell script, with administrator privileges
   * and the dialog's sentence: both go in AppleScript strings, where only \
   * and " are special. */
  static _appleScriptAdmin(shell, privileged = true, prompt = '') {
    const lit = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const says = privileged && prompt ? ` with prompt "${lit(String(prompt).replace(/[\0-\x1f\x7f]/g, ' '))}"` : '';
    return `do shell script "${lit(shell)}"${says}${privileged ? ' with administrator privileges' : ''}`;
  }

  /* Is the root helper of this snapshot still running? A process id from
   * before a restart of the Mac belongs to some other process now. */
  static _helperAlive(snap) {
    if (!snap || !snap.helperPid) return false;
    if (snap.boot && Math.abs(snap.boot - bootTime()) > 120) return false;
    return exec.alive(snap.helperPid);
  }

  /* Tell the root helper to restore (the hold file goes) and wait for it, at
   * most waitMs. True when it has finished (or there is none). */
  _macReleaseHelperSync(waitMs = MAC_HELPER_WAIT_SYNC_MS) {
    const snap = this.snapshot || {};
    if (snap.holdFile) { try { fs.rmSync(snap.holdFile, { force: true }); } catch {} }
    const until = Date.now() + waitMs;
    while (SystemProxy._helperAlive(snap) && Date.now() < until) exec.sleepSync(200);
    return !SystemProxy._helperAlive(snap);
  }

  async _macReleaseHelper(waitMs = this.helperWaitMs) {
    const snap = this.snapshot || {};
    if (snap.holdFile) { try { fs.rmSync(snap.holdFile, { force: true }); } catch {} }
    const until = Date.now() + waitMs;
    while (SystemProxy._helperAlive(snap) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    return !SystemProxy._helperAlive(snap);
  }

  /* Restore what was set with the administrator's password: normally the
   * helper does it. Only when it has finished and our PAC is somehow still
   * set, and only when the user is there to be asked (interactive: they
   * pressed Stop, or the window is up after a restart), is the password
   * asked again. Never while the helper is still at it, and never from the
   * synchronous exit path: false then, the state file stays, and the next
   * look (the watchdog's restore, the next start) finds it done or asks. */
  _restoreMacAdmin(sync, interactive = false) {
    const finish = (helperDone) => {
      if (!helperDone) return false;
      const plan = this._macRestorePlanSync();
      if (!plan.length) return true;
      if (sync || !interactive) return false;
      if (plan.some((a) => !MAC_ELEVATED_VERBS.has(a[0]) || a.some((x) => /[\0\n\r]/.test(String(x))))) return false;
      const script = plan.map((args) => [MAC_NETWORKSETUP, ...args].map(shq).join(' ')).join('; ');
      const src = SystemProxy._appleScriptAdmin(script, true, this._prompt('restore'));
      return exec.run('osascript', ['-e', src], 300000)
        .then(() => this._macRestorePlanSync().length === 0, () => { this._adminDeclined = true; return false; });
    };
    if (sync) return finish(this._macReleaseHelperSync(MAC_HELPER_WAIT_SYNC_MS));
    return this._macReleaseHelper(this.helperWaitMs).then(finish);
  }

  // ── Linux (GNOME gsettings, KDE kioslaverc; elsewhere the environment) ───
  async _has(cmd, args) { try { await exec.run(cmd, args, 3000); return true; } catch { return false; } }

  /* Which desktop Chromium thinks this is, by the same rules as
   * base::nix::GetDesktopEnvironment, case and all: XDG_CURRENT_DESKTOP
   * first (the first name it knows wins), then DESKTOP_SESSION, then
   * GNOME_DESKTOP_SESSION_ID and KDE_FULL_SESSION. What matters is the
   * group: 'gnome' (GSettings), 'kde' (kioslaverc), or 'xfce', 'lxqt',
   * 'other', where it reads only the environment. */
  static chromiumDesktop(env = process.env) {
    const has = (k) => typeof env[k] === 'string';
    if (has('XDG_CURRENT_DESKTOP')) {
      for (const v of env.XDG_CURRENT_DESKTOP.split(':').map((s) => s.trim()).filter(Boolean)) {
        if (['GNOME', 'Unity', 'X-Cinnamon', 'Pantheon', 'Deepin', 'UKUI', 'COSMIC'].includes(v)) return 'gnome';
        if (v === 'KDE') return 'kde';
        if (v === 'XFCE') return 'xfce';
        if (v === 'LXQt') return 'lxqt';
      }
    }
    if (has('DESKTOP_SESSION')) {
      const s = env.DESKTOP_SESSION;
      if (['deepin', 'gnome', 'mate', 'ukui'].includes(s)) return 'gnome';
      if (['kde4', 'kde-plasma', 'kde'].includes(s)) return 'kde';
      if (s.includes('xfce') || s === 'xubuntu') return 'xfce';
    }
    if (has('GNOME_DESKTOP_SESSION_ID')) return 'gnome';
    if (has('KDE_FULL_SESSION')) return 'kde';
    return 'other';
  }

  /* chromiumDesktop(), with LXQt also told apart where Chromium does not
   * (a lower-case or path-style name): to Chromium it is 'other' either way,
   * but it decides where the variable is written for the next login. */
  static linuxDesktop(env = process.env) {
    const d = SystemProxy.chromiumDesktop(env);
    if (d !== 'other') return d;
    const names = `${env.XDG_CURRENT_DESKTOP || ''}:${env.XDG_SESSION_DESKTOP || ''}:${env.DESKTOP_SESSION || ''}`.toLowerCase();
    if (/(^|[^a-z])lxqt([^a-z]|$)/.test(names)) return 'lxqt';
    if (/(^|[^a-z])xfce/.test(names)) return 'xfce';
    return 'other';
  }

  async _applyLinux() {
    const desktop = SystemProxy.linuxDesktop(this.env);
    this.snapshot = { mode: 'none', form: 'pac', appliedMode: this.mode, desktop, gnome: null, kde: null };
    // Our PAC still set by a run whose restore never happened: what that run
    // found there is the user's own setting.
    const old = this._inherited && this._inherited.snapshot && this._inherited.snapshot.form === 'pac' ? this._inherited.snapshot : null;
    const unq = (v) => String(v || '').replace(/^'(.*)'$/, '$1');
    // GNOME's setting is also read by Firefox (on any desktop) and GTK
    // programs, so it is set wherever it exists, as before.
    if (await this._has('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])) {
      try {
        const get = async (schema, key) => (await exec.run('gsettings', ['get', schema, key])).trim();
        this.snapshot.gnome = {
          mode: await get('org.gnome.system.proxy', 'mode'),
          autourl: await get('org.gnome.system.proxy', 'autoconfig-url'),
          // Not changed any more, but kept so an older Shroudly finding this
          // state file restores them as they are.
          host: await get('org.gnome.system.proxy.socks', 'host'),
          port: await get('org.gnome.system.proxy.socks', 'port'),
        };
        const g = this.snapshot.gnome;
        if (old && old.gnome && g.mode === "'auto'" && OUR_PAC.test(unq(g.autourl))) this.snapshot.gnome = old.gnome;
      } catch (e) { this.log('warning', `gsettings failed: ${e.message}`); }
    }
    if (desktop === 'kde') {
      const file = this._kdeFile();
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch {}
      const cur = SystemProxy._kdeRead(text);
      if (cur.locked) this.log('warning', 'KDE proxy settings are locked by the administrator');
      else if (old && old.kde && cur.type === '2' && OUR_PAC.test(cur.script || '')) this.snapshot.kde = { ...old.kde, file };
      else this.snapshot.kde = { file, type: cur.type, script: cur.script };
    }
    const envDesktop = ENV_DESKTOPS.has(desktop);
    if (!this.snapshot.gnome && !this.snapshot.kde && !envDesktop) {
      return { ok: false, code: 'apply_failed', system: desktop, detail: 'The desktop proxy setting could not be read.' };
    }

    let gnomeOk = false;
    let kdeOk = false;
    if (this.snapshot.gnome || this.snapshot.kde) {
      this.snapshot.mode = 'desktop';
      this._arm();
      if (this.snapshot.gnome) {
        try {
          // Automatic configuration from our PAC, in both route modes. In this
          // mode GNOME, Chromium, Firefox and GIO use only the PAC: the manual
          // HTTP/HTTPS/SOCKS entries, whoever set them, are not consulted.
          await exec.run('gsettings', ['set', 'org.gnome.system.proxy', 'autoconfig-url', this.pacUrl]);
          await exec.run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'auto']);
          gnomeOk = this._gnomeOwnedSync();
          if (!gnomeOk) throw new Error('the setting did not take');
        } catch (e) {
          this.log('warning', `gsettings failed: ${e.message}`);
          this._restoreGnomeSync(true);
          this.snapshot.gnome = null;
        }
      }
      if (this.snapshot.kde) {
        try {
          this._kdeWriteSync(this.snapshot.kde.file, { [KDE_TYPE]: '2', [KDE_SCRIPT]: this.pacUrl });
          kdeOk = this._kdeOwnedSync();
          if (!kdeOk) throw new Error('the setting did not take');
          this._kdeNotify();
        } catch (e) {
          this.log('warning', `KDE proxy setting failed: ${e.message}`);
          this._restoreKdeSync(true);
          this.snapshot.kde = null;
        }
      }
      if (!this.snapshot.gnome && !this.snapshot.kde) {
        this.snapshot.mode = 'none';
        this._unarm();
      } else {
        this._takeOverInherited();
        this._saveState();
      }
    }

    // XFCE, LXQt and others: Firefox through GNOME's setting, Chromium
    // browsers through the environment.
    if (envDesktop) return this._envStatus(desktop, gnomeOk);
    const ok = desktop === 'kde' ? kdeOk : gnomeOk;
    if (ok) return { ok: true, code: 'ok', system: desktop };
    return { ok: false, code: 'apply_failed', system: desktop, partial: gnomeOk || kdeOk, detail: 'The desktop refused the proxy setting.' };
  }

  /* What a desktop without a proxy setting got. Firefox follows GNOME's
   * setting (set or not: firefox); Chromium browsers started now follow our
   * auto_proxy when this session already has it (Shroudly was started with
   * it), otherwise after the next login, if it could be written.
   *
   * Written at an earlier login and still missing from this one: this
   * session reads neither ~/.xprofile nor environment.d (startx, or sway,
   * Hyprland or labwc started from a text console or by SDDM's Wayland
   * script), and logging in again will not change that (chromiumNotTaken):
   * the PAC's address is shown for setting it by hand instead of a promise.
   *
   * chromiumRestart: Chromium browsers and apps follow it, but each one read
   * the address when it started; one started before our PAC answered there
   * (or while it said DIRECT, protection off) may go around Shroudly until it
   * is reopened, and the window says so. */
  _envStatus(desktop, firefox) {
    const env = this._envApply(desktop);
    const chromiumNow = this.env[ENV_VAR] === this.pacUrl;
    const chromiumNotTaken = !chromiumNow && env.written && env.beforeThisLogin;
    const chromiumAfterRelogin = !chromiumNow && env.written && !chromiumNotTaken;
    if (firefox && chromiumNow) return { ok: true, code: 'ok', system: desktop, chromiumRestart: true };
    if (!firefox && !chromiumNow && !chromiumAfterRelogin) {
      return chromiumNotTaken
        ? { ok: false, code: 'no_system_proxy', system: desktop, chromiumNotTaken, detail: 'This session does not read the setting Shroudly writes for Chrome and other Chromium browsers.' }
        : { ok: false, code: 'no_system_proxy', system: desktop, detail: 'This desktop has no system proxy setting.' };
    }
    const detail = chromiumNow ? 'Chrome and other Chromium browsers go through Shroudly; Firefox has to be set by hand'
      : chromiumNotTaken ? 'Firefox goes through Shroudly; this session does not read the setting Shroudly writes for Chrome and other Chromium browsers, so they have to be set by hand'
        : !chromiumAfterRelogin ? 'Firefox goes through Shroudly; Chrome and other Chromium browsers could not be set on this desktop'
          : firefox ? 'Firefox goes through Shroudly now; Chrome and other Chromium browsers will after you log out and back in'
            : 'Chrome and other Chromium browsers will go through Shroudly after you log out and back in; Firefox has to be set by hand';
    return { ok: false, code: 'partial_env', system: desktop, partial: true, firefox, chromiumNow, chromiumAfterRelogin, chromiumNotTaken, chromiumRestart: chromiumNow, detail };
  }

  _gnomeOwnedSync() {
    try {
      const mode = exec.runSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode']).trim();
      if (mode === "'auto'") {
        const auto = exec.runSync('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url']).trim().replace(/^'(.*)'$/, '$1');
        return OUR_PAC.test(auto);
      }
      // 2.5.4 and earlier: the SOCKS proxy in manual mode.
      if (mode !== "'manual'" || (this.snapshot && this.snapshot.form === 'pac')) return false;
      const host = exec.runSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host']).trim();
      const gport = exec.runSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port']).trim();
      return host === "'127.0.0.1'" && gport === String(this.socksPort);
    } catch { return false; }
  }

  /* gsettings prints strings quoted ('none'); `set` takes them unquoted. A
   * 2.5.4 snapshot also gets its SOCKS host and port back. */
  static _gnomeRestoreArgs(g, legacy = true) {
    const unq = (v) => String(v || '').replace(/^'(.*)'$/, '$1');
    const auto = unq(g.autourl);
    const steps = [];
    if (legacy) {
      steps.push(['set', 'org.gnome.system.proxy.socks', 'host', unq(g.host)]);
      steps.push(['set', 'org.gnome.system.proxy.socks', 'port', String(parseInt(g.port, 10) || 0)]);
    }
    steps.push(['set', 'org.gnome.system.proxy', 'autoconfig-url', OUR_PAC.test(auto) ? '' : auto]);
    steps.push(['set', 'org.gnome.system.proxy', 'mode', unq(g.mode) || 'none']); // mode last
    return steps;
  }

  /* The GNOME record to put back: the user's own PAC, or manual proxy,
   * served on this computer by a program that has gone comes back with the
   * mode 'none' (its addresses kept), not pointing at nothing (_pacGone).
   * Shroudly never writes the manual servers: what is there now is what
   * the mode would switch back on (2.5.4 and earlier wrote its SOCKS one:
   * put back as recorded). */
  _gnomeRestorable(g, legacy = false) {
    const unq = (v) => String(v || '').replace(/^'(.*)'$/, '$1');
    const mode = unq(g.mode);
    if (mode === 'auto') return this._pacGone(unq(g.autourl)) ? { ...g, mode: "'none'" } : g;
    if (mode !== 'manual' || legacy) return g;
    const servers = [];
    for (const kind of ['http', 'https', 'ftp', 'socks']) {
      let host = '';
      let port = 0;
      try {
        host = unq(exec.runSync('gsettings', ['get', `org.gnome.system.proxy.${kind}`, 'host'], 3000).trim());
        port = parseInt(exec.runSync('gsettings', ['get', `org.gnome.system.proxy.${kind}`, 'port'], 3000).trim(), 10) || 0;
      } catch { return g; } // cannot be told: as before
      if (host && port) servers.push({ host, port });
    }
    const shown = [...new Set(servers.map((x) => `${x.host}:${x.port}`))].join(', ');
    return this._localGone(shown, servers) ? { ...g, mode: "'none'" } : g;
  }

  /* force: straight after a failed apply, when what is there is ours even if
   * only half written, or a set-back was writing it (see restoreSync). */
  _restoreGnomeSync(force = false) {
    const g = this.snapshot && this.snapshot.gnome;
    if (!g) return;
    const legacy = this.snapshot.form !== 'pac';
    if (!force && !legacy && !this._gnomeOwnedSync()) return; // someone else's setting by now
    for (const args of SystemProxy._gnomeRestoreArgs(this._gnomeRestorable(g, legacy), legacy)) { try { exec.runSync('gsettings', args, 3000); } catch {} }
  }

  async _restoreLinux() {
    const g = this.snapshot && this.snapshot.gnome;
    if (g) {
      const legacy = this.snapshot.form !== 'pac';
      if (legacy || this._gnomeOwnedSync()) {
        for (const args of SystemProxy._gnomeRestoreArgs(this._gnomeRestorable(g, legacy), legacy)) { try { await exec.run('gsettings', args, 4000); } catch {} }
      }
    }
    this._restoreKdeSync();
  }

  _restoreLinuxSync(force = null) {
    this._restoreGnomeSync(!!(force && force.has('GNOME')));
    this._restoreKdeSync(!!(force && force.has('KDE')));
  }

  // ── KDE Plasma (kioslaverc) ────────────────────────────────────────────
  /* Plasma 5 and 6 both keep the proxy in kioslaverc, [Proxy Settings]:
   * ProxyType 2 is "use this PAC", "Proxy Config Script" its URL. KIO
   * programs re-read it on the reparseSlaveConfiguration signal (the same
   * name in KIO 5 and 6); Chromium watches the file itself. */
  _kdeFile() {
    const base = this.env.XDG_CONFIG_HOME || path.join(this.env.HOME || os.homedir(), '.config');
    return path.join(base, 'kioslaverc');
  }

  static _kdeUnescape(v) {
    return String(v).trim().replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', s: ' ', '\\': '\\' }[c] ?? m));
  }

  static _kdeEscape(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/^ /, '\\s');
  }

  /* The two keys, null when absent; locked when the administrator made them
   * immutable ([$i]). */
  static _kdeRead(text, extra = null) {
    const out = { type: null, script: null, locked: false };
    if (extra) out.value = null; // and the value of this key of the group
    let inGroup = false;
    for (const raw of String(text).split('\n')) {
      const line = raw.replace(/\r$/, '');
      const t = line.trim();
      if (t.startsWith('[')) {
        const m = t.match(/^\[([^\]]*)\](\[\$i\])?$/);
        inGroup = !!m && m[1] === KDE_GROUP;
        if (inGroup && m[2]) out.locked = true;
        continue;
      }
      if (!inGroup || !t || t.startsWith('#')) continue;
      const m = line.match(/^\s*([^=[]+?)\s*((?:\[[^\]]*\])*)\s*=(.*)$/);
      if (!m) continue;
      if (/\[\$[^\]]*i[^\]]*\]/.test(m[2])) { if (m[1] === KDE_TYPE || m[1] === KDE_SCRIPT) out.locked = true; }
      if (m[2] && !/^(\[\$[a-z]+\])+$/.test(m[2])) continue; // a translation, not the value
      if (m[1] === KDE_TYPE) out.type = SystemProxy._kdeUnescape(m[3]);
      else if (m[1] === KDE_SCRIPT) out.script = SystemProxy._kdeUnescape(m[3]);
      else if (extra && m[1] === extra) out.value = SystemProxy._kdeUnescape(m[3]);
    }
    return out;
  }

  /* KDE's manual proxy servers in the file, each { host, port }: written
   * "http://127.0.0.1 7890" (a space before the port), or with a colon. */
  static _kdeManualServers(text) {
    const out = [];
    for (const key of ['httpProxy', 'httpsProxy', 'ftpProxy', 'socksProxy']) {
      const v = String(SystemProxy._kdeRead(text, key).value || '').trim();
      if (!v) continue;
      const m = v.replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/\/.*$/, '').match(/^(\[[^\]]+\]|[^\s:]+)(?:[\s:]+(\d+))?$/);
      if (m && m[2]) out.push({ host: m[1], port: Number(m[2]) });
    }
    return out;
  }

  /* The manual proxy the user had (type 1) is served on this computer by a
   * program that has gone (see _pacGone). */
  _kdeManualGone(file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
    const servers = SystemProxy._kdeManualServers(text);
    const shown = [...new Set(servers.map((x) => `${x.host}:${x.port}`))].join(', ');
    return this._localGone(shown, servers);
  }

  /* The file with the given keys set (null: removed), everything else as it
   * was. */
  static _kdeEdit(text, values) {
    const lines = String(text).split('\n');
    const trailingNl = lines.length > 1 && lines[lines.length - 1] === '';
    if (trailingNl) lines.pop();
    if (lines.length === 1 && lines[0] === '') lines.pop();
    const keyOf = (line) => { const m = line.match(/^\s*([^=[]+?)\s*((?:\[\$[a-z]+\])*)\s*=/); return m ? m[1] : null; };
    let start = lines.findIndex((l) => l.trim() === `[${KDE_GROUP}]`);
    if (start < 0) {
      if (!Object.values(values).some((v) => v !== null)) return text;
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(`[${KDE_GROUP}]`);
      start = lines.length - 1;
    }
    let end = lines.findIndex((l, i) => i > start && l.trim().startsWith('['));
    if (end < 0) end = lines.length;
    for (const [key, value] of Object.entries(values)) {
      const idx = [];
      for (let i = start + 1; i < end; i++) if (keyOf(lines[i]) === key) idx.push(i);
      if (value === null) {
        for (const i of idx.reverse()) { lines.splice(i, 1); end--; }
        continue;
      }
      const line = `${key}=${SystemProxy._kdeEscape(value)}`;
      if (idx.length) {
        lines[idx[0]] = line;
        for (const i of idx.slice(1).reverse()) { lines.splice(i, 1); end--; }
      } else {
        // After the group's last entry, before the blank line that ends it.
        let at = end;
        while (at > start + 1 && lines[at - 1].trim() === '') at--;
        lines.splice(at, 0, line);
        end++;
      }
    }
    return `${lines.join('\n')}\n`;
  }

  /* kwriteconfig6 / kwriteconfig5 when there is one (KDE's own writer, which
   * locks the file against a settings window saving at the same moment);
   * otherwise the file is edited in place, atomically. */
  _kdeTool() {
    if (this._kdeToolName !== undefined) return this._kdeToolName;
    this._kdeToolName = null;
    for (const t of ['kwriteconfig6', 'kwriteconfig5']) {
      try { exec.runSync(t, ['--help'], 3000); this._kdeToolName = t; break; } catch {}
    }
    return this._kdeToolName;
  }

  _kdeWriteSync(file, values) {
    const tool = this._kdeTool();
    if (tool) {
      try {
        for (const [key, value] of Object.entries(values)) {
          const base = ['--file', file, '--group', KDE_GROUP, '--key', key];
          exec.runSync(tool, value === null ? [...base, '--delete'] : [...base, value], 4000);
        }
        return;
      } catch { /* an old kwriteconfig without --delete: edit the file */ }
    }
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch {}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, SystemProxy._kdeEdit(text, values), 0o600);
  }

  _kdeNotify() {
    exec.spawnDetached('dbus-send', ['--session', '--type=signal', '/KIO/Scheduler', 'org.kde.KIO.Scheduler.reparseSlaveConfiguration', 'string:']);
  }

  _kdeOwnedSync() {
    const k = this.snapshot && this.snapshot.kde;
    let text = '';
    try { text = fs.readFileSync((k && k.file) || this._kdeFile(), 'utf8'); } catch {}
    const cur = SystemProxy._kdeRead(text);
    return cur.type === '2' && OUR_PAC.test(cur.script || '');
  }

  _restoreKdeSync(force = false) {
    const k = this.snapshot && this.snapshot.kde;
    if (!k || (!force && !this._kdeOwnedSync())) return;
    const script = k.script && !OUR_PAC.test(k.script) ? k.script : null;
    // The user's own PAC, or manual proxy, served on this computer by a
    // program that has gone: no proxy, its addresses kept (_pacGone).
    const type = (k.type === '2' && (!script || this._pacGone(script))) || (k.type === '1' && this._kdeManualGone(k.file)) ? null : k.type;
    try { this._kdeWriteSync(k.file, { [KDE_TYPE]: type, [KDE_SCRIPT]: script }); } catch {}
    this._kdeNotify();
  }
  // ── Linux desktops without a proxy setting (XFCE, LXQt, others) ─────────
  /*
   * Chromium browsers on these desktops take their proxy from the
   * environment, once, when they start: auto_proxy=<PAC URL>
   * (net/proxy_resolution/proxy_config_service_linux.cc, GetConfigFromEnv).
   * A running session cannot be given a variable, so it goes where the next
   * login picks it up:
   *   ~/.config/environment.d/90-shroudly.conf   systemd user sessions
   *   ~/.config/lxqt/session.conf, [Environment] LXQt: lxqt-session exports these
   *   ~/.xprofile, in a marked block              XFCE and other X11 sessions
   *                                               (sourced by LightDM's, GDM's and SDDM's session scripts)
   * and into the systemd user manager's and D-Bus's activation environment,
   * for programs started through those from now on. The PAC keeps its port
   * from run to run (portStore), so the address stays right; when Shroudly's
   * own environment already has it, this session got it at login, and
   * Chromium browsers started now go through Shroudly.
   *
   * How long they stay. They only take effect at the next login, and logging
   * out quits Shroudly, so taking them out at every quit would make them
   * useless. The rules:
   *   - apply() writes them on these desktops and records what it wrote, and
   *     what was there before, in envStateFile. That file is not the state
   *     file: the watchdog and the login hook start a restore whenever the
   *     state file outlives the app, and these are meant to outlive it.
   *   - They stay through quit, logout, crash, power loss and engine
   *     restarts. restore(), restoreSync(), recoverSync(), --restore-proxy
   *     and the watchdog never touch them (they still put GNOME's setting,
   *     KDE, macOS and Windows back exactly as before). A Chromium browser
   *     started while Shroudly is not running cannot fetch the PAC, goes
   *     direct, and fetches it again later (after 8 s, 32 s, 2 min, then on a
   *     network change), so a leftover costs nothing. One that fetched it
   *     before goes direct too: the PAC ends in DIRECT on these desktops
   *     (pacProxy), and says only DIRECT while protection is off and
   *     Shroudly still runs (_parkPacServer).
   *   - clearEnv() takes them out, exactly as recorded, when the user stops
   *     protection, and at a start with protection off (EngineManager). A
   *     route mode that did not use the system proxy would too, but both use
   *     the PAC. An uninstall cannot: no Linux package runs anything per user
   *     (see README).
   */
  _envTargets(desktop) {
    const home = this.env.HOME || os.homedir();
    const cfg = this.env.XDG_CONFIG_HOME || path.join(home, '.config');
    const t = [{ kind: 'environment.d', file: path.join(cfg, 'environment.d', ENVD_FILE) }];
    if (desktop === 'lxqt') t.push({ kind: 'lxqt', file: path.join(cfg, 'lxqt', 'session.conf') });
    else t.push({ kind: 'xprofile', file: path.join(home, '.xprofile') });
    return t;
  }

  /* Write the variable for the next login (and, where it reaches, for
   * programs started now). { written } when at least one place has it;
   * beforeThisLogin: and it was already written, at this address, at an
   * earlier login (see _envStatus). */
  _envApply(desktop) {
    if (!this.envStateFile || !OUR_PAC.test(this.pacUrl || '')) return { written: false };
    const url = this.pacUrl;
    const old = SystemProxy._envRead(this.envStateFile) || { files: [] };
    const targets = this._envTargets(desktop);
    // Places written for another desktop in an earlier session stay recorded,
    // and get the current address too.
    for (const r of old.files) {
      if (r && r.file && ['environment.d', 'xprofile', 'lxqt'].includes(r.kind) && !targets.some((t) => t.file === r.file)) targets.push({ kind: r.kind, file: r.file });
    }
    const plans = targets.map((t) => {
      const oldRec = old.files.find((r) => r && r.file === t.file) || null;
      return { ...SystemProxy._envPlan(t, url, oldRec), oldRec };
    });
    // The login this address was first written at: kept while it stays the same.
    const session = SystemProxy._sessionKey(this.env);
    const since = old.url === url && old.session ? old.session : session;
    const state = { v: 1, url, desktop, session: since, files: plans.map((p) => p.rec), activation: old.activation || null };
    // Recorded before anything is written: whatever happens next, the record
    // is there to undo it.
    if (!SystemProxy._envWrite(this.envStateFile, state)) return { written: false };
    for (const p of plans) {
      if (p.skip) continue; // nothing of ours there to update, and nothing appended (see _xprofileSet)
      let madeDir = null;
      try {
        if (p.next !== p.cur) {
          if (p.cur === null) madeDir = SystemProxy._mkdirFor(p.file);
          writeAtomic(p.file, p.next, 0o644);
          if (madeDir) p.rec.madeDir = madeDir;
        }
        p.ok = true;
      } catch (e) {
        // The file is as it was; a folder made for it goes again.
        if (madeDir) SystemProxy._rmMadeDirs(p.file, madeDir);
        this.log('warning', `Could not write ${p.file} for the next login: ${e.message}`);
      }
    }
    // A place not written keeps what an earlier run recorded for it (its
    // entry from then is still there to undo), or nothing.
    state.files = plans.map((p) => (p.ok ? p.rec : p.oldRec)).filter(Boolean);
    state.activation = this._envActivation(url, old.activation);
    SystemProxy._envWrite(this.envStateFile, state);
    const written = plans.some((p) => p.ok);
    return { written, beforeThisLogin: written && old.url === url && !!old.session && !!session && old.session !== session };
  }

  /* This login, told apart from every other: the boot of the machine and the
   * session logind gave it. null where that cannot be told. */
  static _sessionKey(env) {
    const id = env && env.XDG_SESSION_ID;
    const boot = id ? exec.bootId() : null;
    return id && boot ? `${boot}/${id}` : null;
  }

  /* Make the folder a file goes in. Returns the topmost folder that had to
   * be made (null: none), worked out here rather than taken from mkdir, so
   * it is written exactly as _rmMadeDirs will compare it. */
  static _mkdirFor(file) {
    const dir = path.dirname(path.resolve(file));
    let top = null;
    for (let d = dir; !fs.existsSync(d); d = path.dirname(d)) { top = d; if (path.dirname(d) === d) break; }
    fs.mkdirSync(dir, { recursive: true });
    return top;
  }

  /* Folders made for a file (madeDir, the topmost) go when they are empty. */
  static _rmMadeDirs(file, madeDir) {
    const top = path.resolve(madeDir);
    for (let d = path.dirname(path.resolve(file)); d === top || d.startsWith(`${top}${path.sep}`); d = path.dirname(d)) {
      if (!SystemProxy._rmdirSoon(d)) break;
    }
  }

  /* Remove an empty folder. Windows can refuse for a moment while another
   * program (a virus scanner) still holds the file just removed from it. */
  static _rmdirSoon(d) {
    for (let i = 0; ; i++) {
      try { fs.rmdirSync(d); return true; } catch (e) {
        if (process.platform !== 'win32' || i >= 10 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(e.code)) return false;
        sleepSync(50);
      }
    }
  }

  /* Remove what was written for the next login: the user stopped protection. */
  clearEnv() { return SystemProxy.clearEnvSync({ envStateFile: this.envStateFile }, this.log); }

  /* Take out, exactly as recorded, what was written for the next login.
   * Only for the user stopping protection, or a start with protection off;
   * never after a crash (see above). True when something was removed. */
  static clearEnvSync(opts = {}, log = () => {}) {
    const file = opts.envStateFile || SystemProxy._envStateFileFor(opts.stateFile);
    const state = file ? SystemProxy._envRead(file) : null;
    if (!state) return false;
    let changed = false;
    const left = [];
    for (const rec of state.files) {
      try { if (SystemProxy._envUndoFile(rec)) changed = true; } catch { left.push(rec); }
    }
    try { if (SystemProxy._envUndoActivation(state.activation)) changed = true; } catch {}
    if (left.length) SystemProxy._envWrite(file, { ...state, files: left, activation: null }); // tried again next time
    else { try { fs.rmSync(file, { force: true }); } catch {} }
    if (changed) log('info', 'Browser settings for the next login removed');
    return changed;
  }

  static _envStateFileFor(stateFile) { return stateFile ? path.join(path.dirname(stateFile), 'proxy-env.json') : null; }

  static _envRead(file) {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      return s && Array.isArray(s.files) ? s : null;
    } catch { return null; }
  }

  static _envWrite(file, state) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(file, JSON.stringify(state), 0o600);
      return true;
    } catch { return false; }
  }

  /* One place: what it holds now, what it will hold, and what to record to
   * undo exactly that. When our entry is already there (an earlier run), the
   * earlier record stays: it knows what was there before us. */
  static _envPlan(t, url, oldRec) {
    const cur = readOrNull(t.file);
    const keep = oldRec && oldRec.kind === t.kind ? oldRec : null;
    const base = { kind: t.kind, file: t.file };
    let next;
    let rec;
    let skip = false;
    if (t.kind === 'environment.d') {
      next = SystemProxy._envdText(url);
      const ours = cur !== null && SystemProxy._envdOurs(cur);
      rec = ours ? (keep || { ...base, created: true }) : { ...base, created: cur === null, before: cur };
    } else if (t.kind === 'xprofile') {
      const r = SystemProxy._xprofileSet(cur, url);
      next = r.text;
      skip = !!r.skip;
      rec = r.had ? (keep || { ...base, created: false, nl: false }) : { ...base, created: cur === null, nl: r.nl };
    } else { // 'lxqt'
      const r = SystemProxy._iniSet(cur || '', LXQT_GROUP, ENV_VAR, url);
      next = r.text;
      rec = r.ours ? (keep || { ...base, created: false, createdSection: false, sep: '', prevLine: null })
        : { ...base, created: cur === null, createdSection: r.createdSection, sep: r.sep, prevLine: r.prevLine };
    }
    return { file: t.file, cur, next, rec, skip };
  }

  /* Undo one place. Only our own entry goes; a value someone else put there
   * since stays. */
  static _envUndoFile(rec) {
    if (!rec || !rec.file) return false;
    const cur = readOrNull(rec.file);
    if (cur === null) return false;
    let next;
    if (rec.kind === 'environment.d') {
      if (!SystemProxy._envdOurs(cur)) return false;
      next = rec.created || typeof rec.before !== 'string' ? null : rec.before;
    } else if (rec.kind === 'xprofile') {
      next = SystemProxy._xprofileStrip(cur, rec.nl);
      if (rec.created && next === '') next = null;
    } else if (rec.kind === 'lxqt') {
      next = SystemProxy._iniUnset(cur, rec, LXQT_GROUP, ENV_VAR);
      if (rec.created && next === '') next = null;
    } else return false;
    if (next === cur) return false;
    if (next !== null) { writeAtomic(rec.file, next); return true; }
    fs.rmSync(rec.file, { force: true });
    // Folders made for it go too, when nothing else is in them.
    if (rec.madeDir) SystemProxy._rmMadeDirs(rec.file, rec.madeDir);
    return true;
  }

  // environment.d: the whole file is ours.
  static _envdText(url) {
    return `# Written by Shroudly while its protection is on; removed when it is switched off.\n${ENV_VAR}=${url}\n`;
  }

  static _envdOurs(text) { return /^auto_proxy=http:\/\/127\.0\.0\.1:\d+\/proxy\.pac$/m.test(String(text)); }

  // ~/.xprofile: a marked block, appended.
  static _xprofileBlock(url) { return `${XPROFILE_BEGIN}\nexport ${ENV_VAR}='${url}'\n${XPROFILE_END}\n`; }

  /* Our block, whole and exactly as written: the begin marker, our one
   * export line and the end marker, three lines in a row. Nothing else is
   * taken for it, so a line of the user's own is never counted as ours. */
  static _xprofileRange(text) {
    const m = XPROFILE_BLOCK.exec(text);
    if (!m) return null;
    const start = m.index + m[1].length;
    return { start, end: start + m[2].length };
  }

  /* Our lines where the block is no longer whole (the user deleted a line of
   * it, or wrote between its markers): the begin marker, our export line
   * right after it, and the next end marker, as line indexes (-1: not
   * there). null when there is no begin marker. */
  static _xprofileOrphan(lines) {
    const begin = lines.indexOf(XPROFILE_BEGIN);
    if (begin < 0) return null;
    const exp = XPROFILE_EXPORT.test(lines[begin + 1] || '') ? begin + 1 : -1;
    return { begin, exp, end: lines.indexOf(XPROFILE_END, begin + 1) };
  }

  /* The text with our block set to url. nl: a newline had to be added
   * before it (the file did not end with one), which a removal takes out
   * again. had: the block was there already. With our markers there but
   * the block not whole, only our own export line changes, and nothing is
   * appended: a second block would put the user's lines between a begin
   * marker and an end marker of ours. skip: not even that line is there. */
  static _xprofileSet(text, url) {
    const cur = text == null ? '' : String(text);
    const r = SystemProxy._xprofileRange(cur);
    if (r) return { text: cur.slice(0, r.start) + SystemProxy._xprofileBlock(url) + cur.slice(r.end), had: true, nl: false };
    const lines = cur.split('\n');
    const o = SystemProxy._xprofileOrphan(lines);
    if (o) {
      if (o.exp < 0) return { text: cur, had: false, nl: false, skip: true };
      lines[o.exp] = `export ${ENV_VAR}='${url}'`;
      return { text: lines.join('\n'), had: true, nl: false };
    }
    const nl = cur.length > 0 && !cur.endsWith('\n');
    return { text: `${cur}${nl ? '\n' : ''}${SystemProxy._xprofileBlock(url)}`, had: false, nl };
  }

  /* The text without our block: exactly what it was before, when nothing
   * else changed since. Where the block is no longer whole, our own lines
   * go one by one and every other line stays. */
  static _xprofileStrip(text, nl) {
    let out = text;
    const r = SystemProxy._xprofileRange(out);
    if (r) {
      let start = r.start;
      if (nl && r.end === out.length && start > 0 && out[start - 1] === '\n') start -= 1;
      out = out.slice(0, start) + out.slice(r.end);
    }
    const lines = out.split('\n');
    const o = SystemProxy._xprofileOrphan(lines);
    if (!o) return out;
    const drop = new Set([o.begin, o.exp, o.end].filter((i) => i >= 0));
    return lines.filter((_, i) => !drop.has(i)).join('\n');
  }

  // LXQt's session.conf, an INI file read with QSettings.
  static _iniFind(lines, group, key) {
    const start = lines.findIndex((l) => l.trim() === `[${group}]`);
    if (start < 0) return { start: -1, end: -1, at: -1 };
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    let at = -1;
    for (let i = start + 1; i < end && at < 0; i++) {
      const m = lines[i].match(/^\s*([^=;#\s][^=]*?)\s*=/);
      if (m && m[1] === key) at = i;
    }
    return { start, end, at };
  }

  static _iniValue(line) { return String(line).replace(/^[^=]*=/, '').trim().replace(/^"(.*)"$/, '$1'); }

  /* The text with key=value in [group], every other byte as it was, and how
   * to undo it: the line it replaced (prevLine), or that the group was added
   * (createdSection, after sep). ours: the key held our address already. */
  static _iniSet(text, group, key, value) {
    const lines = text.split('\n');
    const f = SystemProxy._iniFind(lines, group, key);
    const line = `${key}=${value}`;
    if (f.start >= 0 && f.at >= 0) {
      const prevLine = lines[f.at];
      lines[f.at] = line;
      return { text: lines.join('\n'), ours: OUR_PAC.test(SystemProxy._iniValue(prevLine)), prevLine, createdSection: false, sep: '' };
    }
    if (f.start >= 0) {
      // After the group's last entry, before the blank lines that end it.
      let at = f.end;
      while (at > f.start + 1 && lines[at - 1].trim() === '') at--;
      lines.splice(at, 0, line);
      return { text: lines.join('\n'), ours: false, prevLine: null, createdSection: false, sep: '' };
    }
    const sep = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { text: `${text}${sep}[${group}]\n${line}\n`, ours: false, prevLine: null, createdSection: true, sep };
  }

  /* The text with our key undone as recorded: the old line back, or the key
   * gone, and the group too when we added it and it is empty again. */
  static _iniUnset(text, rec, group, key) {
    const lines = text.split('\n');
    const f = SystemProxy._iniFind(lines, group, key);
    if (f.at < 0 || !OUR_PAC.test(SystemProxy._iniValue(lines[f.at]))) return text; // not ours any more
    if (typeof rec.prevLine === 'string') {
      lines[f.at] = rec.prevLine;
      return lines.join('\n');
    }
    lines.splice(f.at, 1);
    let out = lines.join('\n');
    if (rec.createdSection) {
      const g = SystemProxy._iniFind(lines, group, key);
      if (g.start >= 0 && lines.slice(g.start + 1, g.end).every((l) => l.trim() === '')) {
        const tail = `${rec.sep || ''}[${group}]\n`;
        if (out.endsWith(tail)) out = out.slice(0, out.length - tail.length);
        else { lines.splice(g.start, 1); out = lines.join('\n'); }
      }
    }
    return out;
  }

  /* systemctl --user show-environment prints NAME=value, or NAME=$'...' when
   * the value needs quoting. null when the name is not set. */
  static _systemdVar(out, name) {
    for (const line of String(out).split('\n')) {
      if (!line.startsWith(`${name}=`)) continue;
      const v = line.slice(name.length + 1);
      if (!(v.startsWith("$'") && v.endsWith("'"))) return v;
      return v.slice(2, -1).replace(/\\(x[0-9a-fA-F]{2}|.)/g, (m, c) => (c.length === 3 && c[0] === 'x'
        ? String.fromCharCode(parseInt(c.slice(1), 16))
        : ({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }[c] ?? c)));
    }
    return null;
  }

  /* The variable for programs started through systemd or D-Bus from now on:
   * best effort, only where the tools are there, each call time-limited.
   * Records the user's own value from before, to put back. */
  _envActivation(url, old) {
    const act = { systemd: null, dbus: false };
    let shown = null;
    try { shown = exec.runSync('systemctl', ['--user', 'show-environment'], 3000); } catch {}
    if (shown !== null) {
      const cur = SystemProxy._systemdVar(shown, ENV_VAR);
      // Ours already (an earlier run): what that run found is the user's.
      const prev = cur !== null && OUR_PAC.test(cur) ? ((old && old.systemd && old.systemd.prev) ?? null) : cur;
      try { exec.runSync('systemctl', ['--user', 'set-environment', `${ENV_VAR}=${url}`], 3000); act.systemd = { prev }; } catch {}
    }
    if (!act.systemd && old && old.systemd) act.systemd = old.systemd;
    try { exec.runSync('dbus-update-activation-environment', ['--systemd', `${ENV_VAR}=${url}`], 3000); act.dbus = true; } catch {}
    if (old && old.dbus) act.dbus = true;
    return act;
  }

  /* systemd's variable goes back to the user's value, or away, while it is
   * still ours. D-Bus's own activation environment can be set but not unset:
   * the user's value goes back when there was one; otherwise ours stays
   * there until logout, a dead address Chromium goes direct around. */
  static _envUndoActivation(act) {
    if (!act) return false;
    let changed = false;
    const prev = act.systemd ? act.systemd.prev : null;
    if (act.systemd) {
      let cur = null;
      try { cur = SystemProxy._systemdVar(exec.runSync('systemctl', ['--user', 'show-environment'], 3000), ENV_VAR); } catch {}
      if (cur !== null && OUR_PAC.test(cur)) {
        try {
          if (typeof prev === 'string') exec.runSync('systemctl', ['--user', 'set-environment', `${ENV_VAR}=${prev}`], 3000);
          else exec.runSync('systemctl', ['--user', 'unset-environment', ENV_VAR], 3000);
          changed = true;
        } catch {}
      }
    }
    if (act.dbus && typeof prev === 'string') {
      try { exec.runSync('dbus-update-activation-environment', ['--systemd', `${ENV_VAR}=${prev}`], 3000); } catch {}
    }
    return changed;
  }
}

module.exports = SystemProxy;
module.exports.OUR_PAC = OUR_PAC;
