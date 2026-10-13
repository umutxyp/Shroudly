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
const { DISCORD_DOMAINS } = require('./discord-relay');
const fingerprints = require('./censor-fingerprints');
const net = require('net');

/* Can we listen on 127.0.0.1:port right now? */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/* The configured port if it is free, else the next free one close by, else
 * any. Other proxies (v2rayN, Clash and more) also default to 10808, and one
 * of them running must not stop protection from starting at all. */
async function pickPort(want) {
  if (await portFree(want)) return want;
  for (let p = want + 1; p <= want + 20 && p < 65536; p++) if (await portFree(p)) return p;
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/* Countries whose filters follow whole connections rather than just the first
 * packet. There the normal mode is often not enough, and Advanced mode is the
 * thing to offer before the user has to discover it. (Research notes in
 * README, "Where it works".) */
const STATEFUL_REGIONS = new Set(['IR', 'CN', 'RU', 'TM', 'BY']);

/* How many cuts on one host, within CUT_WINDOW_MS, before we believe it. A
 * stall or reset is strong evidence; "no reply" is weak (a long-poll looks
 * the same), so it needs more. */
const CUT_WINDOW_MS = 3 * 60 * 1000;
const CUT_NEED = { stall: 2, reset: 2, noreply: 4 };

/* A list that names any Discord domain gets all of them: Discord loads its
 * pieces from a dozen domains, and a list edited before one was added would
 * otherwise leave that piece blocked (activities, gift links, dis.gd). */
function withDiscord(list) {
  const lower = list.map((d) => String(d).toLowerCase());
  if (!lower.some((d) => DISCORD_DOMAINS.includes(d))) return list;
  return [...list, ...DISCORD_DOMAINS.filter((d) => !lower.includes(d))];
}

const DEFAULT_PORT = 10808;

// Domains routed through the proxy in "listed" mode: the list built by
// scripts/site-list/update.js from OONI measurements and curated service
// families (each service with every domain it needs, CDN and captcha
// included), shipped in data/sites.json and kept current by site-list.js.
// The default routing mode sends everything through Shroudly instead, so this
// list only matters to people who narrow it down; they can edit it in Settings.
// FALLBACK_SITE_LIST is only used if the shipped file cannot be read.
function bundledSiteList() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sites.json'), 'utf8')).domains;
    if (Array.isArray(d) && d.length) return d;
  } catch {}
  return FALLBACK_SITE_LIST;
}
const FALLBACK_SITE_LIST = [
  // Discord: every domain the company serves the app, media and activities from
  ...DISCORD_DOMAINS,
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
const DEFAULT_SITE_LIST = bundledSiteList();
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
    // The current automatic list (site-list.js); the one shipped with the app
    // when there is none.
    this.siteList = hooks.siteList || (() => DEFAULT_SITE_LIST);
    this.lastProbe = null;
    this.proxyOptions = hooks.proxyOptions || {};
    this.proxy = new SystemProxy(this.log, this.proxyOptions);
    this.onAdvice = hooks.onAdvice || (() => {});
    // What the window should tell the user about this network. Kept here, not
    // only sent, because most of it is learned before the window has loaded.
    this.advice = { conflicts: [], region: null, cut: null, dnsDown: false };
    this.cuts = new Map();        // host -> [{ reason, t }]
    this.cutHosts = new Set();    // hosts already reported this session
    this.doh = new DohForwarder(this.log, {
      // The route that worked is remembered, so the next start goes straight to it.
      preferredId: store.get('dohRoute') || null,
      onPreferred: (id) => store.set('dohRoute', id),
      onState: (state) => this._setAdvice({ dnsDown: state === 'down' }),
    });
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
      siteList: withDiscord(Array.isArray(s.siteList) ? s.siteList : this.siteList()),
      port: Number(s.listenPort) || DEFAULT_PORT,
    };
  }

  _args(cfg) {
    const a = ['--listen', '127.0.0.1', '--port', String(cfg.port), '--strategy', cfg.strategy];
    if (cfg.autoProbe) a.push('--auto');
    if (cfg.useDoh) { a.push('--doh'); if (this.dohPort) a.push('--doh-port', String(this.dohPort)); }
    if (cfg.preferIpv6) a.push('--ipv6');
    // Block pages and sinkholes of every country we know: an answer pointing
    // at one is forged, so the engine refuses it and keeps looking.
    for (const ip of fingerprints.ALL) a.push('--block-ip', ip);
    return a;
  }

  /* While another VPN or bypass tool is running, look again every half
   * minute, so the warning goes away by itself once the user quits it. */
  _watchConflicts() {
    clearInterval(this._conflictTimer);
    if (!this.advice.conflicts.length) return;
    this._conflictTimer = setInterval(async () => {
      if (!this.active) { clearInterval(this._conflictTimer); return; }
      let tools = [];
      try { tools = await diagnostics.runningTools(); } catch { return; }
      this._setAdvice({ conflicts: tools });
      if (!tools.length) {
        clearInterval(this._conflictTimer);
        this.log('success', 'The other VPN or bypass tool is no longer running.');
      }
    }, 30000);
    if (this._conflictTimer.unref) this._conflictTimer.unref();
  }

  /* Settle on a free port at or after `want`. If it is not the one saved,
   * save it: the next start goes straight to a port that worked, and only
   * looks again if that one is taken too. */
  async _claimPort(want) {
    const saved = Number(this.store.get('listenPort')) || DEFAULT_PORT;
    const port = await pickPort(want);
    if (port !== saved) {
      this.log('warning', `Port ${saved} is in use by another program; Shroudly is using ${port} instead.`);
      this.store.set('listenPort', port);
    }
    this.port = port;
    this.configuredPort = port;
    return port;
  }

  _setAdvice(patch) {
    const next = { ...this.advice, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.advice)) return;
    this.advice = next;
    try { this.onAdvice(this.advice); } catch {}
  }

  /* A site whose connections start and are then cut. One cut means little;
   * several on the same host in a few minutes is the network doing it. Told
   * once per host per session. */
  _onCut(host, reason, kb) {
    if (!host || this.cutHosts.has(host)) return;
    const now = Date.now();
    const list = (this.cuts.get(host) || []).filter((c) => now - c.t < CUT_WINDOW_MS);
    list.push({ reason, t: now });
    this.cuts.set(host, list);
    if (this.cuts.size > 400) this.cuts.clear();
    const strong = list.filter((c) => c.reason !== 'noreply').length;
    const weak = list.length - strong;
    if (strong < CUT_NEED.stall && weak < CUT_NEED.noreply) return;
    this.cutHosts.add(host);
    this.log('warning', `${host}: connects, then the network cuts it (${reason} after ${kb} KB). This network filters whole connections; Shroudly is trying other techniques for it.`);
    this._setAdvice({ cut: { host, reason } });
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
    cfg.port = await this._claimPort(cfg.port);
    this.stats = this._empty();
    this.bypassed.clear();
    this.blockedHosts.clear();
    this.cuts.clear();
    this._setAdvice({ cut: null });
    this._describeEnvironment();
    this.stats.strategy = cfg.strategy;
    this.expectingStop = false;

    // Start the local DoH forwarder so the engine gets real encrypted DNS.
    // If it can't start, the engine falls back to public UDP resolvers.
    if (cfg.useDoh && !this.dohPort) {
      try { this.dohPort = await this.doh.start(); }
      catch (e) { this.dohPort = 0; this.log('warning', `Encrypted DNS unavailable: ${e.message}`); }
    }

    let ready = await this._spawn(bin, this._args(cfg));
    // Something took the port between our check and the engine binding it:
    // move on to another one rather than fail.
    for (let tries = 0; !ready && /listen failed/.test(this.lastError || '') && tries < 3; tries++) {
      cfg.port = await this._claimPort(cfg.port + 1);
      ready = await this._spawn(bin, this._args(cfg));
    }
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
      // The block-page list is long and the same every time: count it, don't print it.
      const shown = args.filter((x, i) => x !== '--block-ip' && args[i - 1] !== '--block-ip');
      const blockIps = (args.length - shown.length) / 2;
      this.log('info', `Starting engine: ${path.basename(bin)} ${shown.join(' ')}${blockIps ? ` (+${blockIps} known block pages)` : ''}`);
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
    if (d.idleVpns && d.idleVpns.length) {
      // Installed and running in the background, but not connected: no
      // conflict, and worth saying so, since people suspect it first.
      this.log('info', `${d.idleVpns.join(', ')} is installed but not connected; that does not interfere.`);
    }
    this._setAdvice({ conflicts: d.conflicts });
    this._watchConflicts();
    if (d.region) {
      this.log('info', d.region === 'filter'
        ? 'Your DNS service filters sites; Shroudly\'s encrypted DNS goes around it.'
        : `DNS answers on this network match the filtering used in ${d.region}.`);
      this._setAdvice({ region: d.region === 'filter' ? null : { country: d.region, stateful: STATEFUL_REGIONS.has(d.region) } });
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
        // Encrypted DNS routes that go through the engine can start now.
        this.doh.setSocksPort(msg.port);
        clearTimeout(this._dohReport);
        this._dohReport = setTimeout(() => {
          const routes = this.doh.summary();
          if (routes && this.active) this.log('info', `Encrypted DNS answering via ${routes}`);
        }, 6000);
        if (this._dohReport.unref) this._dohReport.unref();
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
        // This network filters. If its DNS gave nothing away, the clock's
        // country is the next best hint for whether its filters are the kind
        // that follow whole connections — enough to offer Advanced mode.
        if (!this.advice.region) {
          const cc = diagnostics.timezoneCountry();
          if (cc && STATEFUL_REGIONS.has(cc)) this._setAdvice({ region: { country: cc, stateful: true } });
        }
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
      case 'cut':
        this._onCut(msg.host, msg.strategy, msg.attempts);
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
    // A changed port setting needs a full stop and start; otherwise keep the
    // port this session is actually on (it may be a free one we moved to).
    if (cfg.port !== (this.configuredPort || this.port)) { await this.stop(); return this.start(); }
    cfg.port = this.port;
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
