'use strict';

/* A stand-in for an app whose protocol is neither TLS nor HTTP: MTProto's
 * obfuscated transport, as Telegram's apps open every connection to a data
 * centre (https://core.telegram.org/mtproto/mtproto-transports#transport-obfuscation).
 * The first 64 bytes are random except for a protocol tag at 56..59, and the
 * key and IV that hide the tag are bytes 8..55 of those same 64 bytes, so a
 * filter that has the whole opening in one piece can recover the tag and
 * recognise the protocol; one that does not, cannot. That is exactly the
 * filter the censor below plays.
 *
 *   client(socket)          sends an opening and one abridged message, resolves
 *                           with what the server answered
 *   server()                a "data centre": checks the tag and the message, and
 *                           answers; .seen counts the good openings
 *   isOpening(buf)          the filter's test: a whole opening with a tag
 *   censor(target, opts)    a filter in front of a server; see below
 */

const net = require('net');
const crypto = require('crypto');

const TAGS = ['efefefef', 'eeeeeeee', 'dddddddd'];

function opening() {
  for (;;) {
    const init = crypto.randomBytes(64);
    // What the transport forbids at the start, so it is never taken for
    // another protocol (and what keeps the stand-in honest).
    const first4 = init.readUInt32LE(0);
    if (init[0] === 0xef) continue;
    if ([0x44414548, 0x54534f50, 0x20544547, 0x4954504f, 0xdddddddd, 0xeeeeeeee, 0x02010316].includes(first4)) continue;
    if (init.readUInt32LE(4) === 0) continue;
    init.writeUInt32BE(0xefefefef, 56);
    const enc = crypto.createCipheriv('aes-256-ctr', init.subarray(8, 40), init.subarray(40, 56));
    const encrypted = enc.update(init);
    const out = Buffer.concat([init.subarray(0, 56), encrypted.subarray(56, 64)]);
    return { out, enc };
  }
}

/* The tag hidden at 56..59 of a 64-byte opening, or null. */
function tagOf(buf) {
  if (!buf || buf.length < 64) return null;
  const dec = crypto.createDecipheriv('aes-256-ctr', buf.subarray(8, 40), buf.subarray(40, 56));
  const plain = dec.update(buf.subarray(0, 64));
  const tag = plain.subarray(56, 60).toString('hex');
  return TAGS.includes(tag) ? tag : null;
}
const isOpening = (buf) => tagOf(buf) !== null;

/* One abridged message: length in 4-byte words, then the bytes. */
function message(body) { return Buffer.concat([Buffer.from([body.length / 4]), body]); }

/* Speak the protocol on an open socket (a SOCKS connection through the
 * engine): resolves with the answer, rejects when the connection is refused
 * or nothing comes back in timeoutMs. */
function client(sock, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const { out, enc } = opening();
    const body = crypto.randomBytes(40);
    sock.write(Buffer.concat([out, enc.update(message(body))]));
    let got = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('no answer')); }, timeoutMs);
    sock.on('data', (d) => {
      got = Buffer.concat([got, d]);
      if (got.length >= 8) { clearTimeout(timer); sock.destroy(); resolve(got); }
    });
    sock.on('error', () => {});
    sock.on('close', () => { clearTimeout(timer); if (got.length < 8) reject(new Error('closed')); });
  });
}

/* A data centre: reads the opening and the first message, answers 8 bytes. */
function server() {
  const srv = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 64 + 41) return;
      const dec = crypto.createDecipheriv('aes-256-ctr', buf.subarray(8, 40), buf.subarray(40, 56));
      const plain = dec.update(buf.subarray(0, 64 + 41));
      if (plain.readUInt32BE(56) !== 0xefefefef || plain[64] !== 10) { srv.bad++; c.destroy(); return; }
      srv.seen++;
      c.write(crypto.randomBytes(8));
      c.removeAllListeners('data');
    });
  });
  srv.seen = 0;
  srv.bad = 0;
  return srv;
}

/* A filter in front of `targetPort` on 127.0.0.1 (or opts.host):
 *   mode 'first'  (stateless) looks at the first piece of each connection
 *                 only: a whole opening there is reset (or dropped, with
 *                 drop: true);
 *   mode 'stream' (reassembling) waits for 64 bytes, however they come, and
 *                 resets an opening: nothing short of an address change gets
 *                 past it.
 * .firsts records the length of each connection's first piece, .resets the
 * connections reset, .dropped those dropped. */
function censor(targetPort, opts = {}) {
  const c = net.createServer((sock) => {
    const mode = c.mode;
    const up = net.connect(targetPort, c.host);
    let first = true, held = Buffer.alloc(0), dead = false;
    const kill = () => {
      if (dead) return;
      dead = true;
      if (c.drop) { c.dropped++; up.destroy(); return; }   // swallow: the app hears nothing
      c.resets++;
      try { sock.resetAndDestroy(); } catch { sock.destroy(); }
      up.destroy();
    };
    sock.on('data', (d) => {
      if (dead) return;
      if (first) c.firsts.push(d.length);
      if (mode === 'first') {
        if (first && isOpening(d)) { first = false; kill(); return; }
        first = false;
        up.write(d);
        return;
      }
      first = false;
      if (held === null) { up.write(d); return; }
      held = Buffer.concat([held, d]);
      if (held.length < 64) return;
      if (isOpening(held)) { kill(); return; }
      up.write(held); held = null;
    });
    up.on('data', (d) => { if (!dead) sock.write(d); });
    sock.on('error', () => {}); up.on('error', () => {});
    sock.on('close', () => up.destroy());
    up.on('close', () => { if (!dead) sock.destroy(); });
  });
  c.mode = opts.mode || 'first';
  c.host = opts.host || '127.0.0.1';
  c.drop = !!opts.drop;
  c.firsts = [];
  c.resets = 0;
  c.dropped = 0;
  return c;
}

/* The real thing, for a real data centre: the opening, then req_pq_multi
 * (https://core.telegram.org/method/req_pq_multi) as an unencrypted message,
 * and the answer read back with the server's key (the opening's bytes 8..55
 * reversed). Resolves when the answer is resPQ carrying our nonce: a
 * Telegram server took the connection exactly as an app's. */
function telegramHello(sock, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const { out, enc } = opening();
    const init = Buffer.concat([out.subarray(0, 56), Buffer.alloc(8)]);
    const rev = Buffer.from(init.subarray(8, 56)).reverse();
    const dec = crypto.createDecipheriv('aes-256-ctr', rev.subarray(0, 32), rev.subarray(32, 48));
    const nonce = crypto.randomBytes(16);
    const msg = Buffer.alloc(40);
    // auth_key_id 0, message_id (time * 2^32, divisible by 4), length 20
    const t = BigInt(Math.floor(Date.now() / 1000)) << 32n;
    msg.writeBigUInt64LE(t, 8);
    msg.writeUInt32LE(20, 16);
    msg.writeUInt32LE(0xbe7e8ef1, 20);
    nonce.copy(msg, 24);
    sock.write(Buffer.concat([out, enc.update(message(msg))]));
    let got = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('no answer')); }, timeoutMs);
    sock.on('data', (d) => {
      got = Buffer.concat([got, dec.update(d)]);
      if (got.length < 1 + 20 + 4 + 16) return;
      clearTimeout(timer);
      sock.destroy();
      const ctor = got.readUInt32LE(1 + 20);
      if (ctor === 0x05162463 && got.subarray(1 + 24, 1 + 40).equals(nonce)) resolve(got);
      else reject(new Error(`unexpected answer ${got.subarray(0, 32).toString('hex')}`));
    });
    sock.on('error', () => {});
    sock.on('close', () => { clearTimeout(timer); reject(new Error('closed')); });
  });
}

module.exports = { opening, tagOf, isOpening, client, server, censor, message, telegramHello };
