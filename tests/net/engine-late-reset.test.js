'use strict';

/* A filter that swallows a blocked handshake and, a while later, resets the
 * connection it has been holding (an idle timeout). By then the engine's
 * ladder has given up on the site — "blocked", silently — and left a place for
 * the next connection to carry on from. The late reset hits a connection that
 * never received a single byte: nothing was cut, there was nothing to cut. It
 * must not be reported as a cut (the app would go and check the service), must
 * not make a technique "learned" for the host, and must not wipe the place the
 * search was to carry on from: the next connection resumes there.
 *
 * The fake censor swallows every handshake (nothing forwarded, nothing back)
 * and resets each connection RESET_AFTER ms after it was opened. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-late-reset');
const NAME = 'rst.late-reset.local';
const RESET_AFTER = 16000;   // after the ladder's 15 s budget

/* The shape of a first flight, once the whole ClientHello is in: 'one' (one
 * record holding the whole name: untouched, or split at the TCP level only),
 * 'sni+1' (records split one byte into the name) or 'mid' (split further in);
 * null while it is still arriving. */
function shape(buf) {
  let p = 0, body = Buffer.alloc(0), first = -1;
  while (p + 5 <= buf.length) {
    if (buf[p] !== 0x16) return 'other';
    const len = buf.readUInt16BE(p + 3);
    if (p + 5 + len > buf.length) return null;
    body = Buffer.concat([body, buf.subarray(p + 5, p + 5 + len)]);
    if (first < 0) first = len;
    p += 5 + len;
    if (body.length >= 4 && body.length >= 4 + body.readUIntBE(1, 3)) {
      const i = body.indexOf(NAME);
      if (i < 0) return 'other';
      const inFirst = first - i;
      return inFirst >= NAME.length ? 'one' : inFirst <= 1 ? 'sni+1' : 'mid';
    }
  }
  return null;
}

(async () => {
  // The server is never reached; it is here so a technique that got through
  // would have somewhere to go.
  const server = tls.createServer(testServerOptions(), (s) => s.on('error', () => {})).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  const seen = [];
  const censor = net.createServer((c) => {
    let buf = Buffer.alloc(0), decided = false;
    c.on('error', () => {});
    const timer = setTimeout(() => { try { c.resetAndDestroy(); } catch { c.destroy(); } }, RESET_AFTER);
    c.on('close', () => clearTimeout(timer));
    c.on('data', (d) => {
      if (decided) return;
      buf = Buffer.concat([buf, d]);
      const k = shape(buf);
      if (k) { decided = true; seen.push(k); }
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--auto']);
  const events = (from, type) => eng.out.slice(from).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));

  // The first connection: the client stays until well after the reset.
  let mark = eng.out.length, from = seen.length;
  let raw = await socks(P, '127.0.0.1', censor.address().port);
  let s = tls.connect({ socket: raw, servername: NAME, rejectUnauthorized: false });
  s.on('error', () => {});
  await sleep(RESET_AFTER + 1500);
  s.destroy();
  await sleep(300);
  const blocked = events(mark, 'blocked');
  t.ok(blocked.length === 1 && blocked[0].note === 'silent', `the ladder gave up, silently (${seen.slice(from).join(', ')})`);
  t.ok(!events(mark, 'cut').length, 'the reset that came later, on a connection that never got a byte, is not reported as a cut');
  t.ok(!events(mark, 'bypass').length, 'and nothing was learned from it');

  // The next connection carries on where the first left off: its untouched
  // request first, then the technique after the last one tried (the fifth, a
  // record split one byte into the name), not the list's first technique
  // again (the record split in the middle of the name).
  mark = eng.out.length; from = seen.length;
  raw = await socks(P, '127.0.0.1', censor.address().port);
  s = tls.connect({ socket: raw, servername: NAME, rejectUnauthorized: false });
  s.on('error', () => {});
  for (let i = 0; i < 50 && seen.length - from < 2; i++) await sleep(100);
  s.destroy();
  const next = seen.slice(from);
  t.ok(next[0] === 'one' && next[1] === 'sni+1', `the next connection resumed where the search had stopped (${next.join(', ')})`);

  await sleep(300);
  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); censor.close();
  console.log(`engine-late-reset: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
