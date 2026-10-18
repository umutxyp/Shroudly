'use strict';

/* A dead endpoint hammered by its app. Many computers behind one small router
 * (an internet cafe) share its table of connections, and an endpoint that
 * takes connections and never answers — a dead server, a black-holed
 * telemetry or anti-cheat host — looks to the engine exactly like a site
 * behind a silent filter: every connection to it runs the whole ladder, and
 * each re-dial is one more connection held open. Two limits keep that
 * bounded without taking the ladder away from blocked sites:
 *   - all ladders together hold at most 48 re-dialled connections open at
 *     once (the clients' own first connections are not counted);
 *   - a name whose last ladder came to nothing keeps at most two open on its
 *     next ladders for a minute: the untouched request and the newest
 *     technique, so the search still goes on.
 * And an endpoint that drops the connect itself (SYN dropped) never reaches
 * the ladder at all: the client is told it is unreachable. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-storm');
const EXTRA_MAX = 48;   // EXTRA_LEGS_MAX in core/src/engine.c
const NAME = 'dead.storm.local';

/* What a plain connect does from here: 'open', 'refused' or 'timeout'. */
function directConnect(host, port, ms = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done('open')); s.on('error', () => done('refused'));
    setTimeout(() => done('timeout'), ms);
  });
}

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  // Takes every connection and says nothing (until it is told to come back).
  // A connection counts as open until its end is read. The peak is looked at
  // between rounds of events: the engine closes a connection before it dials
  // the next, but both can arrive in the same round.
  let alive = false, open = 0, peak = 0, accepted = 0;
  const hole = net.createServer((c) => {
    open++; accepted++;
    let gone = false;
    const bye = () => { if (!gone) { gone = true; open--; } };
    c.on('error', () => {});
    c.on('end', bye); c.on('close', bye);
    if (!alive) { c.resume(); return; }   // read and drop, so its closing is seen
    const u = net.connect(server.address().port, '127.0.0.1');
    u.on('error', () => c.destroy());
    c.on('close', () => u.destroy());
    c.pipe(u); u.pipe(c);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => hole.once('listening', r));
  const sampler = setInterval(() => { if (open > peak) peak = open; }, 10);

  const P = await freePort();
  const eng = await startEngine(P, ['--auto']);
  const events = (from, type) => eng.out.slice(from).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));

  /* n clients at once, each a TLS handshake to NAME through the engine, held
   * until the engine has given up on every one of them (or `wait` ms). */
  async function wave(n, wait = 25000) {
    const mark = eng.out.length;
    open = 0; peak = 0; accepted = 0;
    const t0 = Date.now();
    const clients = await Promise.all(Array.from({ length: n }, async () => {
      const raw = await socks(P, '127.0.0.1', hole.address().port);
      const s = tls.connect({ socket: raw, servername: NAME, rejectUnauthorized: false });
      s.on('error', () => {});
      return s;
    }));
    while (events(mark, 'blocked').length < n && Date.now() - t0 < wait) await sleep(100);
    const took = Date.now() - t0;
    const r = { peak, accepted, took, blocked: events(mark, 'blocked').length };
    clients.forEach((s) => s.destroy());
    // The engine closes what it held for them once they have gone.
    const t1 = Date.now();
    while (open > 0 && Date.now() - t1 < 10000) await sleep(100);
    r.left = open;
    return r;
  }

  // An endpoint that drops the connect: 30 clients at once. Each is told it is
  // unreachable after its one dial; no ladder ever starts for it. TEST-NET
  // addresses (RFC 5737) go nowhere on most networks; one that rejects them at
  // once tells the clients sooner, which shows the same.
  const blackhole = (await directConnect('192.0.2.1', 443)) !== 'open';
  const synCheck = (async () => {
    if (!blackhole) return null;
    const mark = eng.out.length;
    const res = await Promise.all(Array.from({ length: 30 }, () =>
      socks(P, '192.0.2.1', 443).then((s) => { s.destroy(); return 'connected'; }, (e) => e.message)));
    return { res, ladders: events(mark, 'blocked').length };
  })();

  // A dead endpoint nobody has seen yet, 40 connections at once: every ladder
  // runs in full, but no more than 48 re-dials are open at any moment.
  let r = await wave(40);
  t.ok(r.blocked === 40 && r.took < 20000,
    `40 connections at once to a silent endpoint: each ladder ends within its budget (${r.took} ms)`);
  t.ok(r.peak > 40, `the ladders still re-dialled (${r.accepted} connections in all)`);
  t.ok(r.peak <= 40 + EXTRA_MAX,
    `but at most ${EXTRA_MAX} re-dials were open at once: peak ${r.peak} (five per connection, 200, without the limit)`);
  t.ok(r.left === 0, 'all of it closed once the clients went away');

  // Within a minute of that, the same name: each ladder keeps two open.
  r = await wave(20);
  t.ok(r.blocked === 20, 'again, 20 connections: each ladder ends');
  t.ok(r.accepted > 20, `the techniques still go out one after another (${r.accepted} connections in all)`);
  t.ok(r.peak <= 2 * 20, `but each keeps at most two open: peak ${r.peak} for 20 clients`);
  t.ok(r.left === 0, 'and all of it closed once the clients went away');

  const syn = await synCheck;
  if (!syn) {
    console.log('  --  dropped connects not checked here: this network answers TEST-NET addresses');
  } else {
    t.ok(syn.res.every((x) => x === 'SOCKS reply 4'), 'an endpoint that drops the connect: every client is told it is unreachable');
    t.ok(syn.ladders === 0, 'and no ladder ever starts for it');
  }

  // The endpoint comes back: its first connection is answered, untouched.
  alive = true;
  const raw = await socks(P, '127.0.0.1', hole.address().port);
  const t0 = Date.now();
  const ok = await new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername: NAME, rejectUnauthorized: false });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
    s.on('data', (d) => { if (d.includes('200 OK')) done(true); });
    s.on('error', () => done(false)); s.on('close', () => done(false));
    setTimeout(() => done(false), 10000);
  });
  t.ok(ok && Date.now() - t0 < 2000, `back up: answered at once (${Date.now() - t0} ms)`);

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  clearInterval(sampler);
  eng.stop(); server.close(); hole.close();
  console.log(`engine-storm: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
