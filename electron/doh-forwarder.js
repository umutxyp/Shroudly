'use strict';

/*
 * Local DNS-over-HTTPS forwarder.
 *
 * Listens for ordinary DNS queries on 127.0.0.1:<port> (UDP) and answers them
 * over real RFC 8484 DoH. The engine's resolver (core/src/doh.c) sends its
 * queries here when the app passes --doh-port, so DNS resolution is encrypted
 * and cannot be read or forged on the wire.
 *
 * Censors block encrypted DNS too, so it has to survive that, and keep
 * surviving as their lists change. No single resolver can be relied on; what
 * lasts is many routes of different kinds, and choosing among them by what
 * actually works on this network right now:
 *
 *   - by address, with no name in the handshake: six operators, two
 *     addresses each. There is no name for a filter to read; it has to know
 *     and block every address.
 *   - by name, through the engine, on addresses shared with a large part of
 *     the web (Cloudflare's front end): the name is split like any other, and
 *     blocking the address would block millions of ordinary sites with it.
 *
 * Every route is HTTP/2 (some resolvers accept nothing else), keeps one
 * multiplexed connection, and has a health record: routes that fail are
 * rested with a growing back-off and tried again later, fast ones go first,
 * and the last one that worked is remembered across restarts. Lookups race
 * the best route alone, then the next two, then three more at a time until
 * one answers: never every route at once, which on a congested link (many
 * computers behind one small router) only makes the congestion worse.
 *
 * A rest is for a route that does not work here, not for a moment when
 * nothing does. So one outage counts once against a route however many
 * lookups were waiting on it, a route that answered lately rests only
 * briefly, resting routes are still asked after the awake ones (not instead
 * of an answer), and a new start begins with a clean record. Without that a
 * blip of a second during a busy page rested the best routes for minutes,
 * and the routes left awake were the ones this network blocks: lookups
 * failed long after the network was back.
 *
 * Speed matters as much as privacy: a lookup that takes too long is
 * indistinguishable from a broken one, and the engine would fall back to plain
 * DNS, which is exactly what censors forge. Answers are cached for their TTL.
 *
 * Nothing is logged or stored: a query comes in, a DoH request goes out, the
 * answer goes back.
 */

const dgram = require('dgram');
const http2 = require('http2');
const net = require('net');
const tls = require('tls');

const CF = ['cloudflare-dns.com', 'one.one.one.one'];
const UPSTREAMS = [
  { id: 'cloudflare-1', op: 'cloudflare', ip: '1.1.1.1', names: CF },
  { id: 'google-1', op: 'google', ip: '8.8.8.8', names: ['dns.google'] },
  { id: 'quad9-1', op: 'quad9', ip: '9.9.9.9', names: ['dns.quad9.net'] },
  { id: 'adguard-1', op: 'adguard', ip: '94.140.14.140', names: ['unfiltered.adguard-dns.com', 'dns.adguard-dns.com'] },
  { id: 'opendns-1', op: 'opendns', ip: '208.67.222.222', names: ['doh.opendns.com', 'dns.opendns.com'] },
  { id: 'dnssb-1', op: 'dnssb', ip: '185.222.222.222', names: ['doh.sb', 'dns.sb'] },
  { id: 'cloudflare-2', op: 'cloudflare', ip: '1.0.0.1', names: CF },
  { id: 'google-2', op: 'google', ip: '8.8.4.4', names: ['dns.google'] },
  { id: 'quad9-2', op: 'quad9', ip: '149.112.112.112', names: ['dns.quad9.net'] },
  { id: 'adguard-2', op: 'adguard', ip: '94.140.14.141', names: ['unfiltered.adguard-dns.com', 'dns.adguard-dns.com'] },
  { id: 'opendns-2', op: 'opendns', ip: '208.67.220.220', names: ['doh.opendns.com', 'dns.opendns.com'] },
  { id: 'dnssb-2', op: 'dnssb', ip: '45.11.45.11', names: ['doh.sb', 'dns.sb'] },
  { id: 'cloudflare-3', op: 'cloudflare', ip: '162.159.36.1', names: CF },
  { id: 'cloudflare-4', op: 'cloudflare', ip: '162.159.46.1', names: CF },
  // By name, through the engine.
  { id: 'cloudflare-front-1', op: 'cloudflare-front', ip: '104.16.248.249', sni: 'cloudflare-dns.com', viaEngine: true },
  { id: 'cloudflare-front-2', op: 'cloudflare-front', ip: '104.16.249.249', sni: 'cloudflare-dns.com', viaEngine: true },
  { id: 'mullvad', op: 'mullvad', ip: '194.242.2.2', sni: 'dns.mullvad.net', viaEngine: true },
];

const QUERY_TIMEOUT_MS = 2500;  // per route; they are raced, not chained
const SECOND_WAVE_MS   = 250;   // the best route goes alone this long
const THIRD_WAVE_MS    = 900;   // then the next two; then three more at a time
const WAVE_SIZE        = 3;
const NEXT_WAVE_MS     = 650;   // between those later waves
const REST_BASE_MS     = 2000;  // a failing route rests 2 s, 4 s, 8 s ... 5 min
const REST_MAX_MS      = 300000;
const PROVEN_MS        = 600000; // a route that answered within this long ...
const REST_PROVEN_MS   = 20000;  // ... rests at most this long: its failure is more likely the network's
const DOWN_AFTER_MS    = 10000;  // lookups failing for this long, with no answer between: blocked
const WARM_INTERVAL_MS = 120000;
// The user's own server (setCustom) not answering twice in a row: the
// built-in routes answer for this long before it is asked again.
const CUSTOM_REST_MS = 30000;
const CUSTOM_TELL_MS = 10 * 60 * 1000;
// Two failures further apart than this, with nothing failing between (a warm
// round that no route answered counts), are not one streak: the computer
// slept, or nothing was looked up. Longer than the warm interval, so a real
// block with few lookups still adds up.
const STREAK_GAP_MS    = WARM_INTERVAL_MS + 30000;
const SESSION_IDLE_MS  = 300000;
// Just after the computer wakes up its network is still coming back: lookups
// failing then are no sign that encrypted DNS is blocked (see resumed()).
const WAKE_QUIET_MS    = 30000;
const CACHE_MAX        = 1500;
const TTL_MIN_S        = 20;
const TTL_MAX_S        = 3600;

function certCoversIp(cert, ip) {
  // subjectaltname like "DNS:cloudflare-dns.com, IP Address:1.1.1.1"
  const san = cert && cert.subjectaltname;
  if (!san) return false;
  return san.split(',').map((x) => x.trim()).some((e) => e === `IP Address:${ip}`);
}

/* The certificate has to be the resolver's: its own address, or one of the
 * names it is known by. (Without a name in the handshake the standard check
 * has nothing to compare, so it is done here.) */
function identityCheck(up) {
  return (_host, cert) => {
    if (!up.sni && certCoversIp(cert, up.ip)) return undefined;
    for (const n of (up.sni ? [up.sni] : up.names)) {
      if (!tls.checkServerIdentity(n, cert)) return undefined;
    }
    return new Error(`certificate does not belong to ${up.sni || up.ip}`);
  };
}

/* A connection to `ip:port` through the engine's SOCKS5 port. The address is
 * given as an IP, so the engine needs no DNS of its own for it. */
function socksConnect(socksPort, ip, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: socksPort });
    const fail = (e) => { s.destroy(); reject(e); };
    s.setTimeout(QUERY_TIMEOUT_MS, () => fail(new Error('SOCKS timeout')));
    s.once('error', fail);
    let stage = 0; let buf = Buffer.alloc(0);
    s.once('connect', () => s.write(Buffer.from([5, 1, 0])));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('SOCKS refused'));
        buf = buf.subarray(2); stage = 1;
        s.write(Buffer.from([5, 1, 0, 1, ...ip.split('.').map(Number), port >> 8, port & 255]));
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(new Error(`SOCKS connect failed (${buf[1]})`));
        const need = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
        if (buf.length < need) return;
        s.removeListener('data', onData); s.removeListener('error', fail); s.setTimeout(0);
        resolve(s);
      }
    };
    s.on('data', onData);
  });
}

/* ── DNS message helpers ───────────────────────────────────────────────── */

// Question name + type, used as the cache key. Returns null if unparseable.
function questionKey(msg) {
  try {
    if (msg.length < 13 || ((msg[2] >> 3) & 0x0f) !== 0) return null; // standard query only
    if (msg.readUInt16BE(4) !== 1) return null;                       // exactly one question
    let p = 12;
    const parts = [];
    while (p < msg.length) {
      const len = msg[p];
      if (len === 0) { p += 1; break; }
      if (len & 0xc0) return null;            // no compression in a question
      parts.push(msg.toString('latin1', p + 1, p + 1 + len).toLowerCase());
      p += 1 + len;
    }
    if (p + 4 > msg.length) return null;
    return `${parts.join('.')}|${msg.readUInt16BE(p)}`;   // name|qtype
  } catch { return null; }
}

// "Server failure" (SERVFAIL) for a query: its header and question, with
// recursion available. null if the question cannot be read.
function failReply(msg) {
  if (!questionKey(msg)) return null;
  let p = 12;
  while (msg[p]) p += 1 + msg[p];
  const out = Buffer.from(msg.subarray(0, p + 5));
  out[2] = 0x80 | (out[2] & 0x79);   // a response; opcode, RD kept; AA, TC off
  out[3] = 0x82;                      // RA, SERVFAIL
  out.writeUInt16BE(1, 4); out.fill(0, 6, 12);
  return out;
}

// Smallest TTL in the answer, so the cache expires when DNS says it should.
function answerTtlSeconds(msg) {
  try {
    if (msg.length < 12) return null;
    if ((msg[3] & 0x0f) !== 0) return null;          // only cache RCODE 0
    const qd = msg.readUInt16BE(4), an = msg.readUInt16BE(6);
    if (an === 0) return null;
    let p = 12;
    const skipName = () => {
      while (p < msg.length) {
        const len = msg[p];
        if (len === 0) { p += 1; return true; }
        if (len & 0xc0) { p += 2; return true; }     // compression pointer
        p += 1 + len;
      }
      return false;
    };
    for (let i = 0; i < qd; i++) { if (!skipName()) return null; p += 4; }
    let min = Infinity;
    for (let i = 0; i < an; i++) {
      if (!skipName()) return null;
      if (p + 10 > msg.length) return null;
      const ttl = msg.readUInt32BE(p + 4);
      const rdlen = msg.readUInt16BE(p + 8);
      p += 10 + rdlen;
      if (ttl < min) min = ttl;
    }
    if (!isFinite(min)) return null;
    return Math.max(TTL_MIN_S, Math.min(TTL_MAX_S, min));
  } catch { return null; }
}

class DohForwarder {
  /* opts.preferredId: the route that worked last time (remembered by the
   *   caller across restarts); opts.onPreferred(id) is told when it changes.
   * opts.onState('ok' | 'down'): encrypted DNS works / is blocked outright:
   *   'down' once lookups have failed for DOWN_AFTER_MS in one streak, with
   *   nothing answered between (see lookupFailed), never for a single blip,
   *   and 'ok' at the next answer. */
  constructor(log, opts = {}) {
    this.log = log || (() => {});
    this.opts = opts;
    this.sock = null;
    this.port = 0;
    this.socksPort = 0;
    this.cache = new Map();     // key -> { answer: Buffer, expires: ms }
    this.warmTimer = null;
    this.stopped = false;
    this.failures = 0;          // lookups in a row that no route could answer
    this.failingSince = 0;      // when the first of them failed
    this.lastFailAt = 0;        // when the streak was last seen still failing
    this.state = 'ok';
    this.lastDowngradeWarn = 0;
    this.preferredId = opts.preferredId || null;
    this.custom = null;         // the user's own server (setCustom), else null
    // fails: failures since it last answered; failAt: when the last one was
    // counted; okAt: when it last answered.
    this.routes = UPSTREAMS.map((u) => ({ ...u, fails: 0, failAt: 0, okAt: 0, restUntil: 0, ewma: 0, session: null, opening: null }));
  }

  /* The engine's port, once it is up: routes that go through it wait for it. */
  setSocksPort(port) { this.socksPort = Number(port) || 0; }

  /* A DNS server of the user's own (custom-dns.js; null: the built-in
   * routes): asked alone while it answers. Its name, if it has one, is
   * looked up through the built-in routes. Answers kept from before are
   * dropped: the user wants this server's. opts.strict: it alone answers,
   * with no fallback when it does not (issue #34: to test a server, and to
   * show no lookup to anyone else). */
  setCustom(spec, opts = {}) {
    if (this.custom) { this.custom.close(); this.custom = null; }
    this.cache.clear();
    if (!spec) return;
    const { CustomDns } = require('./custom-dns');
    this.custom = new CustomDns(spec, {
      socksPort: () => this.socksPort,
      bootstrap: async (name) => require('./custom-dns').firstA(await this.resolveRoutes(buildQuery(name, 1))),
      ...opts,
    });
    this.custom.fails = 0;
    this.custom.restUntil = 0;
    this.custom.toldAt = 0;
    this.custom.strict = !!opts.strict;
  }

  /* Strict: the user's server did not answer, and nothing else is asked;
   * the log says so at most every ten minutes. */
  customFailedStrict(c, e) {
    const now = Date.now();
    if (now - c.toldAt < CUSTOM_TELL_MS) return;
    c.toldAt = now;
    const why = String((e && (e.code || e.message)) || 'no answer').slice(0, 80);
    this.log('warning', `Your DNS server ${require('./custom-dns').shown(c.spec)} does not answer (${why}); it is the only one used, so lookups fail until it answers`);
  }

  /* The user's server did not answer: after the second time in a row it
   * rests, the built-in routes answering meanwhile, and the log says so (at
   * most every ten minutes) rather than every lookup failing or waiting. */
  customFailed(c, e) {
    c.fails++;
    if (c.fails < 2) return;
    const now = Date.now();
    c.restUntil = now + CUSTOM_REST_MS;
    if (now - c.toldAt < CUSTOM_TELL_MS) return;
    c.toldAt = now;
    const why = String((e && (e.code || e.message)) || 'no answer').slice(0, 80);
    this.log('warning', `Your DNS server ${require('./custom-dns').shown(c.spec)} does not answer (${why}); Shroudly's built-in encrypted DNS answers until it does`);
  }

  /* The user's server answers lookups now (set, and not resting). */
  usingCustom() { return !!this.custom && (this.custom.strict || this.custom.restUntil <= Date.now()); }

  customAnswered(c) {
    if (c.toldAt) this.log('success', `Your DNS server ${require('./custom-dns').shown(c.spec)} answers again`);
    c.fails = 0; c.restUntil = 0; c.toldAt = 0;
  }

  usable(r) { return !r.viaEngine || this.socksPort > 0; }

  /* Best first: the remembered route, then measured speed (untried routes
   * count as average), resting routes last. */
  ordered() {
    const now = Date.now();
    this._clockBack(now);
    const score = (r) => (r.restUntil > now ? 1e9 + r.restUntil - now : (r.ewma || 400));
    return this.routes.filter((r) => this.usable(r)).sort((a, b) => {
      if (a.id === this.preferredId && a.restUntil <= now) return -1;
      if (b.id === this.preferredId && b.restUntil <= now) return 1;
      return score(a) - score(b);
    });
  }

  dropSession(r) {
    const sess = r.session;
    r.session = null; r.opening = null;
    if (sess) { try { sess.destroy(); } catch {} }
  }

  /* One HTTP/2 connection per route, opened on demand and reused. */
  session(r) {
    if (r.session && !r.session.closed && !r.session.destroyed) return Promise.resolve(r.session);
    if (r.opening) return r.opening;
    r.opening = (async () => {
      const raw = r.viaEngine ? await socksConnect(this.socksPort, r.ip, 443) : null;
      return new Promise((resolve, reject) => {
        const sock = tls.connect({
          ...(raw ? { socket: raw } : { host: r.ip, port: 443 }),
          servername: r.sni || '',        // no name on the wire unless the route needs one
          ALPNProtocols: ['h2'],
          checkServerIdentity: identityCheck(r),
        });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, QUERY_TIMEOUT_MS);
        sock.once('error', (e) => { clearTimeout(timer); reject(e); });
        sock.once('secureConnect', () => {
          clearTimeout(timer);
          if (sock.alpnProtocol !== 'h2') { sock.destroy(); reject(new Error('no HTTP/2')); return; }
          const sess = http2.connect(`https://${r.sni || r.ip}`, { createConnection: () => sock });
          sess.on('error', () => {});
          sess.on('close', () => { if (r.session === sess) r.session = null; });
          sess.on('goaway', () => { if (r.session === sess) r.session = null; });
          sess.setTimeout(SESSION_IDLE_MS, () => sess.close());
          r.session = sess;
          resolve(sess);
        });
      });
    })().finally(() => { r.opening = null; });
    return r.opening;
  }

  /* One DoH exchange on the route's connection. An error carries the
   * connection it happened on (e.session), so only that one is dropped. */
  async query(r, dnsMsg) {
    const sess = await this.session(r);
    return new Promise((resolve, reject) => {
      const fail = (e) => { e.session = sess; reject(e); };
      let req;
      try {
        req = sess.request({
          ':method': 'POST', ':path': '/dns-query',
          'content-type': 'application/dns-message', accept: 'application/dns-message',
          'content-length': dnsMsg.length,
        });
      } catch (e) { fail(e); return; }
      const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); fail(new Error('timeout')); }, QUERY_TIMEOUT_MS);
      let status = 0; const chunks = [];
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks);
        if (status !== 200 || body.length < 12) fail(new Error(`HTTP ${status}`));
        else resolve(body);
      });
      req.on('error', (e) => { clearTimeout(timer); fail(e); });
      req.end(dnsMsg);
    });
  }

  /* Ask one route, and keep its record. */
  async ask(r, dnsMsg) {
    const t0 = Date.now();
    try {
      const answer = await this.query(r, dnsMsg);
      this.succeeded(r, Date.now() - t0);
      return answer;
    } catch (e) {
      this.failed(r, t0, e && e.session);
      throw e;
    }
  }

  /* Any answer, a warm probe's too, shows encrypted DNS works here: a
   * streak of failed lookups before it is over (see lookupFailed). */
  succeeded(r, ms) {
    r.ewma = r.ewma ? Math.round(r.ewma * 0.7 + ms * 0.3) : ms;
    r.fails = 0; r.restUntil = 0; r.okAt = Date.now();
    this.failures = 0;
    this.failingSince = 0;
  }

  /* A lookup no route could answer. "down" takes a streak of them lasting
   * DOWN_AFTER_MS: never one blip (a busy page has many lookups in flight,
   * and a second without a network failed three of them at once), and never
   * two blips with an answer between them, or with the computer asleep or
   * nothing looked up between (STREAK_GAP_MS): either starts a new streak. */
  lookupFailed(now = Date.now()) {
    this._clockBack(now);
    // Just woken up: the network is not back yet; a streak starts after.
    if (now < (this.quietUntil || 0)) { this.failures = 0; this.failingSince = 0; this.lastFailAt = 0; return; }
    if (!this.failures || now - this.lastFailAt > STREAK_GAP_MS) { this.failures = 0; this.failingSince = now; }
    this.failures++;
    this.lastFailAt = now;
    if (this.failures >= 3 && now - this.failingSince >= DOWN_AFTER_MS) {
      this.setState('down');
      if (now - (this.lastDowngradeWarn || 0) > 300000) {
        this.lastDowngradeWarn = now;
        this.log('warning', 'Encrypted DNS is not reachable on this network; lookups are falling back to ordinary DNS, which your provider can read and change.');
      }
    }
  }

  /* A warm round no route answered: a streak under way is still on, however
   * few lookups there are. One that ended long ago (the computer asleep,
   * warm rounds not running) is not revived: it is over, and the next
   * failed lookup starts a new one. */
  stillFailing(now = Date.now()) {
    if (!this.failures) return;
    if (now - this.lastFailAt > STREAK_GAP_MS) { this.failures = 0; this.failingSince = 0; this.lastFailAt = 0; return; }
    this.lastFailAt = now;
  }

  /* A route failed a request made at `since`. A dead connection fails every
   * request it carries at once, and a connection that could not be opened
   * fails every lookup that waited for it: that is one failure, counted once,
   * not once per lookup (ten lookups in flight used to rest the best route
   * for five minutes after one lost connection). A route that answered
   * lately rests at most REST_PROVEN_MS. Only the connection the request
   * used is dropped, never a newer one another lookup has opened since. */
  failed(r, since = Date.now(), sess = null) {
    if (sess && r.session === sess) this.dropSession(r);
    const now = Date.now();
    this._clockBack(now);
    if (r.failAt && r.failAt >= since) return;
    r.failAt = now;
    r.fails++;
    const cap = r.okAt && now - r.okAt < PROVEN_MS ? REST_PROVEN_MS : REST_MAX_MS;
    r.restUntil = now + Math.min(cap, REST_BASE_MS * 2 ** (r.fails - 1));
  }

  /* Race the routes in waves. The first valid answer wins. */
  resolve(dnsMsg) {
    const c = this.custom;
    if (c && c.strict) {
      return c.query(dnsMsg).then((a) => { this.customAnswered(c); return a; }, (e) => {
        if (this.custom === c) this.customFailedStrict(c, e);
        throw e;
      });
    }
    if (!c || c.restUntil > Date.now()) return this.resolveRoutes(dnsMsg);
    return c.query(dnsMsg).then((a) => { this.customAnswered(c); return a; }, (e) => {
      if (this.custom === c) this.customFailed(c, e);
      return this.resolveRoutes(dnsMsg);
    });
  }

  /* Through the built-in routes, raced as below. */
  resolveRoutes(dnsMsg) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const order = this.ordered();
      let awake = order.filter((r) => r.restUntil <= now);
      // The resting routes come after the awake ones, soonest to wake first:
      // a lookup the awake routes cannot answer still asks them, in the same
      // waves. Before, a lookup asked only the awake routes (or, with all of
      // them resting, the three that woke soonest), so once a blip had rested
      // the good routes it failed on the routes this network blocks for as
      // long as their rests lasted.
      const resting = order.filter((r) => r.restUntil > now);
      // The second wave is the best route of the other kind and the best of
      // another operator: when a network blocks one kind of route, it usually
      // blocks all of that kind, and the answer should not wait for wave three.
      if (awake.length > 2) {
        const [first, ...rest] = awake;
        const otherKind = rest.find((r) => !!r.viaEngine !== !!first.viaEngine);
        const otherOp = rest.find((r) => r !== otherKind && r.op !== first.op);
        const lead = [first, otherKind, otherOp].filter(Boolean);
        awake = [...lead, ...rest.filter((r) => !lead.includes(r))];
      }
      const plan = [...awake, ...resting];
      if (!plan.length) { reject(new Error('no route')); return; }
      let settled = false, pending = 0, started = 0, lastErr = null;
      // "Server failure" (SERVFAIL): the resolver could not get an answer it
      // trusts, mostly for a name whose DNSSEC signatures are wrong, and the
      // engine takes it as the answer (core/src/doh.c). One operator's could
      // also be its own passing trouble: it is the answer once a second
      // operator agrees, or when no route has anything better.
      let failure = null;
      const failedOps = new Set();
      const timers = [];
      const finish = () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      const fire = (r) => {
        started++; pending++;
        this.ask(r, dnsMsg).then((ans) => {
          pending--;
          if (settled) return;
          if ((ans[3] & 0x0f) === 2) {
            failure = failure || ans;
            failedOps.add(r.op.replace(/-front$/, ''));
            if (failedOps.size >= 2 || (pending === 0 && started === plan.length)) { settled = true; finish(); resolve(failure); }
            else upTo(started + 1);
            return;
          }
          settled = true; finish();
          if (this.preferredId !== r.id) {
            this.preferredId = r.id;
            if (typeof this.opts.onPreferred === 'function') this.opts.onPreferred(r.id);
          }
          resolve(ans);
        }).catch((e) => {
          pending--;
          lastErr = e;
          if (!settled && pending === 0 && started === plan.length) { settled = true; finish(); if (failure) resolve(failure); else reject(lastErr); }
        });
      };
      const upTo = (n) => { while (!settled && started < Math.min(n, plan.length)) fire(plan[started]); };
      upTo(1);
      timers.push(setTimeout(() => upTo(3), SECOND_WAVE_MS));
      // Then a few more at a time, best first, for as long as nothing answers.
      const wave = () => {
        upTo(started + WAVE_SIZE);
        if (!settled && started < plan.length) timers.push(setTimeout(wave, NEXT_WAVE_MS));
      };
      timers.push(setTimeout(wave, THIRD_WAVE_MS));
      // A route that fails fast should not leave the rest waiting for their wave.
      const early = setInterval(() => {
        if (settled) { clearInterval(early); return; }
        if (pending === 0) upTo(started + 1);
      }, 50);
      timers.push(early);
    });
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (typeof this.opts.onState === 'function') this.opts.onState(state);
  }

  /* Which routes answer, for the log: "cloudflare-1 23ms, google-1 31ms". */
  summary() {
    const now = Date.now();
    const c = this.custom;
    if (this.usingCustom()) return c.ewma ? `${require('./custom-dns').shown(c.spec)} ${c.ewma}ms` : '';
    const up = this.routes.filter((r) => this.usable(r) && r.ewma && r.restUntil <= now)
      .sort((a, b) => a.ewma - b.ewma).slice(0, 3).map((r) => `${r.id} ${r.ewma}ms`);
    return up.join(', ');
  }

  cacheGet(key, queryMsg) {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) { this.cache.delete(key); return null; }
    // Replay under the asking query's transaction id.
    const out = Buffer.from(hit.answer);
    out[0] = queryMsg[0]; out[1] = queryMsg[1];
    return out;
  }

  cachePut(key, answer) {
    const ttl = answerTtlSeconds(answer);
    if (ttl == null) return;
    if (this.cache.size >= CACHE_MAX) {
      // Drop the oldest insertions; Map keeps insertion order.
      let n = Math.ceil(CACHE_MAX / 8);
      for (const k of this.cache.keys()) { this.cache.delete(k); if (--n <= 0) break; }
    }
    this.cache.set(key, { answer: Buffer.from(answer), expires: Date.now() + ttl * 1000 });
  }

  /* Keep the best routes' connections open before anyone browses, so the
   * first real lookup does not pay for a handshake; and look in on resting
   * routes now and then, so one that comes back is noticed. */
  warm() {
    if (this.stopped) return;
    const probe = buildQuery('cloudflare.com', 1);
    const c = this.custom;
    // The user's server is asked even while it rests, so one that comes back
    // is used again by itself; while it answers, nothing else needs warming.
    if (c && c.strict) { c.query(probe).then(() => this.customAnswered(c), (e) => { if (this.custom === c) this.customFailedStrict(c, e); }); return; }
    if (c) { c.query(probe).then(() => this.customAnswered(c), (e) => { if (this.custom === c) this.customFailed(c, e); }); if (c.restUntil <= Date.now()) return; }
    const now = Date.now();
    const order = this.ordered();
    const best = order.filter((r) => r.restUntil <= now).slice(0, 3);
    const due = order.filter((r) => r.restUntil > now && r.restUntil - now < WARM_INTERVAL_MS).slice(0, 2);
    const asks = [...best, ...due].map((r) => this.ask(r, probe).then(() => true, () => false));
    if (asks.length) Promise.all(asks).then((ok) => { if (!ok.some(Boolean)) this.stillFailing(); });
  }

  /* port: the one it had before, taken again if it is free, so whoever was
   * told it (Advanced mode's DNS gate, elevated and started once) still
   * reaches it after a Stop and Start; otherwise any free one. */
  start(port = 0) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      // A transient send error (an unreachable loopback reply, a full buffer)
      // must not take the forwarder down: the engine would keep sending to a
      // dead port and every lookup would quietly fall back to the plain DNS
      // this exists to avoid. Only a failure to bind is fatal, and that is
      // handled by the once('error') below, before the port is published.
      sock.on('error', (e) => { this.log('warning', `DoH forwarder: ${e.message}`); });
      sock.on('message', (msg, rinfo) => {
        if (msg.length < 12 || msg.length > 4096) return; // not a sane DNS query
        const key = questionKey(msg);
        if (key) {
          const hit = this.cacheGet(key, msg);
          if (hit) { try { sock.send(hit, rinfo.port, rinfo.address); } catch {} return; }
        }
        this.resolve(msg)
          .then((answer) => {
            if (key) this.cachePut(key, answer);
            this.failures = 0;
            this.failingSince = 0;
            this.setState('ok');
            try { sock.send(answer, rinfo.port, rinfo.address); } catch {}
          })
          .catch(() => {
            // Only the user's server, and it did not answer: "server
            // failure" goes back, so the engine stops waiting for it (it
            // falls through to nothing else) and the app asking hears at once.
            const c = this.custom;
            if (c && c.strict) { const f = failReply(msg); if (f) { try { sock.send(f, rinfo.port, rinfo.address); } catch {} } return; }
            /* Nothing is sent back, so the engine falls through to plain DNS.
             * That is the right thing to do — a lookup that fails outright is
             * worse — but it quietly undoes the encryption this exists to
             * provide. Say so, rather than let it pass unnoticed. */
            this.lookupFailed();
          });
      });
      sock.bind(port, '127.0.0.1', () => {
        this.sock = sock;
        this.port = sock.address().port;
        this.stopped = false;
        // A new start, often after something went wrong (a Stop and Start, an
        // engine restart, another network): the rests of the last session do
        // not carry over, or one blip in it kept the best routes out of this
        // one too. What is known about their speed does.
        this.clearRests();
        this.warm();
        this.warmTimer = setInterval(() => this.warm(), WARM_INTERVAL_MS);
        if (this.warmTimer.unref) this.warmTimer.unref();
        resolve(this.port);
      });
      sock.once('error', (e) => {
        if (this.sock === sock) return;
        try { sock.close(); } catch {}
        if (port) this.start(0).then(resolve, reject);
        else reject(e);
      });
    });
  }

  clearRests() {
    for (const r of this.routes) { r.fails = 0; r.failAt = 0; r.restUntil = 0; }
    this.failures = 0;
    this.failingSince = 0;
    this.lastFailAt = 0;
  }

  /* Another network, or the same one back after a gap: the connections made
   * before are dead without knowing it (a request on one waits out its whole
   * timeout), and the rests earned there say nothing about here. Lookups
   * start afresh, the remembered route first. */
  networkChanged() {
    for (const r of this.routes) this.dropSession(r);
    if (this.custom) this.custom.drop();
    this.clearRests();
  }

  /* The computer woke up: the same network back after a gap, its
   * connections dead (networkChanged), and a moment before failed lookups
   * mean anything. */
  resumed(now = Date.now()) {
    this.networkChanged();
    this.quietUntil = now + WAKE_QUIET_MS;
  }

  /* The clock was set back: times recorded "in the future" would rest a
   * route, or hold a streak, until it caught up. They count as now. */
  _clockBack(now) {
    for (const r of this.routes) {
      if (r.restUntil > now + REST_MAX_MS) r.restUntil = now + REST_MAX_MS;
      if (r.failAt > now) r.failAt = now;
      if (r.okAt > now) r.okAt = now;
    }
    if (this.lastFailAt > now) this.lastFailAt = now;
    if (this.failingSince > now) this.failingSince = now;
  }

  stop() {
    this.stopped = true;
    if (this.warmTimer) { clearInterval(this.warmTimer); this.warmTimer = null; }
    this.cache.clear();
    for (const r of this.routes) this.dropSession(r);
    if (this.custom) this.custom.drop();
    this.socksPort = 0;
    if (this.sock) { try { this.sock.close(); } catch {} this.sock = null; }
  }
}

/* Minimal DNS query builder, used only for the keep-warm probe. */
function buildQuery(name, qtype) {
  const labels = name.split('.').filter(Boolean);
  let len = 12 + 1 + 4;
  for (const l of labels) len += 1 + l.length;
  const b = Buffer.alloc(len);
  b.writeUInt16BE(Math.floor(Math.random() * 65536), 0);
  b.writeUInt16BE(0x0100, 2);   // RD
  b.writeUInt16BE(1, 4);        // QDCOUNT
  let p = 12;
  for (const l of labels) { b[p++] = l.length; b.write(l, p, 'latin1'); p += l.length; }
  b[p++] = 0;
  b.writeUInt16BE(qtype, p); p += 2;
  b.writeUInt16BE(1, p);        // IN
  return b;
}

module.exports = DohForwarder;
module.exports.UPSTREAMS = UPSTREAMS;
module.exports.buildQuery = buildQuery;
module.exports.failReply = failReply;
module.exports.socksConnect = socksConnect;
