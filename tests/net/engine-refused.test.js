'use strict';

/* A server that mishandles a technique while the handshake still completes
 * (#68): DDoS-Guard, given a ClientHello in two TLS records, answers with its
 * own certificate instead of the site's, and the browser shows
 * NET::ERR_CERT_AUTHORITY_INVALID. The engine took the answer for success and
 * kept using the technique. Now the browser turning the handshake down (an
 * alert as its only word: plaintext in TLS 1.2, one 19-byte encrypted record
 * in TLS 1.3) makes the engine leave that kind of technique out for the name
 * and open its next connection with one of another kind.
 *
 * The stand-in network resets an untouched handshake (so a technique is
 * needed) and answers anything else with a ServerHello; the stand-in browser
 * sends the ClientHello Node's TLS makes, then either refuses or goes on. */

const net = require('net');
const tls = require('tls');
const { Duplex } = require('stream');
const { startEngine, sleep, freePort, socks, suite } = require('./helpers');

const t = suite('engine-refused');

/* The ClientHello Node's TLS sends for `name`: only its first flight is
 * taken, so no handshake ever completes and nothing is verified or trusted. */
function clientHello(name) {
  return new Promise((resolve) => {
    const d = new Duplex({ read() {}, write(chunk, enc, cb) { resolve(Buffer.from(chunk)); cb(); } });
    const s = tls.connect({ socket: d, servername: name });
    s.on('error', () => {});
    setTimeout(() => s.destroy(), 100);
  });
}

/* As in engine-cut.test.js: 'one' (one record holding the whole name),
 * 'sni+1', 'end', 'mid' (record cuts), 'other'; null while incomplete. */
function shape(buf, name) {
  let p = 0, body = Buffer.alloc(0), first = -1;
  while (p + 5 <= buf.length) {
    if (buf[p] !== 0x16) return 'other';
    const len = buf.readUInt16BE(p + 3);
    if (p + 5 + len > buf.length) return null;
    body = Buffer.concat([body, buf.subarray(p + 5, p + 5 + len)]);
    if (first < 0) first = len;
    p += 5 + len;
    if (body.length >= 4 && body.length >= 4 + body.readUIntBE(1, 3)) {
      const i = body.indexOf(name);
      if (i < 0) return 'other';
      const inFirst = first - i;
      return inFirst >= name.length ? 'one' : inFirst <= 1 ? 'sni+1' : inFirst === name.length - 1 ? 'end' : 'mid';
    }
  }
  return null;
}
const RECORD_CUT = ['sni+1', 'mid', 'end'];

// A ServerHello record (enough for the engine to take it for one).
const SERVER_HELLO = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);
const ALERT_12 = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x30]);              // unknown_ca
const CCS = Buffer.from([0x14, 0x03, 0x03, 0x00, 0x01, 0x01]);
const record23 = (n) => Buffer.concat([Buffer.from([0x17, 0x03, 0x03, n >> 8, n & 255]), Buffer.alloc(n, 0xa5)]);

(async () => {
  const seen = [];
  const site = net.createServer((c) => {
    let buf = Buffer.alloc(0), chunks = 0, done = false;
    c.on('error', () => {});
    c.on('data', (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]); chunks++;
      let name = null, k = null;
      for (const n of names) {
        const s = shape(buf, n);
        if (s === null) return;                                              // not all in yet
        if (s !== 'other') { name = n; k = s; break; }
      }
      if (!k) { c.destroy(); return; }
      done = true;
      if (k === 'one' && chunks === 1) { c.resetAndDestroy(); return; }     // untouched: blocked
      seen.push({ name, shape: k });
      c.write(SERVER_HELLO);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => site.once('listening', r));
  const names = new Set();

  const P = await freePort();
  const eng = await startEngine(P, ['--auto']);

  /* One visit: the ClientHello, the server's answer, then what the browser
   * says: 'refuse12', 'refuse13' or 'go on'. */
  async function visit(name, then) {
    names.add(name);
    const hello = await clientHello(name);
    const before = eng.out.length;
    const n0 = seen.length;
    const s = await socks(P, '127.0.0.1', site.address().port);
    s.on('error', () => {});
    let got = Buffer.alloc(0);
    await new Promise((resolve) => {
      s.on('data', (d) => {
        got = Buffer.concat([got, d]);
        if (got.length < SERVER_HELLO.length) return;
        if (then === 'refuse12') s.end(ALERT_12);
        else if (then === 'refuse13') s.end(Buffer.concat([CCS, record23(19)]));
        else s.end(Buffer.concat([CCS, record23(53), record23(40)]));      // Finished, then a request
        resolve();
      });
      s.on('close', resolve);
      s.write(hello);
      setTimeout(resolve, 20000);
    });
    await sleep(800);
    s.destroy();
    const ev = (type) => eng.out.slice(before).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));
    return { answered: got.length >= SERVER_HELLO.length, shapes: seen.slice(n0).filter((x) => x.name === name).map((x) => x.shape), refused: ev('refused'), bypass: ev('bypass') };
  }

  for (const [how, name] of [['refuse12', 'ddg-12.example.test'], ['refuse13', 'ddg-13.example.test']]) {
    let r = await visit(name, how);
    t.ok(r.answered && RECORD_CUT.includes(r.shapes[0]), `${how}: the first technique cuts the record (${r.shapes.join(',')})`);
    t.ok(r.refused.length === 1 && r.refused[0].host === name && /tlsrec/.test(r.refused[0].strategy) && r.refused[0].next && !/tlsrec/.test(r.refused[0].next),
      `${how}: the browser's refusal is reported, with a technique of another kind next: ${JSON.stringify(r.refused[0] || null)}`);
    r = await visit(name, 'go on');
    t.ok(r.answered && r.shapes.length >= 1 && r.shapes.every((k) => !RECORD_CUT.includes(k)),
      `${how}: the next connection keeps the ClientHello in one record (${r.shapes.join(',')})`);
    t.ok(!r.refused.length, `${how}: a browser that goes on is no refusal`);
  }

  // A browser that goes on after the record cut: the technique is kept.
  {
    const name = 'fine-cut.example.test';
    let r = await visit(name, 'go on');
    t.ok(r.answered && RECORD_CUT.includes(r.shapes[0]) && !r.refused.length, `a site that takes the record cut keeps it (${r.shapes.join(',')})`);
    r = await visit(name, 'go on');
    t.ok(r.answered && RECORD_CUT.includes(r.shapes[0]), `and opens with it next time (${r.shapes.join(',')})`);
  }

  eng.stop(); site.close();
  console.log(`engine-refused: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
