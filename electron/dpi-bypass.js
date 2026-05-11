const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const https = require('https');

const execFileAsync = promisify(execFile);

const RUNTIME_STATE_KEY = 'dpiRuntimeState';
const POWERSHELL = 'powershell.exe';

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

class DPIBypass {
  constructor(store, options = {}) {
    this.store = store;
    this.addLog = options.addLog || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.isActive = false;
    this.stats = this.createEmptyStats();
    this.monitorInterval = null;
    this.engineProcess = null;
    this.enginePid = null;
    this.transition = null;
    this.lastKnownBytes = 0;
    this.expectingEngineStop = false;
    this.lastEngineError = null;
  }

  createEmptyStats() {
    return {
      packetsProcessed: 0,
      bytesProcessed: 0,
      connectionsSaved: 0,
      startTime: null,
      techniques: {},
      engine: null,
      adapterCount: 0,
    };
  }

  log(level, message) {
    this.addLog(level, message);
    const method = level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'log';
    console[method](`[Shroudly] ${message}`);
  }

  async runPowerShell(script, timeout = 15000) {
    const { stdout, stderr } = await execFileAsync(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024 * 4,
      }
    );

    if (stderr && stderr.trim()) {
      this.log('warning', stderr.trim());
    }

    return stdout;
  }

  async runCommand(file, args = [], timeout = 15000) {
    return execFileAsync(file, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
    });
  }

  withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ]);
  }

  async initialize() {
    await this.recoverPreviousSession();
  }

  async recoverPreviousSession() {
    const state = this.store.get(RUNTIME_STATE_KEY);
    if (!state) {
      return;
    }

    this.log('warning', 'Recovering from previous session...');

    try {
      await this.withTimeout(this.killProcessTree(state.enginePid), 5000, 'Engine kill on recovery');
    } catch (err) {
      this.log('warning', `Recovery engine kill: ${err.message}`);
    }

    if (state.pendingRestore && state.snapshot) {
      this.log('warning', 'Previous session did not shut down cleanly. Restoring network settings...');
      try {
        await this.withTimeout(this.restoreNetworkSnapshot(state.snapshot), 20000, 'Network restore on recovery');
        this.log('success', 'Network settings recovered from previous session');
      } catch (err) {
        this.log('error', `Network restore on recovery failed: ${err.message}`);
      }
    }

    this.store.delete(RUNTIME_STATE_KEY);
  }

  async start(config = {}) {
    if (this.transition) {
      return this.transition;
    }

    this.transition = this.startInternal(config).finally(() => {
      this.transition = null;
    });

    return this.transition;
  }

  async startInternal(config = {}) {
    if (this.isActive) {
      return { success: true, alreadyActive: true };
    }

    const settings = this.normalizeSettings(config);
    const needsSystemChanges = this.needsSystemChanges(settings);
    let snapshot = null;

    try {
      await this.recoverPreviousSession();

      if (needsSystemChanges) {
        snapshot = await this.captureNetworkSnapshot(settings);
        this.store.set(RUNTIME_STATE_KEY, {
          pendingRestore: true,
          startedAt: new Date().toISOString(),
          snapshot,
        });
      }

      if (settings.customDNS) {
        await this.configureDNS(settings.dnsServers, snapshot.adapters);
      }

      if (settings.nativeFrag) {
        await this.configureMTU(settings.maxPayload, snapshot.adapters);
      }

      if (settings.ttlManipulation) {
        await this.configureTTL(settings.ttlValue, snapshot.ttl);
      }

      const engineStarted = await this.startShroudlyEngine(settings);
      if (!engineStarted) {
        const detail = this.lastEngineError ? ` ${this.lastEngineError}` : '';
        if (/WinDivertOpen|administrator|access is denied|erişim engellendi/i.test(detail)) {
          throw new Error(`Administrator privileges required for DPI bypass.${detail}`);
        }

        throw new Error(`ShroudlyEngine could not be started. Check that ShroudlyEngine.exe and WinDivert files exist.${detail}`);
      }

      this.isActive = true;
      this.stats = {
        ...this.createEmptyStats(),
        startTime: Date.now(),
        engine: 'ShroudlyEngine',
        adapterCount: snapshot?.adapters?.length || 0,
        techniques: {
          'HTTP Fragmentation': settings.fragmentHTTP,
          'HTTPS/SNI Fragmentation': settings.fragmentHTTPS,
          'Wrong Checksum Fake Packets': settings.wrongChecksum || settings.sniFakePackets,
          'Custom DNS': settings.customDNS,
          'MTU Fragmentation': settings.nativeFrag,
          'TTL Override': settings.ttlManipulation,
          'ShroudlyEngine': true,
        },
      };

      this.store.set(RUNTIME_STATE_KEY, {
        pendingRestore: Boolean(snapshot),
        startedAt: new Date().toISOString(),
        enginePid: this.enginePid,
        snapshot,
      });

      this.startConnectionMonitor();
      this.onStatusChange(true);
      this.log('success', 'DPI engine started and network snapshot saved');
      return { success: true };
    } catch (error) {
      this.log('error', `Startup failed: ${error.message}`);
      await this.cleanupAfterFailure(snapshot);
      throw error;
    }
  }

  async stop() {
    if (this.transition) {
      await this.transition.catch(() => {});
    }

    if (!this.isActive && !this.store.get(RUNTIME_STATE_KEY)?.pendingRestore) {
      return { success: true };
    }

    await this.stopInternal();
    return { success: true };
  }

  async stopInternal() {
    this.stopConnectionMonitor();
    this.expectingEngineStop = true;

    // Always kill engine first, regardless of what else fails.
    try {
      await this.withTimeout(this.killShroudlyEngine(), 8000, 'Engine kill');
    } catch (err) {
      this.log('warning', `Engine kill: ${err.message}`);
    }

    // Restore network even if engine kill had issues.
    const state = this.store.get(RUNTIME_STATE_KEY);
    if (state?.snapshot) {
      try {
        await this.withTimeout(this.restoreNetworkSnapshot(state.snapshot), 20000, 'Network restore');
      } catch (err) {
        this.log('error', `Network restore timed out or failed: ${err.message}`);
      }
    }

    this.store.delete(RUNTIME_STATE_KEY);
    this.engineProcess = null;
    this.enginePid = null;
    this.isActive = false;
    this.stats = this.createEmptyStats();
    this.expectingEngineStop = false;
    this.onStatusChange(false);
    this.log('success', 'DPI engine stopped and original network settings restored');
  }

  async cleanupAfterFailure(snapshot) {
    this.stopConnectionMonitor();
    this.expectingEngineStop = true;

    try {
      await this.withTimeout(this.killShroudlyEngine(), 8000, 'Engine kill on failure');
    } catch (err) {
      this.log('warning', `Engine kill on failure: ${err.message}`);
    }

    if (snapshot) {
      try {
        await this.withTimeout(this.restoreNetworkSnapshot(snapshot), 20000, 'Network restore on failure');
      } catch (err) {
        this.log('error', `Network restore on failure timed out: ${err.message}`);
      }
    }

    this.store.delete(RUNTIME_STATE_KEY);
    this.engineProcess = null;
    this.enginePid = null;
    this.isActive = false;
    this.stats = this.createEmptyStats();
    this.expectingEngineStop = false;
    this.onStatusChange(false);
  }

  normalizeSettings(config) {
    const saved = this.store.store || {};
    const merged = { ...saved, ...config };
    const allowSystemNetworkChanges = merged.allowSystemNetworkChanges === true;
    const dnsServers = Array.isArray(merged.dnsServers)
      ? merged.dnsServers
      : String(merged.dnsServers || '').split(',');

    return {
      fragmentHTTP: merged.fragmentHTTP ?? true,
      fragmentHTTPS: merged.fragmentHTTPS ?? true,
      fragmentSize: this.clampNumber(merged.fragmentSize, 1, 10, 2),
      ttlManipulation: allowSystemNetworkChanges ? (merged.ttlManipulation ?? false) : false,
      ttlValue: this.clampNumber(merged.ttlValue, 1, 255, 5),
      sniFakePackets: merged.sniFakePackets ?? true,
      wrongChecksum: merged.wrongChecksum ?? true,
      nativeFrag: allowSystemNetworkChanges ? (merged.nativeFrag ?? false) : false,
      maxPayload: this.clampNumber(merged.maxPayload, 576, 1500, 1200),
      customDNS: allowSystemNetworkChanges ? (merged.customDNS ?? false) : false,
      dnsServers: dnsServers.map((server) => String(server).trim()).filter(Boolean),
      autoMode: merged.autoMode ?? true,
      aggressiveMode: merged.aggressiveMode ?? true,
      allowSystemNetworkChanges,
    };
  }

  needsSystemChanges(settings) {
    return Boolean(settings.customDNS || settings.nativeFrag || settings.ttlManipulation);
  }

  clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(number)));
  }

  async checkAdminRights() {
    if (await this.hasHighIntegrityToken()) {
      return true;
    }

    try {
      await this.runCommand('fltmc.exe', [], 5000);
      return true;
    } catch {
      return false;
    }
  }

  async hasHighIntegrityToken() {
    try {
      const { stdout } = await this.runCommand('whoami.exe', ['/groups'], 5000);
      return stdout.includes('S-1-16-12288');
    } catch {
      return false;
    }
  }

  async captureNetworkSnapshot(settings) {
    const script = `
$adapters = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $dns = Get-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
  $ip = Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    Name = $_.Name
    InterfaceIndex = $_.InterfaceIndex
    DnsServers = @($dns.ServerAddresses)
    Mtu = $ip.NlMtu
  }
}
$ttl = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters' -Name DefaultTTL -ErrorAction SilentlyContinue
[PSCustomObject]@{
  Adapters = @($adapters)
  Ttl = if ($ttl) { [PSCustomObject]@{ Exists = $true; Value = $ttl.DefaultTTL } } else { [PSCustomObject]@{ Exists = $false; Value = $null } }
} | ConvertTo-Json -Depth 5
`;

    const output = await this.runPowerShell(script);
    const snapshot = safeJsonParse(output, {});
    const adapters = Array.isArray(snapshot.Adapters)
      ? snapshot.Adapters
      : snapshot.Adapters
        ? [snapshot.Adapters]
        : [];

    if (adapters.length === 0 && (settings.customDNS || settings.nativeFrag)) {
      throw new Error('No active physical network adapter found');
    }

    return {
      adapters: adapters.map((adapter) => ({
        name: adapter.Name,
        interfaceIndex: adapter.InterfaceIndex,
        dnsServers: Array.isArray(adapter.DnsServers)
          ? adapter.DnsServers.filter(Boolean)
          : adapter.DnsServers
            ? [adapter.DnsServers]
            : [],
        mtu: adapter.Mtu,
      })),
      ttl: {
        exists: Boolean(snapshot.Ttl?.Exists),
        value: snapshot.Ttl?.Value ?? null,
      },
    };
  }

  async configureDNS(servers, adapters) {
    if (!servers.length) {
      throw new Error('At least one DNS server is required when custom DNS is enabled');
    }

    const serverList = servers.map((server) => `'${server.replace(/'/g, "''")}'`).join(',');
    const indexes = adapters.map((adapter) => Number(adapter.interfaceIndex)).filter(Boolean);

    for (const index of indexes) {
      await this.runPowerShell(`Set-DnsClientServerAddress -InterfaceIndex ${index} -ServerAddresses @(${serverList}) -ErrorAction Stop`);
    }

    await this.flushDNS();
    this.log('info', `DNS updated for ${indexes.length} adapter(s): ${servers.join(', ')}`);
  }

  async configureMTU(mtu, adapters) {
    for (const adapter of adapters) {
      await this.runCommand('netsh.exe', [
        'interface',
        'ipv4',
        'set',
        'subinterface',
        adapter.name,
        `mtu=${mtu}`,
        'store=active',
      ]);
    }

    this.log('info', `MTU set to ${mtu} for ${adapters.length} adapter(s)`);
  }

  async configureTTL(ttlValue) {
    await this.runCommand('reg.exe', [
      'add',
      'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters',
      '/v',
      'DefaultTTL',
      '/t',
      'REG_DWORD',
      '/d',
      String(ttlValue),
      '/f',
    ]);
    this.log('info', `DefaultTTL set to ${ttlValue}`);
  }

  async restoreNetworkSnapshot(snapshot) {
    const adapters = snapshot?.adapters || [];

    for (const adapter of adapters) {
      await this.restoreAdapterDNS(adapter);
      await this.restoreAdapterMTU(adapter);
    }

    await this.restoreTTL(snapshot?.ttl);
    await this.flushDNS();
  }

  async restoreAdapterDNS(adapter) {
    const index = Number(adapter.interfaceIndex);
    if (!index) {
      return;
    }

    try {
      if (adapter.dnsServers?.length) {
        const serverList = adapter.dnsServers.map((server) => `'${String(server).replace(/'/g, "''")}'`).join(',');
        await this.runPowerShell(
          `Set-DnsClientServerAddress -InterfaceIndex ${index} -ServerAddresses @(${serverList}) -ErrorAction Stop`,
          10000
        );
      } else {
        await this.runPowerShell(
          `Set-DnsClientServerAddress -InterfaceIndex ${index} -ResetServerAddresses -ErrorAction Stop`,
          10000
        );
      }
      this.log('info', `DNS restored for adapter ${adapter.name}`);
    } catch (error) {
      this.log('error', `Could not restore DNS for ${adapter.name}: ${error.message}`);
      // Fallback: reset via netsh
      try {
        await this.runCommand('netsh.exe', ['interface', 'ip', 'set', 'dns', adapter.name, 'dhcp'], 8000);
        this.log('info', `DNS reset via netsh fallback for ${adapter.name}`);
      } catch (fallbackErr) {
        this.log('error', `DNS netsh fallback also failed for ${adapter.name}: ${fallbackErr.message}`);
      }
    }
  }

  async restoreAdapterMTU(adapter) {
    try {
      if (!adapter.mtu) {
        return;
      }

      await this.runCommand('netsh.exe', [
        'interface',
        'ipv4',
        'set',
        'subinterface',
        adapter.name,
        `mtu=${adapter.mtu}`,
        'store=active',
      ]);
    } catch (error) {
      this.log('warning', `Could not restore MTU for ${adapter.name}: ${error.message}`);
    }
  }

  async restoreTTL(ttl) {
    try {
      if (!ttl) {
        return;
      }

      if (ttl.exists) {
        await this.runCommand('reg.exe', [
          'add',
          'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters',
          '/v',
          'DefaultTTL',
          '/t',
          'REG_DWORD',
          '/d',
          String(ttl.value),
          '/f',
        ]);
      } else {
        await this.runCommand('reg.exe', [
          'delete',
          'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters',
          '/v',
          'DefaultTTL',
          '/f',
        ]).catch(() => {});
      }
    } catch (error) {
      this.log('warning', `Could not restore DefaultTTL: ${error.message}`);
    }
  }

  async flushDNS() {
    try {
      await this.runCommand('ipconfig.exe', ['/flushdns'], 10000);
    } catch (error) {
      this.log('warning', `DNS cache flush failed: ${error.message}`);
    }
  }

  async startShroudlyEngine(settings) {
    const enginePath = this.resolveShroudlyEnginePath();
    if (!enginePath) {
      return false;
    }

    const args = this.buildShroudlyEngineArgs(settings);
    this.log('info', `Starting ShroudlyEngine: ${args.join(' ') || 'balanced mode'}`);
    this.lastEngineError = null;

    this.engineProcess = spawn(enginePath, args, {
      cwd: path.dirname(enginePath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.enginePid = this.engineProcess.pid;

    this.engineProcess.stdout.on('data', (data) => {
      normalizeLines(data).forEach((line) => this.log('info', `ShroudlyEngine: ${line}`));
    });

    this.engineProcess.stderr.on('data', (data) => {
      normalizeLines(data).forEach((line) => {
        this.lastEngineError = line;
        this.log('warning', `ShroudlyEngine: ${line}`);
      });
    });

    this.engineProcess.on('error', (error) => {
      this.lastEngineError = error.message;
      this.log('error', `ShroudlyEngine process error: ${error.message}`);
    });

    this.engineProcess.on('close', (code) => {
      this.handleShroudlyEngineClosed(code);
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));
    return Boolean(this.engineProcess && this.enginePid && !this.engineProcess.killed);
  }

  resolveShroudlyEnginePath() {
    const rel = path.join('electron', 'tools', 'shroudly-engine', 'ShroudlyEngine.exe');

    // In a packaged app __dirname points inside app.asar which Electron virtualises —
    // fs.existsSync returns true even for asar paths but spawn() cannot use them.
    // Always resolve to the real filesystem via app.asar.unpacked when packaged.
    const isPackaged = __dirname.includes('app.asar');

    if (isPackaged) {
      const resourcesPath = process.resourcesPath || path.join(__dirname, '..', '..', '..');
      const unpacked = path.join(resourcesPath, 'app.asar.unpacked', rel);
      return unpacked;
    }

    // Development: direct path from project root
    return path.join(__dirname, 'tools', 'shroudly-engine', 'ShroudlyEngine.exe');
  }

  buildShroudlyEngineArgs(settings) {
    const fragmentSize = settings.aggressiveMode
      ? Math.max(settings.fragmentSize || 3, 3)
      : (settings.fragmentSize || 3);

    const args = [
      '--fragment-size',     String(fragmentSize),
      '--max-packets-per-flow', settings.aggressiveMode ? '2' : '1',
    ];

    if (!settings.fragmentHTTP)  args.push('--no-http-split');
    if (!settings.fragmentHTTPS) args.push('--no-tls-split');
    if (!settings.wrongChecksum && !settings.sniFakePackets) args.push('--no-http-case');

    // Advanced techniques — disabled only when user explicitly turns them off
    if (!settings.sniFakePackets) args.push('--no-fake-sni');
    if (!settings.aggressiveMode)  args.push('--no-disorder');
    if (!settings.aggressiveMode)  args.push('--no-triple-split');

    return args;
  }

  async handleShroudlyEngineClosed(code) {
    const wasActive = this.isActive;
    this.engineProcess = null;
    this.enginePid = null;

    if (!wasActive || this.expectingEngineStop) {
      return;
    }

    this.log('error', `ShroudlyEngine stopped unexpectedly with code ${code}. Restoring network settings.`);
    try {
      await this.stopInternal();
    } catch (error) {
      this.log('error', `Automatic restore after crash failed: ${error.message}`);
    }
  }

  async killShroudlyEngine() {
    // Try Node.js direct kill first (instant, no shell spawn needed).
    if (this.engineProcess && !this.engineProcess.killed) {
      try { this.engineProcess.kill('SIGKILL'); } catch {}
    }

    const pid = this.enginePid || this.engineProcess?.pid || this.store.get(RUNTIME_STATE_KEY)?.enginePid;
    if (pid) {
      await this.killProcessTree(pid);
    }
  }

  // Synchronous engine kill — called from process.on('exit') which cannot use async.
  killShroudlyEngineSync() {
    try {
      if (this.engineProcess && !this.engineProcess.killed) {
        this.engineProcess.kill('SIGKILL');
      }
    } catch {}

    const pid = this.enginePid || this.engineProcess?.pid || this.store.get?.(RUNTIME_STATE_KEY)?.enginePid;
    if (pid) {
      try {
        require('child_process').execFileSync(
          'taskkill.exe', ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true, timeout: 3000 }
        );
      } catch {}
    }
  }

  async killProcessTree(pid) {
    if (!pid) {
      return;
    }

    try {
      await this.runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 8000);
    } catch {
      // Process may already be gone — fine during cleanup.
    }
  }

  startConnectionMonitor() {
    this.stopConnectionMonitor();
    this.monitorInterval = setInterval(async () => {
      if (!this.isActive) {
        return;
      }

      const bytes = await this.getNetworkBytes();
      if (bytes > 0 && this.lastKnownBytes > 0) {
        const delta = Math.max(0, bytes - this.lastKnownBytes);
        this.stats.bytesProcessed += delta;
        this.stats.packetsProcessed += Math.max(1, Math.round(delta / 1200));
      }
      this.lastKnownBytes = bytes;

      if (Math.random() < 0.05 && await this.testConnection('www.cloudflare.com')) {
        this.stats.connectionsSaved += 1;
      }
    }, 1000);
  }

  stopConnectionMonitor() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.lastKnownBytes = 0;
  }

  async getNetworkBytes() {
    try {
      const output = await this.runPowerShell(
        "(Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes,SentBytes -Sum).Sum | Measure-Object -Sum | Select-Object -ExpandProperty Sum",
        5000
      );
      return Number(String(output).trim()) || 0;
    } catch {
      return 0;
    }
  }

  getStats() {
    return {
      ...this.stats,
      uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
    };
  }

  async testConnection(domain) {
    return new Promise((resolve) => {
      const req = https.get(`https://${domain}`, { timeout: 3000 }, (res) => {
        res.resume();
        resolve([200, 204, 301, 302, 308].includes(res.statusCode));
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }
}

module.exports = DPIBypass;
