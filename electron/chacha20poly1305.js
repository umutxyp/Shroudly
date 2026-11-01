'use strict';

/*
 * ChaCha20-Poly1305 (RFC 8439), for Shadowsocks's chacha20-ietf-poly1305
 * where Node's crypto has no such cipher: Electron's (BoringSSL) does not.
 * Plain Node has it, and shadowsocks.js uses that whenever it is there; the
 * tests check this one against it and against the RFC's own vectors.
 *
 * Poly1305 with BigInt: one multiplication and one reduction per 16-byte
 * block, fast enough for one person's browsing through their own server.
 */

function rotl(v, n) { return ((v << n) | (v >>> (32 - n))) >>> 0; }

/* One 64-byte ChaCha20 block for (key words, counter, nonce words) into out. */
function block(k, counter, n, out) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = k[i];
  s[12] = counter >>> 0; s[13] = n[0]; s[14] = n[1]; s[15] = n[2];
  const x = Uint32Array.from(s);
  const qr = (a, b, c, d) => {
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12);
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) out.writeUInt32LE((x[i] + s[i]) >>> 0, i * 4);
}

const words = (buf, n) => { const w = new Uint32Array(n); for (let i = 0; i < n; i++) w[i] = buf.readUInt32LE(i * 4); return w; };

/* data XOR the key stream from block `counter` on. */
function chacha20(key, nonce, counter, data) {
  const k = words(key, 8);
  const n = words(nonce, 3);
  const out = Buffer.allocUnsafe(data.length);
  const ks = Buffer.allocUnsafe(64);
  for (let off = 0, c = counter; off < data.length; off += 64, c++) {
    block(k, c, n, ks);
    const end = Math.min(64, data.length - off);
    for (let i = 0; i < end; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}

const P = (1n << 130n) - 5n;
const M130 = (1n << 130n) - 1n;
const leBig = (b) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };

function poly1305(key, msg) {
  const r = leBig(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBig(key.subarray(16, 32));
  let h = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.subarray(i, i + 16);
    h += leBig(chunk) + (1n << BigInt(8 * chunk.length));
    h *= r;
    // h mod 2^130 - 5, without a division.
    h = (h & M130) + (h >> 130n) * 5n;
    h = (h & M130) + (h >> 130n) * 5n;
  }
  if (h >= P) h -= P;
  h = (h + s) & ((1n << 128n) - 1n);
  const tag = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) { tag[i] = Number(h & 0xffn); h >>= 8n; }
  return tag;
}

const pad16 = (n) => Buffer.alloc((16 - (n % 16)) % 16);
function macData(aad, ct) {
  const lens = Buffer.alloc(16);
  lens.writeBigUInt64LE(BigInt(aad.length), 0);
  lens.writeBigUInt64LE(BigInt(ct.length), 8);
  return Buffer.concat([aad, pad16(aad.length), ct, pad16(ct.length), lens]);
}

/* ciphertext + 16-byte tag */
function seal(key, nonce, plain, aad = Buffer.alloc(0)) {
  const otk = chacha20(key, nonce, 0, Buffer.alloc(32));
  const ct = chacha20(key, nonce, 1, plain);
  return Buffer.concat([ct, poly1305(otk, macData(aad, ct))]);
}

/* the plaintext, or null when the tag does not match */
function open(key, nonce, sealed, aad = Buffer.alloc(0)) {
  if (sealed.length < 16) return null;
  const ct = sealed.subarray(0, sealed.length - 16);
  const otk = chacha20(key, nonce, 0, Buffer.alloc(32));
  const want = poly1305(otk, macData(aad, ct));
  if (!require('crypto').timingSafeEqual(want, sealed.subarray(sealed.length - 16))) return null;
  return chacha20(key, nonce, 1, ct);
}

module.exports = { seal, open, chacha20, poly1305 };
