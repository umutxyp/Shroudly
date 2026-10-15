'use strict';

/* On a network that drops a blocked handshake without a word, one
 * connection's 15 s budget covers the untouched attempt and the first four
 * techniques. A site that only a later technique opens used to stay blocked
 * for good: every connection tried the same four. Now a ladder that runs out
 * silently leaves its place behind, and the site's next connection carries on
 * from there — skipping the untouched attempt it has already seen dropped —
 * and wraps around the list, until something gets through; that is then
 * learned, and the connection after it opens at once.
 *
 * The fake censor here does not model one real filter: it swallows every
 * handshake (nothing forwarded, nothing back, nothing closed) except the one
 * shape it is told to let through — the handshake split into two TLS records
 * in the middle of the server name, which is what tlsrec-sni-mid sends. For
 * the first two connections it lets nothing through, so the engine's place in
 * the list moves well past that technique, and reaching it again takes a
 * wrap-around. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-resume');
const NAME = 'late.resume.local';

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
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  let mode = 'nothing';      // or 'mid': what the censor lets through
  const seen = [];           // the shape of every attempt that reached it
  const censor = net.createServer((c) => {
    const m = mode;
    let buf = Buffer.alloc(0), u = null, decided = false;
    c.on('error', () => {});
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      if (decided) return;                       // swallowed
      buf = Buffer.concat([buf, d]);
      const k = shape(buf);
      if (!k) return;
      decided = true; seen.push(k);
      if (m === 'mid' && k === 'mid') {
        u = net.connect(server.address().port, '127.0.0.1');
        u.on('error', () => c.destroy());
        u.write(buf); u.pipe(c);
      }
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--auto']);
  const events = (from, type) => eng.out.slice(from).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));

  async function visit() {
    const mark = eng.out.length; const from = seen.length;
    const t0 = Date.now();
    const raw = await socks(P, '127.0.0.1', censor.address().port);
    const ok = await new Promise((resolve) => {
      const s = tls.connect({ socket: raw, servername: NAME, rejectUnauthorized: false });
      let over = false;
      const iv = setInterval(() => { if (events(mark, 'blocked').length) fin(false); }, 100);
      function fin(v) { if (over) return; over = true; clearInterval(iv); s.destroy(); resolve(v); }
      s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { if (d.includes('200 OK')) fin(true); });
      s.on('error', () => fin(false)); s.on('close', () => fin(false));
      setTimeout(() => fin(false), 20000);
    });
    const ms = Date.now() - t0;
    await sleep(300);
    return { ok, ms, blocked: events(mark, 'blocked')[0], bypass: events(mark, 'bypass')[0], seen: seen.slice(from) };
  }

  // Nothing gets through. The first connection: the untouched attempt (5 s)
  // and four techniques, all with the same shape as far as the censor sees.
  let r = await visit();
  t.ok(!r.ok && r.blocked && r.blocked.note === 'silent', `nothing gets through: blocked, silently (${JSON.stringify(r.blocked)})`);
  t.ok(r.seen[0] === 'one' && r.seen.length === r.blocked.attempts, `it tried: ${r.seen.join(', ')}`);
  const firstAttempts = r.blocked.attempts;

  // The second connection carries on where the first stopped: the next
  // technique in the list (the mid-name record split), no untouched attempt
  // first, and so more techniques in the same 15 s.
  r = await visit();
  t.ok(!r.ok && r.blocked && r.blocked.note === 'silent', 'second connection: still blocked, silently');
  t.ok(r.seen[0] === 'mid', `it started where the first left off, not with the untouched attempt (${r.seen.join(', ')})`);
  t.ok(r.blocked.attempts > firstAttempts, `and fit more techniques in: ${r.blocked.attempts} against ${firstAttempts}`);

  // Now the censor lets the mid-name split through — a technique the engine's
  // place in the list has just gone past.
  mode = 'mid';
  const shapes = [];
  let opened = null, tries = 0;
  for (; tries < 4 && !opened; tries++) {
    r = await visit();
    shapes.push(...r.seen);
    if (r.ok) opened = r;
    else t.ok(r.blocked && r.blocked.note === 'silent', `connection ${tries + 3}: not yet (${r.seen.join(', ')})`);
  }
  t.ok(opened, `repeated connections find it: connection ${tries + 2} opened the site`);
  const wrapped = shapes.indexOf('one') >= 0 && shapes.lastIndexOf('sni+1') > shapes.indexOf('one');
  t.ok(wrapped, `after wrapping round the end of the list to its start (${shapes.join(', ')})`);
  t.ok(opened.bypass && opened.bypass.strategy === 'tlsrec-sni-mid' && opened.bypass.note === 'silent',
    `reported as a bypass of a silent drop: ${JSON.stringify(opened.bypass)}`);

  r = await visit();
  t.ok(r.ok && r.ms < 2000 && r.seen.length === 1 && r.seen[0] === 'mid',
    `learned: the next connection opens on its first try (${r.ms} ms, ${r.seen.length} attempt)`);
  t.ok(!r.bypass && !r.blocked, 'and nothing more is reported');

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); censor.close();
  console.log(`engine-resume: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
