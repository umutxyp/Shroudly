'use strict';

/*
 * Cross-platform system proxy control.
 *
 * The engine exposes a local SOCKS5 proxy on 127.0.0.1:<port>. To make the
 * whole machine use it we point the OS/browser proxy at it, and we always
 * restore the previous state on stop / crash / logout.
 *
 * Windows : WinINET per-user proxy (registry under HKCU, no admin needed).
 *           A PAC file routes everything through SOCKS, bypassing localhost.
 * macOS   : `networksetup -setsocksfirewallproxy` on active services.
 * Linux   : GNOME gsettings if present; always also writes a PAC the UI can
 *           surface, and exports HTTP(S)_PROXY guidance. No system file edits.
 *
 * Nothing here requires elevation. Every change is reverted by restore().
 */

const { execFile, execFileSync } = require('child_process');
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
    this.snapshot = null;        // previous state for restore
    this.pacPath = null;
  }

  /* Write a PAC that sends everything through the SOCKS proxy except localhost
   * and private ranges (so LAN and loopback keep working). */
  writePac(port) {
    const pac = `function FindProxyForURL(url, host) {
  if (isPlainHostName(host) ||
      shExpMatch(host, "127.*") || shExpMatch(host, "10.*") ||
      shExpMatch(host, "172.16.*") || shExpMatch(host, "192.168.*") ||
      shExpMatch(host, "localhost") || shExpMatch(host, "*.local")) {
    return "DIRECT";
  }
  return "SOCKS5 127.0.0.1:${port}; SOCKS 127.0.0.1:${port}; DIRECT";
}
`;
    const p = path.join(os.tmpdir(), 'shroudly.pac');
    fs.writeFileSync(p, pac, 'utf8');
    this.pacPath = p;
    return p;
  }

  async apply(port) {
    if (this.applied) return;
    this.writePac(port);
    if (this.platform === 'win32') await this._applyWindows(port);
    else if (this.platform === 'darwin') await this._applyMac(port);
    else await this._applyLinux(port);
    this.applied = true;
    this.log('success', `System routed through local proxy on port ${port}`);
  }

  async restore() {
    if (!this.applied) return;
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
      if (this.pacPath) { try { fs.unlinkSync(this.pacPath); } catch {} }
    }
  }

  /* Synchronous best-effort restore for process-exit / crash paths. */
  restoreSync() {
    if (!this.applied) return;
    try {
      if (this.platform === 'win32') this._restoreWindowsSync();
      else if (this.platform === 'darwin') this._restoreMacSync();
      else this._restoreLinuxSync();
    } catch {}
    this.applied = false;
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
# Use a PAC pointing at our SOCKS proxy.
Set-ItemProperty -Path $k -Name AutoConfigURL -Value ('file:///' + '${this.pacPath.replace(/\\/g, '/')}')
Set-ItemProperty -Path $k -Name ProxyEnable -Value 0
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
${s.ProxyServer ? `Set-ItemProperty -Path $k -Name ProxyServer -Value '${String(s.ProxyServer).replace(/'/g, "''")}'` : ''}
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
`;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true, timeout: 4000 });
    } catch {}
  }

  // Notify WinINET that settings changed (InternetSetOption via rundll is not
  // reliable; use a tiny P/Invoke through PowerShell Add-Type).
  async _refreshWinInet() {
    const ps = `
$sig = @'
[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@
$t = Add-Type -MemberDefinition $sig -Name WinINet -Namespace Net -PassThru
[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) # SETTINGS_CHANGED
[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) # REFRESH
`;
    try { await this._ps(ps); } catch {}
  }

  _ps(script) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  }

  // ── macOS (networksetup) ───────────────────────────────────────────────
  async _macServices() {
    const out = await run('networksetup', ['-listallnetworkservices']);
    return out.split('\n').slice(1).map(s => s.trim())
      .filter(s => s && !s.startsWith('*'));
  }

  async _applyMac(port) {
    const services = await this._macServices();
    this.snapshot = { services: [] };
    for (const svc of services) {
      let prev = { enabled: false };
      try {
        const info = await run('networksetup', ['-getsocksfirewallproxy', svc]);
        prev.enabled = /Enabled:\s*Yes/i.test(info);
      } catch {}
      this.snapshot.services.push({ name: svc, prev });
      try {
        await run('networksetup', ['-setsocksfirewallproxy', svc, '127.0.0.1', String(port)]);
        await run('networksetup', ['-setsocksfirewallproxystate', svc, 'on']);
      } catch (e) { this.log('warning', `proxy set failed for ${svc}: ${e.message}`); }
    }
  }

  async _restoreMac() {
    const svcs = (this.snapshot && this.snapshot.services) || [];
    for (const s of svcs) {
      try {
        await run('networksetup', ['-setsocksfirewallproxystate', s.name, s.prev.enabled ? 'on' : 'off']);
      } catch {}
    }
  }

  _restoreMacSync() {
    const svcs = (this.snapshot && this.snapshot.services) || [];
    for (const s of svcs) {
      try {
        execFileSync('networksetup', ['-setsocksfirewallproxystate', s.name, s.prev.enabled ? 'on' : 'off'],
          { timeout: 3000 });
      } catch {}
    }
  }

  // ── Linux (GNOME gsettings if present; otherwise PAC only) ──────────────
  async _hasGsettings() {
    try { await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode']); return true; }
    catch { return false; }
  }

  async _applyLinux(port) {
    this.snapshot = { gnome: null };
    if (await this._hasGsettings()) {
      try {
        const mode = (await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])).trim();
        const sh = (await run('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host'])).trim();
        const sp = (await run('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port'])).trim();
        this.snapshot.gnome = { mode, host: sh, port: sp };
        await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'host', '127.0.0.1']);
        await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'port', String(port)]);
        await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual']);
        this.log('info', 'GNOME system proxy set to SOCKS 127.0.0.1');
        return;
      } catch (e) { this.log('warning', `gsettings failed: ${e.message}`); }
    }
    // No desktop proxy API: expose PAC + env guidance. Apps can use the SOCKS
    // proxy directly; we do not edit any system file.
    this.log('info', `No GNOME proxy API. Point apps at socks5://127.0.0.1:${port} (PAC: ${this.pacPath}).`);
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
      execFileSync('gsettings', ['set', 'org.gnome.system.proxy', 'mode', (g.mode || 'none').replace(/'/g, '')],
        { timeout: 3000 });
    } catch {}
  }

  _safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
}

module.exports = SystemProxy;
