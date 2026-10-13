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
 *   app killed / crashed    a detached watchdog (proxy-watchdog.js) learns the
 *                           app is gone at once (the pipe to it closes) and
 *                           restores within a fraction of a second
 *   reboot / power loss     a run-once login hook starts "Shroudly --restore-proxy"
 *                           (Windows RunOnce, Linux autostart, macOS LaunchAgent)
 *   next launch             EngineManager.recover() restores from the state file
 *   uninstall / update      the NSIS installer resets a leftover Shroudly proxy
 *
 * The snapshot lives in a state file so any of these can restore the user's
 * exact previous settings. A recovery restores only while the settings still
 * point at our proxy, so it never undoes a change the user made since.
 *
 * Windows : WinINET per-user proxy (HKCU, no admin), via reg.exe (fast and
 *           synchronous, unlike PowerShell, so it also works while exiting).
 *           We publish the PAC over a tiny local HTTP server, because WinINET
 *           refuses file:// PAC URLs, and also set a direct SOCKS fallback.
 * macOS   : `networksetup -setsocksfirewallproxy` on active services. This needs
 *           admin; we detect whether non-interactive sudo is possible and, if
 *           not, fall back to per-app SOCKS (env + PAC URL) without failing.
 * Linux   : GNOME gsettings if present; always also expose a PAC URL + SOCKS
 *           address for apps. No system file edits.
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
const MAC_AGENT_LABEL = 'me.codeshare.shroudly.proxy-restore';
const OUR_PAC = /^http:\/\/127\.0\.0\.1:\d+\/proxy\.pac$/;

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

// ── Windows registry (reg.exe) ───────────────────────────────────────────
function regGet(name) {
  try {
    const out = runSync('reg.exe', ['query', WIN_KEY, '/v', name]);
    const m = out.match(new RegExp(`^\\s*${name}\\s+(REG_\\w+)\\s*(.*)$`, 'mi'));
    return m ? { type: m[1], data: m[2].trim() } : null;
  } catch { return null; } // value not present
}
function regSet(name, type, data) {
  runSync('reg.exe', ['add', WIN_KEY, '/v', name, '/t', type, '/d', String(data), '/f']);
}
function regDel(name) {
  try { runSync('reg.exe', ['delete', WIN_KEY, '/v', name, '/f']); } catch {}
}

class SystemProxy {
  /*
   * opts.stateFile      where the snapshot is kept while the proxy is applied
   * opts.watchdog       { execPath, script } to run proxy-watchdog.js detached
   * opts.restoreCommand { exe, args } run once at next login if we never restore
   */
  constructor(log, opts = {}) {
    this.log = log || (() => {});
    this.platform = process.platform;
    this.stateFile = opts.stateFile || null;
    this.watchdogOpts = opts.watchdog || null;
    this.restoreCommand = opts.restoreCommand || null;
    this.applied = false;
    this.snapshot = null;
    this.pacServer = null;
    this.pacPort = 0;
    this.pacUrl = null;
    this.socksPort = 0;
    this.mode = 'all';   // 'all' | 'listed'
    this.list = [];      // domains routed through the proxy in 'listed' mode
  }

  /* A PAC that always sends local/private hosts direct. In 'all' mode every
   * other host goes through the proxy; in 'listed' mode only the domains in
   * this.list (and their subdomains) do, everything else goes direct. */
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

  pacBody(port) {
    const proxy = `SOCKS5 127.0.0.1:${port}; SOCKS 127.0.0.1:${port}; DIRECT`;
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

  async apply(port, mode = 'all', list = []) {
    if (this.applied) return;
    this.socksPort = port;
    this.mode = mode === 'listed' ? 'listed' : 'all';
    this.list = Array.isArray(list) ? list : [];
    await this.startPacServer(port);
    try {
      if (this.platform === 'win32') this._applyWindows(port);
      else if (this.platform === 'darwin') await this._applyMac(port);
      else await this._applyLinux(port);
    } catch (e) {
      // Undo whatever part was applied before failing.
      this.applied = true;
      this.restoreSync();
      throw e;
    }
    this.applied = true;
    this.log('success', `System routed through local proxy on port ${port}`);
  }

  async restore() {
    if (!this.applied) { this.stopPacServer(); return; }
    try {
      if (this.platform === 'win32') this._restoreWindows();
      else if (this.platform === 'darwin') await this._restoreMac();
      else await this._restoreLinux();
      this.log('success', 'System proxy settings restored');
    } catch (e) {
      this.log('warning', `Proxy restore issue: ${e.message}`);
    } finally {
      this._disarm();
    }
  }

  /* Synchronous restore, for process exit and session end. */
  restoreSync() {
    if (!this.applied) { this.stopPacServer(); return; }
    try {
      if (this.platform === 'win32') this._restoreWindows();
      else if (this.platform === 'darwin') this._restoreMacSync();
      else this._restoreLinuxSync();
    } catch {}
    this._disarm();
  }

  // ── state file + safety nets ───────────────────────────────────────────
  /* Called once the snapshot is taken and before the first setting changes:
   * from here on every exit path can find what to put back. */
  _arm() {
    if (this.stateFile) {
      const state = { v: 1, platform: this.platform, port: this.socksPort, snapshot: this.snapshot };
      try {
        fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
        fs.writeFileSync(this.stateFile, JSON.stringify(state));
      } catch (e) { this.log('warning', `Could not save proxy state: ${e.message}`); }
    }
    this._installLoginHook();
    this._startWatchdog();
  }

  _disarm() {
    this.applied = false;
    this.snapshot = null;
    this.stopPacServer();
    this._stopWatchdog();
    this._removeLoginHook();
    if (this.stateFile) { try { fs.rmSync(this.stateFile, { force: true }); } catch {} }
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
        runSync('reg.exe', ['add', WIN_RUNONCE_KEY, '/v', WIN_RUNONCE_VALUE, '/t', 'REG_SZ', '/d', line, '/f']);
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
    try {
      if (this.platform === 'win32') runSync('reg.exe', ['delete', WIN_RUNONCE_KEY, '/v', WIN_RUNONCE_VALUE, '/f']);
      else if (this.platform === 'darwin') fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_AGENT_LABEL}.plist`), { force: true });
      else fs.rmSync(path.join(os.homedir(), '.config', 'autostart', 'shroudly-proxy-restore.desktop'), { force: true });
    } catch {}
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
    if (!state || state.platform !== process.platform) {
      p._removeLoginHook();
      if (opts.stateFile) { try { fs.rmSync(opts.stateFile, { force: true }); } catch {} }
      return false;
    }
    p.socksPort = state.port;
    p.snapshot = state.snapshot;
    let ours = false;
    try { ours = p._stillOursSync(); } catch {}
    if (ours) {
      p.applied = true;
      p.restoreSync(); // also clears the state file and login hook
      log('success', 'System proxy from the previous session restored');
      return true;
    }
    p._disarm();
    return false;
  }

  /*
   * 2.0.0 kept no state file: if it left the system pointing at a local
   * Shroudly proxy, switch that proxy off (its previous values are unknown).
   */
  static resetLegacySync(log = () => {}) {
    try {
      if (process.platform === 'win32') {
        const server = regGet('ProxyServer');
        const pac = regGet('AutoConfigURL');
        const ourServer = server && /^socks=127\.0\.0\.1:\d+$/.test(server.data);
        const ourPac = pac && OUR_PAC.test(pac.data);
        if (!ourServer && !ourPac) return false;
        regSet('ProxyEnable', 'REG_DWORD', '0');
        if (ourServer) regDel('ProxyServer');
        if (ourPac) regDel('AutoConfigURL');
        const ov = regGet('ProxyOverride');
        if (ov && ov.data === '<local>;127.*;10.*;172.16.*;192.168.*;localhost') regDel('ProxyOverride');
      } else if (process.platform === 'darwin') {
        const out = runSync('networksetup', ['-listallnetworkservices']);
        let any = false;
        for (const svc of out.split('\n').slice(1).map((x) => x.trim()).filter((x) => x && !x.startsWith('*'))) {
          const cur = SystemProxy._macReadSync(svc);
          if (cur.enabled && cur.server === '127.0.0.1') {
            any = true;
            const args = ['-setsocksfirewallproxystate', svc, 'off'];
            try { runSync('networksetup', args, 3000); } catch { try { runSync('sudo', ['-n', 'networksetup', ...args], 3000); } catch {} }
          }
        }
        if (!any) return false;
      } else {
        const host = runSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host']).trim();
        const mode = runSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode']).trim();
        if (host !== "'127.0.0.1'" || mode !== "'manual'") return false;
        runSync('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'none']);
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
      return (server && server.data === `socks=127.0.0.1:${port}`) || (pac && OUR_PAC.test(pac.data));
    }
    if (this.platform === 'darwin') {
      const snap = this.snapshot || {};
      if (snap.mode === 'perapp') return false;
      return (snap.services || []).some((s) => {
        const cur = SystemProxy._macReadSync(s.name);
        if (cur.enabled && cur.server === '127.0.0.1' && cur.port === port) return true;
        const auto = SystemProxy._macReadAutoSync(s.name);
        return auto.enabled && OUR_PAC.test(auto.url);
      });
    }
    const g = this.snapshot && this.snapshot.gnome;
    if (!g) return false;
    const host = runSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host']).trim();
    const gport = runSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port']).trim();
    const mode = runSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode']).trim();
    if (host === "'127.0.0.1'" && gport === port && mode === "'manual'") return true;
    const autourl = runSync('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url']).trim().replace(/^'(.*)'$/, '$1');
    return mode === "'auto'" && OUR_PAC.test(autourl);
  }

  // ── Windows (WinINET, HKCU, no admin) ──────────────────────────────────
  _applyWindows(port) {
    const snap = {};
    for (const name of WIN_VALUES) snap[name] = regGet(name);
    this.snapshot = snap;
    this.snapshot.appliedMode = this.mode;
    this._arm();
    // WinINET loads the PAC over HTTP (file:// PACs are rejected). In 'listed'
    // mode only the PAC decides, so we leave the user's manual proxy untouched;
    // in 'all' mode we also set a direct SOCKS proxy for stacks that ignore PAC.
    regSet('AutoConfigURL', 'REG_SZ', this.pacUrl);
    if (this.mode === 'all') {
      regSet('ProxyServer', 'REG_SZ', `socks=127.0.0.1:${port}`);
      regSet('ProxyOverride', 'REG_SZ', '<local>;127.*;10.*;172.16.*;192.168.*;localhost');
      regSet('ProxyEnable', 'REG_DWORD', '1');
    }
    this._refreshWinInet();
  }

  _restoreWindows() {
    const snap = this.snapshot || {};
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
    try {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => {});
      p.unref();
    } catch {}
  }

  // ── macOS (networksetup) ───────────────────────────────────────────────
  async _macServices() {
    const out = await run('networksetup', ['-listallnetworkservices']);
    return out.split('\n').slice(1).map(s => s.trim()).filter(s => s && !s.startsWith('*'));
  }

  static _macReadSync(svc) {
    try {
      const info = runSync('networksetup', ['-getsocksfirewallproxy', svc]);
      return {
        enabled: /Enabled:\s*Yes/i.test(info),
        server: ((info.match(/^Server:\s*(.*)$/mi) || [])[1] || '').trim(),
        port: ((info.match(/^Port:\s*(\d+)/mi) || [])[1] || '').trim(),
      };
    } catch { return { enabled: false, server: '', port: '' }; }
  }

  static _macReadAutoSync(svc) {
    try {
      const info = runSync('networksetup', ['-getautoproxyurl', svc]);
      return {
        enabled: /Enabled:\s*Yes/i.test(info),
        url: ((info.match(/^URL:\s*(.*)$/mi) || [])[1] || '').trim(),
      };
    } catch { return { enabled: false, url: '' }; }
  }

  // Can we run networksetup without an interactive password prompt?
  async _macSudoNonInteractive() {
    try { await run('sudo', ['-n', 'networksetup', '-version'], 3000); return true; }
    catch { return false; }
  }

  async _applyMac(port) {
    // networksetup may require admin. Try unprivileged first (works when the
    // user's account already allows it / managed Macs), then non-interactive
    // sudo, and finally fall back to per-app mode so we never hang on a prompt.
    const services = await this._macServices();
    this.snapshot = {
      services: services.map((name) => ({
        name,
        prev: SystemProxy._macReadSync(name),
        prevAuto: SystemProxy._macReadAutoSync(name),
      })),
      mode: 'system',
      appliedMode: this.mode,
    };
    this._arm();
    let anyOk = false;
    const sudoOk = await this._macSudoNonInteractive();
    const prefix = (args) => sudoOk ? ['sudo', '-n', 'networksetup', ...args] : ['networksetup', ...args];

    for (const svc of services) {
      try {
        if (this.mode === 'listed') {
          // Only listed sites: drive routing with a PAC (setautoproxyurl),
          // leaving the system SOCKS proxy untouched.
          const [c1, ...a1] = prefix(['-setautoproxyurl', svc, this.pacUrl]);
          await run(c1, a1, 6000);
          const [c2, ...a2] = prefix(['-setautoproxystate', svc, 'on']);
          await run(c2, a2, 6000);
        } else {
          const [c1, ...a1] = prefix(['-setsocksfirewallproxy', svc, '127.0.0.1', String(port)]);
          await run(c1, a1, 6000);
          const [c2, ...a2] = prefix(['-setsocksfirewallproxystate', svc, 'on']);
          await run(c2, a2, 6000);
        }
        anyOk = true;
      } catch (e) { /* keep trying other services */ }
    }

    if (!anyOk) {
      // Nothing changed system-wide, so there is nothing to recover later.
      this.snapshot.mode = 'perapp';
      this._stopWatchdog();
      this._removeLoginHook();
      if (this.stateFile) { try { fs.rmSync(this.stateFile, { force: true }); } catch {} }
      this.log('warning',
        `Could not set the macOS system proxy without a password. ` +
        `Apps can still use SOCKS 127.0.0.1:${port} directly (PAC: ${this.pacUrl}).`);
    }
  }

  static _macRestoreArgs(s) {
    const steps = [];
    if (s.prev && s.prev.server && s.prev.port) steps.push(['-setsocksfirewallproxy', s.name, s.prev.server, s.prev.port]);
    if (s.prev) steps.push(['-setsocksfirewallproxystate', s.name, s.prev.enabled ? 'on' : 'off']);
    if (s.prevAuto && s.prevAuto.url) steps.push(['-setautoproxyurl', s.name, s.prevAuto.url]);
    if (s.prevAuto) steps.push(['-setautoproxystate', s.name, s.prevAuto.enabled ? 'on' : 'off']);
    return steps;
  }

  async _restoreMac() {
    const snap = this.snapshot || {};
    if (snap.mode === 'perapp') return;
    const sudoOk = await this._macSudoNonInteractive();
    for (const s of (snap.services || [])) {
      for (const args of SystemProxy._macRestoreArgs(s)) {
        try { await run(...(sudoOk ? ['sudo', ['-n', 'networksetup', ...args]] : ['networksetup', args]), 6000); } catch {}
      }
    }
  }

  _restoreMacSync() {
    const snap = this.snapshot || {};
    if (snap.mode === 'perapp') return;
    for (const s of (snap.services || [])) {
      for (const args of SystemProxy._macRestoreArgs(s)) {
        try { runSync('networksetup', args, 3000); }
        catch { try { runSync('sudo', ['-n', 'networksetup', ...args], 3000); } catch {} }
      }
    }
  }

  // ── Linux (GNOME gsettings; otherwise PAC/env only) ──────────────────────
  async _has(cmd, args) { try { await run(cmd, args, 3000); return true; } catch { return false; } }

  async _applyLinux(port) {
    this.snapshot = { gnome: null, mode: 'perapp' };
    if (await this._has('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])) {
      try {
        const mode = (await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])).trim();
        const host = (await run('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host'])).trim();
        const sport = (await run('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port'])).trim();
        const autourl = (await run('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url'])).trim();
        this.snapshot = { gnome: { mode, host, port: sport, autourl }, mode: 'gnome', appliedMode: this.mode };
        this._arm();
        if (this.mode === 'listed') {
          // Only listed sites: GNOME 'auto' mode with our PAC URL.
          await run('gsettings', ['set', 'org.gnome.system.proxy', 'autoconfig-url', this.pacUrl]);
          await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'auto']);
          this.log('info', 'GNOME system proxy set to PAC (listed sites)');
        } else {
          await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'host', '127.0.0.1']);
          await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'port', String(port)]);
          await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual']);
          this.log('info', 'GNOME system proxy set to SOCKS 127.0.0.1');
        }
        return;
      } catch (e) {
        this.log('warning', `gsettings failed: ${e.message}`);
        this._restoreLinuxSync();
        this.snapshot = { gnome: null, mode: 'perapp' };
      }
    }
    this.log('info', `No desktop proxy API in use. Point apps at socks5://127.0.0.1:${port} (PAC: ${this.pacUrl}).`);
  }

  /* gsettings prints strings quoted ('none'); `set` takes them unquoted. */
  static _gnomeRestoreArgs(g) {
    const unq = (v) => String(v || '').replace(/^'(.*)'$/, '$1');
    const steps = [
      ['set', 'org.gnome.system.proxy.socks', 'host', unq(g.host)],
      ['set', 'org.gnome.system.proxy.socks', 'port', String(parseInt(g.port, 10) || 0)],
      ['set', 'org.gnome.system.proxy', 'autoconfig-url', unq(g.autourl) || ''],
      ['set', 'org.gnome.system.proxy', 'mode', unq(g.mode) || 'none'], // mode last
    ];
    return steps;
  }

  async _restoreLinux() {
    const g = this.snapshot && this.snapshot.gnome;
    if (!g) return;
    for (const args of SystemProxy._gnomeRestoreArgs(g)) { try { await run('gsettings', args, 4000); } catch {} }
  }

  _restoreLinuxSync() {
    const g = this.snapshot && this.snapshot.gnome;
    if (!g) return;
    for (const args of SystemProxy._gnomeRestoreArgs(g)) { try { runSync('gsettings', args, 3000); } catch {} }
  }
}

module.exports = SystemProxy;
