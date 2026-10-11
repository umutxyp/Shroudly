'use strict';

/*
 * Cross-platform system proxy control.
 *
 * The engine exposes a local SOCKS5 proxy on 127.0.0.1:<port>. To route traffic
 * through it we point the OS/browser proxy at it, and we always restore the
 * previous state on stop / crash / logout.
 *
 * Windows : WinINET per-user proxy (HKCU, no admin). We publish the PAC over a
 *           tiny local HTTP server, because modern WinINET refuses file:// PAC
 *           URLs. We also set a direct HKCU proxy as a fallback.
 * macOS   : `networksetup -setsocksfirewallproxy` on active services. This needs
 *           admin; we detect whether non-interactive sudo is possible and, if
 *           not, fall back to per-app SOCKS (env + PAC URL) without failing.
 * Linux   : GNOME/KDE gsettings/kwriteconfig if present; always also expose a
 *           PAC URL + SOCKS address for apps. No system file edits.
 *
 * Every change is reverted by restore()/restoreSync().
 */

const { execFile, execFileSync } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve(String(stdout || ''));
    });
  });
}

class SystemProxy {
  constructor(log) {
    this.log = log || (() => {});
    this.platform = process.platform;
    this.applied = false;
    this.snapshot = null;
    this.pacServer = null;
    this.pacPort = 0;
    this.pacUrl = null;
    this.socksPort = 0;
  }

  pacBody(port) {
    return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host) ||
      shExpMatch(host, "127.*") || shExpMatch(host, "10.*") ||
      shExpMatch(host, "172.16.*") || shExpMatch(host, "192.168.*") ||
      shExpMatch(host, "localhost") || shExpMatch(host, "*.local")) {
    return "DIRECT";
  }
  return "SOCKS5 127.0.0.1:${port}; SOCKS 127.0.0.1:${port}; DIRECT";
}
`;
  }

  /* Serve the PAC over loopback HTTP so WinINET (and others) will load it.
   * Returns the PAC URL. */
  async startPacServer(socksPort) {
    const body = this.pacBody(socksPort);
    await new Promise((resolve, reject) => {
      this.pacServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
        res.end(body);
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

  async apply(port) {
    if (this.applied) return;
    this.socksPort = port;
    await this.startPacServer(port);
    if (this.platform === 'win32') await this._applyWindows(port);
    else if (this.platform === 'darwin') await this._applyMac(port);
    else await this._applyLinux(port);
    this.applied = true;
    this.log('success', `System routed through local proxy on port ${port}`);
  }

  async restore() {
    if (!this.applied) { this.stopPacServer(); return; }
    try {
      if (this.platform === 'win32') await this._restoreWindows();
      else if (this.platform === 'darwin') await this._restoreMac();
      else await this._restoreLinux();
      this.log('success', 'System proxy settings restored');
    } catch (e) {
      this.log('warning', `Proxy restore issue: ${e.message}`);
    } finally {
      this.applied = false;
      this.snapshot = null;
      this.stopPacServer();
    }
  }

  restoreSync() {
    if (!this.applied) return;
    try {
      if (this.platform === 'win32') this._restoreWindowsSync();
      else if (this.platform === 'darwin') this._restoreMacSync();
      else this._restoreLinuxSync();
    } catch {}
    this.applied = false;
    this.stopPacServer();
  }

  // ── Windows (WinINET, HKCU, no admin) ──────────────────────────────────
  async _applyWindows(port) {
    const ps = `
$ErrorActionPreference='Stop'
$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$cur = Get-ItemProperty -Path $k
$snap = @{
  ProxyEnable = [int]($cur.ProxyEnable);
  ProxyServer = [string]$cur.ProxyServer;
  AutoConfigURL = [string]$cur.AutoConfigURL
} | ConvertTo-Json -Compress
# Point WinINET at our HTTP-served PAC (file:// PACs are rejected by WinINET).
Set-ItemProperty -Path $k -Name AutoConfigURL -Value '${this.pacUrl}'
# Also set a direct SOCKS proxy as a fallback for stacks that ignore PAC.
Set-ItemProperty -Path $k -Name ProxyEnable -Value 1
Set-ItemProperty -Path $k -Name ProxyServer -Value 'socks=127.0.0.1:${port}'
Set-ItemProperty -Path $k -Name ProxyOverride -Value '<local>;127.*;10.*;172.16.*;192.168.*;localhost'
$snap
`;
    const out = await this._ps(ps);
    this.snapshot = this._safeJson(out);
    await this._refreshWinInet();
  }

  async _restoreWindows() {
    const s = this.snapshot || {};
    const ps = `
$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
${s.AutoConfigURL ? `Set-ItemProperty -Path $k -Name AutoConfigURL -Value '${String(s.AutoConfigURL).replace(/'/g, "''")}'`
                  : `Remove-ItemProperty -Path $k -Name AutoConfigURL -ErrorAction SilentlyContinue`}
Set-ItemProperty -Path $k -Name ProxyEnable -Value ${Number(s.ProxyEnable) ? 1 : 0}
${s.ProxyServer ? `Set-ItemProperty -Path $k -Name ProxyServer -Value '${String(s.ProxyServer).replace(/'/g, "''")}'`
               : `Remove-ItemProperty -Path $k -Name ProxyServer -ErrorAction SilentlyContinue`}
Remove-ItemProperty -Path $k -Name ProxyOverride -ErrorAction SilentlyContinue
`;
    await this._ps(ps);
    await this._refreshWinInet();
  }

  _restoreWindowsSync() {
    const s = this.snapshot || {};
    const ps = `
$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
${s.AutoConfigURL ? `Set-ItemProperty -Path $k -Name AutoConfigURL -Value '${String(s.AutoConfigURL).replace(/'/g, "''")}'`
                  : `Remove-ItemProperty -Path $k -Name AutoConfigURL -ErrorAction SilentlyContinue`}
Set-ItemProperty -Path $k -Name ProxyEnable -Value ${Number(s.ProxyEnable) ? 1 : 0}
${s.ProxyServer ? `Set-ItemProperty -Path $k -Name ProxyServer -Value '${String(s.ProxyServer).replace(/'/g, "''")}'`
               : `Remove-ItemProperty -Path $k -Name ProxyServer -ErrorAction SilentlyContinue`}
Remove-ItemProperty -Path $k -Name ProxyOverride -ErrorAction SilentlyContinue
`;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { windowsHide: true, timeout: 4000 });
      this._refreshWinInetSync();
    } catch {}
  }

  _winInetRefreshScript() {
    return `
$sig = @'
[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@
$t = Add-Type -MemberDefinition $sig -Name WinINet -Namespace Net -PassThru
[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`;
  }
  async _refreshWinInet() { try { await this._ps(this._winInetRefreshScript()); } catch {} }
  _refreshWinInetSync() {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', this._winInetRefreshScript()],
        { windowsHide: true, timeout: 3000 });
    } catch {}
  }

  _ps(script) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  }

  // ── macOS (networksetup) ───────────────────────────────────────────────
  async _macServices() {
    const out = await run('networksetup', ['-listallnetworkservices']);
    return out.split('\n').slice(1).map(s => s.trim()).filter(s => s && !s.startsWith('*'));
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
    this.snapshot = { services: [], mode: 'system' };
    let anyOk = false;
    const sudoOk = await this._macSudoNonInteractive();
    const prefix = (args) => sudoOk ? ['sudo', '-n', 'networksetup', ...args] : ['networksetup', ...args];

    for (const svc of services) {
      let prev = { enabled: false };
      try {
        const info = await run('networksetup', ['-getsocksfirewallproxy', svc]);
        prev.enabled = /Enabled:\s*Yes/i.test(info);
      } catch {}
      this.snapshot.services.push({ name: svc, prev });
      try {
        const [c1, ...a1] = prefix(['-setsocksfirewallproxy', svc, '127.0.0.1', String(port)]);
        await run(c1, a1, 6000);
        const [c2, ...a2] = prefix(['-setsocksfirewallproxystate', svc, 'on']);
        await run(c2, a2, 6000);
        anyOk = true;
      } catch (e) { /* keep trying other services */ }
    }

    if (!anyOk) {
      this.snapshot.mode = 'perapp';
      this.log('warning',
        `Could not set the macOS system proxy without a password. ` +
        `Apps can still use SOCKS 127.0.0.1:${port} directly (PAC: ${this.pacUrl}).`);
    }
  }

  async _restoreMac() {
    const snap = this.snapshot || {};
    if (snap.mode === 'perapp') return;
    const sudoOk = await this._macSudoNonInteractive();
    const prefix = (args) => sudoOk ? ['sudo', '-n', 'networksetup', ...args] : ['networksetup', ...args];
    for (const s of (snap.services || [])) {
      try {
        const [c, ...a] = prefix(['-setsocksfirewallproxystate', s.name, s.prev.enabled ? 'on' : 'off']);
        await run(c, a, 6000);
      } catch {}
    }
  }

  _restoreMacSync() {
    const snap = this.snapshot || {};
    if (snap.mode === 'perapp') return;
    for (const s of (snap.services || [])) {
      try {
        execFileSync('networksetup', ['-setsocksfirewallproxystate', s.name, s.prev.enabled ? 'on' : 'off'], { timeout: 3000 });
      } catch {
        try { execFileSync('sudo', ['-n', 'networksetup', '-setsocksfirewallproxystate', s.name, s.prev.enabled ? 'on' : 'off'], { timeout: 3000 }); } catch {}
      }
    }
  }

  // ── Linux (GNOME gsettings or KDE; otherwise PAC/env only) ──────────────
  async _has(cmd, args) { try { await run(cmd, args, 3000); return true; } catch { return false; } }

  async _applyLinux(port) {
    this.snapshot = { gnome: null, kde: null, mode: 'perapp' };
    if (await this._has('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])) {
      try {
        const mode = (await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])).trim();
        const sh = (await run('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host'])).trim();
        const sp = (await run('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port'])).trim();
        this.snapshot.gnome = { mode, host: sh, port: sp };
        await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'host', '127.0.0.1']);
        await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'port', String(port)]);
        await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual']);
        this.snapshot.mode = 'gnome';
        this.log('info', 'GNOME system proxy set to SOCKS 127.0.0.1');
        return;
      } catch (e) { this.log('warning', `gsettings failed: ${e.message}`); }
    }
    this.log('info', `No desktop proxy API in use. Point apps at socks5://127.0.0.1:${port} (PAC: ${this.pacUrl}).`);
  }

  async _restoreLinux() {
    const g = this.snapshot && this.snapshot.gnome;
    if (!g) return;
    try {
      await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', (g.mode || "'none'").replace(/'/g, '')]);
      if (g.host) await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'host', g.host.replace(/'/g, '')]);
      if (g.port) await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'port', g.port]);
    } catch {}
  }

  _restoreLinuxSync() {
    const g = this.snapshot && this.snapshot.gnome;
    if (!g) return;
    try {
      execFileSync('gsettings', ['set', 'org.gnome.system.proxy', 'mode', (g.mode || 'none').replace(/'/g, '')], { timeout: 3000 });
    } catch {}
  }

  _safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
}

module.exports = SystemProxy;
