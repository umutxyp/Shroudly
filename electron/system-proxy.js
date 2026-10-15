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
 *           kioslaverc. Other desktops (XFCE, LXQt, window managers) have no
 *           system proxy: reported as 'no_system_proxy', not as routed.
 */

const { execFile, execFileSync, spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Watchdog = require('./watchdog');

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
const KDE_GROUP = 'Proxy Settings';
const KDE_TYPE = 'ProxyType';
const KDE_SCRIPT = 'Proxy Config Script';
const OUR_PAC = /^http:\/\/127\.0\.0\.1:\d+\/proxy\.pac$/;
const OWNERSHIP_INTERVAL_MS = 60000;

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve(String(stdout || ''));
    });
  });
}

function runSync(cmd, args, timeout = 4000) {
  return String(execFileSync(cmd, args, { timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || '');
}

function spawnDetached(cmd, args) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

/* A process of another user (the root helper) answers kill(0) with EPERM. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* Waiting without an event loop, for the exit and recovery paths. */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/* Everything that reaches outside the process goes through here, so the tests
 * can stand in for reg.exe, networksetup, gsettings and kwriteconfig. */
const REAL_EXEC = { run, runSync, spawnDetached, alive, sleepSync };
let exec = REAL_EXEC;

/* Shell-quote one argument for /bin/sh: everything literal. */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

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
   * opts.onOwnership    (owned, { lost }) when another program takes the system
   *                     proxy over while we are applied, and if it comes back
   */
  constructor(log, opts = {}) {
    this.log = log || (() => {});
    this.platform = opts.platform || process.platform;
    this.env = opts.env || process.env;
    this.stateFile = opts.stateFile || null;
    this.watchdogOpts = opts.watchdog || null;
    this.restoreCommand = opts.restoreCommand || null;
    this.onOwnership = opts.onOwnership || null;
    this.ownershipIntervalMs = opts.ownershipIntervalMs || OWNERSHIP_INTERVAL_MS;
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

  /* What a routed host gets. Never DIRECT: with DIRECT as a fallback, any
   * failed proxy connection made Chromium quietly go around Shroudly and
   * mark it bad for five minutes, so blocked sites failed with no sign of why.
   *
   * "SOCKS" is added on macOS only. Safari and everything else built on
   * CFNetwork skip "SOCKS5" in a PAC but take "SOCKS", which they speak as
   * SOCKS5 with the name resolved by us; without it they would not be routed
   * at all. Chromium and Firefox read "SOCKS" as SOCKS4, which carries an
   * address looked up locally — the censored network's DNS. They only fall
   * back to it after a SOCKS5 failure, but then for five minutes, so on
   * Windows and Linux, where nothing that reads the PAC needs it, it is left
   * out. */
  pacProxy(port) {
    const socks5 = `SOCKS5 127.0.0.1:${port}`;
    return this.platform === 'darwin' ? `${socks5}; SOCKS 127.0.0.1:${port}` : socks5;
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

  /* Serve the PAC over loopback HTTP so WinINET (and others) will load it.
   * Returns the PAC URL. */
  async startPacServer(socksPort) {
    this.pacText = this.pacBody(socksPort);
    await new Promise((resolve, reject) => {
      this.pacServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
        res.end(this.pacText);
      });
      this.pacServer.on('error', reject);
      // port 0 => OS picks a free port, bound to loopback only
      this.pacServer.listen(0, '127.0.0.1', () => {
        this.pacPort = this.pacServer.address().port;
        this.pacUrl = `http://127.0.0.1:${this.pacPort}/proxy.pac`;
        resolve();
      });
    });
    return this.pacUrl;
  }

  stopPacServer() {
    if (this.pacServer) { try { this.pacServer.close(); } catch {} this.pacServer = null; }
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

  /*
   * Point the system at the engine. Returns what happened, for the window to
   * act on:
   *   { ok, code, system, pacUrl, socks, partial?, detail? }
   *   code 'ok'               the system proxy points at Shroudly
   *        'no_system_proxy'  this desktop has none (XFCE, LXQt, window
   *                           managers); partial when GNOME's setting was set
   *                           anyway for the programs that read it (Firefox)
   *        'needs_admin'      macOS Standard account: applyAsAdmin() asks for
   *                           an administrator's password and does it
   *        'apply_failed'     the desktop refused the change; nothing is left
   *                           changed
   * The PAC server and SOCKS address stay up in every case, for programs
   * pointed at them by hand. Throws only when nothing could be undone either.
   */
  async apply(port, mode = 'all', list = []) {
    if (this.applied) return this.status;
    this.socksPort = port;
    this.mode = mode === 'listed' ? 'listed' : 'all';
    this.list = Array.isArray(list) ? list : [];
    await this.startPacServer(port);
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
    else this.log('warning', `${status.detail || 'System proxy not set'} Apps can still use SOCKS5 127.0.0.1:${port} directly (PAC: ${this.pacUrl}).`);
    if (status.ok || status.partial) this._startOwnershipWatch();
    return this.status;
  }

  /* Returns false when something could not be put back; the state file then
   * stays, so the watchdog or the next start tries again. */
  async restore() {
    if (!this.applied) { this.stopPacServer(); return true; }
    let done = true;
    try {
      if (this.platform === 'win32') this._restoreWindows();
      else if (this.platform === 'darwin') done = await this._restoreMac();
      else await this._restoreLinux();
      if (done) this.log('success', 'System proxy settings restored');
      else this.log('warning', 'System proxy settings could not be restored yet; they will be at the next start');
    } catch (e) {
      this.log('warning', `Proxy restore issue: ${e.message}`);
    } finally {
      this._disarm({ keepState: !done });
    }
    return done;
  }

  /* Synchronous restore, for process exit and session end. */
  restoreSync() {
    if (!this.applied) { this.stopPacServer(); return true; }
    let done = true;
    try {
      if (this.platform === 'win32') this._restoreWindows();
      else if (this.platform === 'darwin') done = this._restoreMacSync();
      else this._restoreLinuxSync();
    } catch {}
    this._disarm({ keepState: !done });
    return done;
  }

  // ── state file + safety nets ───────────────────────────────────────────
  /* Called once the snapshot is taken and before the first setting changes:
   * from here on every exit path can find what to put back. */
  _arm() {
    this._saveState();
    this._installLoginHook();
    this._startWatchdog();
  }

  _saveState() {
    if (!this.stateFile) return;
    const state = { v: 2, platform: this.platform, port: this.socksPort, pacUrl: this.pacUrl, snapshot: this.snapshot };
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state));
    } catch (e) { this.log('warning', `Could not save proxy state: ${e.message}`); }
  }

  /* Nothing was changed after all (no desktop proxy, no permission): nothing
   * to recover later either. */
  _unarm() {
    this._stopWatchdog();
    this._removeLoginHook();
    if (this.stateFile) { try { fs.rmSync(this.stateFile, { force: true }); } catch {} }
  }

  _disarm({ keepState = false } = {}) {
    this.applied = false;
    this.snapshot = null;
    this.status = null;
    this.stopPacServer();
    this._stopOwnershipWatch();
    if (keepState) return;
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
        fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
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
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Shroudly proxy restore\nExec=${[cmd.exe, ...cmd.args].map(q).join(' ')}\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`);
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
  /* Every minute while applied: the same settings a recovery reads, so a VPN
   * client, another bypass tool or the user taking the system proxy over is
   * noticed and can be told, instead of Shroudly showing itself as protecting
   * traffic that no longer reaches it. Asynchronous and one small read per
   * setting (reg.exe, networksetup, gsettings, or a file on KDE). */
  _startOwnershipWatch() {
    if (!this.onOwnership || this._ownTimer) return;
    this._owned = true;
    this._ownTimer = setInterval(() => { this.checkOwnership().catch(() => {}); }, this.ownershipIntervalMs);
    if (this._ownTimer.unref) this._ownTimer.unref();
  }

  _stopOwnershipWatch() {
    if (this._ownTimer) { clearInterval(this._ownTimer); this._ownTimer = null; }
  }

  /* Returns the settings no longer ours ([] when all are), or null when they
   * could not be read. Tells onOwnership only when that changes. */
  async checkOwnership() {
    if (!this.applied || this._checking) return null;
    this._checking = true;
    try {
      const lost = await this._lostSettings();
      if (lost === null || !this.applied) return lost;
      const owned = lost.length === 0;
      if (owned !== this._owned) {
        this._owned = owned;
        if (owned) this.log('info', 'The system proxy points at Shroudly again');
        else this.log('warning', `Another program changed the system proxy (${lost.join(', ')}): that traffic no longer goes through Shroudly`);
        if (this.onOwnership) { try { this.onOwnership(owned, { lost }); } catch {} }
      }
      return lost;
    } finally { this._checking = false; }
  }

  async _lostSettings() {
    const snap = this.snapshot || {};
    const url = this.pacUrl;
    try {
      if (this.platform === 'win32') {
        let out = '';
        try { out = await exec.run('reg.exe', ['query', WIN_KEY, '/v', 'AutoConfigURL'], 4000); }
        catch (e) { if (e.killed || e.code === 'ENOENT') return null; } // else: the value is gone
        const cur = regParse('AutoConfigURL', out);
        return cur && cur.data === url ? [] : ['AutoConfigURL'];
      }
      if (this.platform === 'darwin') {
        if (snap.mode !== 'system' && snap.mode !== 'admin') return [];
        const lost = [];
        for (const s of (snap.services || []).filter((x) => x.applied)) {
          const cur = SystemProxy._macParseAuto(await exec.run('networksetup', ['-getautoproxyurl', s.name], 4000));
          if (!(cur.enabled && cur.url === url)) lost.push(s.name);
        }
        return lost;
      }
      const lost = [];
      if (snap.gnome) {
        const mode = (await exec.run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], 4000)).trim();
        const auto = (await exec.run('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url'], 4000)).trim();
        if (mode !== "'auto'" || auto !== `'${url}'`) lost.push('GNOME');
      }
      if (snap.kde) {
        const cur = SystemProxy._kdeRead(await fs.promises.readFile(snap.kde.file, 'utf8').catch(() => ''));
        if (cur.type !== '2' || cur.script !== url) lost.push('KDE');
      }
      return lost;
    } catch { return null; }
  }

  /*
   * Restore a proxy left behind by a run that never got to restore it (crash,
   * kill, power loss). Reads the state file; restores only if the system still
   * points at our proxy. Synchronous: used by the watchdog and at startup.
   * Returns true if something was restored.
   */
  static recoverSync(opts = {}, log = () => {}) {
    let state = null;
    try { state = JSON.parse(fs.readFileSync(opts.stateFile, 'utf8')); } catch {}
    const p = new SystemProxy(log, opts);
    if (!state || state.platform !== p.platform) {
      p._removeLoginHook();
      if (opts.stateFile) { try { fs.rmSync(opts.stateFile, { force: true }); } catch {} }
      return false;
    }
    p.socksPort = state.port;
    p.pacUrl = state.pacUrl || null;
    p.snapshot = state.snapshot;
    // A root helper may still be on its way to restoring (macOS, admin):
    // let it, rather than asking for the password for nothing.
    if (p.platform === 'darwin' && p.snapshot && p.snapshot.mode === 'admin') p._macReleaseHelperSync();
    let ours = false;
    try { ours = p._stillOursSync(); } catch {}
    if (ours) {
      p.applied = true;
      if (!p.restoreSync()) { // also clears the state file and login hook
        log('warning', 'System proxy from the previous session could not be restored yet');
        return false;
      }
      log('success', 'System proxy from the previous session restored');
      return true;
    }
    p._disarm();
    return false;
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
        let any = false;
        const set = (args) => {
          try { exec.runSync('networksetup', args, 3000); } catch { try { exec.runSync('sudo', ['-n', 'networksetup', ...args], 3000); } catch {} }
        };
        for (const svc of SystemProxy._macParseServices(out)) {
          const cur = SystemProxy._macReadSync(svc);
          if (cur.enabled && cur.server === '127.0.0.1') { any = true; set(['-setsocksfirewallproxystate', svc, 'off']); }
          const auto = SystemProxy._macReadAutoSync(svc);
          if (auto.enabled && OUR_PAC.test(auto.url)) { any = true; set(['-setautoproxystate', svc, 'off']); }
        }
        if (!any) return false;
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
    this.snapshot = snap;
    this.snapshot.appliedMode = this.mode;
    this.snapshot.form = 'pac';
    this._arm();
    // WinINET loads the PAC over HTTP (file:// PACs are rejected). The user's
    // manual proxy is left as it is: WinINET and Chromium use the PAC first.
    regSet('AutoConfigURL', 'REG_SZ', this.pacUrl);
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

  async _applyMac() {
    // networksetup may require admin. Try unprivileged first (works for an
    // administrator account and on managed Macs), then non-interactive sudo;
    // never a prompt here. A Standard account gets 'needs_admin'.
    const services = await this._macServices();
    this.snapshot = {
      services: services.map((name) => ({ name, prevAuto: SystemProxy._macReadAutoSync(name) })),
      mode: 'system',
      form: 'pac',
      appliedMode: this.mode,
    };
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
      this._saveState();
      return { ok: true, code: 'ok', system: 'macos' };
    }
    // Nothing changed system-wide, so there is nothing to recover later.
    this.snapshot.mode = 'perapp';
    this._unarm();
    return {
      ok: false, code: 'needs_admin', system: 'macos',
      detail: 'This macOS account may not change the network settings without an administrator\'s password.',
    };
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
      let url = String(s.prevAuto.url || '').trim();
      if (url === '(null)' || OUR_PAC.test(url)) url = '';
      const off = ['-setautoproxystate', s.name, 'off'];
      if (s.prevAuto.enabled && url) steps.push(['-setautoproxyurl', s.name, url], ['-setautoproxystate', s.name, 'on']);
      else if (url) steps.push(off, ['-setautoproxyurl', s.name, url], off);
      else steps.push(off);
    }
    return steps;
  }

  /* What to run to restore, per service: everything for a 2.5.4 state file
   * (recoverSync has checked it is ours), otherwise only the services whose
   * PAC is still ours. */
  _macRestorePlanSync() {
    const snap = this.snapshot || {};
    const plan = [];
    for (const s of (snap.services || [])) {
      if (snap.form === 'pac' && !SystemProxy._macOwnedAutoSync(s.name)) continue;
      plan.push(...SystemProxy._macRestoreArgs(s));
    }
    return plan;
  }

  async _restoreMac() {
    const snap = this.snapshot || {};
    if (snap.mode === 'admin') return this._restoreMacAdmin(false);
    if (snap.mode !== 'system') return true;
    const plan = this._macRestorePlanSync();
    const sudoOk = plan.length ? await this._macSudoNonInteractive() : false;
    for (const args of plan) {
      try { await (sudoOk ? exec.run('sudo', ['-n', 'networksetup', ...args], 6000) : exec.run('networksetup', args, 6000)); } catch {}
    }
    return true;
  }

  _restoreMacSync() {
    const snap = this.snapshot || {};
    if (snap.mode === 'admin') return this._restoreMacAdmin(true);
    if (snap.mode !== 'system') return true;
    for (const args of this._macRestorePlanSync()) {
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
   * now. So stopping, quitting, a crash or a kill restore without asking
   * again; only when the helper itself is gone (a restart of the Mac) does a
   * restore ask for the password once more. Nothing is installed: no sudoers
   * entry, no launch daemon. The helper runs only networksetup, with
   * arguments fixed here and quoted, never read from a file.
   *
   * Returns the same kind of status as apply(): code 'ok', 'cancelled' (the
   * dialog was dismissed: nothing changed) or 'needs_admin' (refused).
   */
  async applyAsAdmin() {
    if (this.platform !== 'darwin') return { ok: false, code: 'unsupported' };
    if (!this.applied || !this.snapshot || !this.pacUrl) return { ok: false, code: 'not_active' };
    if (this.snapshot.mode === 'system' || this.snapshot.mode === 'admin') return this.status;
    const services = await this._macServices();
    const holdFile = this._holdFile();
    this.snapshot = {
      services: services.map((name) => ({ name, prevAuto: SystemProxy._macReadAutoSync(name) })),
      mode: 'admin',
      form: 'pac',
      appliedMode: this.mode,
      holdFile,
      helperPid: 0,
    };
    try { fs.mkdirSync(path.dirname(holdFile), { recursive: true }); fs.writeFileSync(holdFile, String(process.pid)); } catch {}
    this._arm();
    const script = SystemProxy._macAdminScript({
      services: this.snapshot.services, pacUrl: this.pacUrl, holdFile, appPid: process.pid,
    });
    let out;
    try {
      out = await exec.run('osascript', ['-e', SystemProxy._appleScriptAdmin(script)], 300000);
    } catch (e) {
      // Dismissed or refused: nothing was changed.
      try { fs.rmSync(holdFile, { force: true }); } catch {}
      this.snapshot = { services: [], mode: 'perapp', form: 'pac', appliedMode: this.mode };
      this._unarm();
      const cancelled = /-128|cancel/i.test(`${e.stderr || ''} ${e.message || ''}`);
      this.log('warning', cancelled ? 'Administrator password not given; the system proxy was not changed' : `Could not change the system proxy as administrator: ${String(e.stderr || e.message).trim()}`);
      this.status = { ...this.status, ok: false, code: cancelled ? 'cancelled' : 'needs_admin' };
      return this.status;
    }
    this.snapshot.helperPid = parseInt(String(out).trim(), 10) || 0;
    for (const s of this.snapshot.services) s.applied = SystemProxy._macOwnedAutoSync(s.name);
    this._saveState();
    const ok = this.snapshot.services.some((s) => s.applied);
    this.status = { ...this.status, ok, code: ok ? 'ok' : 'apply_failed', system: 'macos', admin: true, partial: false };
    if (ok) {
      this.log('success', `System routed through local proxy on port ${this.socksPort} (administrator)`);
      this._startOwnershipWatch();
    } else {
      this.log('warning', 'The system proxy did not change, although the administrator password was accepted');
    }
    return this.status;
  }

  _holdFile() {
    return this.stateFile ? `${this.stateFile}.hold` : path.join(os.tmpdir(), `shroudly-proxy-${process.pid}.hold`);
  }

  /* The elevated script: apply, then start the restoring helper in the
   * background and print its pid. POSIX sh, every argument single-quoted. */
  static _macAdminScript({ services, pacUrl, holdFile, appPid, networksetup = MAC_NETWORKSETUP }) {
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
      const steps = SystemProxy._macRestoreArgs({ name: s.name, prevAuto: s.prevAuto }).map(cmd);
      return `case "$(${shq(networksetup)} -getautoproxyurl ${shq(s.name)})" in *${shq(`URL: ${pacUrl}`)}*${shq('Enabled: Yes')}*) ${steps.join('; ')};; esac`;
    });
    const wait = `while [ -e ${shq(holdFile)} ] && kill -0 ${pid} 2>/dev/null; do sleep 1; done`;
    return `${apply.map((c) => `${c} >/dev/null 2>&1`).join('; ')}; ( ${wait}; ${back.join('; ')} ) </dev/null >/dev/null 2>&1 & echo $!`;
  }

  /* osascript source running a shell script with administrator privileges:
   * the script goes in an AppleScript string, where only \ and " are special. */
  static _appleScriptAdmin(shell, privileged = true) {
    const lit = String(shell).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `do shell script "${lit}"${privileged ? ' with administrator privileges' : ''}`;
  }

  /* Tell the root helper to restore (the hold file goes) and give it a few
   * seconds to do so. True when it has finished. */
  _macReleaseHelperSync(waitMs = 5000) {
    const snap = this.snapshot || {};
    if (snap.holdFile) { try { fs.rmSync(snap.holdFile, { force: true }); } catch {} }
    const until = Date.now() + waitMs;
    while (snap.helperPid && exec.alive(snap.helperPid) && Date.now() < until) exec.sleepSync(200);
    return !exec.alive(snap.helperPid);
  }

  async _macReleaseHelper(waitMs = 5000) {
    const snap = this.snapshot || {};
    if (snap.holdFile) { try { fs.rmSync(snap.holdFile, { force: true }); } catch {} }
    const until = Date.now() + waitMs;
    while (snap.helperPid && exec.alive(snap.helperPid) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    return !exec.alive(snap.helperPid);
  }

  /* Restore what was set with the administrator's password: normally the
   * helper does it; if it is gone and our PAC is still set, ask for the
   * password again. False when that was refused — the state file then stays,
   * and the next start (or login) tries again. */
  _restoreMacAdmin(sync) {
    const finish = () => {
      const plan = this._macRestorePlanSync();
      if (!plan.length) return true;
      if (plan.some((a) => !MAC_ELEVATED_VERBS.has(a[0]) || a.some((x) => /[\0\n\r]/.test(String(x))))) return false;
      const script = plan.map((args) => [MAC_NETWORKSETUP, ...args].map(shq).join(' ')).join('; ');
      const src = SystemProxy._appleScriptAdmin(script);
      if (sync) {
        try { exec.runSync('osascript', ['-e', src], 300000); } catch { return false; }
        return this._macRestorePlanSync().length === 0;
      }
      return exec.run('osascript', ['-e', src], 300000)
        .then(() => this._macRestorePlanSync().length === 0, () => false);
    };
    if (sync) { this._macReleaseHelperSync(); return finish(); }
    return this._macReleaseHelper().then(finish);
  }

  // ── Linux (GNOME gsettings, KDE kioslaverc; otherwise PAC/SOCKS only) ────
  async _has(cmd, args) { try { await exec.run(cmd, args, 3000); return true; } catch { return false; } }

  /* Which desktop's proxy setting the browsers on it follow. Chromium reads
   * GNOME's settings only on the desktops below and KDE's on Plasma; on any
   * other desktop it reads the environment, which a running session cannot
   * be given. */
  static linuxDesktop(env = process.env) {
    const names = String(env.XDG_CURRENT_DESKTOP || env.XDG_SESSION_DESKTOP || '').toLowerCase().split(':').map((s) => s.trim()).filter(Boolean);
    if (names.includes('kde') || (!names.length && env.KDE_FULL_SESSION === 'true')) return 'kde';
    const gnome = ['gnome', 'unity', 'x-cinnamon', 'cinnamon', 'pantheon', 'deepin', 'ukui'];
    if (names.some((n) => gnome.includes(n))) return 'gnome';
    return 'other';
  }

  async _applyLinux() {
    const desktop = SystemProxy.linuxDesktop(this.env);
    this.snapshot = { mode: 'none', form: 'pac', appliedMode: this.mode, desktop, gnome: null, kde: null };
    // GNOME's setting is also read by Firefox and GTK programs on other
    // desktops, so it is set wherever it exists, as before.
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
      } catch (e) { this.log('warning', `gsettings failed: ${e.message}`); }
    }
    if (desktop === 'kde') {
      const file = this._kdeFile();
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch {}
      const cur = SystemProxy._kdeRead(text);
      if (cur.locked) this.log('warning', 'KDE proxy settings are locked by the administrator');
      else this.snapshot.kde = { file, type: cur.type, script: cur.script };
    }
    if (!this.snapshot.gnome && !this.snapshot.kde) {
      return {
        ok: false, code: desktop === 'other' ? 'no_system_proxy' : 'apply_failed', system: desktop,
        detail: desktop === 'other' ? 'This desktop has no system proxy setting.' : 'The desktop proxy setting could not be read.',
      };
    }
    this.snapshot.mode = 'desktop';
    this._arm();

    let gnomeOk = false;
    let kdeOk = false;
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
    } else this._saveState();

    const ok = desktop === 'kde' ? kdeOk : desktop === 'gnome' ? gnomeOk : false;
    if (ok) return { ok: true, code: 'ok', system: desktop };
    const partial = gnomeOk || kdeOk;
    if (desktop === 'other') {
      return {
        ok: false, code: 'no_system_proxy', system: desktop, partial,
        detail: partial
          ? 'This desktop has no system proxy setting; only programs that read GNOME\'s (such as Firefox) follow it.'
          : 'This desktop has no system proxy setting.',
      };
    }
    return { ok: false, code: 'apply_failed', system: desktop, partial, detail: 'The desktop refused the proxy setting.' };
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

  /* force: straight after a failed apply, when what is there is ours even if
   * only half written. */
  _restoreGnomeSync(force = false) {
    const g = this.snapshot && this.snapshot.gnome;
    if (!g) return;
    const legacy = this.snapshot.form !== 'pac';
    if (!force && !legacy && !this._gnomeOwnedSync()) return; // someone else's setting by now
    for (const args of SystemProxy._gnomeRestoreArgs(g, legacy)) { try { exec.runSync('gsettings', args, 3000); } catch {} }
  }

  async _restoreLinux() {
    const g = this.snapshot && this.snapshot.gnome;
    if (g) {
      const legacy = this.snapshot.form !== 'pac';
      if (legacy || this._gnomeOwnedSync()) {
        for (const args of SystemProxy._gnomeRestoreArgs(g, legacy)) { try { await exec.run('gsettings', args, 4000); } catch {} }
      }
    }
    this._restoreKdeSync();
  }

  _restoreLinuxSync() {
    this._restoreGnomeSync();
    this._restoreKdeSync();
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
  static _kdeRead(text) {
    const out = { type: null, script: null, locked: false };
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
    }
    return out;
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
    let mode = 0o600;
    try { text = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode & 0o777; } catch {}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.shroudly-${process.pid}.tmp`;
    fs.writeFileSync(tmp, SystemProxy._kdeEdit(text, values), { mode });
    fs.renameSync(tmp, file);
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
    const type = k.type === '2' && !script ? null : k.type;
    try { this._kdeWriteSync(k.file, { [KDE_TYPE]: type, [KDE_SCRIPT]: script }); } catch {}
    this._kdeNotify();
  }
}

module.exports = SystemProxy;
module.exports.OUR_PAC = OUR_PAC;
