'use strict';

/*
 * Local DNS-over-HTTPS forwarder.
 *
 * Listens for ordinary DNS queries on 127.0.0.1:<port> (UDP) and answers them
 * over real RFC 8484 DoH. The engine's resolver (core/src/doh.c) sends its
 * queries here when the app passes --doh-port, so DNS resolution is encrypted
 * and cannot be read or injected on the wire.
 *
 * Each upstream is reached BY IP with TLS but no SNI, so the DoH connection
 * itself can't be blocked by SNI inspection. Validation still succeeds because
 * the certificates for these resolvers list their own IPs, which we check
 * explicitly against the presented certificate (tls does not verify identity
 * when servername is empty).
 *
 * Speed matters as much as privacy here: a DNS lookup that takes too long is
 * indistinguishable from a broken one, and the engine would fall back to plain
 * UDP resolvers, which are exactly what the censor poisons. So:
 *   - every upstream keeps a pooled TLS connection open (no handshake per query)
 *   - the connections are opened at startup and kept warm, so the first real
 *     lookup is as fast as the hundredth
 *   - upstreams are raced rather than chained: the preferred one goes first and
 *     the others join 300 ms later, so one slow resolver cannot stall a lookup
 *   - answers are cached for their TTL, so repeat lookups cost nothing
 *
 * Nothing is logged or stored: a query comes in, a DoH request goes out, the
 * answer goes back.
 */

const dgram = require('dgram');
const https = require('https');
const tls = require('tls');

// Upstreams by IP, with the cert names we accept for that IP.
const UPSTREAMS = [
  { ip: '1.1.1.1', names: ['cloudflare-dns.com', '1.1.1.1', 'one.one.one.one'] },
  { ip: '9.9.9.9', names: ['dns.quad9.net', '9.9.9.9'] },
  { ip: '8.8.8.8', names: ['dns.google', '8.8.8.8'] },
];

const QUERY_TIMEOUT_MS = 2500;  // per upstream; they are raced, not chained
const FANOUT_DELAY_MS  = 300;   // how long the preferred upstream gets alone
const WARM_INTERVAL_MS = 120000;
const CACHE_MAX        = 1500;
const TTL_MIN_S        = 20;
const TTL_MAX_S        = 3600;

for (const up of UPSTREAMS) {
  up.agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 8,
    maxFreeSockets: 2,
  });
}

function certCoversIp(cert, ip) {
  // subjectaltname like "DNS:cloudflare-dns.com, IP Address:1.1.1.1"
  const san = cert && cert.subjectaltname;
  if (!san) return false;
  return san.split(',').map((s) => s.trim()).some((e) => e === `IP Address:${ip}`);
}

function queryUpstream(up, dnsMsg) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: up.ip,
      servername: '', // no SNI
      port: 443,
      path: '/dns-query',
      method: 'POST',
      agent: up.agent,
      headers: {
        'content-type': 'application/dns-message',
        accept: 'application/dns-message',
        'content-length': dnsMsg.length,
      },
      // Verify against the IP (SAN) ourselves, since without a servername the
      // default identity check has no hostname to match.
      checkServerIdentity: (_host, cert) => {
        if (certCoversIp(cert, up.ip)) return undefined;
        // Some resolvers put only their hostname in the cert, not the IP.
        try { return tls.checkServerIdentity(up.names[0], cert); }
        catch (e) { return e; }
      },
      timeout: QUERY_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(dnsMsg);
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
  constructor(log) {
    this.log = log || (() => {});
    this.sock = null;
    this.port = 0;
    this.preferred = 0;
    this.cache = new Map();     // key -> { answer: Buffer, expires: ms }
    this.warmTimer = null;
    this.stopped = false;
    this.failures = 0;
    this.lastDowngradeWarn = 0;
  }

  /* Race the upstreams: the preferred one starts immediately, the rest join
   * after a short delay. The first valid answer wins and becomes preferred. */
  resolve(dnsMsg) {
    return new Promise((resolve, reject) => {
      const order = [this.preferred, ...UPSTREAMS.map((_, i) => i).filter((i) => i !== this.preferred)];
      let settled = false, pending = 0, started = 0, lastErr = null, timer = null;

      const done = (err, ans, idx) => {
        if (settled) return;
        if (!err) {
          settled = true;
          clearTimeout(timer);
          this.preferred = idx;
          resolve(ans);
          return;
        }
        lastErr = err;
        if (pending === 0 && started === order.length) { settled = true; clearTimeout(timer); reject(lastErr); }
      };

      const fire = (idx) => {
        started++; pending++;
        queryUpstream(UPSTREAMS[idx], dnsMsg)
          .then((ans) => { pending--; done(null, ans, idx); })
          .catch((e) => { pending--; done(e, null, idx); });
      };

      fire(order[0]);
      timer = setTimeout(() => {
        if (!settled) for (let i = 1; i < order.length; i++) fire(order[i]);
      }, FANOUT_DELAY_MS);
    });
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

  /* Open (and keep) the TLS connections before anyone browses, so the first
   * real lookup does not pay for a handshake. */
  warm() {
    if (this.stopped) return;
    const probe = buildQuery('cloudflare.com', 1);
    for (let i = 0; i < UPSTREAMS.length; i++) {
      queryUpstream(UPSTREAMS[i], probe).catch(() => {});
    }
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
            try { sock.send(answer, rinfo.port, rinfo.address); } catch {}
          })
          .catch(() => {
            /* Nothing is sent back, so the engine falls through to plain DNS.
             * That is the right thing to do — a lookup that fails outright is
             * worse — but it quietly undoes the encryption this exists to
             * provide, and blocking three fixed addresses is a cheap way for a
             * network to force it. Say so, rather than let it pass unnoticed. */
            this.failures = (this.failures || 0) + 1;
            const now = Date.now();
            if (this.failures >= 3 && now - (this.lastDowngradeWarn || 0) > 300000) {
              this.lastDowngradeWarn = now;
              this.log('warning', 'Encrypted DNS is not reachable on this network; lookups are falling back to ordinary DNS, which your provider can read and change.');
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
