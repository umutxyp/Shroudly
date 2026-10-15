'use strict';

/* A silent-drop filter on a slow path: the untouched handshake is swallowed,
 * a technique gets through, but its answer takes seconds to come back (a
 * congested mobile network, satellite, a lossy link retransmitting). The
 * engine starts the next technique after a couple of seconds of silence; it
 * must not throw the slower answer away when it does. Every connection the
 * ladder opened is listened to until one answers, so the page loads, the
 * technique that answered is learned (the untouched request was still
 * unanswered: evidence), and the next connection opens with it at once. Even
 * an answer that comes after the ladder's 15 s is still used. And a server
 * that is merely slow, censored or not, teaches nothing.
 *
 * The fake censor swallows a first TLS record that holds the whole server
 * name of a blocked site (untouched, or split at the TCP level only) and lets
 * a handshake split into records through; the answer to any connection it
 * lets through is held back for that site's delay. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-slowpath');

/* The client's first flight once its whole ClientHello is in, however many
 * records it was split into: the handshake body, and the first record alone;
 * null while it is still arriving, {} when it is not a TLS handshake. */
function hello(buf) {
  let p = 0, body = Buffer.alloc(0), firstEnd = -1;
  while (p + 5 <= buf.length) {
    if (buf[p] !== 0x16) return {};
    const len = buf.readUInt16BE(p + 3);
    if (p + 5 + len > buf.length) return null;
    body = Buffer.concat([body, buf.subarray(p + 5, p + 5 + len)]);
    if (firstEnd < 0) firstEnd = 5 + len;
    p += 5 + len;
    if (body.length >= 4 && body.length >= 4 + body.readUIntBE(1, 3)) return { body, first: buf.subarray(0, firstEnd) };
  }
  return null;
}

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  // name -> { blocked, delay }: how the path treats it right now.
  const sites = {};
  const seen = [];   // every first record that reached the censor: { name, whole, passed }
  const censor = net.createServer((c) => {
    let buf = Buffer.alloc(0), u = null, decided = false;
    c.on('error', () => {});
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      if (decided) return;
      buf = Buffer.concat([buf, d]);
      const h = hello(buf);
      if (!h) return;
      decided = true;
      const name = h.body && Object.keys(sites).find((n) => h.body.includes(Buffer.from(n)));
      // Something it cannot read is swallowed too: only blocked sites come here.
      const site = sites[name] || { blocked: true, delay: 0 };
      const whole = !!name && h.first.includes(Buffer.from(name));
      const passed = !(site.blocked && (whole || !name));
      seen.push({ name, whole, passed });
      if (!passed) return;                                    // swallowed: nothing back, nothing closed
      const at = Date.now();
      u = net.connect(server.address().port, '127.0.0.1');
      u.on('error', () => c.destroy());
      u.once('data', (a) => setTimeout(() => { if (!c.destroyed) { c.write(a); u.pipe(c); } },
        Math.max(0, site.delay - (Date.now() - at))));
      u.write(buf);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--auto']);
  const events = (from, type) => eng.out.slice(from).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));
  async function visit(name, wait = 25000) {
    const mark = eng.out.length; const from = seen.length;
    const s0 = await eng.stats();
    const t0 = Date.now();
    const raw = await socks(P, '127.0.0.1', censor.address().port);
    const ok = await new Promise((resolve) => {
      const s = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false });
      const done = (v) => { s.destroy(); resolve(v); };
      s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { if (d.includes('200 OK')) done(true); });
      s.on('error', () => done(false)); s.on('close', () => done(false));
      setTimeout(() => done(false), wait);
    });
    const ms = Date.now() - t0;
    await sleep(300);
    const s1 = await eng.stats();
    return { ok, ms, desync: s1.desync - s0.desync, tries: seen.slice(from),
      bypass: events(mark, 'bypass'), blocked: events(mark, 'blocked') };
  }

  // Answers 3 s after the technique's handshake: later than the engine waits
  // before its next technique. 2.5.4 loaded this in about 8 s, every time.
  sites['three.slowpath.local'] = { blocked: true, delay: 3000 };
  let r = await visit('three.slowpath.local');
  t.ok(r.ok && r.ms < 12000, `technique answered 3 s late: the page still loads (${r.ms} ms)`);
  t.ok(r.bypass.length === 1 && r.bypass[0].note === 'silent' && r.bypass[0].strategy === 'tlsrec-sni',
    `learned from it, the untouched request being unanswered: ${JSON.stringify(r.bypass[0])}`);
  r = await visit('three.slowpath.local');
  t.ok(r.ok && r.ms < 3000 + 1500 && r.tries.length === 1 && r.tries[0].passed,
    `the next connection opens with it at once, no waiting on the untouched request (${r.ms} ms, ${r.tries.length} attempt)`);
  t.ok(!r.bypass.length && !r.blocked.length, 'and nothing more is reported');

  // Answers 2.7 s late: just after the engine has sent its next technique.
  // The first technique's answer is the one used, and learned.
  sites['late.slowpath2.local'] = { blocked: true, delay: 2700 };
  r = await visit('late.slowpath2.local');
  t.ok(r.ok && r.ms < 12000, `technique answered after the next one went out: still used (${r.ms} ms)`);
  t.ok(r.bypass.length === 1 && r.bypass[0].strategy === 'tlsrec-sni' && r.tries.length >= 3,
    `the one that answered is learned, not the latest (${r.bypass[0] && r.bypass[0].strategy}, ${r.tries.length} attempts out)`);

  // Answers after the ladder's whole 15 s budget: "blocked" is said when the
  // time is up, but the connections stay open and the late answer is used —
  // as 2.5.4 did, which relayed its last attempt with no time limit.
  sites['crawl.slowpath3.local'] = { blocked: true, delay: 11000 };
  r = await visit('crawl.slowpath3.local');
  t.ok(r.ok && r.ms < 19000, `technique answered after the ladder's budget: the page still loads (${r.ms} ms)`);
  t.ok(r.bypass.length === 1 && r.bypass[0].strategy === 'tlsrec-sni',
    `and that technique is learned: ${JSON.stringify(r.bypass[0])}`);
  sites['crawl.slowpath3.local'].delay = 0;
  r = await visit('crawl.slowpath3.local');
  t.ok(r.ok && r.tries.length === 1 && r.tries[0].passed && r.ms < 2000,
    `the next connection opens with it (${r.ms} ms, ${r.tries.length} attempt)`);

  // Merely slow, not censored: every handshake is answered 9 s late, by when
  // two techniques have gone out beside it. The untouched one answers first:
  // used, nothing learned, nothing reported.
  sites['slow.slowsite.local'] = { blocked: false, delay: 9000 };
  r = await visit('slow.slowsite.local');
  t.ok(r.ok && r.ms < 11000 && r.tries.length >= 2, `slow server (9 s): served by the untouched request (${r.ms} ms, ${r.tries.length} attempts out)`);
  t.ok(!r.bypass.length && !r.blocked.length, 'no bypass or block reported for it');
  sites['slow.slowsite.local'].delay = 0;
  r = await visit('slow.slowsite.local');
  t.ok(r.ok && r.desync === 0 && r.tries.length === 1 && r.tries[0].whole,
    'and the next connection to it goes untouched: nothing was learned');

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); censor.close();
  console.log(`engine-slowpath: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
