'use strict';

/*
 * VLESS and Trojan, for "Your own server" (own-server.js): the kinds of
 * server people in Iran pass around as vless:// and trojan:// links, where
 * Shadowsocks is filtered by its look.
 *
 * Both are a short header in front of the connection's own bytes, carried
 * inside something a filter takes for ordinary web traffic:
 *
 *   VLESS   0x00, the 16 bytes of the user's UUID, 0x00 (no additions),
 *           0x01 (a TCP connection), the port (2 bytes), the address (1 an
 *           IPv4 address, 2 a name with its length, 3 an IPv6 address);
 *           the server answers 0x00, a length, that many bytes, then data.
 *   Trojan  the SHA-224 of the password in hex (56 letters), CRLF, 0x01,
 *           the address as SOCKS5 writes it (1 IPv4, 3 a name, 4 IPv6),
 *           the port, CRLF; nothing comes back but data.
 *
 * Carried here over:
 *   tcp          the header straight on the connection
 *   ws           a WebSocket (binary messages; masked on the way up, as
 *                every client's are): what servers behind Cloudflare and
 *                other CDNs use
 *   httpupgrade  the WebSocket's opening request and answer, then the bytes
 *                as they are
 * each with TLS (the system's own, with the certificate checked unless the
 * link says allowInsecure) or without.
 *
 * Not here: REALITY, the Vision flow, gRPC, XHTTP, mKCP, QUIC, and VLESS's
 * own encryption. Those need a TLS of their own making; a link that asks
 * for one is told so (parse: 'unsupported'), never tried another way.
 *
 * Only TCP connections are carried (as with Shadowsocks here).
 */

const crypto = require('crypto');
const net = require('net');
const tls = require('tls');

const NETS = ['tcp', 'ws', 'httpupgrade'];
// After the program closed its side, the server's last bytes are waited for
// this long (Xray itself gives a connection two seconds then).
const LINGER_MS = 10000;

function uuidBytes(text) {
  const hex = String(text || '').replace(/-/g, '');
  return /^[0-9a-fA-F]{32}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function hostPort(text) {
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(text) || /^([^\s:/@[\]]+):(\d{1,5})$/.exec(text);
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: m[1], port };
}

/* A name as it may stand in a Host header or as the certificate's name. */
function plainName(s) { return typeof s === 'string' && /^[A-Za-z0-9.\-_:[\]]{1,253}$/.test(s); }

/* vless://UUID@host:port?type=ws&security=tls&path=/x&host=h&sni=s#name and
 * trojan://password@host:port?…  ->  { ok: true, kind, host, port, id |
 * password, net, tls, sni, wsHost, path, alpn, insecure, name }, or
 * { ok: false, error: 'format' } or { ok: false, error: 'unsupported', what }
 * with what one of: reality, flow, encryption, transport, security. */
function parseLink(input) {
  const text = String(input || '').trim();
  const m = /^(vless|trojan):\/\/([^@/?#]+)@([^/?#]+)\/?(?:\?([^#]*))?(?:#(.*))?$/i.exec(text);
  if (!m) return { ok: false, error: 'format' };
  const kind = m[1].toLowerCase();
  const hp = hostPort(m[3]);
  if (!hp) return { ok: false, error: 'format' };
  let secret;
  let name = '';
  try { secret = decodeURIComponent(m[2]); } catch { return { ok: false, error: 'format' }; }
  try { name = m[5] ? decodeURIComponent(m[5]) : ''; } catch {}
  const q = {};
  for (const part of String(m[4] || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = (i < 0 ? part : part.slice(0, i)).toLowerCase();
    let v = i < 0 ? '' : part.slice(i + 1);
    try { v = decodeURIComponent(v.replace(/\+/g, '%20')); } catch { return { ok: false, error: 'format' }; }
    if (!(k in q)) q[k] = v;
  }
  const no = (what) => ({ ok: false, error: 'unsupported', what });
  const netKind = (q.type || q.net || 'tcp').toLowerCase();
  const security = (q.security || (kind === 'trojan' ? 'tls' : 'none')).toLowerCase();
  if (security === 'reality') return no('reality');
  if (security !== 'tls' && security !== 'none' && security !== '') return no('security');
  if (q.flow) return no('flow');
  if (kind === 'vless' && q.encryption && q.encryption.toLowerCase() !== 'none') return no('encryption');
  if (!NETS.includes(netKind)) return no('transport');
  // A header disguise on plain TCP (headerType=http) is another transport.
  if (netKind === 'tcp' && q.headertype && q.headertype.toLowerCase() !== 'none') return no('transport');
  const out = { ok: true, kind, ...hp, net: netKind, tls: security === 'tls', name };
  if (kind === 'vless') {
    const id = uuidBytes(secret);
    if (!id) return { ok: false, error: 'format' };
    out.id = id.toString('hex');
  } else {
    if (!secret || secret.length > 512 || /[\r\n]/.test(secret)) return { ok: false, error: 'format' };
    out.password = secret;
  }
  const sni = q.sni || q.peer || '';
  const wsHost = q.host || '';
  if ((sni && !plainName(sni)) || (wsHost && !plainName(wsHost))) return { ok: false, error: 'format' };
  out.sni = sni;
  out.wsHost = wsHost;
  // The path as the server knows it: Xray's "?ed=2048" (early data in the
  // opening request) is its client's own note, not part of the path.
  let p = q.path || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/([?&])ed=\d+(&|$)/, (all, a, b) => (b ? a : '')).replace(/[?&]$/, '');
  if (/[\s\r\n]/.test(p) || p.length > 1024) return { ok: false, error: 'format' };
  out.path = p || '/';
  out.alpn = String(q.alpn || '').split(',').map((x) => x.trim()).filter((x) => /^[a-z0-9./-]{1,16}$/i.test(x));
  out.insecure = ['1', 'true'].includes(String(q.allowinsecure || q.insecure || '').toLowerCase());
  return out;
}

/* The same server as a link again (what the settings keep is the user's own
 * text; this is for the tests and for showing a link without its secret). */
function describe(p) {
  const where = p.host.includes(':') ? `[${p.host}]:${p.port}` : `${p.host}:${p.port}`;
  const how = `${p.net === 'ws' ? 'WebSocket' : p.net === 'httpupgrade' ? 'HTTPUpgrade' : 'TCP'}${p.tls ? ' + TLS' : ''}`;
  return `${p.kind === 'vless' ? 'VLESS' : 'Trojan'} ${where} (${how})`;
}

/* ── the headers ────────────────────────────────────────────────────────── */

function ipv6Bytes(host) {
  // "::" filled in, a trailing IPv4 part taken as its two groups.
  let h = host;
  const v4 = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) h = `${v4[1]}${((Number(v4[2]) << 8) | Number(v4[3])).toString(16)}:${((Number(v4[4]) << 8) | Number(v4[5])).toString(16)}`;
  const [head, tail] = h.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined && tail ? tail.split(':') : [];
  const fill = h.includes('::') ? new Array(8 - a.length - b.length).fill('0') : [];
  const groups = [...a, ...fill, ...b];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

/* VLESS: what goes first on the connection, for a TCP connection to host:port. */
function vlessHeader(idHex, host, port) {
  const id = Buffer.from(idHex, 'hex');
  let addr;
  if (net.isIPv4(host)) addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]);
  else if (net.isIPv6(host)) addr = Buffer.concat([Buffer.from([3]), ipv6Bytes(host)]);
  else {
    const name = Buffer.from(host, 'utf8');
    if (!name.length || name.length > 255) throw new Error('a name too long for VLESS');
    addr = Buffer.concat([Buffer.from([2, name.length]), name]);
  }
  return Buffer.concat([Buffer.from([0]), id, Buffer.from([0, 1, port >> 8, port & 0xff]), addr]);
}

function trojanHeader(password, host, port) {
  const hash = Buffer.from(crypto.createHash('sha224').update(password, 'utf8').digest('hex'), 'latin1');
  let addr;
  if (net.isIPv4(host)) addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]);
  else if (net.isIPv6(host)) addr = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]);
  else {
    const name = Buffer.from(host, 'utf8');
    if (!name.length || name.length > 255) throw new Error('a name too long for Trojan');
    addr = Buffer.concat([Buffer.from([3, name.length]), name]);
  }
  const crlf = Buffer.from('\r\n', 'latin1');
  return Buffer.concat([hash, crlf, Buffer.from([1]), addr, Buffer.from([port >> 8, port & 0xff]), crlf]);
}

/* ── WebSocket, the little of it a tunnel needs ─────────────────────────── */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX_FRAME = 16 * 1024 * 1024;

/* One binary message, masked (every client-to-server frame is). */
function wsFrame(data, opcode = 2) {
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127, 0, 0, 0, 0]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; })()]);
  const mask = crypto.randomBytes(4);
  const body = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) body[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/* Takes the server's bytes, gives back the payloads of its data frames, in
 * order; onPing(payload) for a ping, onClose() for a close. Throws on what
 * no server sends (a masked frame, a length beyond WS_MAX_FRAME). */
class WsReader {
  constructor({ onPing = () => {}, onClose = () => {} } = {}) {
    this.buf = Buffer.alloc(0);
    this.onPing = onPing;
    this.onClose = onClose;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const opcode = b[0] & 0x0f;
      if (b[1] & 0x80) throw new Error('a masked frame from the server');
      let n = b[1] & 0x7f;
      let at = 2;
      if (n === 126) { if (b.length < 4) break; n = b.readUInt16BE(2); at = 4; } else if (n === 127) {
        if (b.length < 10) break;
        if (b.readUInt32BE(2) !== 0) throw new Error('a frame too long');
        n = b.readUInt32BE(6); at = 10;
      }
      if (n > WS_MAX_FRAME) throw new Error('a frame too long');
      if (b.length < at + n) break;
      const payload = b.subarray(at, at + n);
      this.buf = b.subarray(at + n);
      if (opcode === 0 || opcode === 1 || opcode === 2) { if (n) out.push(payload); } else if (opcode === 9) this.onPing(payload);
      else if (opcode === 8) { this.onClose(); break; }
      // a pong (10), or an opcode not known: nothing to do with it
    }
    return out;
  }
}

/* ── one connection through the server ──────────────────────────────────── */

function readUntil(s, done, timeout) {
  return new Promise((resolve, reject) => {
    let b = Buffer.alloc(0);
    const t = setTimeout(() => fail(new Error('timeout')), timeout);
    const off = () => { clearTimeout(t); s.removeListener('data', onData); s.removeListener('error', fail); s.removeListener('close', onEnd); };
    function fail(e) { off(); reject(e); }
    function onEnd() { fail(new Error('closed')); }
    function onData(d) {
      b = Buffer.concat([b, d]);
      let r;
      try { r = done(b); } catch (e) { fail(e); return; }
      if (r === null || r === undefined) { if (b.length > 65536) fail(new Error('too long')); return; }
      off();
      resolve(r);
    }
    s.on('data', onData);
    s.once('error', fail);
    s.once('close', onEnd);
  });
}

/* The connection to the server itself: TCP, then TLS where the link says
 * so. Rejects with e.why: 'noAnswer' (not reached), 'tls' (reached, and its
 * TLS or certificate refused). */
function dial(p, { timeout = 15000, ca = null, connectTo = null } = {}) {
  return new Promise((resolve, reject) => {
    const where = connectTo || { host: p.host, port: p.port };
    const raw = net.connect({ host: where.host, port: where.port, allowHalfOpen: true });
    let up = false;
    const fail = (why) => (e) => { raw.destroy(); reject(Object.assign(new Error(e && e.message ? e.message : why), { why })); };
    raw.setTimeout(timeout, () => fail(up ? 'tls' : 'noAnswer')(new Error('timeout')));
    raw.once('error', fail('noAnswer'));
    raw.once('connect', () => {
      up = true;
      raw.setNoDelay(true);
      if (!p.tls) { raw.setTimeout(0); raw.removeAllListeners('error'); resolve(raw); return; }
      const servername = p.sni || p.wsHost || p.host;
      const alpn = p.net === 'tcp' ? p.alpn : ['http/1.1'];
      const t = tls.connect({
        socket: raw,
        allowHalfOpen: true,
        ...(net.isIP(servername) ? {} : { servername }),
        ...(alpn && alpn.length ? { ALPNProtocols: alpn } : {}),
        rejectUnauthorized: !p.insecure,
        ...(ca ? { ca } : {}),
      });
      t.once('error', fail('tls'));
      t.once('secureConnect', () => { raw.setTimeout(0); t.removeAllListeners('error'); resolve(t); });
    });
  });
}

/* The opening request of a WebSocket (ws) or of a plain upgrade
 * (httpupgrade), and its answer. Resolves what came after the answer's
 * blank line (a server may send data right behind it). */
async function upgrade(s, p, timeout) {
  const key = crypto.randomBytes(16).toString('base64');
  const hostHeader = p.wsHost || p.sni || (p.host.includes(':') ? `[${p.host}]` : p.host);
  const lines = [
    `GET ${p.path || '/'} HTTP/1.1`,
    `Host: ${hostHeader}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    ...(p.net === 'ws' ? [`Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13'] : []),
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '', '',
  ];
  s.write(lines.join('\r\n'));
  return readUntil(s, (b) => {
    const end = b.indexOf('\r\n\r\n');
    if (end < 0) return null;
    const head = b.subarray(0, end).toString('latin1');
    if (!/^HTTP\/1\.1 101\b/.test(head)) throw Object.assign(new Error(`the server answered ${head.split('\r\n')[0].slice(0, 60)}`), { why: 'protocol' });
    if (p.net === 'ws') {
      const accept = (/^sec-websocket-accept:\s*(\S+)/im.exec(head) || [])[1];
      const want = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      if (accept !== want) throw Object.assign(new Error('not a WebSocket answer'), { why: 'protocol' });
    }
    return b.subarray(end + 4);
  }, timeout);
}

/* A connection to host:port through the server p. Resolves a Tunnel: write
 * (buf), end(), destroy(), and events through on('data' | 'close' |
 * 'error'). The header goes out with the first bytes written (or after
 * `firstWait` ms with none), as Xray's own client sends it. */
async function connect(p, host, port, opts = {}) {
  const timeout = opts.timeout || 15000;
  const s = await dial(p, opts);
  let rest = Buffer.alloc(0);
  try {
    if (p.net !== 'tcp') rest = await upgrade(s, p, timeout);
  } catch (e) {
    s.destroy();
    throw Object.assign(e, { why: e.why || 'protocol' });
  }
  return new Tunnel(s, p, host, port, rest);
}

class Tunnel extends require('events') {
  constructor(s, p, host, port, rest) {
    super();
    this.s = s;
    this.ws = p.net === 'ws';
    this.header = p.kind === 'vless' ? vlessHeader(p.id, host, port) : trojanHeader(p.password, host, port);
    // VLESS's answer starts with two bytes and its additions: taken off.
    this.skip = p.kind === 'vless' ? -1 : 0;   // -1: the two bytes not read yet
    this.pre = Buffer.alloc(0);
    this.closed = false;
    this.reader = this.ws ? new WsReader({
      onPing: (d) => { try { s.write(wsFrame(d, 10)); } catch {} },
      onClose: () => this.destroy(),
    }) : null;
    s.on('data', (d) => this._in(d));
    s.on('error', (e) => { if (!this.closed) this.emit('error', e); this.destroy(); });
    s.on('close', () => this.destroy());
    // The server is done sending: what it sent has been handed on already.
    s.on('end', () => this.destroy());
    if (rest.length) setImmediate(() => this._in(rest));
  }

  _send(b) { return this.s.write(this.ws ? wsFrame(b) : b); }

  write(b) {
    if (this.closed || this.ended) return false;
    if (this.header) { const h = this.header; this.header = null; return this._send(Buffer.concat([h, b])); }
    return this._send(b);
  }

  /* Nothing to send first (a server that speaks first: SMTP, SSH): the
   * header alone opens the connection. */
  open() { if (this.header && !this.closed) { const h = this.header; this.header = null; this._send(h); } }

  _in(d) {
    if (this.closed) return;
    let parts;
    try { parts = this.reader ? this.reader.push(d) : [d]; } catch (e) { this.emit('error', e); this.destroy(); return; }
    for (let b of parts) {
      if (this.skip !== 0) {
        this.pre = Buffer.concat([this.pre, b]);
        if (this.skip < 0) {
          if (this.pre.length < 2) continue;
          if (this.pre[0] !== 0) { this.emit('error', Object.assign(new Error('not a VLESS answer'), { why: 'protocol' })); this.destroy(); return; }
          this.skip = 2 + this.pre[1];
        }
        if (this.pre.length < this.skip) continue;
        b = this.pre.subarray(this.skip);
        this.pre = Buffer.alloc(0);
        this.skip = 0;
        this.answered = true;
        if (!b.length) continue;
      }
      this.answered = true;
      this.emit('data', b);
    }
  }

  pause() { this.s.pause(); }

  resume() { this.s.resume(); }

  /* The program has sent all it will (it closed its side): what it wrote
   * still goes out, and what the server still sends is still handed on,
   * for LINGER_MS at most. On plain TCP and HTTPUpgrade the server is told
   * (the connection's own end); a WebSocket has no way to say "done
   * sending" without closing, so it is only kept open that long. */
  end() {
    if (this.closed || this.ended) return;
    this.ended = true;
    if (this.header) this.open();
    if (!this.ws) { try { this.s.end(); } catch { this.destroy(); return; } }
    const t = setTimeout(() => this.destroy(), LINGER_MS);
    if (t.unref) t.unref();
    this.once('close', () => clearTimeout(t));
  }

  destroy() {
    const was = this.closed;
    this.closed = true;
    this.s.destroy();
    if (!was) this.emit('close');
  }
}

/* ── the local client ───────────────────────────────────────────────────── */

/* A SOCKS5 server on 127.0.0.1 that sends every connection through the
 * server p, as shadowsocks.js startClient does for Shadowsocks: the engine
 * is pointed at it (--upstream-file) with `user` and `pass`, made fresh for
 * each client, so no other program or user of this computer can use the
 * user's server through it. onError(e): the server could not be used (e.why
 * 'noAnswer', 'tls' or 'protocol'). Resolves { port, close() }. */
function startClient(p, { user = '', pass = '', onError = () => {}, ca = null, connectTo = null } = {}) {
  const open = new Set();
  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    c.on('error', () => {});
    open.add(c);
    c.on('close', () => open.delete(c));
    let b = Buffer.alloc(0);
    let st = 0;
    const onData = (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0) {
        if (b.length < 2 || b.length < 2 + b[1]) return;
        const offered = [...b.subarray(2, 2 + b[1])];
        b = b.subarray(2 + b[1]);
        if (!user) { c.write(Buffer.from([5, 0])); st = 1; } else if (offered.includes(2)) { c.write(Buffer.from([5, 2])); st = 3; } else { c.end(Buffer.from([5, 0xff])); return; }
      }
      if (st === 3) {
        if (b.length < 2 || b.length < 3 + b[1] || b.length < 3 + b[1] + b[2 + b[1]]) return;
        const u = b.subarray(2, 2 + b[1]).toString();
        const pw = b.subarray(3 + b[1], 3 + b[1] + b[2 + b[1]]).toString();
        b = b.subarray(3 + b[1] + b[2 + b[1]]);
        const same = u.length === user.length && pw.length === pass.length
          && crypto.timingSafeEqual(Buffer.from(u), Buffer.from(user)) && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(pass));
        if (!same) { c.end(Buffer.from([1, 1])); return; }
        c.write(Buffer.from([1, 0]));
        st = 1;
      }
      if (st === 1) {
        if (b.length < 5) return;
        if (b[0] !== 5 || b[1] !== 1) { c.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        let host; let at;
        if (b[3] === 1) { if (b.length < 10) return; host = [...b.subarray(4, 8)].join('.'); at = 8; } else if (b[3] === 3) {
          if (b.length < 7 + b[4]) return;
          host = b.subarray(5, 5 + b[4]).toString(); at = 5 + b[4];
        } else if (b[3] === 4) {
          if (b.length < 22) return;
          const g = [];
          for (let i = 0; i < 16; i += 2) g.push(b.readUInt16BE(4 + i).toString(16));
          host = g.join(':'); at = 20;
        } else { c.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const port = b.readUInt16BE(at);
        const early = b.subarray(at + 2);
        st = 2;
        c.removeListener('data', onData);
        c.pause();
        connect(p, host, port, { ca, connectTo }).then((t) => {
          if (c.destroyed) { t.destroy(); return; }
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          // Each side waits when the other cannot take more.
          let downHeld = false;
          let upHeld = false;
          t.on('data', (d2) => {
            if (!c.write(d2) && !downHeld) { downHeld = true; t.pause(); c.once('drain', () => { downHeld = false; t.resume(); }); }
          });
          t.on('error', () => {});
          // What the server sent last still reaches the program; what the
          // program wrote last still reaches the server.
          t.on('close', () => { if (!c.destroyed) c.end(); });
          c.on('end', () => t.end());
          c.on('close', () => t.destroy());
          if (early.length) t.write(early);
          // A program that waits for the server to speak first never sends:
          // the header then goes by itself.
          const first = setTimeout(() => t.open(), 300);
          c.on('data', (d2) => {
            clearTimeout(first);
            if (!t.write(d2) && !t.closed && !t.ended && !upHeld) { upHeld = true; c.pause(); t.s.once('drain', () => { upHeld = false; c.resume(); }); }
          });
          c.resume();
        }).catch((e) => {
          try { onError(e); } catch {}
          // 5: connection refused, as a SOCKS5 server says it.
          c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
      }
    };
    c.on('data', onData);
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => { srv.close(); for (const c of open) c.destroy(); },
    }));
  });
}

module.exports = { NETS, parseLink, describe, uuidBytes, vlessHeader, trojanHeader, wsFrame, WsReader, dial, connect, startClient, Tunnel };
