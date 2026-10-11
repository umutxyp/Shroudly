'use strict';

/*
 * EngineManager — drives the native shroudly-core binary.
 *
 * Responsibilities:
 *   - resolve & spawn the right binary for this OS/arch
 *   - translate UI settings into engine CLI args
 *   - set the system proxy while active, restore it on stop/crash/exit
 *   - parse the engine's JSON stdout into live stats + logs
 *   - restart the engine with backoff if it dies unexpectedly
 *
 * No elevation, no drivers, no third-party tools.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const SystemProxy = require('./system-proxy');

const DEFAULT_PORT = 10808;
const MAX_RESTARTS = 5;
// No output at all for this long, although STATS is asked every second, means
// the engine hangs: the system proxy then points at a dead endpoint, so treat
// it like a crash. Generous, because a site test (PROBE) blocks the engine's
// command loop while it runs.
const HANG_TIMEOUT_MS = 60000;

function coreBinaryPath() {
  const plat = process.platform;              // win32 | darwin | linux
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const dir = `${plat}-${arch}`;
  const bin = plat === 'win32' ? 'shroudly-core.exe' : 'shroudly-core';

  // Packaged: resources/app.asar.unpacked/electron/tools/core/<dir>/bin
  const rel = path.join('electron', 'tools', 'core', dir, bin);
  const packaged = __dirname.includes('app.asar');
  if (packaged) {
    const res = process.resourcesPath || path.join(__dirname, '..', '..', '..');
    return path.join(res, 'app.asar.unpacked', rel);
  }
  return path.join(__dirname, 'tools', 'core', dir, bin);
}

class EngineManager {
  constructor(store, hooks = {}) {
    this.store = store;
    this.log = hooks.addLog || (() => {});
    this.onStatusChange = hooks.onStatusChange || (() => {});
    this.onProbe = hooks.onProbe || (() => {});
    this.lastProbe = null;
    this.proxyOptions = hooks.proxyOptions || {};
    this.proxy = new SystemProxy(this.log, this.proxyOptions);

    this.proc = null;
    this.active = false;
    this.port = Number(store.get('listenPort', DEFAULT_PORT)) || DEFAULT_PORT;
    this.expectingStop = false;
    this.restarts = 0;
    this.lastError = null;
    this.startedAt = 0;

    this.stats = this._empty();
  }

  _empty() {
    return {
      engine: 'shroudly-core',
      startTime: 0,
      connsTotal: 0, connsActive: 0,
      bytesUp: 0, bytesDown: 0,
      desync: 0, tlsSeen: 0, httpSeen: 0,
      probeOk: 0, probeFail: 0,
      strategy: '',
    };
  }

  isActive() { return this.active; }

  getStats() {
    return { ...this.stats, uptime: this.startedAt ? Date.now() - this.startedAt : 0 };
  }

  _settings() {
    const s = this.store.store || {};
    const strategy = typeof s.strategy === 'string' && s.strategy ? s.strategy : 'split(sni)';
    return {
      strategy,
      autoProbe: s.autoMode !== false,          // "auto mode" now means real auto-probe
      useDoh: s.dnsProtection === true,         // anti-poisoning resolver
      preferIpv6: s.preferIpv6 === true,
      port: Number(s.listenPort || this.port) || DEFAULT_PORT,
    };
  }

  _args(cfg) {
    const a = ['--listen', '127.0.0.1', '--port', String(cfg.port), '--strategy', cfg.strategy];
    if (cfg.autoProbe) a.push('--auto');
    if (cfg.useDoh) a.push('--doh');
    if (cfg.preferIpv6) a.push('--ipv6');
    return a;
  }

  async start() {
    if (this.active) return { success: true, alreadyActive: true };

    const bin = coreBinaryPath();
    if (!fs.existsSync(bin)) {
      const msg = `Engine binary not found for ${process.platform}-${process.arch}. Run: npm run build:core`;
      this.log('error', msg);
      throw new Error(msg);
    }

    const cfg = this._settings();
    this.port = cfg.port;
    this.stats = this._empty();
    this.stats.strategy = cfg.strategy;
    this.expectingStop = false;

    const ready = await this._spawn(bin, this._args(cfg));
    if (!ready) {
      await this._cleanup();
      throw new Error(this.lastError || 'Engine failed to start');
    }

    try {
      await this.proxy.apply(this.port);
    } catch (e) {
      this.log('error', `Could not set system proxy: ${e.message}`);
      await this._cleanup();
      throw e;
    }

    this.active = true;
    this.startedAt = Date.now();
    this.stats.startTime = this.startedAt;
    this.store.set('runtimeActive', true);
    this._startStatsPoll();
    this.onStatusChange(true);
    this.log('success', `Shroudly engine active (strategy: ${cfg.strategy}${cfg.autoProbe ? ' + auto' : ''})`);
    return { success: true };
  }

  _spawn(bin, args) {
    return new Promise((resolve) => {
      this.log('info', `Starting engine: ${path.basename(bin)} ${args.join(' ')}`);
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

      try {
        this.proc = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        this.lastError = e.message;
        return finish(false);
      }

      let buf = '';
      this.lastOutputAt = Date.now();
      this.proc.stdout.on('data', (d) => {
        this.lastOutputAt = Date.now();
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this._onLine(line, finish);
        }
      });
      this.proc.stderr.on('data', (d) => {
        const t = d.toString().trim();
        if (t) { this.lastError = t; this.log('warning', `engine: ${t}`); }
      });
      this.proc.on('error', (e) => { this.lastError = e.message; this.log('error', `engine error: ${e.message}`); finish(false); });
      this.proc.on('close', (code) => { this._onClose(code); if (!settled) finish(false); });

      setTimeout(() => { if (!settled) { this.lastError = 'engine start timeout'; finish(false); } }, 6000);
    });
  }

  _onLine(line, finishStart) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.log('info', `engine: ${line}`); return; }
    switch (msg.type) {
      case 'ready':
        this.log('success', `Engine listening on 127.0.0.1:${msg.port}`);
        if (finishStart) finishStart(true);
        break;
      case 'stats':
        this.stats.connsTotal = msg.conns_total;
        this.stats.connsActive = msg.conns_active;
        this.stats.bytesUp = msg.bytes_up;
        this.stats.bytesDown = msg.bytes_down;
        this.stats.desync = msg.desync;
        this.stats.tlsSeen = msg.tls;
        this.stats.httpSeen = msg.http;
        this.stats.probeOk = msg.probe_ok;
        this.stats.probeFail = msg.probe_fail;
        break;
      case 'probe':
        if (msg.ok && msg.strategy === 'none') {
          this.log('info', `Auto: ${msg.host} is not blocked here`);
        } else if (msg.ok) {
          this.log('success', `Auto: ${msg.host} works with ${msg.strategy}`);
        } else {
          this.log('warning', `Auto: ${msg.host} stays blocked — split/disorder can't defeat this DPI`);
        }
        // Surface the probe result (incl. suggest:"advanced") to the app so the UI
        // can offer Advanced mode when a site can't be unblocked at this level.
        this.lastProbe = { host: msg.host, ok: !!msg.ok, blocked: !!msg.blocked,
                           strategy: msg.strategy || null, suggest: msg.suggest || null };
        if (typeof this.onProbe === 'function') this.onProbe(this.lastProbe);
        break;
      case 'error':
        this.lastError = msg.msg || `code ${msg.code}`;
        this.log('error', `engine: ${this.lastError}`);
        break;
      case 'stopped':
        break;
      default:
        break;
    }
  }

  _startStatsPoll() {
    this._stopStatsPoll();
    this._poll = setInterval(() => {
      if (!this.proc) return;
      if (this.active && Date.now() - this.lastOutputAt > HANG_TIMEOUT_MS) {
        this.log('error', 'Engine stopped responding; restarting it');
        this.lastOutputAt = Date.now();
        try { this.proc.kill('SIGKILL'); } catch {} // _onClose restores the proxy and restarts
        return;
      }
      if (this.proc.stdin.writable) {
        try { this.proc.stdin.write('STATS\n'); } catch {}
      }
    }, 1000);
  }
  _stopStatsPoll() { if (this._poll) { clearInterval(this._poll); this._poll = null; } }

  // Ask the engine to probe a host (used by UI "test site").
  probe(host) {
    if (this.proc && this.proc.stdin.writable) {
      try { this.proc.stdin.write(`PROBE ${host}\n`); } catch {}
    }
  }

  async _onClose(code) {
    const wasActive = this.active;
    this.proc = null;
    if (this.expectingStop || !wasActive) return;

    this.log('error', `Engine exited unexpectedly (code ${code}).`);
    // Restore proxy immediately so the user is never left half-routed.
    await this.proxy.restore();
    this.active = false;
    this.onStatusChange(false);

    if (this.restarts < MAX_RESTARTS) {
      this.restarts++;
      const delay = Math.min(500 * this.restarts, 4000);
      this.log('warning', `Restarting engine in ${delay}ms (attempt ${this.restarts}/${MAX_RESTARTS})`);
      setTimeout(() => { this.start().catch((e) => this.log('error', `Restart failed: ${e.message}`)); }, delay);
    } else {
      this.log('error', 'Engine keeps crashing; giving up. Check logs.');
      this.restarts = 0;
    }
  }

  async stop() {
    if (!this.active && !this.proc) { await this.proxy.restore(); return { success: true }; }
    this.expectingStop = true;
    this._stopStatsPoll();

    // Restore proxy first so traffic goes direct the instant we stop.
    await this.proxy.restore();

    if (this.proc) {
      try { this.proc.stdin.write('STOP\n'); } catch {}
      await this._waitExit(2500);
      if (this.proc) { try { this.proc.kill(); } catch {} }
    }

    this.active = false;
    this.restarts = 0;
    this.startedAt = 0;
    this.store.set('runtimeActive', false);
    this.onStatusChange(false);
    this.log('success', 'Shroudly engine stopped; system restored');
    return { success: true };
  }

  _waitExit(ms) {
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      const t = setTimeout(resolve, ms);
      this.proc.once('close', () => { clearTimeout(t); resolve(); });
    });
  }

  async _cleanup() {
    this._stopStatsPoll();
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    try { await this.proxy.restore(); } catch {}
    this.active = false;
  }

  // Synchronous last-resort cleanup on hard exit.
  cleanupSync() {
    try { if (this.proc) this.proc.kill(); } catch {}
    try { this.proxy.restoreSync(); } catch {}
  }

  async recover() {
    // A previous run that never restored the proxy (crash, kill, power loss)
    // left a state file with the user's settings: put them back. 2.0.0 left
    // only the runtimeActive flag, so fall back to switching its proxy off.
    let restored = false;
    try { restored = SystemProxy.recoverSync(this.proxyOptions, this.log); } catch {}
    if (!restored && this.store.get('runtimeActive')) {
      this.log('info', 'Recovering: restoring proxy from previous session');
      try { SystemProxy.resetLegacySync(this.log); } catch {}
    }
    this.store.set('runtimeActive', false);
  }
}

module.exports = EngineManager;
module.exports.coreBinaryPath = coreBinaryPath;
