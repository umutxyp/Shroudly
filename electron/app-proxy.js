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
 * app-env.js points HTTPS_PROXY here. Every request is a CONNECT host:port.
 * Where it goes:
 *  - into the engine, by name, so its own DNS and its desync apply exactly as
 *    they do for the browser: anything on the public internet;
 *  - straight out: the local network, names this machine's own DNS resolves
 *    to a private address (a company's internal servers, which public DNS
 *    does not know and must not be asked about), everything while protection
 *    is off, and everything not on the list when the user routes only listed
 *    sites;
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
 * Only this machine can reach it, and it only tunnels. Anything that is not
 * CONNECT is refused, and a web page cannot send CONNECT.
 */

const http = require('http');
const net = require('net');
const dns = require('dns');
const { socksConnect } = require('./discord-relay');
const { countryOf } = require('./censor-fingerprints');

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
    this.routed = routed || (() => true);
    this.lookup = lookupAll;            // tests stand in for this machine's DNS
    this.server = null;
    this.port = 0;
    this.tunnels = 0;
    this.lastOkAt = 0;
    this.sockets = new Set();
    this.open = 0;
    this.decisions = new Map();         // host -> { via, until }
    this._warnedAt = 0;
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
      const srv = http.createServer((req, res) => { res.writeHead(405, { allow: 'CONNECT' }); res.end(); });
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

  _warn(msg) {
    // One line every half minute is enough: programs retry constantly.
    const now = Date.now();
    if (now - this._warnedAt < 30000) return;
    this._warnedAt = now;
    this.log('warning', msg);
  }

  _track(s) { this.sockets.add(s); s.once('close', () => this.sockets.delete(s)); }

  /* 'engine' | 'direct' | 'refuse' for host, with protection on or off. */
  async route(host) {
    if (net.isIP(host)) {
      const c = addrClass(host);
      if (c === 'loopback' || c === 'unspecified' || c === 'linklocal') return 'refuse';
      if (c === 'private' || !this.getSocksPort()) return 'direct';
      return this.routed(host) ? 'engine' : 'direct';
    }
    if (host === 'localhost' || host.endsWith('.localhost')) return 'refuse';
    if (isLocalName(host)) return 'direct';
    if (!this.getSocksPort() || !this.routed(host)) return 'direct';

    const hit = this.decisions.get(host);
    if (hit && hit.until > Date.now()) return hit.via;
    // What this machine's own DNS says. Unknown here, or public: the engine
    // (with its own DNS). A private answer is an internal server, unless it
    // is a known block page.
    const addrs = await this.lookup(host);
    let via = 'engine';
    if (addrs && addrs.length && !addrs.some((a) => countryOf(embeddedV4(a) || a))) {
      const classes = addrs.map(addrClass);
      if (classes.every((c) => c !== 'public')) via = 'direct';
    }
    if (this.decisions.size > 4000) this.decisions.clear();
    this.decisions.set(host, { via, until: Date.now() + DECISION_TTL_MS });
    return via;
  }

  async _tunnel(req, client, head) {
    this._track(client);
    client.on('error', () => {});
    const t = parseTarget(String(req.url || ''));
    if (!t) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    if (this.open >= MAX_TUNNELS) { client.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    this.open++;
    client.once('close', () => { this.open--; });

    let up;
    try {
      const via = await this.route(t.host);
      if (via === 'refuse') { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const socksPort = via === 'engine' ? this.getSocksPort() : null;
      up = socksPort ? await socksConnect(socksPort, t.host, t.port) : await direct(t.host, t.port);
    } catch (e) {
      this._warn(`Games and apps: could not reach ${t.host} (${e.message})`);
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    if (client.destroyed) { up.destroy(); return; }
    this._track(up);
    this.tunnels++;
    this.lastOkAt = Date.now();

    const end = () => { client.destroy(); up.destroy(); };
    up.on('error', end); client.on('error', end);
    up.on('close', end); client.on('close', end);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  }
}

module.exports = AppProxy;
module.exports.proxyUrl = proxyUrl;
module.exports.parseTarget = parseTarget;
module.exports.isLocal = isLocal;
module.exports.addrClass = addrClass;
module.exports.embeddedV4 = embeddedV4;
module.exports.PREFERRED_PORTS = PREFERRED_PORTS;
