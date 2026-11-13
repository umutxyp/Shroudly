'use strict';

/* On a network that drops a blocked handshake without a word every attempt
 * costs its whole wait. A ladder that took them one by one got through the
 * untouched attempt and four techniques in its 15 s, so a site only a later
 * technique opens took several connections to open (and, once there was a
 * last way out, went to Tor after the first: see engine-search.test.js).
 * Now two unanswered attempts send the rest of the list out at once
 * (BURST_BATCH in engine.c): one connection tries every technique.
 *
 * A name that came to nothing then rests (COOL_MS): its next connections
 * keep to two connections at a time and go one technique at a time again,
 * each leaving its place behind for the next to carry on from, wrapping
 * around the list, until something gets through; that is then learned, and
 * the connection after it opens at once. The untouched request still goes
 * first on such a connection (a server that was down looks exactly like a
 * silent filter) but only gets a moment to itself before the next technique
 * goes out beside it, instead of its full 5 s.
 *
 * The fake censor here does not model one real filter: it swallows every
 * handshake (nothing forwarded, nothing back, nothing closed) except the one
 * shape it is told to let through: the handshake split into two TLS records
 * one byte before the end of the server name, which is what tlsrec-sni-end
 * sends, the sixth technique. For the first connection it lets nothing
 * through. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-resume');
const NAME = 'late.resume.local';

/* The shape of a first flight, once the whole ClientHello is in: 'one' (one
 * record holding the whole name: untouched, or split at the TCP level only),
 * 'sni+1' (records split one byte into the name), 'end' (one byte before its
 * end) or 'mid' (split in between); null while it is still arriving. */
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
      return inFirst >= NAME.length ? 'one' : inFirst <= 1 ? 'sni+1' : inFirst === NAME.length - 1 ? 'end' : 'mid';
    }
  }
  return null;
}

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  let mode = 'nothing';      // or 'end': what the censor lets through
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
      if (m === 'end' && k === 'end') {
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

  // Nothing gets through. The first connection: the untouched attempt, one
  // technique, and then the rest of the list at once: every technique there is.
  const techniques = JSON.parse(eng.out.split('\n').find((l) => l.includes('"ready"'))).techniques;
  let r = await visit();
  t.ok(!r.ok && r.blocked && r.blocked.note === 'silent', `nothing gets through: blocked, silently (${JSON.stringify(r.blocked)})`);
  t.ok(r.seen[0] === 'one' && r.seen.length === r.blocked.attempts, `it tried: ${r.seen.join(', ')}`);
  t.ok(r.blocked.attempts === techniques + 1 && r.ms < 24000, `the whole list on one connection: ${r.blocked.attempts} attempts for ${techniques} techniques, in ${r.ms} ms`);
  const firstAttempts = r.blocked.attempts;

  // Now the censor lets the split before the name's end through. The name
  // rests: its next connections race the untouched request and then go one
  // technique at a time, from the top of the list (the first was a whole
  // pass), each carrying on where the one before stopped.
  mode = 'end';
  let opened = null, tries = 0;
  const firsts = [];
  for (; tries < 4 && !opened; tries++) {
    r = await visit();
    t.ok(r.seen[0] === 'one', `connection ${tries + 2} raced its untouched request first`);
    firsts.push(r.seen[1]);
    if (r.ok) opened = r;
    else t.ok(r.blocked && r.blocked.note === 'silent' && r.blocked.attempts < firstAttempts,
      `connection ${tries + 2}: not yet, and not the whole list again (${r.seen.join(', ')})`);
  }
  t.ok(firsts[0] === 'mid', `the first of them starts at the top of the list (${firsts[0]})`);
  t.ok(firsts.length < 2 || firsts[1] !== 'mid', `the next carries on where it stopped (${firsts.join(' | ')})`);
  t.ok(opened, `repeated connections find it: connection ${tries + 1} opened the site`);
  t.ok(opened.bypass && opened.bypass.strategy === 'tlsrec-sni-end' && opened.bypass.note === 'silent',
    `reported as a bypass of a silent drop: ${JSON.stringify(opened.bypass)}`);

  r = await visit();
  t.ok(r.ok && r.ms < 2000 && r.seen.length === 1 && r.seen[0] === 'end',
    `learned: the next connection opens on its first try (${r.ms} ms, ${r.seen.length} attempt)`);
  t.ok(!r.bypass && !r.blocked, 'and nothing more is reported');

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); censor.close();
  console.log(`engine-resume: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
