'use strict';

/*
 * Programs that go around Shroudly and that this network stops: a bot on
 * Node or Python, a command-line tool, a game's launcher. They read neither
 * the system proxy nor, many of them, HTTPS_PROXY (Games and apps mode), so
 * the engine never sees them and nothing it says shows them stuck. Their
 * connections, in the system's table, do (procnet.outbound). One is stopped
 * when it connects to:
 *  - an address this network's DNS gives instead of the real one: a block
 *    page the start-up check saw it answer with (diagnostics' forged
 *    answers; public ones only, a private one may be the router), or a
 *    censor's known one (censor-fingerprints.js). It asked the network's
 *    DNS and was sent to the censor;
 *    A program that failed at once there (the block page's certificate is
 *    not the site's) has already closed its connection when it is looked
 *    at; the closed connection (TIME_WAIT) stays a minute or two, held by
 *    no process: it counts too, the program unnamed. Nothing of Shroudly's
 *    ever connects to such an address (the engine refuses those answers);
 *  - a real address of a name this network stops at the handshake: a
 *    service the autopilot found blocked so (blockcheck: a direct handshake
 *    fails where the same name works through Shroudly), or a site the
 *    engine needed a technique for, found no technique for, or saw cut, or
 *    a service's own name (a bot's computer need not have the service's
 *    app), checked the same way the first time a program goes to one of
 *    its addresses. The addresses are the ones Shroudly's encrypted DNS
 *    gives (asking the network's DNS about every such site would tell it
 *    what encrypted DNS hides). A name blocked only by DNS does not count
 *    here: at its real address a program gets through (and where it asked
 *    the network's DNS, it is at the block page, above). Only a connection
 *    a program holds counts here: a closed one may have been the engine's.
 * A program whose connection the network resets at the handshake holds it a
 * few milliseconds and leaves nothing in the connection table; what stays,
 * for minutes, is the name it looked up through the system's DNS (Windows'
 * DNS cache, procnet.dnsCache: Shroudly's own lookups go over encrypted DNS,
 * and the engine says when it asks the system's itself, "netdns"). A
 * service's name, or a site the engine told about, in that cache and found
 * blocked here (by DNS or at the handshake: the program has whichever
 * address the system's DNS gave) counts as well (issue #48: Serein, a Rust
 * Discord client, reset at every handshake). The program is named where it
 * still holds a connection to one of the name's addresses; a service's own
 * programs, while its mode is on, may have looked it up (its updater), so
 * an unnamed lookup of its names does not count then. The cache is looked
 * at once a minute even on a network that shows no filter yet.
 *
 * Either way Advanced mode is what makes it work: its DNS gate answers the
 * program's own lookups from the encrypted-DNS forwarder, and its decoys go
 * ahead of every connection, whoever makes it. The autopilot asks for it by
 * its usual rules (needAdvanced: once a session, never beside a game's
 * anti-cheat, not for two weeks once declined, not once turned off by
 * hand), naming the program, and says so in one line.
 *
 * Not counted: Shroudly's own processes (the engine connects to those very
 * addresses for every app it carries), and the programs of a service whose
 * own mode is on (Discord's, Roblox's: that mode and its watcher see to
 * them). Looked for every LOOK_MS while Advanced mode is available and off
 * and the autopilot would still ask for it, or say why it does not
 * (autopilot.advancedPending), and only on a network that shows a filter
 * (forged DNS seen at the start, a service found blocked, a site the
 * engine told about): elsewhere the system's table is not read at all.
 */

const dns = require('dns');
const net = require('net');
const fingerprints = require('./censor-fingerprints');
const { familyOf } = require('./autopilot');

const LOOK_MS = 15 * 1000;
// A name's addresses are asked of the system's DNS again after this long (a
// CDN moves a name between addresses).
const RESOLVE_MS = 10 * 60 * 1000;
const RESOLVE_WAIT_MS = 2500;
// The sites the engine told about lately, matched against: the latest ones.
const NOTED_MAX = 32;
// A site found not stopped at the handshake is not checked again for this
// long on the same network.
const CLEAR_MS = 6 * 60 * 60 * 1000;
// Checks of sites (each a few handshakes) in one look, at most.
const CHECKS_PER_LOOK = 2;
// The DNS cache on a network that shows no filter yet: this often.
const CACHE_EVERY_MS = 60 * 1000;

/* The names of a service a program of its own connects to (its API, its
 * gateway, its files); their addresses count once the autopilot found the
 * service blocked at the handshake. */
const SERVICE_NAMES = {
  discord: ['discord.com', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net', 'discordapp.com'],
  roblox: ['www.roblox.com', 'apis.roblox.com', 'clientsettingscdn.roblox.com', 'auth.roblox.com'],
};

/* A service's own programs, by the name the system gives them, and the mode
 * that carries them. */
const SERVICE_PROGRAMS = [
  { mode: 'discordMode', name: /^(discord|discordptb|discordcanary|discorddevelopment|update)(\.exe)?$/i },
  { mode: 'appMode', name: /^roblox/i },
];

const plain = (ip) => String(ip || '').toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
const norm = (host) => String(host || '').toLowerCase().replace(/\.$/, '');

/* An address on the internet, not on this computer or the local network. */
function isPublic(ip) {
  const a = plain(ip);
  const v = net.isIP(a);
  if (v === 4) {
    const [x, y] = a.split('.').map(Number);
    return !(x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 192 && y === 168)
      || (x === 172 && y >= 16 && y <= 31) || (x === 100 && y >= 64 && y <= 127));
  }
  if (v === 6) return !(a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a));
  return false;
}

/* A name's addresses from the DNS server at 127.0.0.1:port (the encrypted-
 * DNS forwarder), IPv4 and IPv6: [] when nothing in time. */
function addrsVia(port) {
  return (name) => {
    const r = new dns.promises.Resolver({ timeout: RESOLVE_WAIT_MS, tries: 1 });
    r.setServers([`127.0.0.1:${port}`]);
    const one = (p) => p.catch(() => []);
    return Promise.all([one(r.resolve4(name)), one(r.resolve6(name))]).then(([a, b]) => [...a, ...b]);
  };
}

class AroundWatch {
  /*
   * opts.wanted()            whether to look now
   * opts.connections(want)   procnet.outbound
   * opts.resolve(name)       the addresses encrypted DNS gives for name
   * opts.check(name)         blockcheck, through the engine
   * opts.blockedServices()   autopilot.blockedAtHandshake()
   * opts.modeOn(mode)        whether a mode is on
   * opts.ownPids()           Shroudly's processes (the app, the engine)
   * opts.need(host, opts)    autopilot.needAdvanced
   * opts.dnsCache()          procnet.dnsCache: name -> [addresses]
   * opts.log(level, msg), opts.now()
   */
  constructor(opts) {
    this.wanted = opts.wanted || (() => false);
    this.connections = opts.connections || (async () => []);
    this.resolve = opts.resolve || (async () => []);
    this.check = opts.check || (async () => null);
    this.blockedServices = opts.blockedServices || (() => []);
    this.modeOn = opts.modeOn || (() => false);
    this.ownPids = opts.ownPids || (() => []);
    this.need = opts.need || (async () => false);
    this.dnsCache = opts.dnsCache || (async () => new Map());
    this.log = opts.log || (() => {});
    this.now = opts.now || Date.now;
    // Address -> the name this network's DNS gave it for (null: a censor's
    // known address).
    this.forgedAt = new Map(fingerprints.ALL.map((ip) => [ip, null]));
    this.noted = new Map();     // site -> when the engine last told it
    this.addrs = new Map();     // name -> { list, at }
    this.verdicts = new Map();  // site -> { blocked, stopped (at the handshake), at }
    this.selfAsked = new Map(); // sites the engine asked the system's DNS about itself
    this.lastCache = -Infinity; // when the DNS cache was last looked at
    this.forgedSeen = false;    // the start-up check saw forged answers
    this.gen = 0;
    this.busy = false;
  }

  /* The start-up check's forged answers (diagnostics: [{ host, addrs }]). */
  forged(hits) {
    for (const h of hits || []) {
      if ((h.addrs || []).length) this.forgedSeen = true;
      for (const ip of h.addrs || []) if (isPublic(ip)) this.forgedAt.set(plain(ip), norm(h.host));
    }
  }

  /* Whether this network shows a filter at all. */
  _filtered() { return this.forgedSeen || this.noted.size > 0 || this.blockedServices().length > 0; }

  /* An engine event about a site (engine-manager's onHostEvent): one that
   * needed a technique, that no technique opened, or that is cut after it
   * connects. */
  note(kind, host, info) {
    info = info || {};
    if (kind === 'netdns') { const s = norm(host); if (s) this.selfAsked.set(s, this.now()); return; }
    const real = kind === 'bypass' || (kind === 'blocked' && !info.alert && !info.siteOk) || (kind === 'cut' && info.believed === true);
    const h = norm(host);
    if (!real || !h || net.isIP(h)) return;
    this.noted.delete(h);
    this.noted.set(h, this.now());
    while (this.noted.size > NOTED_MAX) this.noted.delete(this.noted.keys().next().value);
  }

  /* A different network: what was learnt about the last one does not hold.
   * (A block page's address stays one.) */
  networkChanged() {
    this.gen++;
    this.noted.clear();
    this.addrs.clear();
    this.verdicts.clear();
    this.selfAsked.clear();
  }

  async _addressesOf(name) {
    const c = this.addrs.get(name);
    if (c && this.now() - c.at < RESOLVE_MS) return c.list;
    let list = [];
    try { list = (await this.resolve(name)) || []; } catch {}
    list = list.map(plain).filter(isPublic);
    this.addrs.set(name, { list, at: this.now() });
    return list;
  }

  /* Every address worth a look: address -> { name, kind: 'dns' (a block
   * page), 'service' (a blocked service's) or 'site' (to be checked) }. */
  async _watched() {
    const out = new Map();
    for (const [ip, name] of this.forgedAt) out.set(ip, { name: name || null, kind: 'dns' });
    const blocked = this.blockedServices();
    const services = blocked.flatMap((id) => SERVICE_NAMES[id] || []);
    const others = Object.entries(SERVICE_NAMES).filter(([id]) => !blocked.includes(id)).flatMap(([, n]) => n);
    const sites = [...new Set([...this.noted.keys(), ...others])].filter((h) => !services.includes(h)).filter((h) => {
      const v = this.verdicts.get(h);
      return !v || v.stopped || this.now() - v.at >= CLEAR_MS;
    });
    const lists = await Promise.all([...services, ...sites].map((n) => this._addressesOf(n)));
    [...services, ...sites].forEach((name, i) => {
      const kind = i < services.length ? 'service' : 'site';
      for (const ip of lists[i]) if (!out.has(ip)) out.set(ip, { name, kind });
    });
    return out;
  }

  /* What blocks a site on this network: { blocked, stopped (at the
   * handshake) }, and whether it was checked just now; null when nothing
   * could be learnt (offline, say: not kept). Checked once, again only
   * after CLEAR_MS of "not stopped". */
  async _verdict(name) {
    const v = this.verdicts.get(name);
    if (v && !this._due(name)) return { v, fresh: false };
    let r = null;
    try { r = await this.check(name); } catch {}
    if (!r || r.unknown) return null;
    const nv = { blocked: !!r.blocked, stopped: !!r.blocked && r.how === 'tls', at: this.now() };
    this.verdicts.set(name, nv);
    return { v: nv, fresh: true };
  }

  /* Is a site stopped at the handshake on this network (a program at its
   * real address is)? */
  async _stopped(name) {
    const got = await this._verdict(name);
    if (!got) return false;
    if (!got.v.stopped && got.fresh) this.log('info', `Autopilot: a program reaches ${name} directly, around Shroudly; ${got.v.blocked ? 'only its DNS is blocked on this network, and the program has the real address' : 'it is not blocked on this network'}`);
    return got.v.stopped;
  }

  /* A name worth finding in the DNS cache: a service's, or a site the
   * engine told about (or one under it, or above it). */
  _lookedFor(name) {
    if (familyOf(name)) return true;
    if (this.noted.has(name)) return true;
    for (const h of this.noted.keys()) if (name.endsWith(`.${h}`) || h.endsWith(`.${name}`)) return true;
    return false;
  }

  /* The engine asked the system's DNS about this name's site itself. */
  _askedBySelf(name) {
    for (const s of this.selfAsked.keys()) if (name === s || name.endsWith(`.${s}`)) return true;
    return false;
  }

  _ours(row, own) {
    if (own.has(row.pid) || /^shroudly/i.test(row.name || '')) return true;
    return SERVICE_PROGRAMS.some((p) => p.name.test(row.name || '') && this.modeOn(p.mode));
  }

  /* Whether a site's verdict is due (none yet, or an old "not stopped"). */
  _due(name) {
    const v = this.verdicts.get(name);
    return !v || (!v.stopped && this.now() - v.at >= CLEAR_MS);
  }

  /* The names in the system's DNS cache that a program looked up itself,
   * around Shroudly, and that this network blocks: Advanced mode asked for,
   * naming the program where it still holds a connection to one of the
   * name's addresses. Resolves whether it is on now, or null when nothing
   * was found. */
  async _lookedUp(gen, own, checks) {
    this.lastCache = this.now();
    let cache = new Map();
    try { cache = await this.dnsCache(); } catch {}
    for (const [raw, addrs] of cache) {
      const name = norm(raw);
      if (!this._lookedFor(name) || this._askedBySelf(name)) continue;
      const due = this._due(name);
      if (due && checks.n >= CHECKS_PER_LOOK) continue;
      if (due) checks.n++;
      const got = await this._verdict(name);
      if (!got || !got.v.blocked) continue;
      if (gen !== this.gen || !this.wanted()) return false;
      const list = (addrs || []).map(plain);
      let held = [];
      if (list.length) {
        try { held = (await this.connections((ip) => list.includes(plain(ip)))).filter((r) => r.pid > 0 && !this._ours(r, own)); } catch {}
      }
      if (held.length) return this._ask(held[0], plain(held[0].remote.host), { name, kind: 'site' });
      const fam = familyOf(name);
      const mode = fam === 'discord' ? 'discordMode' : fam === 'roblox' ? 'appMode' : null;
      if (mode && this.modeOn(mode)) continue;
      return this.need(name, {
        why: `a program looked ${name} up itself, around Shroudly, and this network blocks it`,
        label: name,
        told: { ask: 'autoAroundAskHost', on: 'autoAroundOnAny', params: { host: name } },
      });
    }
    return null;
  }

  /* One look: the first program found stopped gets Advanced mode asked for
   * (one it names first). Resolves whether it is on now. */
  async look() {
    if (this.busy || !this.wanted()) return false;
    const filtered = this._filtered();
    // No filter seen yet: only the DNS cache, once a minute (cheap).
    if (!filtered && this.now() - this.lastCache < CACHE_EVERY_MS) return false;
    this.busy = true;
    try {
      const gen = this.gen;
      const own = new Set(this.ownPids().filter(Boolean).map(Number));
      if (!filtered) return !!(await this._lookedUp(gen, own, { n: 0 }));
      const watched = await this._watched();
      if (gen !== this.gen || !this.wanted()) return false;
      const rows = (await this.connections((ip) => watched.has(plain(ip)))).sort((a, b) => (b.pid > 0) - (a.pid > 0));
      let checks = 0;
      for (const row of rows) {
        if (row.pid > 0 && this._ours(row, own)) continue;
        const ip = plain(row.remote.host);
        const hit = watched.get(ip);
        if (!hit || (!(row.pid > 0) && hit.kind !== 'dns')) continue;
        if (hit.kind === 'site') {
          const due = this._due(hit.name);
          if (due && checks >= CHECKS_PER_LOOK) continue;
          if (due) checks++;
          if (!(await this._stopped(hit.name))) continue;
        }
        if (gen !== this.gen || !this.wanted()) return false;
        return await this._ask(row, ip, hit);
      }
      if (gen !== this.gen || !this.wanted()) return false;
      return !!(await this._lookedUp(gen, own, { n: checks }));
    } finally { this.busy = false; }
  }

  _ask(row, ip, hit) {
    const where = hit.kind === 'dns'
      ? `and this network's DNS sent it to a block page (${ip}${hit.name ? ` for ${hit.name}` : ''})`
      : `straight to ${hit.name} (${ip}), which this network stops at the handshake`;
    // Gone already (a closed connection): what it was sent to is named.
    if (!(row.pid > 0)) {
      const what = hit.name || ip;
      return this.need(what, { why: `a program goes around Shroudly, ${where}`, label: what, told: { ask: 'autoAroundAskAny', on: 'autoAroundOnAny', params: {} } });
    }
    const program = row.name || `PID ${row.pid}`;
    return this.need(program, { why: `it goes around Shroudly, ${where}`, label: program, told: { ask: 'autoAroundAsk', on: 'autoAroundOn', params: { program } } });
  }
}

module.exports = AroundWatch;
module.exports.LOOK_MS = LOOK_MS;
module.exports.CLEAR_MS = CLEAR_MS;
module.exports.SERVICE_NAMES = SERVICE_NAMES;
module.exports.isPublic = isPublic;
module.exports.addrsVia = addrsVia;
