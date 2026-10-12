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
const DohForwarder = require('./doh-forwarder');
const diagnostics = require('./diagnostics');

const DEFAULT_PORT = 10808;

// Domains routed through the proxy in "listed" mode. Services that are widely
// blocked somewhere, together with the CDN domains they load their images and
// media from — a site whose CDN is left out loads as a page of broken images,
// which is worse than not routing it at all. Only lawful services are listed.
// The default routing mode sends everything through Shroudly instead, so this
// list only matters to people who narrow it down; they can edit it in Settings.
const DEFAULT_SITE_LIST = [
  // Discord
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media',
  'discordcdn.com', 'discord.dev', 'discordstatus.com',
  // Roblox
  'roblox.com', 'rbxcdn.com', 'robloxlabs.com',
  // Reading / writing / sharing
  'wattpad.com', 'pastebin.com', 'medium.com', 'imgur.com', 'linktr.ee',
  'archiveofourown.org', 'tumblr.com', 'wordpress.com', 'blogspot.com',
  'quora.com', 'deviantart.com', 'flickr.com', 'pinterest.com',
  // Audio / video
  'soundcloud.com', 'sndcdn.com', 'spotify.com', 'scdn.co',
  'youtube.com', 'youtu.be', 'ytimg.com', 'googlevideo.com',
  'twitch.tv', 'ttvnw.net', 'jtvnw.net', 'vimeo.com', 'vimeocdn.com',
  'dailymotion.com', 'dmcdn.net',
  // Social
  'x.com', 'twitter.com', 'twimg.com', 't.co',
  'facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com',
  'whatsapp.com', 'whatsapp.net',
  'tiktok.com', 'tiktokcdn.com', 'tiktokv.com',
  'reddit.com', 'redd.it', 'redditstatic.com', 'redditmedia.com',
  'telegram.org', 'telegram.me', 't.me', 'signal.org',
  // Reference and news
  'wikipedia.org', 'wikimedia.org', 'archive.org',
  'bbc.com', 'bbc.co.uk', 'dw.com', 'voanews.com', 'rferl.org',
  'reuters.com', 'theguardian.com', 'nytimes.com',
  'eksisozluk.com',
  // Tools developers and students lose first
  'github.com', 'githubusercontent.com', 'githubassets.com', 'gitlab.com',
  'stackoverflow.com', 'stackexchange.com', 'sstatic.net',
  'duckduckgo.com', 'proton.me', 'protonmail.com', 'tutanota.com', 'torproject.org',
];
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
    this.onSiteBlocked = hooks.onSiteBlocked || (() => {});
    this.onNeedRestart = hooks.onNeedRestart || (() => {});
    this.onDnsAutoEnabled = hooks.onDnsAutoEnabled || (() => {});
    this.lastProbe = null;
    this.proxyOptions = hooks.proxyOptions || {};
    this.proxy = new SystemProxy(this.log, this.proxyOptions);
    this.doh = new DohForwarder(this.log);
    this.dohPort = 0;

    this.proc = null;
    this.active = false;
    // Hosts we have already reported on, so a busy page logs one line per site
    // rather than one per connection.
    this.bypassed = new Set();
    this.blockedHosts = new Set();
    this._dnsAutoFixed = false;
    this._dnsReenabledForBlock = false;
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
      useDoh: s.dnsProtection !== false,        // encrypted DNS: default on
      preferIpv6: s.preferIpv6 === true,
      // Default: everything goes through Shroudly. That is what makes a blocked
      // site work without anyone having to know its name in advance, and it is
      // what gives every lookup our encrypted DNS. It costs nothing, because the
      // engine leaves a connection completely untouched unless it is refused:
      // ordinary browsing is relayed as-is, at the same speed as no proxy.
      routeMode: s.routeMode === 'listed' ? 'listed' : 'all',
      siteList: Array.isArray(s.siteList) ? s.siteList : DEFAULT_SITE_LIST,
      port: Number(s.listenPort || this.port) || DEFAULT_PORT,
    };
  }

  _args(cfg) {
    const a = ['--listen', '127.0.0.1', '--port', String(cfg.port), '--strategy', cfg.strategy];
    if (cfg.autoProbe) a.push('--auto');
    if (cfg.useDoh) { a.push('--doh'); if (this.dohPort) a.push('--doh-port', String(this.dohPort)); }
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
    this.bypassed.clear();
    this.blockedHosts.clear();
    this._describeEnvironment();
    this.stats.strategy = cfg.strategy;
    this.expectingStop = false;

    // Start the local DoH forwarder so the engine gets real encrypted DNS.
    // If it can't start, the engine falls back to public UDP resolvers.
    if (cfg.useDoh && !this.dohPort) {
      try { this.dohPort = await this.doh.start(); }
      catch (e) { this.dohPort = 0; this.log('warning', `Encrypted DNS unavailable: ${e.message}`); }
    }

    const ready = await this._spawn(bin, this._args(cfg));
    if (!ready) {
      await this._cleanup();
      throw new Error(this.lastError || 'Engine failed to start');
    }

    try {
      await this.proxy.apply(this.port, cfg.routeMode, cfg.siteList);
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
      // Only this process's own exit counts: a replaced engine (restart())
      // may close after its successor is already running.
      const proc = this.proc;
      proc.on('close', (code) => { if (this.proc !== proc) return; this._onClose(code); if (!settled) finish(false); });

      setTimeout(() => { if (!settled) { this.lastError = 'engine start timeout'; finish(false); } }, 6000);
    });
  }

  /* Write down what this machine looks like, and act on the two findings that
   * change the outcome: another tool steering the same traffic, and a resolver
   * handing back forged answers. Runs in the background so it never delays the
   * engine coming up. */
  async _describeEnvironment() {
    let d;
    try { d = await diagnostics.collect(); } catch { return; }

    const net = `${d.iface.name} (${d.iface.kind})`;
    const dnsList = d.dnsServers.length ? d.dnsServers.join(', ') : 'unknown';
    this.log('info', `System: ${d.os} — network ${net}, DNS ${dnsList}`);

    if (d.needRestart.length) {
      // The most common report by far is "works in my browser, not in the
      // app". It is almost always this: the program read the connection
      // settings when it launched and has not looked since.
      const names = d.needRestart.join(', ');
      this.log('warning', `${names} was already running when protection started. Close and reopen it, or it will keep using the unprotected connection it started with.`);
      if (typeof this.onNeedRestart === 'function') this.onNeedRestart(d.needRestart);
    }

    if (d.conflicts.length) {
      // Two tools rewriting the same connections is the most common reason a
      // working setup stops working, so say it plainly and name them.
      this.log('warning', `Also running: ${d.conflicts.join(', ')}. Another bypass tool or VPN changes the same connections as Shroudly; if sites misbehave, turn one of them off.`);
      if (typeof this.onConflicts === 'function') this.onConflicts(d.conflicts);
    }

    if (d.forgedDns.length) {
      const names = d.forgedDns.map((h) => h.host).join(', ');
      if (this.store.get('dnsProtection') === false) {
        // The user switched it off and their network is forging answers. The
        // engine reads this setting once, at startup, and this check finishes
        // after it has already started — so flipping the setting is not enough,
        // the engine has to be restarted to pick it up. Guarded so it can only
        // happen once per session, and not gated on `active`, which may still
        // be false at the moment this resolves.
        this.store.set('dnsProtection', true);
        this.log('warning', `Your DNS is being tampered with (${names}). Encrypted DNS has been switched back on automatically.`);
        if (!this._dnsAutoFixed) {
          this._dnsAutoFixed = true;
          setTimeout(() => { if (this.active) this.restart().catch(() => {}); }, 1200);
        }
      } else {
        this.log('info', `Your provider's DNS returns forged answers for ${names}; Shroudly's encrypted DNS is handling it.`);
      }
      if (typeof this.onDnsTampering === 'function') this.onDnsTampering(d.forgedDns);
    }
  }

  _onLine(line, finishStart) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.log('info', `engine: ${line}`); return; }
    switch (msg.type) {
      case 'ready':
        this.log('success', `Engine listening on 127.0.0.1:${msg.port}`);
        // A session that has been up for a while has earned a fresh restart
        // budget; otherwise a handful of crashes spread over days eventually
        // leaves the engine refusing to come back at all.
        clearTimeout(this._restartCredit);
        this._restartCredit = setTimeout(() => { this.restarts = 0; }, 120000);
        if (this._restartCredit.unref) this._restartCredit.unref();
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
        this.stats.sampledAt = Date.now(); // lets the UI compute rates per sample
        break;
      // A site that needed a technique, and one that defeated all of them. These
      // two lines are what makes a user's log enough to diagnose a report: the
      // site, the technique that worked, and how many had to be tried.
      case 'bypass':
        this.blockedHosts.delete(msg.host);
        if (!this.bypassed.has(msg.host)) {
          // One line per site, but the set is only there to stop repeats, so
          // it is capped rather than allowed to track a whole session.
          if (this.bypassed.size > 400) this.bypassed.clear();
          this.bypassed.add(msg.host);
          this.log('success', `${msg.host}: blocked here, opened with ${msg.strategy} (${msg.attempts} tries, ${msg.family})`);
        }
        break;
      case 'blocked':
        // A site that defeated every technique while encrypted DNS was switched
        // off: the most likely cause is the DNS answer itself, which none of
        // the techniques can fix. Turn it back on and retry rather than leave
        // the user staring at a page that will never load. Once per session.
        if (this.store.get('dnsProtection') === false && !this._dnsReenabledForBlock) {
          this._dnsReenabledForBlock = true;
          this.store.set('dnsProtection', true);
          this.log('warning', `${msg.host} could not be opened with encrypted DNS switched off. It has been switched back on.`);
          if (typeof this.onDnsAutoEnabled === 'function') this.onDnsAutoEnabled(msg.host);
          setTimeout(() => { if (this.active) this.restart().catch(() => {}); }, 300);
          break;
        }
        if (!this.blockedHosts.has(msg.host)) {
          if (this.blockedHosts.size > 400) this.blockedHosts.clear();
          this.blockedHosts.add(msg.host);
          this.log('warning', `${msg.host}: still blocked after ${msg.attempts} techniques (${msg.family}) — this network may need Advanced mode`);
          // Nobody reads a log unprompted. A site that could not be opened at
          // all is the one moment the user needs telling, because otherwise
          // they conclude the app simply does not work.
          if (typeof this.onSiteBlocked === 'function') this.onSiteBlocked(msg.host);
        }
        break;
      case 'send_failed':
        this.log('warning', `${msg.host}: connection dropped while sending (${msg.family})`);
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

  /* Apply changed settings while active: replace the engine process but keep
   * the system proxy pointed at it, so the switch is a brief blip instead of a
   * full proxy off/on cycle. */
  async restart() {
    if (!this.active || this.restarting) return { success: true };
    const cfg = this._settings();
    if (cfg.port !== this.port) { await this.stop(); return this.start(); }
    this.restarting = true;
    try {
      this.expectingStop = true;
      this._stopStatsPoll();
      const old = this.proc;
      if (old) {
        try { old.stdin.write('STOP\n'); } catch {}
        await this._waitExit(2500);
        if (this.proc === old) { try { old.kill('SIGKILL'); } catch {} await this._waitExit(1000); }
      }
      this.proc = null;
      this.expectingStop = false;
      this.stats.strategy = cfg.strategy;
      // DNS protection may have just been turned on: start the forwarder;
      // or turned off: it keeps running harmlessly and is dropped on stop().
      if (cfg.useDoh && !this.dohPort) {
        try { this.dohPort = await this.doh.start(); } catch { this.dohPort = 0; }
      }
      const ready = await this._spawn(coreBinaryPath(), this._args(cfg));
      if (!ready) {
        await this._cleanup(); // restores the proxy
        this.store.set('runtimeActive', false);
        this.onStatusChange(false);
        throw new Error(this.lastError || 'Engine failed to restart');
      }
      this._startStatsPoll();
      this.log('success', `Settings applied (strategy: ${cfg.strategy}${cfg.autoProbe ? ' + auto' : ''})`);
      return { success: true };
    } finally {
      this.restarting = false;
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
    this.doh.stop(); this.dohPort = 0;
    this.store.set('runtimeActive', false);
    this.onStatusChange(false);
    this.log('success', 'Shroudly engine stopped; system restored');
    return { success: true };
  }

  /* Re-apply the system proxy with the current route mode / site list, without
   * restarting the engine. Used when the user changes those settings. */
  async reapplyProxy() {
    if (!this.active) return { success: true };
    const cfg = this._settings();
    try {
      await this.proxy.restore();                       // back to the user's own settings
      await this.proxy.apply(this.port, cfg.routeMode, cfg.siteList);
      this.log('success', 'Proxy routing updated');
    } catch (e) {
      this.log('error', `Could not update proxy routing: ${e.message}`);
    }
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
    this.doh.stop(); this.dohPort = 0;
    try { await this.proxy.restore(); } catch {}
    this.active = false;
  }

  // Synchronous last-resort cleanup on hard exit.
  cleanupSync() {
    try { if (this.proc) this.proc.kill(); } catch {}
    try { this.doh.stop(); } catch {}
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
module.exports.DEFAULT_SITE_LIST = DEFAULT_SITE_LIST;
