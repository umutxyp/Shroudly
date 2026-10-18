'use strict';

/*
 * DiscordRelay — gets the Discord app's own updater through.
 *
 * The Discord app checks for updates before it opens, with a native updater
 * (a Rust library inside Discord). That updater ignores the system proxy, so
 * Shroudly never sees its traffic. On macOS and older Windows it also speaks
 * at most TLS 1.2, where the server's certificate travels in the clear: a
 * filter can read "discord.com" in the server's reply and cut the connection,
 * whatever is done to the client's side — Advanced mode included. The result
 * is a Discord that sits on "Checking for updates" while the browser works.
 *
 * Discord reads the update server's address from its settings.json
 * (NEW_UPDATE_ENDPOINT; see discord-app.js). Pointed here, the updater talks
 * plain HTTP to this machine and each request is repeated to Discord over
 * TLS 1.3 — through the engine while protection is on, directly while it is
 * off. Download links in the update manifest, and redirects, are rewritten to
 * come back here as well. Nothing else is changed: the updater checks every
 * package against the SHA-256 in the manifest, so an altered byte is refused.
 *
 * Only this machine can reach it, only with its own address in the Host
 * header (a web page cannot rebind a name onto it), and it only forwards GET
 * and HEAD to Discord's own domains.
 */

const http = require('http');
const net = require('net');
const tls = require('tls');

const PREFERRED_PORTS = [10809, 18809, 28809];
const UPSTREAM_DEFAULT = 'updates.discord.com';
const HOST_PREFIX = '/__h/';      // /__h/<host>/<path>: a rewritten link
const IDLE_MS = 30000;

// Every domain Discord the company serves the app, its updates, media and
// activities from.
const DISCORD_DOMAINS = [
  'discord.com', 'discord.gg', 'discord.co', 'discord.media', 'discord.new',
  'discord.gift', 'discord.gifts', 'discord.dev', 'discord.design', 'discord.store',
  'discord.tools', 'discordapp.com', 'discordapp.net', 'discordcdn.com',
  'discordstatus.com', 'discordsays.com', 'discordsez.com', 'discordactivities.com',
  'discord-activities.com', 'dis.gd',
];

function isDiscordHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(h)) return false;
  return DISCORD_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/* Absolute https links on Discord's domains -> this relay. */
function rewriteUrls(text, base) {
  return text.replace(/https:\/\/([a-z0-9.-]+)(?=[/"'?\s]|$)/gi, (m, host) =>
    (isDiscordHost(host) ? `${base}${HOST_PREFIX}${host.toLowerCase()}` : m));
}

/* The address part of a SOCKS5 request. A name goes as a name, so the engine
 * resolves it with its own DNS; an address goes as an address. */
function socksAddress(host) {
  if (net.isIPv4(host)) return Buffer.from([1, ...host.split('.').map(Number)]);
  if (net.isIPv6(host)) {
    // A trailing dotted quad (::ffff:1.2.3.4) is two 16-bit words.
    let ip = host.replace(/%.*$/, '');
    const q = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
    if (q) ip = `${ip.slice(0, q.index)}${((+q[1] << 8) | +q[2]).toString(16)}:${((+q[3] << 8) | +q[4]).toString(16)}`;
    const [head, tail = ''] = ip.split('::');
    const parts = (s) => (s ? s.split(':') : []);
    const h = parts(head); const t = parts(tail);
    const words = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    const b = Buffer.alloc(17); b[0] = 4;
    words.forEach((w, i) => b.writeUInt16BE(parseInt(w, 16) || 0, 1 + i * 2));
    return b;
  }
  const h = Buffer.from(host);
  return Buffer.concat([Buffer.from([3, h.length]), h]);
}

function socksConnect(socksPort, host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: socksPort });
    const fail = (e) => { s.destroy(); reject(e); };
    s.setTimeout(15000, () => fail(new Error('SOCKS timeout')));
    s.once('error', fail);
    s.once('close', () => reject(new Error('SOCKS closed')));
    let stage = 0;
    let buf = Buffer.alloc(0);
    s.once('connect', () => s.write(Buffer.from([5, 1, 0])));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('SOCKS auth refused'));
        buf = buf.subarray(2);
        stage = 1;
        s.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(host), Buffer.from([port >> 8, port & 255])]));
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(new Error(`SOCKS connect failed (${buf[1]})`));
        const need = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
        if (buf.length < need) return;
        s.removeListener('data', onData);
        s.removeListener('error', fail);
        s.removeAllListeners('close');
        s.setTimeout(0);
        if (buf.length > need) s.unshift(buf.subarray(need));
        resolve(s);
      }
    };
    s.on('data', onData);
  });
}

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

class DiscordRelay {
  /* getSocksPort(): the engine's port while protection is on, else null. */
  constructor(log, getSocksPort) {
    this.log = log || (() => {});
    this.getSocksPort = getSocksPort || (() => null);
    // async (): resolves once the engine is up, or it is not coming (main.js).
    this.waitForEngine = null;
    this.server = null;
    this.port = 0;
    this.requests = 0;
    this.lastOkAt = 0;
    this._warnedAt = 0;
  }

  get running() { return !!this.server; }

  /* Listen on `preferred` if it is free, else on the first free fallback.
   * The port ends up in Discord's settings, so callers keep it stable. */
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
      const srv = http.createServer((req, res) => this._handle(req, res));
      srv.on('clientError', (e, sock) => { try { sock.destroy(); } catch {} });
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
    try { this.server.closeAllConnections?.(); } catch {}
    this.server = null;
  }

  _warn(msg) {
    // One line every half minute is enough: the updater retries constantly.
    const now = Date.now();
    if (now - this._warnedAt < 30000) return;
    this._warnedAt = now;
    this.log('warning', msg);
  }

  async _connect(host) {
    // Protection on its way up (at login, or the engine being restarted):
    // wait for it rather than go out directly, which a filtering network
    // refuses, leaving Discord saying "retrying".
    if (this.waitForEngine) { try { await this.waitForEngine(); } catch {} }
    const socksPort = this.getSocksPort();
    const raw = socksPort
      ? await socksConnect(socksPort, host, 443)
      : await new Promise((resolve, reject) => {
        const s = net.connect({ host, port: 443 });
        s.setTimeout(15000, () => { s.destroy(); reject(new Error('connect timeout')); });
        s.once('error', reject);
        s.once('connect', () => { s.setTimeout(0); s.removeListener('error', reject); resolve(s); });
      });
    // TLS 1.3 is the point: it keeps the server's certificate encrypted.
    const sock = tls.connect({ socket: raw, servername: host, minVersion: 'TLSv1.3', ALPNProtocols: ['http/1.1'] });
    sock.setTimeout(IDLE_MS, () => sock.destroy(new Error('timed out')));
    return sock;
  }

  async _handle(req, res) {
    const self = `127.0.0.1:${this.port}`;
    const hostHdr = String(req.headers.host || '').toLowerCase();
    if (hostHdr !== self && hostHdr !== `localhost:${this.port}`) { res.writeHead(403).end(); return; }

    let host = UPSTREAM_DEFAULT;
    let path = req.url || '/';
    if (path.startsWith(HOST_PREFIX)) {
      const rest = path.slice(HOST_PREFIX.length);
      const i = rest.search(/[/?]/);
      host = (i < 0 ? rest : rest.slice(0, i)).toLowerCase();
      path = i < 0 ? '/' : rest.slice(i);
      if (!path.startsWith('/')) path = `/${path}`;
    }
    if (!isDiscordHost(host) || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(403).end(); return; }

    this.requests++;

    const headers = { ...req.headers, host };
    for (const h of HOP) delete headers[h];
    // Responses may need their links rewritten, so ask for them uncompressed.
    // Update packages are compressed archives already; nothing is lost.
    headers['accept-encoding'] = 'identity';
    const base = `http://${self}`;

    // One more try on a new connection when the first fails before any answer
    // (cut during the handshake, a way through that stopped working): the
    // engine picks another way, and Discord's updater, which shows "Update
    // failed" at the first error, need not see it.
    const attempt = async (n) => {
      let sock;
      try {
        sock = await this._connect(host);
      } catch (e) {
        if (n < 2 && !res.writableEnded && !res.destroyed) { attempt(n + 1); return; }
        this._warn(`Discord app: could not reach ${host} (${e.message})`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
        return;
      }
      let answered = false;
      const up = http.request({ createConnection: () => sock, method: req.method, path, headers }, (ur) => {
        answered = true;
        const h = { ...ur.headers };
        for (const k of HOP) delete h[k];
        if (h.location && /^https:\/\//i.test(h.location)) h.location = rewriteUrls(h.location, base);
        ur.on('error', () => res.destroy());
        if (ur.statusCode < 400) this.lastOkAt = Date.now();
        const json = /json/i.test(String(h['content-type'] || ''));
        if (json && req.method === 'GET') {
          const chunks = [];
          let size = 0;
          ur.on('data', (c) => {
            size += c.length;
            if (size > 8 * 1024 * 1024) { ur.destroy(); res.destroy(); return; }
            chunks.push(c);
          });
          ur.on('end', () => {
            const body = Buffer.from(rewriteUrls(Buffer.concat(chunks).toString('utf8'), base));
            delete h['content-encoding'];
            h['content-length'] = String(body.length);
            res.writeHead(ur.statusCode, h);
            res.end(body);
          });
          return;
        }
        res.writeHead(ur.statusCode, h);
        ur.pipe(res);
      });
      up.on('error', (e) => {
        if (!answered && n < 2 && !res.headersSent && !res.destroyed) { attempt(n + 1); return; }
        this._warn(`Discord app: ${host}${path.split('?')[0]} failed (${e.message})`);
        if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy();
      });
      // The updater hung up: drop the upstream request with it.
      res.on('close', () => { if (!res.writableFinished) up.destroy(); });
      up.end();
    };
    attempt(1);
  }
}

module.exports = DiscordRelay;
module.exports.isDiscordHost = isDiscordHost;
module.exports.rewriteUrls = rewriteUrls;
module.exports.DISCORD_DOMAINS = DISCORD_DOMAINS;
module.exports.socksConnect = socksConnect;
module.exports.socksAddress = socksAddress;
