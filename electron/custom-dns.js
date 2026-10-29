'use strict';

/*
 * A DNS server of the user's own (Settings, "DNS server", issue #34), in place
 * of the built-in encrypted routes (doh-forwarder.js): to try another one when
 * one is blocked or slow, to use a nearer one, or to see which answer works.
 *
 *   doh   https://host[:port]/path   DNS over HTTPS (RFC 8484), HTTP/2 or 1.1
 *   dot   host[:port], 853           DNS over TLS (RFC 7858)
 *   tcp   host[:port], 53            plain DNS over TCP: where a network
 *                                    blocks or forges UDP port 53 but leaves
 *                                    TCP alone
 *   udp   host[:port], 53            plain DNS
 *
 * The encrypted ones go through the engine (the server's name in the TLS
 * handshake is split like any other site's), the plain ones straight out. A
 * server given by name is looked up through the built-in encrypted routes
 * (bootstrap), never the network's own DNS. Only this server is asked while
 * it is set: an answer that differs from the built-in routes' is what the
 * user wants to see. Nothing is logged or stored.
 *
 * Through a proxy of the user's own (issue #58): a server blocked by its
 * address (a public DoH one in some networks) is reached through a SOCKS5 or
 * HTTP proxy the user has, for these connections only; everything else still
 * goes through the engine. The server's name goes to the proxy, so nothing is
 * looked up here. DoH, DoT and TCP; not UDP, which proxies hardly relay.
 */

const dgram = require('dgram');
const http2 = require('http2');
const net = require('net');
const tls = require('tls');

const KINDS = ['doh', 'dot', 'tcp', 'udp'];
const PORTS = { doh: 443, dot: 853, tcp: 53, udp: 53 };
const TIMEOUT_MS = 2500;
// Plain DNS over UDP: the question is sent again this long after, once, as
// any resolver's client does; a lossy network then costs a moment, not the
// whole wait (and the built-in DNS taking over).
const UDP_RESEND_MS = 800;
const IDLE_MS = 60000;

const isIp = (h) => net.isIP(String(h || '').replace(/^\[|\]$/g, '')) !== 0;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
// An address, or a name (not one of digits only: "300.1.1.1" is a mistyped
// address, not a name).
const hostOk = (h) => isIp(h) || (HOST.test(h) && !/^[\d.]+$/.test(h));

/* What the user typed for `kind`: { kind, host, port, path } (path for DoH),
 * or { error } saying what is wrong ('kind', 'empty', 'url', 'host',
 * 'port'). A scheme matching the kind may be typed (tls://, tcp://, udp://). */
function parse(kind, text) {
  if (!KINDS.includes(kind)) return { error: 'kind' };
  let s = String(text || '').trim();
  if (!s) return { error: 'empty' };
  if (kind === 'doh') {
    const full = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
    let u;
    try { u = new URL(full); } catch { return { error: 'url' }; }
    if (u.protocol !== 'https:' || u.username || u.password) return { error: 'url' };
    // As typed: URL reads "1.2.3" as the address 1.2.0.3.
    const typed = (/^[a-z]+:\/\/(\[[^\]]*\]|[^/:?#]*)/i.exec(full) || [])[1] || '';
    if (/^[\d.]+$/.test(typed) && !isIp(typed)) return { error: 'host' };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!hostOk(host)) return { error: 'host' };
    const port = u.port ? Number(u.port) : 443;
    return { kind, host, port, path: (u.pathname && u.pathname !== '/' ? u.pathname : '/dns-query') + (u.search || '') };
  }
  const scheme = { dot: /^(tls|dot):\/\//i, tcp: /^tcp:\/\//i, udp: /^(udp|dns):\/\//i }[kind];
  s = s.replace(scheme, '').replace(/\/+$/, '');
  if (/^[a-z]+:\/\//i.test(s)) return { error: 'url' };
  let host = s; let port = PORTS[kind];
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) { host = v6[1]; if (v6[2]) port = Number(v6[2]); } else if ((s.match(/:/g) || []).length === 1) {
    const [h, p] = s.split(':');
    host = h; port = Number(p);
  }
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) return { error: 'port' };
  if (!hostOk(host)) return { error: 'host' };
  return { kind, host, port };
}

/* The proxy typed for the DNS server: socks5://[user:pass@]host:port (also
 * socks5h:// and socks://) or http://[user:pass@]host:port. null for none,
 * { type: 'socks5' | 'http', host, port, user, pass }, or { error: 'proxy' }. */
function parseProxy(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /^(socks5h?|socks|http):\/\/(?:([^:@/\s]*)(?::([^@/\s]*))?@)?(\[[0-9a-f:.]+\]|[^:/\s[\]]+):(\d{1,5})\/?$/i.exec(s);
  if (!m) return { error: 'proxy' };
  const host = m[4].replace(/^\[|\]$/g, '');
  const port = Number(m[5]);
  if (!hostOk(host) || !(port > 0 && port < 65536)) return { error: 'proxy' };
  let user = '';
  let pass = '';
  try { user = decodeURIComponent(m[2] || ''); pass = decodeURIComponent(m[3] || ''); } catch { return { error: 'proxy' }; }
  if (Buffer.byteLength(user) > 255 || Buffer.byteLength(pass) > 255) return { error: 'proxy' };
  return { type: /^http$/i.test(m[1]) ? 'http' : 'socks5', host, port, user, pass };
}

/* As the user sees it, without a password: "socks5://127.0.0.1:1080". */
function shownProxy(p) {
  if (!p || p.error) return '';
  return `${p.type}://${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}`;
}

/* A TCP connection to host:port (a name or an address) through proxy p:
 * SOCKS5 (RFC 1928; no login, or a user name and password, RFC 1929), or an
 * HTTP CONNECT. Rejects when the proxy refuses or does not answer. */
function viaProxy(p, host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: p.host, port: p.port });
    let buf = Buffer.alloc(0);
    let step = 'connect';
    const done = (e) => { clearTimeout(t); s.removeAllListeners('data'); s.removeAllListeners('error'); if (e) { s.destroy(); reject(e); } else resolve(s); };
    const t = setTimeout(() => done(new Error(`the proxy did not answer (${step})`)), TIMEOUT_MS * 2);
    s.once('error', (e) => done(e));
    const target = () => {
      const v4 = net.isIP(host) === 4;
      const v6 = net.isIP(host) === 6;
      const addr = v4 ? Buffer.from([1, ...host.split('.').map(Number)])
        : v6 ? Buffer.concat([Buffer.from([4]), ip6Bytes(host)])
          : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
      const pb = Buffer.alloc(2); pb.writeUInt16BE(port, 0);
      step = 'socks connect';
      s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, pb]));
    };
    s.once('connect', () => {
      if (p.type === 'http') {
        const h = host.includes(':') ? `[${host}]` : host;
        const auth = p.user || p.pass ? `Proxy-Authorization: Basic ${Buffer.from(`${p.user}:${p.pass}`).toString('base64')}\r\n` : '';
        step = 'http connect';
        s.write(`CONNECT ${h}:${port} HTTP/1.1\r\nHost: ${h}:${port}\r\n${auth}\r\n`);
      } else {
        step = 'socks hello';
        s.write(Buffer.from(p.user || p.pass ? [5, 2, 0, 2] : [5, 1, 0]));
      }
    });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (step === 'http connect') {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) { if (buf.length > 8192) done(new Error('the proxy answered with no end')); return; }
        const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(buf.slice(0, end).toString('latin1')) || [])[1]);
        if (status !== 200) { done(new Error(`the proxy refused (HTTP ${status || '?'})`)); return; }
        const rest = buf.slice(end + 4);
        done();
        if (rest.length) s.unshift(rest);
        return;
      }
      if (step === 'socks hello') {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || (buf[1] !== 0 && buf[1] !== 2)) { done(new Error('the proxy refused (SOCKS5 method)')); return; }
        const method = buf[1];
        buf = buf.slice(2);
        if (method === 2) {
          const u = Buffer.from(p.user || '');
          const w = Buffer.from(p.pass || '');
          step = 'socks login';
          s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([w.length]), w]));
        } else target();
        return;
      }
      if (step === 'socks login') {
        if (buf.length < 2) return;
        if (buf[1] !== 0) { done(new Error('the proxy refused the user name or password')); return; }
        buf = buf.slice(2);
        target();
        return;
      }
      if (step === 'socks connect') {
        if (buf.length < 5) return;
        if (buf[0] !== 5 || buf[1] !== 0) { done(new Error(`the proxy could not connect (SOCKS5 ${buf[1]})`)); return; }
        const len = buf[3] === 1 ? 4 : buf[3] === 4 ? 16 : buf[3] === 3 ? 1 + buf[4] : -1;
        if (len < 0) { done(new Error('the proxy answered in a form not known')); return; }
        if (buf.length < 4 + len + 2) return;
        const rest = buf.slice(4 + len + 2);
        done();
        if (rest.length) s.unshift(rest);
      }
    });
  });
}

/* The 16 bytes of an IPv6 address. */
function ip6Bytes(a) {
  const halves = a.split('::');
  const l = halves[0] ? halves[0].split(':') : [];
  const r = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return out;
}

/* As the user sees it: "https://dns.google/dns-query", "tls://1.1.1.1",
 * "tcp://8.8.8.8:53", "udp://9.9.9.9:53". */
function shown(spec) {
  if (!spec) return '';
  const h = spec.host.includes(':') ? `[${spec.host}]` : spec.host;
  if (spec.kind === 'doh') return `https://${h}${spec.port === 443 ? '' : `:${spec.port}`}${spec.path}`;
  return `${{ dot: 'tls', tcp: 'tcp', udp: 'udp' }[spec.kind]}://${h}:${spec.port}`;
}

/* The first IPv4 address in a DNS answer, or null. */
function firstA(msg) {
  try {
    const qd = msg.readUInt16BE(4); const an = msg.readUInt16BE(6);
    let p = 12;
    const skip = () => { while (p < msg.length) { const l = msg[p]; if (l === 0) { p += 1; return; } if (l & 0xc0) { p += 2; return; } p += 1 + l; } };
    for (let i = 0; i < qd; i++) { skip(); p += 4; }
    for (let i = 0; i < an; i++) {
      skip();
      const type = msg.readUInt16BE(p); const len = msg.readUInt16BE(p + 8);
      if (type === 1 && len === 4) return [...msg.subarray(p + 10, p + 14)].join('.');
      p += 10 + len;
    }
  } catch {}
  return null;
}

/* A chunked HTTP/1.1 body, once all of it is here; else null. */
function unchunk(b) {
  const parts = [];
  let p = 0;
  for (;;) {
    const eol = b.indexOf('\r\n', p);
    if (eol < 0) return null;
    const n = parseInt(b.subarray(p, eol).toString('latin1'), 16);
    if (!(n >= 0)) return Buffer.alloc(0);
    if (n === 0) return Buffer.concat(parts);
    if (b.length < eol + 2 + n + 2) return null;
    parts.push(b.subarray(eol + 2, eol + 2 + n));
    p = eol + 2 + n + 2;
  }
}

/* Answers on a stream (TCP, TLS): each message after its two-byte length,
 * matched to the question by its id. */
class Framed {
  constructor(sock) {
    this.sock = sock;
    this.waiting = new Map();   // id -> { resolve, reject, timer }
    this.buf = Buffer.alloc(0);
    this.dead = false;
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 2) {
        const len = this.buf.readUInt16BE(0);
        if (this.buf.length < 2 + len) break;
        const m = this.buf.subarray(2, 2 + len);
        this.buf = this.buf.subarray(2 + len);
        const w = m.length >= 2 && this.waiting.get(m.readUInt16BE(0));
        if (w) { this.waiting.delete(m.readUInt16BE(0)); clearTimeout(w.timer); w.resolve(Buffer.from(m)); }
      }
    });
    const end = (e) => {
      this.dead = true;
      for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(e || new Error('closed')); }
      this.waiting.clear();
    };
    sock.on('error', end);
    sock.on('close', () => end());
    sock.setTimeout(IDLE_MS, () => sock.destroy());
  }

  /* Two questions with the same id at once (two programs asking) would get
   * each other's answer: one is sent under a free id, and its answer carries
   * the asker's id back. */
  ask(msg) {
    return new Promise((resolve, reject) => {
      const own = msg.readUInt16BE(0);
      let id = own;
      while (this.waiting.has(id)) id = (id + 1) & 0xffff;
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('timeout')); }, TIMEOUT_MS);
      this.waiting.set(id, { resolve: (m) => { m.writeUInt16BE(own, 0); resolve(m); }, reject, timer });
      const q = Buffer.from(msg); q.writeUInt16BE(id, 0);
      const head = Buffer.alloc(2); head.writeUInt16BE(q.length, 0);
      this.sock.write(Buffer.concat([head, q]));
    });
  }
}

class CustomDns {
  /* spec: parse()'s result. opts.socksPort(): the engine's port (0 while
   * none); opts.bootstrap(name): its IPv4 address through the built-in
   * routes; opts.proxy: parseProxy()'s result, the user's proxy for this
   * server (#58); opts.ca: certificate authorities to trust instead of the
   * system's (tests). */
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.opts = opts;
    this.ip = isIp(spec.host) ? spec.host : null;
    this.ipAt = 0;
    this.conn = null;          // Framed (tcp, dot) or an HTTP/2 session (doh)
    this.opening = null;
    this.ewma = 0;
    this.closed = false;
    this.h1Only = false;       // a DoH server without HTTP/2: one connection per question
  }

  async address() {
    if (isIp(this.spec.host)) return this.spec.host;
    if (this.ip && Date.now() - this.ipAt < 10 * 60 * 1000) return this.ip;
    const ip = this.opts.bootstrap ? await this.opts.bootstrap(this.spec.host) : null;
    if (!ip) throw new Error(`${this.spec.host} could not be looked up`);
    this.ip = ip; this.ipAt = Date.now();
    return ip;
  }

  /* A TCP connection to the server: through the engine when it is up (and
   * the address is IPv4), else straight. */
  async raw(ip, port, viaEngine) {
    const socksPort = viaEngine && this.opts.socksPort ? this.opts.socksPort() : 0;
    if (socksPort && net.isIP(ip) === 4) return require('./doh-forwarder').socksConnect(socksPort, ip, port);
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: ip, port });
      const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, TIMEOUT_MS);
      s.once('connect', () => { clearTimeout(t); s.removeAllListeners('error'); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  /* TLS on a connection, checked against the server's name (or, given by
   * address, against that address). */
  tls(raw, alpn) {
    const name = isIp(this.spec.host) ? null : this.spec.host;
    return new Promise((resolve, reject) => {
      const s = tls.connect({
        socket: raw, servername: name || undefined, ALPNProtocols: alpn, ca: this.opts.ca,
        checkServerIdentity: (h, cert) => tls.checkServerIdentity(name || this.spec.host, cert),
      });
      const t = setTimeout(() => { s.destroy(); reject(new Error('TLS timeout')); }, TIMEOUT_MS);
      s.once('secureConnect', () => { clearTimeout(t); s.removeAllListeners('error'); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  async open() {
    const { kind, port } = this.spec;
    // Through the user's proxy, by name: nothing is looked up here (#58).
    const proxy = this.opts.proxy && !this.opts.proxy.error ? this.opts.proxy : null;
    const connect = proxy ? () => viaProxy(proxy, this.spec.host, port)
      : async (viaEngine) => this.raw(await this.address(), port, viaEngine);
    if (kind === 'tcp') return new Framed(await connect(false));
    if (kind === 'dot') return new Framed(await this.tls(await connect(true), undefined));
    const sock = await this.tls(await connect(true), ['h2', 'http/1.1']);
    if (sock.alpnProtocol !== 'h2') { this.h1Only = true; return { h1: sock }; }
    const sess = http2.connect(`https://${this.spec.host}`, { createConnection: () => sock });
    sess.on('error', () => {});
    sess.setTimeout(IDLE_MS, () => sess.close());
    return sess;
  }

  connection() {
    if (this.h1Only) return this.open();
    const c = this.conn;
    const alive = c && !(c.dead || c.closed || c.destroyed);
    if (alive) return Promise.resolve(c);
    if (this.opening) return this.opening;
    this.opening = this.open().then((n) => { this.conn = n; return n; }).finally(() => { this.opening = null; });
    return this.opening;
  }

  drop() {
    const c = this.conn;
    this.conn = null;
    this.h1Only = false;
    try { if (c && c.sock) c.sock.destroy(); else if (c && c.h1) c.h1.destroy(); else if (c) c.destroy(); } catch {}
  }

  async udp(msg) {
    const ip = await this.address();
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket(net.isIP(ip) === 6 ? 'udp6' : 'udp4');
      const id = msg.readUInt16BE(0);
      const again = setTimeout(() => { try { s.send(msg, this.spec.port, ip); } catch {} }, UDP_RESEND_MS);
      const t = setTimeout(() => { clearTimeout(again); s.close(); reject(new Error('timeout')); }, TIMEOUT_MS);
      s.on('message', (m) => { if (m.length >= 12 && m.readUInt16BE(0) === id) { clearTimeout(t); clearTimeout(again); s.close(); resolve(m); } });
      s.on('error', (e) => { clearTimeout(t); clearTimeout(again); try { s.close(); } catch {} reject(e); });
      s.send(msg, this.spec.port, ip);
    });
  }

  /* One HTTP/1.1 exchange on its own connection (a server without HTTP/2).
   * The body: by its length, chunked, or up to the end of the connection. */
  h1(sock, msg) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, TIMEOUT_MS);
      let buf = Buffer.alloc(0);
      const done = (ended) => {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) { if (ended) { clearTimeout(t); reject(new Error('closed')); } return; }
        const head = buf.subarray(0, end).toString('latin1');
        const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head) || [])[1]);
        const len = Number((/\r\ncontent-length:\s*(\d+)/i.exec(head) || [])[1]);
        let body = null;
        if (/\r\ntransfer-encoding:[^\r]*chunked/i.test(head)) body = unchunk(buf.subarray(end + 4));
        else if (len >= 0) body = buf.length >= end + 4 + len ? buf.subarray(end + 4, end + 4 + len) : null;
        else if (ended) body = buf.subarray(end + 4);
        if (!body) { if (ended) { clearTimeout(t); reject(new Error('closed')); } return; }
        clearTimeout(t); sock.destroy();
        if (status !== 200 || body.length < 12) reject(new Error(`HTTP ${status}`)); else resolve(Buffer.from(body));
      };
      sock.on('data', (d) => { buf = Buffer.concat([buf, d]); done(false); });
      sock.on('end', () => done(true));
      sock.on('error', (e) => { clearTimeout(t); reject(e); });
      const h = this.spec.host.includes(':') ? `[${this.spec.host}]` : this.spec.host;
      sock.write(`POST ${this.spec.path} HTTP/1.1\r\nHost: ${h}\r\nContent-Type: application/dns-message\r\nAccept: application/dns-message\r\nContent-Length: ${msg.length}\r\nConnection: close\r\n\r\n`);
      sock.write(msg);
    });
  }

  h2(sess, msg) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = sess.request({ ':method': 'POST', ':path': this.spec.path, 'content-type': 'application/dns-message', accept: 'application/dns-message', 'content-length': msg.length });
      } catch (e) { reject(e); return; }
      const t = setTimeout(() => { try { req.close(http2.constants.NGHTTP2_CANCEL); } catch {} reject(new Error('timeout')); }, TIMEOUT_MS);
      let status = 0; const chunks = [];
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => { clearTimeout(t); const b = Buffer.concat(chunks); if (status !== 200 || b.length < 12) reject(new Error(`HTTP ${status}`)); else resolve(b); });
      req.on('error', (e) => { clearTimeout(t); reject(e); });
      req.end(msg);
    });
  }

  /* The server's answer to one DNS query. */
  async query(msg) {
    if (this.closed) throw new Error('closed');
    const t0 = Date.now();
    let answer;
    try {
      if (this.spec.kind === 'udp') answer = await this.udp(msg);
      else {
        let c = await this.connection();
        // HTTP/1.1: each question on a connection of its own (the first ones
        // may have shared the opening that found it out).
        if (c.h1) {
          if (c.taken) c = await this.open();
          c.taken = true;
          if (this.conn === c) this.conn = null;
          answer = await this.h1(c.h1, msg);
        } else if (c instanceof Framed) answer = await c.ask(msg); else answer = await this.h2(c, msg);
      }
    } catch (e) {
      this.drop();
      throw e;
    }
    const ms = Date.now() - t0;
    this.ewma = this.ewma ? Math.round(this.ewma * 0.7 + ms * 0.3) : ms;
    return answer;
  }

  close() { this.closed = true; this.drop(); }
}

module.exports = { CustomDns, parse, shown, parseProxy, shownProxy, viaProxy, firstA, KINDS, PORTS };
