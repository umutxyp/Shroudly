'use strict';

/*
 * AppProxy — the way in for programs that ignore the system proxy.
 *
 * Roblox, its installer and many command-line tools bring their own HTTP
 * library (libcurl) and never look at the system proxy setting. The one proxy
 * they honour is the HTTPS_PROXY environment variable. So in Turkey, for
 * example, roblox.com opens in the browser through Shroudly while the Roblox
 * app and its installer cannot reach a single Roblox server.
 *
 * app-env.js points HTTPS_PROXY here. A request is a CONNECT host:port, or,
 * from the few libraries that never ask for a tunnel, a whole https://
 * address to fetch for them (see _forward). Where it goes:
 *  - into the engine, by name, so its own DNS and its desync apply exactly as
 *    they do for the browser: anything on the public internet;
 *  - straight out: the local network, names this machine's own DNS resolves
 *    to a private address (a company's internal servers, which public DNS
 *    does not know and must not be asked about), everything while protection
 *    is off, and everything not on the list when the user routes only listed
 *    sites;
 *  - nowhere yet: anything that would go into the engine while the engine is
 *    on its way (starting, or restarting after a crash) and did not come
 *    within the wait. Never straight out instead: on a network that filters,
 *    that fails anyway (a name its DNS does not answer), and a download
 *    under way is better retried through Shroudly than broken;
 *  - nowhere: this machine itself and link-local addresses (the cloud
 *    metadata address among them). No program needs a proxy to reach those,
 *    and refusing them keeps this from being a way in to local services.
 * A private address that is a known block page (Iran answers 10.10.34.34 for
 * blocked names) is a block, not an internal server: that goes to the engine.
 *
 * An http:// proxy rather than the engine's SOCKS port: that is the one form
 * everything that reads HTTPS_PROXY understands. A socks5h:// value makes
 * some programs (pip, npm) fail outright.
 *
 * Only this machine can reach it. It tunnels, and it fetches an https://
 * address named whole in the request line; anything else is refused. A web
 * page can send neither: not CONNECT, and not a request line with a whole
 * address in it (a browser writes only the path there).
 */

const http = require('http');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { socksConnect } = require('./discord-relay');
const { countryOf } = require('./censor-fingerprints');
const LogGate = require('./log-gate');

const PREFERRED_PORTS = [10810, 18810, 28810];
const CONNECT_TIMEOUT_MS = 15000;
const LOOKUP_TIMEOUT_MS = 1500;
const DECISION_TTL_MS = 60000;
const MAX_TUNNELS = 1024;

function proxyUrl(port) { return `http://127.0.0.1:${port}`; }

/* "host:port" or "[v6]:port" from a CONNECT line. */
function parseTarget(s) {
  const m = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(s) || /^([a-z0-9._-]{1,253}):(\d{1,5})$/i.exec(s);
  if (!m) return null;
  const port = Number(m[2]);
  if (!port || port > 65535) return null;
  const host = m[1].toLowerCase().replace(/\.$/, '');
  if (!host || (m[0].startsWith('[') && !net.isIPv6(host))) return null;
  return { host, port };
}

/* The IPv4 address inside an IPv4-mapped or NAT64 IPv6 address, if any. */
function embeddedV4(ip) {
  let m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m && net.isIPv4(m[1])) return m[1];
  m = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (m) {
    const hi = parseInt(m[1], 16); const lo = parseInt(m[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/* 'loopback' | 'unspecified' | 'linklocal' | 'private' | 'public' */
function addrClass(ip) {
  const v4 = net.isIPv4(ip) ? ip : (net.isIPv6(ip) ? embeddedV4(ip) : null);
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 0) return 'unspecified';
    if (a === 169 && b === 254) return 'linklocal';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    return 'public';
  }
  const h = String(ip).toLowerCase();
  if (h === '::1') return 'loopback';
  if (h === '::') return 'unspecified';
  if (/^fe[89ab]/.test(h)) return 'linklocal';
  if (/^f[cd]/.test(h)) return 'private';
  return 'public';
}

/* A name only the local network can know. */
function isLocalName(h) {
  return !h.includes('.') || h === 'localhost' || /\.(local|localhost|lan|internal|home\.arpa)$/.test(h);
}

/* Never sent through the engine: this machine, the local network, local names. */
function isLocal(host) {
  const h = String(host).toLowerCase();
  if (net.isIP(h)) return addrClass(h) !== 'public';
  return isLocalName(h);
}

function lookupAll(host) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
    dns.lookup(host, { all: true }, (err, addrs) => { clearTimeout(timer); resolve(err ? null : addrs.map((a) => a.address)); });
  });
}

/* The certificates a forwarded request trusts: the ones Node.js ships with
 * and, where it can read them, the system's own (what the browsers on this
 * computer trust: a company's, an antivirus that looks into HTTPS). Read
 * once. null: Node's own only. */
let trustedCa;
function trusted() {
  if (trustedCa !== undefined) return trustedCa;
  trustedCa = null;
  try {
    if (typeof tls.getCACertificates === 'function') {
      const sys = tls.getCACertificates('system');
      if (sys && sys.length) trustedCa = [...new Set([...tls.rootCertificates, ...sys])];
    }
  } catch {}
  return trustedCa;
}

/* TLS on a connection already made, the server's certificate checked for
 * `host`. Never without that check: the program handed its request over in
 * the clear, trusting this to reach the real server. */
function secure(sock, host, extra) {
  return new Promise((resolve, reject) => {
    const opts = { socket: sock, host, ALPNProtocols: ['http/1.1'], ...(extra || {}) };
    if (!net.isIP(host) && !opts.servername) opts.servername = host;
    if (!opts.ca) { const ca = trusted(); if (ca) opts.ca = ca; }
    opts.rejectUnauthorized = true;
    const s = tls.connect(opts);
    const fail = (e) => { s.destroy(); sock.destroy(); reject(e); };
    s.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('TLS timeout')));
    s.once('error', fail);
    s.once('secureConnect', () => { s.setTimeout(0); s.removeListener('error', fail); resolve(s); });
  });
}

// Headers that belong to one connection, not to the request or the answer.
const HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/* A message's headers without those: { name: value | [values] } for a
 * request (host set apart by the caller), or the flat list for an answer. */
function carried(rawHeaders, flat) {
  const named = new Set();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === 'connection') {
      for (const n of String(rawHeaders[i + 1]).split(',')) named.add(n.trim().toLowerCase());
    }
  }
  const list = []; const obj = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const k = rawHeaders[i]; const l = k.toLowerCase(); const v = rawHeaders[i + 1];
    if (HOP.has(l) || named.has(l)) continue;
    if (flat) { list.push(k, v); continue; }
    if (l === 'host') continue;
    if (obj[k] === undefined) obj[k] = v; else obj[k] = [].concat(obj[k], v);
  }
  return flat ? list : obj;
}

function direct(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.setTimeout(CONNECT_TIMEOUT_MS, () => { s.destroy(); reject(new Error('connect timeout')); });
    s.once('error', reject);
    s.once('connect', () => { s.setTimeout(0); s.removeListener('error', reject); resolve(s); });
  });
}

class AppProxy {
  /*
   * getSocksPort(): the engine's port while protection is on, else null.
   * routed(host):   false when the user routes only listed sites and this one
   *                 is not listed (optional; everything is routed without it).
   */
  constructor(log, getSocksPort, routed) {
    this.log = log || (() => {});
    this.getSocksPort = getSocksPort || (() => null);
    // async (): resolves once the engine is up, or it is not coming (main.js).
    this.waitForEngine = null;
    // (): the engine is still on its way after that wait (main.js).
    this.engineDue = () => false;
    this.routed = routed || (() => true);
    this.lookup = lookupAll;            // tests stand in for this machine's DNS
    this.direct = direct;               // ... for the way straight out
    this.tlsOptions = null;             // ... and for the certificates trusted
    this.forwards = 0;                  // requests made for a program (_forward)
    this.server = null;
    this.port = 0;
    this.tunnels = 0;
    this.lastOkAt = 0;
    this.sockets = new Set();
    this.open = 0;
    this.decisions = new Map();         // host -> { via, until }
    // A line about a host it could not reach: at once, then at most every
    // half hour per host (log-gate.js; main.js shares one with the engine).
    this.logGate = new LogGate();
    // Told of every tunnel that opened (host, 'engine' | 'direct'): how the
    // app knows a program really goes through Shroudly, not just that the
    // setting was written.
    this.onTunnel = null;
    // Told of every request that arrives (host), before it is carried on: a
    // program that uses the setting is using it even while the site it asks
    // for cannot be reached.
    this.onRequest = null;
  }

  get running() { return !!this.server; }
  get url() { return this.server ? proxyUrl(this.port) : null; }

  /* Listen on `preferred` if it is free, else on the first free fallback. The
   * address ends up in the session's environment, so callers keep it stable. */
  async start(preferred) {
    if (this.server) return this.port;
    const tries = [...new Set([Number(preferred) || 0, ...PREFERRED_PORTS].filter(Boolean)), 0];
    let lastErr;
    for (const p of tries) {
      try { return await this._listen(p); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no port');
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => { this._forward(req, res); });
      srv.on('connect', (req, sock, head) => { this._tunnel(req, sock, head); });
      srv.on('clientError', (e, sock) => {
        try { if (sock.writable) sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); else sock.destroy(); } catch {}
      });
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        srv.on('error', () => {});
        this.server = srv;
        this.port = srv.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    if (!this.server) return;
    try { this.server.close(); } catch {}
    for (const s of this.sockets) { try { s.destroy(); } catch {} }
    this.sockets.clear();
    this.decisions.clear();
    this.server = null;
  }

  /* Programs retry constantly: the line about a host is said the first
   * time, then at most every half hour for that host and kind. */
  _warn(kind, host, msg) {
    if (!this.logGate.allow(kind, host)) return;
    this.log('warning', msg);
  }

  _track(s) { this.sockets.add(s); s.once('close', () => this.sockets.delete(s)); }

  /* 'engine' | 'direct' | 'refuse' for host, with protection on or off;
   * 'later' for what would go into an engine still on its way. */
  async route(host) {
    if (net.isIP(host)) {
      const c = addrClass(host);
      if (c === 'loopback' || c === 'unspecified' || c === 'linklocal') return 'refuse';
      if (c === 'private' || !this.routed(host)) return 'direct';
      return this.getSocksPort() ? 'engine' : this._offRoute();
    }
    if (host === 'localhost' || host.endsWith('.localhost')) return 'refuse';
    if (isLocalName(host)) return 'direct';
    if (!this.routed(host)) return 'direct';
    if (!this.getSocksPort()) return this._offRoute();

    const hit = this.decisions.get(host);
    if (hit && hit.until > Date.now()) return hit.via;
    // What this machine's own DNS says. Unknown here, or public: the engine
    // (with its own DNS). A private answer is an internal server, unless it
    // is a known block page.
    // 0.0.0.0 or :: is not a server anywhere: it is how DNS filters (a
    // local ad blocker, an ISP) say "blocked", so the engine's own DNS decides.
    const addrs = await this.lookup(host);
    let via = 'engine';
    if (addrs && addrs.length && !addrs.some((a) => countryOf(embeddedV4(a) || a))) {
      const classes = addrs.map(addrClass);
      if (!classes.includes('unspecified') && classes.every((c) => c !== 'public')) via = 'direct';
    }
    if (this.decisions.size > 4000) this.decisions.clear();
    this.decisions.set(host, { via, until: Date.now() + DECISION_TTL_MS });
    return via;
  }

  /* No engine: straight out while protection is off; while it is on its
   * way, nothing yet. */
  _offRoute() {
    let due = false;
    try { due = !!this.engineDue(); } catch {}
    return due ? 'later' : 'direct';
  }

  /* A connection to host:port the way route() says: { up, via }. Throws with
   * .status (the answer for the program) when there is none. */
  async _open(host, port) {
    let via;
    try {
      // As in the Discord relay: protection on its way up is waited for, so
      // a program started at login does not go out directly and fail.
      if (this.waitForEngine) { try { await this.waitForEngine(); } catch {} }
      via = await this.route(host);
      if (via === 'refuse') throw Object.assign(new Error('not carried'), { status: 403 });
      if (via === 'later') throw Object.assign(new Error('Shroudly is restarting; try again in a moment'), { later: true });
      const socksPort = via === 'engine' ? this.getSocksPort() : null;
      const up = socksPort ? await socksConnect(socksPort, host, port) : await this.direct(host, port);
      return { up, via: socksPort ? 'engine' : 'direct' };
    } catch (e) {
      if (e && e.status) throw e;
      // "Shroudly is restarting": one line per restart, not one per host.
      this._warn(e && e.later ? 'apps-restarting' : 'apps-unreachable', e && e.later ? '*' : host, `Games and apps: could not reach ${host} (${e.message})`);
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { status: 502 });
    }
  }

  _opened(host, via) {
    this.tunnels++;
    this.lastOkAt = Date.now();
    this.logGate.forget('apps-unreachable', host);
    if (this.onTunnel) { try { this.onTunnel(host, via); } catch {} }
  }

  async _tunnel(req, client, head) {
    this._track(client);
    client.on('error', () => {});
    const t = parseTarget(String(req.url || ''));
    if (!t) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    if (this.onRequest) { try { this.onRequest(t.host); } catch {} }
    if (this.open >= MAX_TUNNELS) { client.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    this.open++;
    client.once('close', () => { this.open--; });

    let up; let via;
    try { ({ up, via } = await this._open(t.host, t.port)); } catch (e) {
      if (!client.destroyed) client.end(e.status === 403 ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    if (client.destroyed) { up.destroy(); return; }
    this._track(up);
    this._opened(t.host, via);

    const end = () => { client.destroy(); up.destroy(); };
    up.on('error', end); client.on('error', end);
    up.on('close', end); client.on('close', end);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  }

  /* "GET https://host/path HTTP/1.1": the request made for the program.
   *
   * Given an http:// proxy for an https:// address, curl, Go, Python and
   * Node.js itself ask for a tunnel. axios does not (nor do a few older
   * libraries): it hands the proxy the whole address and expects the answer
   * back. Refused, as it was up to 2.6.74, every program built on it failed
   * from the moment the mode was on, protection on or off (TruckersMP's
   * launcher: "Request failed with status code 405"). So it is carried: the
   * connection goes where a tunnel to that host would, TLS is made here with
   * the server's certificate checked, and the request and its answer pass
   * through unchanged.
   *
   * Only https://: this is nobody's proxy for plain http, and a request line
   * that holds only a path (all a web page can make a browser send here) is
   * refused as before. */
  async _forward(req, res) {
    const refuse = (code, headers) => { try { res.writeHead(code, { connection: 'close', ...(headers || {}) }); res.end(); } catch {} };
    const rawUrl = String(req.url || '');
    let u = null;
    if (/^https:\/\//i.test(rawUrl)) { try { u = new URL(rawUrl); } catch {} }
    if (!u || u.protocol !== 'https:') { req.resume(); refuse(405, { allow: 'CONNECT' }); return; }
    const t = u.username || u.password ? null : parseTarget(`${u.hostname}:${u.port || 443}`);
    if (!t) { req.resume(); refuse(400); return; }
    if (this.onRequest) { try { this.onRequest(t.host); } catch {} }
    if (this.open >= MAX_TUNNELS) { req.resume(); refuse(503); return; }
    this.open++;
    let closed = false;
    res.once('close', () => { closed = true; this.open--; });
    req.on('error', () => {}); res.on('error', () => {});

    let up; let via;
    try {
      ({ up, via } = await this._open(t.host, t.port));
      this._track(up);
      up = await secure(up, t.host, this.tlsOptions);
    } catch (e) {
      if (!e.status) this._warn('apps-unreachable', t.host, `Games and apps: could not reach ${t.host} (${e.message})`);
      req.resume(); refuse(e.status === 403 ? 403 : 502);
      return;
    }
    if (closed) { up.destroy(); return; }
    this._track(up);
    this._opened(t.host, via);
    this.forwards++;
    if (this.logGate.allow('apps-forward', '*')) {
      this.log('info', `Games and apps: a program asked for https://${t.host} without a tunnel (as programs built on axios do); Shroudly makes such requests for it`);
    }

    const headers = carried(req.rawHeaders, false);
    headers.Host = u.host;
    headers.Connection = 'close';
    // No agent named: only then does Node.js use the connection handed to it.
    const out = http.request({ createConnection: () => up, method: req.method, path: `${u.pathname || '/'}${u.search || ''}`, headers, setHost: false });
    const drop = () => { out.destroy(); up.destroy(); };
    res.once('close', drop);
    out.on('error', () => { if (!res.headersSent) refuse(502); else res.destroy(); up.destroy(); });
    out.on('response', (r) => {
      r.on('error', () => { res.destroy(); });
      try { res.writeHead(r.statusCode, r.statusMessage, carried(r.rawHeaders, true)); } catch { res.destroy(); drop(); return; }
      r.pipe(res);
    });
    req.pipe(out);
  }
}

module.exports = AppProxy;
module.exports.proxyUrl = proxyUrl;
module.exports.parseTarget = parseTarget;
module.exports.isLocal = isLocal;
module.exports.addrClass = addrClass;
module.exports.embeddedV4 = embeddedV4;
module.exports.PREFERRED_PORTS = PREFERRED_PORTS;
