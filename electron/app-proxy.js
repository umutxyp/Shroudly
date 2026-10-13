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
 * app-env.js points HTTPS_PROXY here. Every request is a CONNECT host:port,
 * handed to the engine by name, so the engine's own DNS and its desync apply
 * exactly as they do for the browser. While protection is off the tunnel goes
 * straight out, so those programs keep working. This machine and the local
 * network are always reached directly.
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
const { socksConnect } = require('./discord-relay');

const PREFERRED_PORTS = [10810, 18810, 28810];
const CONNECT_TIMEOUT_MS = 15000;

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

/* This machine, the local network, or a name only the local network knows:
 * never sent through the engine. */
function isLocal(host) {
  const h = String(host).toLowerCase();
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
           (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(h)) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return !h.includes('.') || h === 'localhost' || /\.(local|localhost|lan|internal|home\.arpa)$/.test(h);
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
  /* getSocksPort(): the engine's port while protection is on, else null. */
  constructor(log, getSocksPort) {
    this.log = log || (() => {});
    this.getSocksPort = getSocksPort || (() => null);
    this.server = null;
    this.port = 0;
    this.tunnels = 0;
    this.lastOkAt = 0;
    this.sockets = new Set();
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

  async _tunnel(req, client, head) {
    this._track(client);
    client.on('error', () => {});
    const t = parseTarget(String(req.url || ''));
    if (!t) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }

    const socksPort = isLocal(t.host) ? null : this.getSocksPort();
    let up;
    try {
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
module.exports.PREFERRED_PORTS = PREFERRED_PORTS;
