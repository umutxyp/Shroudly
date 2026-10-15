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
const Families = require('./families');
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

/* A host that could not be reached at all is logged again only after this
 * long: a browser retries a dead host over and over, and the log should say
 * so once, not once per retry. */
const UNREACHABLE_REPEAT_MS = 5 * 60 * 1000;

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
    // Every site-level finding, as (kind, host, detail): 'bypass', 'blocked',
    // 'cut', 'unreachable'. The app uses it to recognise which services this
    // network filters, and sites that turn the user away themselves.
    this.onHostEvent = hooks.onHostEvent || (() => {});
    this.onNeedRestart = hooks.onNeedRestart || (() => {});
    this.onDnsAutoEnabled = hooks.onDnsAutoEnabled || (() => {});
    // The current automatic list (site-list.js); the one shipped with the app
    // when there is none.
    this.siteList = hooks.siteList || (() => DEFAULT_SITE_LIST);
    this.lastProbe = null;
    this.proxyOptions = hooks.proxyOptions || {};
    // What the system proxy is doing, for the window: SystemProxy.apply()'s
    // result ({ ok, code: 'ok' | 'partial_env' | 'no_system_proxy' |
    // 'needs_admin' | 'apply_failed' | 'replaced', ... }), or null while
    // protection is off.
    this.onProxyStatus = hooks.onProxyStatus || (() => {});
    this.proxyStatus = null;
    // A macOS restore recoverSync() had to leave for the administrator's
    // password: { declined } for the window, or null (see recoverProxyAsAdmin).
    // proxyRecoveryPending: it is still to be asked for by itself, once.
    this.onProxyRecovery = hooks.onProxyRecovery || (() => {});
    this.proxyRecovery = null;
    this.proxyRecoveryPending = false;
    this._restartTimer = null;
    // Starts, stops and settings restarts run one at a time, in the order they
    // were asked for (_serial); _stops counts the stops asked for and not yet
    // done, during which nothing may point the system at the engine again.
    this._ops = Promise.resolve();
    this._starting = null;
    this._stops = 0;
    this._stopGen = 0;
    // How long after a start a system DNS that answered nothing is looked at again.
    this.dnsRecheckMs = 20000;
    this.proxy = new SystemProxy(this.log, {
      ...this.proxyOptions,
      // Linux desktops without a proxy setting: the PAC's address is written
      // for the next login, so its port is kept from run to run.
      portStore: this.proxyOptions.portStore || { get: () => store.get('pacPort'), set: (p) => store.set('pacPort', p) },
      // Another program took the system proxy over (or gave it back).
      onOwnership: (owned, info) => {
        if (!this.proxyStatus) return;
        const base = this.proxyStatus.replacedFrom || this.proxyStatus;
        this._setProxyStatus(owned ? base : { ...base, ok: false, code: 'replaced', lost: info.lost, replacedFrom: base });
      },
    });
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
    this.unreachable = new Map();  // host -> when it was last logged
    // How many techniques the engine's ladder has; it says so when it starts.
    this.techniques = 0;
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

  /* A stop has been asked for and is not done yet. */
  get stopping() { return this._stops > 0; }

  _serial(fn) {
    const run = this._ops.then(fn);
    this._ops = run.catch(() => {});
    return run;
  }

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
      siteList: Families.expand(withDiscord(Array.isArray(s.siteList) ? s.siteList : this.siteList())),
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

  /* What is actually deciding how connections are made. With auto mode the
   * engine's ladder picks a technique per site and the configured strategy is
   * not used at all, so naming it ("split(sni) + auto") said something untrue. */
  _strategyLabel(cfg) {
    if (!cfg.autoProbe) return cfg.strategy;
    return this.techniques ? `auto, ${this.techniques} techniques` : 'auto';
  }

  /* A host the engine could not connect to at all: its name did not resolve,
   * or none of its addresses answered. Not censorship as far as we can tell,
   * but without this line the log has nothing to say when a site does not
   * load. Once per host every few minutes. */
  _onUnreachable(host, stage) {
    if (!host) return;
    const now = Date.now();
    const last = this.unreachable.get(host);
    if (last && now - last < UNREACHABLE_REPEAT_MS) return;
    if (this.unreachable.size > 400) this.unreachable.clear();
    this.unreachable.set(host, now);
    this.log('warning', `${host}: could not be reached (${stage === 'dns' ? 'DNS' : 'connection'})`);
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

  /* Asked again while a start is under way (the automatic start at launch
   * and a click on Start at the same moment): the same start, never a second
   * engine and PAC server. A start asked for after a Stop is a new one, made
   * once that stop is done. */
  start() {
    if (this._starting) return this._starting;
    const p = this._serial(() => this._start());
    this._starting = p;
    const done = () => { if (this._starting === p) this._starting = null; };
    p.then(done, done);
    return p;
  }

  async _start() {
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
    this.unreachable.clear();
    this.cuts.clear();
    this._setAdvice({ cut: null });
    this._describeEnvironment();
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

    let status;
    try {
      // When an engine restart kept the system setting (see _onClose), this
      // only points the PAC at the new port.
      status = await this.proxy.apply(this.port, cfg.routeMode, cfg.siteList);
    } catch (e) {
      this.log('error', `Could not set system proxy: ${e.message}`);
      await this._cleanup();
      throw e;
    }
    // The engine ended while the system was being pointed at it. _onClose
    // had no session to restart then: undo it all and fail this start, never
    // show protection on with no engine behind it.
    if (!this.proc) {
      this.log('error', `Engine exited unexpectedly (code ${this._exitCode ?? '?'}).`);
      await this._cleanup();
      throw new Error(this.lastError || 'The engine exited while starting');
    }
    this._setProxyStatus(status);

    this.active = true;
    this.startedAt = Date.now();
    this.stats.startTime = this.startedAt;
    this.store.set('runtimeActive', true);
    this._startStatsPoll();
    this.onStatusChange(true);
    this.stats.strategy = this._strategyLabel(cfg);
    this.log('success', `Shroudly engine active (strategy: ${this.stats.strategy})`);
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
    // A DNS program on this computer (often left behind by another bypass
    // tool), and a system DNS that answers nothing: both break every program
    // that does not go through Shroudly, while the browser keeps working.
    if (d.localDns && d.localDns.programs && d.localDns.programs.length) {
      this.log('info', `System DNS is a program on this computer: ${d.localDns.programs.join(', ')}`);
    }
    if (d.dnsAsked && d.dnsAnswered === 0) this._recheckDns();

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

  /* The system DNS answered none of the test names at the start. At login
   * that is mostly the network not being up yet (the Wi-Fi connects after
   * Shroudly starts), so it is looked at once more a little later, and said
   * only if the DNS still answers nothing while the network itself is up
   * (diagnostics.dnsDead). */
  _recheckDns() {
    clearTimeout(this._dnsRecheck);
    this._dnsRecheck = setTimeout(async () => {
      if (!this.active) return;
      let dead = false;
      try { dead = await diagnostics.dnsDead(); } catch {}
      if (dead && this.active) {
        this.log('warning', 'The system DNS answered none of the test names. Programs that do not go through Shroudly cannot reach anything; check the DNS program or the network settings.');
      }
    }, this.dnsRecheckMs);
    if (this._dnsRecheck.unref) this._dnsRecheck.unref();
  }

  _onLine(line, finishStart) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.log('info', `engine: ${line}`); return; }
    switch (msg.type) {
      case 'ready':
        this.techniques = Number(msg.techniques) || 0;
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
        // What the filter does is judged from what it did (forged DNS
        // answers, cut connections, silent drops), never from which country
        // the clock is set to.
        try { this.onHostEvent('bypass', msg.host, msg.note || null); } catch {}
        this.blockedHosts.delete(msg.host);
        if (!this.bypassed.has(msg.host)) {
          // One line per site, but the set is only there to stop repeats, so
          // it is capped rather than allowed to track a whole session.
          if (this.bypassed.size > 400) this.bypassed.clear();
          this.bypassed.add(msg.host);
          // A silent drop is a different kind of filter from one that refuses,
          // and worth telling apart when reading a report.
          const how = msg.note === 'silent' ? ' — the network drops these connections silently instead of refusing them' : '';
          this.log('success', `${msg.host}: blocked here, opened with ${msg.strategy} (${msg.attempts} tries, ${msg.family})${how}`);
        }
        break;
      case 'blocked':
        try { this.onHostEvent('blocked', msg.host, msg.note || null); } catch {}
        // Every attempt went unanswered. A filter that drops silently and a
        // server that is down look exactly the same from here, so this is a
        // line in the log, not a notification, and no setting is changed
        // because of it. The engine starts the next connection to this host
        // further along the ladder, so a technique that works is still found.
        if (msg.note === 'silent') {
          if (!this.blockedHosts.has(msg.host)) {
            if (this.blockedHosts.size > 400) this.blockedHosts.clear();
            this.blockedHosts.add(msg.host);
            this.log('warning', `${msg.host}: no answer after ${msg.attempts} techniques (${msg.family}) — the network may be dropping these connections silently, or the site is down`);
          }
          break;
        }
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
        try { this.onHostEvent('cut', msg.host, msg.strategy || null); } catch {}
        this._onCut(msg.host, msg.strategy, msg.attempts);
        break;
      case 'unreachable':
        try { this.onHostEvent('unreachable', msg.host, msg.stage || null); } catch {}
        this._onUnreachable(msg.host, msg.stage);
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
    this._exitCode = code;
    if (this.expectingStop || !wasActive) return;

    this.log('error', `Engine exited unexpectedly (code ${code}).`);
    const retry = this.restarts < MAX_RESTARTS;
    // Restore proxy immediately so the user is never left half-routed —
    // except one set with an administrator's password (macOS Standard
    // account) while the engine is about to come back: taking it down now
    // and setting it again would ask for the password again. It stays, and
    // the restarted engine's port goes into the PAC.
    const kept = retry && this._keepsProxy();
    // Off at once, so nothing points the system at the dead engine while
    // the restore runs (a re-apply, a settings restart).
    this.active = false;
    this._stopStatsPoll();
    const gen = this._stopGen;
    if (!kept) {
      await this.proxy.restore();
      this._setProxyStatus(null);
    }
    this.onStatusChange(false);
    // A Stop pressed while that restore ran: nothing comes back after it.
    if (gen !== this._stopGen) return;

    if (retry) {
      this.restarts++;
      const delay = Math.min(500 * this.restarts, 4000);
      this.log('warning', `Restarting engine in ${delay}ms (attempt ${this.restarts}/${MAX_RESTARTS})`);
      clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        this.start().catch(async (e) => {
          this.log('error', `Restart failed: ${e.message}`);
          // A kept system setting must not outlive an engine that is not
          // coming back.
          if (!this.active && this.proxy.applied) { try { await this.proxy.restore(); } catch {} this._setProxyStatus(null); }
        });
      }, delay);
    } else {
      this.log('error', 'Engine keeps crashing; giving up. Check logs.');
      this.restarts = 0;
    }
  }

  /* Apply changed settings while active: replace the engine process but keep
   * the system proxy pointed at it, so the switch is a brief blip instead of a
   * full proxy off/on cycle. Nothing once a stop is asked for: a settings
   * change and a Stop within a second must end stopped. */
  restart() {
    if (!this.active || this.restarting || this.stopping) return Promise.resolve({ success: true });
    return this._serial(() => this._restart());
  }

  async _restart() {
    if (!this.active || this.restarting || this.stopping) return { success: true };
    const cfg = this._settings();
    // A changed port setting needs a full stop and start; otherwise keep the
    // port this session is actually on (it may be a free one we moved to).
    // A system proxy set with an administrator's password stays through it
    // (see _onClose): only the PAC learns the new port.
    if (cfg.port !== (this.configuredPort || this.port)) {
      await this._stop({ keepProxy: this._keepsProxy() });
      return this._start();
    }
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
      this.stats.strategy = this._strategyLabel(cfg);
      this.log('success', `Settings applied (strategy: ${this.stats.strategy})`);
      return { success: true };
    } finally {
      this.restarting = false;
    }
  }

  /* user: the user switched protection off (window or tray). Only then may a
   * macOS restore ask for the administrator's password, and only then goes
   * what was written for the next login on Linux desktops without a proxy
   * setting; a quit, an update or a restart keeps it (system-proxy.js).
   * keepProxy: an engine restart that keeps an administrator-set proxy.
   * From the moment it is asked for, re-applies, settings restarts and the
   * administrator button do nothing (stopping), and a start still under way
   * finishes first and is then stopped, so it always ends stopped. */
  stop(opts = {}) {
    this._stops++;
    this._stopGen++;
    // A start asked for after this is a new one, and a crash restart still
    // waiting must not undo it.
    this._starting = null;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    const p = this._serial(() => this._stop(opts));
    const done = () => { this._stops--; };
    p.then(done, done);
    return p;
  }

  async _stop({ user = false, keepProxy = false } = {}) {
    if (!this.active && !this.proc) {
      if (!keepProxy) { await this.proxy.restore({ interactive: user }); this._setProxyStatus(null); this._refreshRecovery(); }
      if (user) this._clearProxyEnv();
      return { success: true };
    }
    this.expectingStop = true;
    this._stopStatsPoll();

    // Restore proxy first so traffic goes direct the instant we stop.
    let restored = true;
    if (!keepProxy) {
      restored = (await this.proxy.restore({ interactive: user })) !== false;
      this._setProxyStatus(null);
    }
    if (user) this._clearProxyEnv();

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
    if (!keepProxy) {
      // Only said restored when it was (the proxy has said what was not).
      this.log('success', restored ? 'Shroudly engine stopped; system restored' : 'Shroudly engine stopped');
      // A restore whose password dialog was dismissed: the window offers it.
      this._refreshRecovery();
    }
    return { success: true };
  }

  /* Is the system proxy one set with an administrator's password, which an
   * engine restart should leave in place? */
  _keepsProxy() {
    return !!(this.proxyStatus && this.proxyStatus.admin && this.proxy.applied && typeof this.proxy.updatePort === 'function');
  }

  _clearProxyEnv() {
    try { if (typeof this.proxy.clearEnv === 'function') this.proxy.clearEnv(); } catch {}
  }

  /* Re-apply the system proxy with the current route mode / site list, without
   * restarting the engine. Used when the user changes those settings. */
  /* The automatic site list changed: serve it from the PAC in place. */
  updateSiteList() {
    if (!this.active) return false;
    return this.proxy.updateList(this._settings().siteList);
  }

  /* Also the window's "Set Shroudly again" after another program took the
   * system proxy over. Resolves to { success, status }: the status it ends
   * with, null when protection went off meanwhile. */
  async reapplyProxy() {
    // Not while protection is off or on its way off (a Stop pressed within a
    // second of a settings change): a re-apply finishing after the Stop would
    // point the system at an engine that is gone.
    if (!this._live()) return { success: true, status: null };
    const cfg = this._settings();
    const st = this.proxyStatus;
    const replaced = !!(st && st.code === 'replaced');
    try {
      // Set with an administrator's password (macOS) and still ours: the
      // system already points at our PAC, and re-applying would ask for the
      // password again, so only the PAC's answer changes. Taken over by
      // another program, it has to be set again, password and all.
      if (st && st.admin && !replaced && this.proxy.updateRouting &&
          this.proxy.updateRouting(cfg.routeMode, cfg.siteList)) {
        this.log('success', 'Proxy routing updated');
        return { success: true, status: st };
      }
      await this.proxy.restore();                       // back to the user's own settings
      let status = this._live() ? await this.proxy.apply(this.port, cfg.routeMode, cfg.siteList) : null;
      if (status && replaced && st.admin && status.code === 'needs_admin' && this.proxy.applyAsAdmin && this._live()) {
        status = await this.proxy.applyAsAdmin();
      }
      // Stopped meanwhile: that stop's restore runs after this one's apply
      // (the proxy makes one change at a time), and its status stands.
      if (!status || status.code === 'not_active' || !this._live()) return { success: true, status: null };
      this._setProxyStatus(status);
      if (status.ok || !replaced) this.log('success', 'Proxy routing updated');
      return { success: true, status };
    } catch (e) {
      this.log('error', `Could not update proxy routing: ${e.message}`);
      return { success: false, status: this.proxyStatus };
    }
  }

  /* Protection is on, and no stop is on its way. */
  _live() { return this.active && !this.stopping; }

  _setProxyStatus(status) {
    this.proxyStatus = status || null;
    try { this.onProxyStatus(this.proxyStatus); } catch {}
  }

  /* macOS Standard account ('needs_admin'): set the system proxy with an
   * administrator's password, asked for by the system's own dialog. For a
   * button in the window; resolves to the new status (code 'ok', 'cancelled'
   * or 'needs_admin'). */
  async applyProxyAsAdmin() {
    if (!this._live() || !this.proxy.applyAsAdmin) return { ok: false, code: 'not_active' };
    const status = await this.proxy.applyAsAdmin();
    // Protection was stopped (and maybe started again) while the dialog was
    // open: that answer belongs to no session that is still running.
    if (!this._live() || !status || status.code === 'not_active') return status || { ok: false, code: 'not_active' };
    this._setProxyStatus(status);
    return status;
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
    this._setProxyStatus(null);
    this.active = false;
  }

  // Synchronous last-resort cleanup on hard exit.
  cleanupSync() {
    try { if (this.proc) this.proc.kill(); } catch {}
    try { this.doh.stop(); } catch {}
    try { this.proxy.restoreSync(); } catch {}
  }

  /* protectionOn: whether protection is about to start (the user left it
   * on). When it is off, what was written for the next login on Linux
   * desktops without a proxy setting goes too. */
  async recover({ protectionOn } = {}) {
    // A previous run that never restored the proxy (crash, kill, power loss)
    // left a state file with the user's settings: put them back. 2.0.0 left
    // only the runtimeActive flag, so fall back to switching its proxy off.
    // The app's own start waits only briefly for a macOS root helper, and
    // never asks for a password here, before there is a window.
    let restored = false;
    try { restored = SystemProxy.recoverSync({ ...this.proxyOptions, helperWaitMs: 3000 }, this.log); } catch {}
    // 'kept': ours, still set, waiting for an administrator's password. Not
    // 2.0.0's leftover: switching it off blindly would lose the user's own
    // setting recorded with it.
    this.proxyRecovery = restored === 'kept' ? SystemProxy.pendingAdminRecovery(this.proxyOptions) : null;
    this.proxyRecoveryPending = !!(this.proxyRecovery && !this.proxyRecovery.declined);
    if (!restored && this.store.get('runtimeActive')) {
      this.log('info', 'Recovering: restoring proxy from previous session');
      try { SystemProxy.resetLegacySync(this.log); } catch {}
    }
    if (protectionOn === false) { try { SystemProxy.clearEnvSync(this.proxyOptions, this.log); } catch {} }
    this.store.set('runtimeActive', false);
  }

  /* With protection staying off: finish a macOS restore that needs the
   * administrator's password (one dialog, in one process; see
   * SystemProxy.recoverAsAdmin). When protection starts instead, apply()
   * carries the recorded settings over and its own password request covers
   * both.
   * By itself (user false) it asks once per run, and only with the window on
   * screen (windowShown): never from the tray alone, where a dialog out of
   * nowhere is all the user would see. Once they have dismissed it, only
   * the window's button (user true) asks again. */
  async recoverProxyAsAdmin({ user = false, windowShown = true } = {}) {
    if (!this.proxyRecovery) return false;
    if (!user && (!this.proxyRecoveryPending || this.proxyRecovery.declined || !windowShown)) return false;
    this.proxyRecoveryPending = false;
    let done = false;
    try { done = await SystemProxy.recoverAsAdmin({ ...this.proxyOptions, userAsked: user }, this.log); } catch {}
    this._refreshRecovery(done);
    return done;
  }

  /* What the window shows about it: still waiting (declined or not), or done. */
  _refreshRecovery(done = false) {
    const next = done ? null : SystemProxy.pendingAdminRecovery(this.proxyOptions);
    if (JSON.stringify(next) === JSON.stringify(this.proxyRecovery)) return;
    this.proxyRecovery = next;
    try { this.onProxyRecovery(next); } catch {}
  }
}

module.exports = EngineManager;
module.exports.coreBinaryPath = coreBinaryPath;
module.exports.DEFAULT_SITE_LIST = DEFAULT_SITE_LIST;
