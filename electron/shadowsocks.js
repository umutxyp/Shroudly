'use strict';

/*
 * Shadowsocks (AEAD, SIP004), both ends, for "Use my own server" and "Share
 * my connection" (own-server.js, share.js).
 *
 * Shadowsocks because the people it is for already have it: in Iran the
 * servers sold and shared through a shutdown are given as ss:// links, and
 * every common app (v2rayNG, Hiddify, Shadowrocket, sing-box) takes one, so a
 * friend can join a Shroudly that shares its connection from any of them.
 * AEAD because the stream is both encrypted and authenticated: nothing on the
 * way can read it or change it, and it looks like random bytes to a filter.
 *
 * The wire, per direction: a random salt as long as the key, then chunks of
 * [length (2 bytes, at most 0x3FFF) + tag][payload + tag], each sealed with
 * the session subkey HKDF-SHA1(master key, salt, "ss-subkey") and a nonce
 * that counts up from zero (12 bytes, little-endian). The client's first
 * bytes of plaintext are the target, as in SOCKS5 (type, address, port).
 * The master key comes from the password as OpenSSL's EVP_BytesToKey (MD5).
 *
 * The server keeps the salts it has seen for a while and turns a repeated one
 * away (a recorded connection played back by someone probing it), and one
 * that fails to authenticate is held open in silence until it gives up,
 * never answered: a prober learns nothing from how it ends.
 */

const crypto = require('crypto');
const net = require('net');

const METHODS = {
  'chacha20-ietf-poly1305': { key: 32, cipher: 'chacha20-poly1305' },
  'aes-256-gcm': { key: 32, cipher: 'aes-256-gcm' },
  'aes-128-gcm': { key: 16, cipher: 'aes-128-gcm' },
};
const TAG = 16;
const MAX_CHUNK = 0x3fff;

function masterKey(password, len) {
  const out = [];
  let prev = Buffer.alloc(0);
  let have = 0;
  while (have < len) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(password, 'utf8')])).digest();
    out.push(prev);
    have += prev.length;
  }
  return Buffer.concat(out).subarray(0, len);
}

class Sealer {
  constructor(method, key, salt) {
    const m = METHODS[method];
    this.cipher = m.cipher;
    this.subkey = Buffer.from(crypto.hkdfSync('sha1', key, salt, Buffer.from('ss-subkey'), m.key));
    this.nonce = Buffer.alloc(12);
  }

  _bump() {
    for (let i = 0; i < this.nonce.length; i++) { this.nonce[i]++; if (this.nonce[i] !== 0) break; }
  }

  seal(plain) {
    const c = crypto.createCipheriv(this.cipher, this.subkey, this.nonce, { authTagLength: TAG });
    const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    this._bump();
    return body;
  }

  /* null when it does not authenticate. */
  open(sealed) {
    try {
      const d = crypto.createDecipheriv(this.cipher, this.subkey, this.nonce, { authTagLength: TAG });
      d.setAuthTag(sealed.subarray(sealed.length - TAG));
      const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
      this._bump();
      return plain;
    } catch { return null; }
  }
}

/* What one side sends: a salt first, then sealed chunks. `salt` only
 * for the tests' fixed vectors (tests/net/fixtures/ss-vectors.json, which
 * Android's Shadowsocks.kt is checked against too). */
class Encoder {
  constructor(method, key, salt = crypto.randomBytes(METHODS[method].key)) {
    this.method = method;
    this.key = key;
    this.salt = salt;
    this.s = new Sealer(method, key, this.salt);
    this.started = false;
  }

  encode(data) {
    const parts = [];
    if (!this.started) { parts.push(this.salt); this.started = true; }
    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      const piece = data.subarray(i, i + MAX_CHUNK);
      const len = Buffer.alloc(2);
      len.writeUInt16BE(piece.length);
      parts.push(this.s.seal(len), this.s.seal(piece));
    }
    return Buffer.concat(parts);
  }
}

/* What the other side reads back; `bad` once something did not
 * authenticate (the rest of the stream is then meaningless). */
class Decoder {
  constructor(method, key) {
    this.method = method;
    this.key = key;
    this.buf = Buffer.alloc(0);
    this.s = null;
    this.salt = null;
    this.want = 0;      // the payload length read, waiting for its body
    this.bad = false;
  }

  /* The plaintext that is complete so far. */
  push(data) {
    if (this.bad) return Buffer.alloc(0);
    this.buf = Buffer.concat([this.buf, data]);
    const out = [];
    const saltLen = METHODS[this.method].key;
    if (!this.s) {
      if (this.buf.length < saltLen) return Buffer.alloc(0);
      this.salt = Buffer.from(this.buf.subarray(0, saltLen));
      this.s = new Sealer(this.method, this.key, this.salt);
      this.buf = this.buf.subarray(saltLen);
    }
    for (;;) {
      if (!this.want) {
        if (this.buf.length < 2 + TAG) break;
        const len = this.s.open(this.buf.subarray(0, 2 + TAG));
        if (!len) { this.bad = true; break; }
        this.want = len.readUInt16BE(0) & MAX_CHUNK;
        this.buf = this.buf.subarray(2 + TAG);
        if (!this.want) { this.bad = true; break; }
      }
      if (this.buf.length < this.want + TAG) break;
      const plain = this.s.open(this.buf.subarray(0, this.want + TAG));
      if (!plain) { this.bad = true; break; }
      out.push(plain);
      this.buf = this.buf.subarray(this.want + TAG);
      this.want = 0;
    }
    return Buffer.concat(out);
  }
}

/* The target in SOCKS5 form: type, address, port. */
function encodeTarget(host, port) {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  if (net.isIPv4(host)) return Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number)), p]);
  if (net.isIPv6(host)) {
    // An IPv4 address written at the end (::ffff:1.2.3.4): as its two words.
    const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
    if (v4) {
      const [a, b, c, d] = v4.slice(1).map(Number);
      host = `${host.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const parts = host.split('::');
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
    const words = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    const b = Buffer.alloc(16);
    words.forEach((w, i) => b.writeUInt16BE(parseInt(w || '0', 16), i * 2));
    return Buffer.concat([Buffer.from([4]), b, p]);
  }
  const name = Buffer.from(host, 'utf8');
  if (name.length > 255) throw new Error('name too long');
  return Buffer.concat([Buffer.from([3, name.length]), name, p]);
}

/* { host, port, used } from the start of a buffer, null if not all there
 * yet, false if it cannot be one. */
function decodeTarget(b) {
  if (b.length < 1) return null;
  const t = b[0];
  if (t === 1) {
    if (b.length < 7) return null;
    return { host: [...b.subarray(1, 5)].join('.'), port: b.readUInt16BE(5), used: 7 };
  }
  if (t === 4) {
    if (b.length < 19) return null;
    const words = [];
    for (let i = 0; i < 8; i++) words.push(b.readUInt16BE(1 + i * 2).toString(16));
    return { host: words.join(':'), port: b.readUInt16BE(17), used: 19 };
  }
  if (t === 3) {
    if (b.length < 2) return null;
    const n = b[1];
    if (!n) return false;
    if (b.length < 2 + n + 2) return null;
    return { host: b.subarray(2, 2 + n).toString('utf8'), port: b.readUInt16BE(2 + n), used: 4 + n };
  }
  return false;
}

/* A connection through a Shadowsocks server to host:port: a duplex of the
 * plaintext, given as { socket, write(data), onData(fn), end() }. */
function connect({ server, port, method, password, host, targetPort, timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    const key = masterKey(password, METHODS[method].key);
    const enc = new Encoder(method, key);
    const dec = new Decoder(method, key);
    const s = net.connect({ host: server, port });
    s.setNoDelay(true);
    const timer = setTimeout(() => { s.destroy(); reject(new Error('the server does not answer')); }, timeout);
    s.once('error', (e) => { clearTimeout(timer); reject(e); });
    s.once('connect', () => {
      clearTimeout(timer);
      s.write(enc.encode(encodeTarget(host, targetPort)));
      resolve({ socket: s, enc, dec });
    });
  });
}

/* The client: a SOCKS5 server on 127.0.0.1 that sends every connection
 * through the Shadowsocks server. The engine is pointed at it as its own
 * server (--upstream-file), with `user` and `pass`, made fresh for each
 * client: another program or user of this computer cannot use the user's
 * server through it. Without them (the test in Settings), none is asked.
 * Resolves { port, close() }. */
function startClient({ server, port, method, password, user = '', pass = '', onError = () => {} }) {
  const key = masterKey(password, METHODS[method].key);
  const srv = net.createServer((c) => {
    c.on('error', () => {});
    let b = Buffer.alloc(0);
    let st = 0;
    const onData = (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0) {
        if (b.length < 2 || b.length < 2 + b[1]) return;
        const offered = [...b.subarray(2, 2 + b[1])];
        b = b.subarray(2 + b[1]);
        if (!user) { c.write(Buffer.from([5, 0])); st = 1; }
        else if (offered.includes(2)) { c.write(Buffer.from([5, 2])); st = 3; }
        else { c.end(Buffer.from([5, 0xff])); return; }
      }
      if (st === 3) {
        // RFC 1929: the user name and password the engine was given.
        if (b.length < 2 || b.length < 3 + b[1] || b.length < 3 + b[1] + b[2 + b[1]]) return;
        const u = b.subarray(2, 2 + b[1]).toString();
        const pw = b.subarray(3 + b[1], 3 + b[1] + b[2 + b[1]]).toString();
        b = b.subarray(3 + b[1] + b[2 + b[1]]);
        if (u !== user || pw !== pass) { c.end(Buffer.from([1, 1])); return; }
        c.write(Buffer.from([1, 0]));
        st = 1;
      }
      if (st === 1) {
        if (b.length < 4) return;
        if (b[0] !== 5 || b[1] !== 1) { c.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const tgt = decodeTarget(b.subarray(3));
        if (tgt === null) return;
        if (tgt === false) { c.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        st = 2;
        c.removeListener('data', onData);
        c.pause();
        const rest = b.subarray(3 + tgt.used);
        const enc = new Encoder(method, key);
        const dec = new Decoder(method, key);
        const up = net.connect({ host: server, port });
        up.setNoDelay(true);
        let answered = false;
        up.once('error', (e) => { if (!answered) { onError(e); c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); } c.destroy(); });
        up.once('connect', () => {
          answered = true;
          up.write(enc.encode(Buffer.concat([encodeTarget(tgt.host, tgt.port), rest])));
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          c.on('data', (x) => up.write(enc.encode(x)));
          up.on('data', (x) => {
            const plain = dec.push(x);
            if (dec.bad) { onError(new Error('the server\'s answer does not authenticate (another password or method)')); up.destroy(); c.destroy(); return; }
            if (plain.length) c.write(plain);
          });
          c.on('end', () => up.end());
          up.on('end', () => c.end());
          c.on('close', () => up.destroy());
          up.on('close', () => c.destroy());
          c.resume();
        });
      }
    };
    c.on('data', onData);
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

/* A set of the salts seen lately, bounded. */
class SaltLog {
  constructor(max = 100000) { this.max = max; this.set = new Set(); this.order = []; }
  seen(salt) {
    const k = salt.toString('hex');
    if (this.set.has(k)) return true;
    this.set.add(k);
    this.order.push(k);
    if (this.order.length > this.max) this.set.delete(this.order.shift());
    return false;
  }
}

/* The server for "Share my connection": takes Shadowsocks connections on
 * host:port and opens each target through `dial(host, port)` (Shroudly's
 * engine, so it gets past the filters on the sharer's own network too).
 * Nothing is logged of who connects or where to; only counts are kept
 * (people: the addresses connected right now, held only while they are).
 * opts.maxConns bounds what is open at once. Resolves { port, close(),
 * stats() }. */
function startServer({ host = '0.0.0.0', port = 0, method, password, dial, maxConns = 128 }) {
  const key = masterKey(password, METHODS[method].key);
  const salts = new SaltLog();
  const stats = { open: 0, total: 0, bytesUp: 0, bytesDown: 0, peers: new Map() };
  const conns = new Set();
  const srv = net.createServer((c) => {
    c.on('error', () => {});
    if (stats.open >= maxConns) { c.destroy(); return; }
    stats.open++;
    conns.add(c);
    c.once('close', () => { stats.open--; conns.delete(c); });
    // Nothing that can be a client's: held in silence until it gives up.
    const silence = () => { c.removeAllListeners('data'); c.on('data', () => {}); c.setTimeout(60000, () => c.destroy()); };
    const dec = new Decoder(method, key);
    let plain = Buffer.alloc(0);
    let started = false;
    const onData = (d) => {
      const p = dec.push(d);
      if (dec.bad) { silence(); return; }
      if (dec.salt && !started && dec.s && salts.seen(dec.salt)) { silence(); return; }
      started = started || !!dec.s;
      plain = Buffer.concat([plain, p]);
      const tgt = decodeTarget(plain);
      if (tgt === null) return;
      if (tgt === false) { silence(); return; }
      c.removeListener('data', onData);
      c.pause();
      stats.total++;
      const who = c.remoteAddress;
      stats.peers.set(who, (stats.peers.get(who) || 0) + 1);
      c.once('close', () => { const n = stats.peers.get(who) - 1; if (n > 0) stats.peers.set(who, n); else stats.peers.delete(who); });
      const rest = plain.subarray(tgt.used);
      Promise.resolve(dial(tgt.host, tgt.port)).then((up) => {
        const enc = new Encoder(method, key);
        if (rest.length) up.write(rest);
        c.on('data', (x) => {
          const q = dec.push(x);
          if (dec.bad) { c.destroy(); up.destroy(); return; }
          if (q.length) { stats.bytesUp += q.length; up.write(q); }
        });
        up.on('data', (x) => { stats.bytesDown += x.length; c.write(enc.encode(x)); });
        c.on('end', () => up.end());
        up.on('end', () => c.end());
        c.on('close', () => up.destroy());
        up.on('close', () => c.destroy());
        up.on('error', () => c.destroy());
        c.resume();
      }, () => c.destroy());
    };
    c.on('data', onData);
    c.setTimeout(30000, () => { if (!started) c.destroy(); });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => resolve({
      port: srv.address().port,
      // Everyone still connected is let go at once.
      close: () => new Promise((r) => { srv.close(() => r()); for (const c of conns) c.destroy(); }),
      stats: () => ({ open: stats.open, total: stats.total, people: stats.peers.size, bytesUp: stats.bytesUp, bytesDown: stats.bytesDown }),
    }));
  });
}

module.exports = { METHODS, masterKey, Encoder, Decoder, encodeTarget, decodeTarget, connect, startClient, startServer, SaltLog };
