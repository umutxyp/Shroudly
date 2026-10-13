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
 * the best route alone, then the next two, then everything still standing.
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
const THIRD_WAVE_MS    = 900;   // then the next two; then all the rest
const REST_BASE_MS     = 2000;  // a failing route rests 2 s, 4 s, 8 s ... 5 min
const REST_MAX_MS      = 300000;
const WARM_INTERVAL_MS = 120000;
const SESSION_IDLE_MS  = 300000;
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
   * opts.onState('ok' | 'down'): encrypted DNS works / is blocked outright. */
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
    this.state = 'ok';
    this.lastDowngradeWarn = 0;
    this.preferredId = opts.preferredId || null;
    this.routes = UPSTREAMS.map((u) => ({ ...u, fails: 0, restUntil: 0, ewma: 0, session: null, opening: null }));
  }

  /* The engine's port, once it is up: routes that go through it wait for it. */
  setSocksPort(port) { this.socksPort = Number(port) || 0; }

  usable(r) { return !r.viaEngine || this.socksPort > 0; }

  /* Best first: the remembered route, then measured speed (untried routes
   * count as average), resting routes last. */
  ordered() {
    const now = Date.now();
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

  async query(r, dnsMsg) {
    const t0 = Date.now();
    const sess = await this.session(r);
    const answer = await new Promise((resolve, reject) => {
      const req = sess.request({
        ':method': 'POST', ':path': '/dns-query',
        'content-type': 'application/dns-message', accept: 'application/dns-message',
        'content-length': dnsMsg.length,
      });
      const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); reject(new Error('timeout')); }, QUERY_TIMEOUT_MS);
      let status = 0; const chunks = [];
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks);
        if (status !== 200 || body.length < 12) reject(new Error(`HTTP ${status}`));
        else resolve(body);
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end(dnsMsg);
    });
    const ms = Date.now() - t0;
    r.ewma = r.ewma ? Math.round(r.ewma * 0.7 + ms * 0.3) : ms;
    r.fails = 0; r.restUntil = 0;
    return answer;
  }

  failed(r) {
    r.fails++;
    r.restUntil = Date.now() + Math.min(REST_MAX_MS, REST_BASE_MS * 2 ** (r.fails - 1));
    this.dropSession(r);
  }

  /* Race the routes in waves. The first valid answer wins. */
  resolve(dnsMsg) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const order = this.ordered();
      const awake = order.filter((r) => r.restUntil <= now);
      // Everything resting: still try the three that wake soonest, rather than
      // give up on encrypted DNS altogether.
      let plan = awake.length ? awake : order.slice(0, 3);
      // The second wave is the best route of the other kind and the best of
      // another operator: when a network blocks one kind of route, it usually
      // blocks all of that kind, and the answer should not wait for wave three.
      if (plan.length > 2) {
        const [first, ...rest] = plan;
        const otherKind = rest.find((r) => !!r.viaEngine !== !!first.viaEngine);
        const otherOp = rest.find((r) => r !== otherKind && r.op !== first.op);
        const lead = [first, otherKind, otherOp].filter(Boolean);
        plan = [...lead, ...rest.filter((r) => !lead.includes(r))];
      }
      if (!plan.length) { reject(new Error('no route')); return; }
      let settled = false, pending = 0, started = 0, lastErr = null;
      const timers = [];
      const finish = () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      const fire = (r) => {
        started++; pending++;
        this.query(r, dnsMsg).then((ans) => {
          pending--;
          if (settled) return;
          settled = true; finish();
          if (this.preferredId !== r.id) {
            this.preferredId = r.id;
            if (typeof this.opts.onPreferred === 'function') this.opts.onPreferred(r.id);
          }
          resolve(ans);
        }).catch((e) => {
          pending--;
          this.failed(r);
          lastErr = e;
          if (!settled && pending === 0 && started === plan.length) { settled = true; finish(); reject(lastErr); }
        });
      };
      const upTo = (n) => { while (!settled && started < Math.min(n, plan.length)) fire(plan[started]); };
      upTo(1);
      timers.push(setTimeout(() => upTo(3), SECOND_WAVE_MS));
      timers.push(setTimeout(() => upTo(plan.length), THIRD_WAVE_MS));
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
    const now = Date.now();
    const order = this.ordered();
    const best = order.filter((r) => r.restUntil <= now).slice(0, 3);
    const due = order.filter((r) => r.restUntil > now && r.restUntil - now < WARM_INTERVAL_MS).slice(0, 2);
    for (const r of [...best, ...due]) this.query(r, probe).catch(() => this.failed(r));
  }

  start() {
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
            this.setState('ok');
            try { sock.send(answer, rinfo.port, rinfo.address); } catch {}
          })
          .catch(() => {
            /* Nothing is sent back, so the engine falls through to plain DNS.
             * That is the right thing to do — a lookup that fails outright is
             * worse — but it quietly undoes the encryption this exists to
             * provide. Say so, rather than let it pass unnoticed. */
            this.failures = (this.failures || 0) + 1;
            const now = Date.now();
            if (this.failures >= 3) {
              this.setState('down');
              if (now - (this.lastDowngradeWarn || 0) > 300000) {
                this.lastDowngradeWarn = now;
                this.log('warning', 'Encrypted DNS is not reachable on this network; lookups are falling back to ordinary DNS, which your provider can read and change.');
              }
            }
          });
      });
      sock.bind(0, '127.0.0.1', () => {
        this.sock = sock;
        this.port = sock.address().port;
        this.stopped = false;
        this.warm();
        this.warmTimer = setInterval(() => this.warm(), WARM_INTERVAL_MS);
        if (this.warmTimer.unref) this.warmTimer.unref();
        resolve(this.port);
      });
      sock.once('error', reject);
    });
  }

  stop() {
    this.stopped = true;
    if (this.warmTimer) { clearInterval(this.warmTimer); this.warmTimer = null; }
    this.cache.clear();
    for (const r of this.routes) this.dropSession(r);
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
