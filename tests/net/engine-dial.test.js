'use strict';

/* Dialling through the engine's own resolver: every address a name has is
 * tried, not just the first; the answer is kept for its TTL (never less than
 * 20 s); an address that failed is dropped so the next connection does not
 * wait on it again; a first dial over many dead addresses is held to about
 * 14 s; and a host that cannot be reached at all is reported — once, not on
 * every retry, only for a name on a web port — with whether DNS or the
 * connection failed. A re-dial the ladder's time budget cut short ends the
 * ladder as "blocked", not "unreachable". A local DNS server stands in for the
 * app's encrypted-DNS forwarder; nothing here needs the internet. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, dnsStub, testServerOptions, suite } = require('./helpers');

const t = suite('engine-dial');

/* A port free on ::1 and on 127.0.0.1 alike, so an address that maps to
 * 127.0.0.1 is sure to be refused while ::1 answers. */
async function dualFreePort() {
  for (;;) {
    const p = await freePort();
    const ok = await new Promise((resolve) => {
      const s = net.createServer(); s.once('error', () => resolve(false));
      s.listen(p, '::1', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
}

function handshake(raw, servername) {
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername, rejectUnauthorized: false });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.on('secureConnect', () => done(true)); s.on('error', () => done(false));
    setTimeout(() => done(false), 8000);
  });
}

/* What a plain connect does from here: 'open', 'refused' (or any other quick
 * error) or 'timeout'. */
function directConnect(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done('open')); s.on('error', () => done('refused'));
    setTimeout(() => done('timeout'), ms);
  });
}

/* A web port nothing on this machine answers on: "unreachable" is only
 * reported for 80 and 443. */
async function deadWebPort() {
  for (const p of [443, 80]) {
    if ((await directConnect('::1', p)) !== 'open' && (await directConnect('127.0.0.1', p)) !== 'open') return p;
  }
  throw new Error('something listens on port 443 and port 80 of this machine; this test needs one of them free');
}

(async () => {
  const X = await dualFreePort();
  const server = tls.createServer(testServerOptions(), (s) => s.on('error', () => {}));
  await new Promise((r) => server.listen({ port: X, host: '::1', ipv6Only: true }, r));
  const DEAD = await dualFreePort();   // nothing listens here
  const WEB = await deadWebPort();

  const dns = await dnsStub({
    // The first address refuses (127.0.0.1 on a port only ::1 serves), the second works.
    'multi.example': { AAAA: ['::ffff:127.0.0.1', '::1'], ttl: 1 },
    'gone.example': { AAAA: ['::1'], ttl: 300 },
    'gone-p2p.example': { AAAA: ['::1'], ttl: 300 },
    // The site's server first, then addresses that never answer (see below).
    'late.example': { AAAA: ['::1', '::ffff:192.0.2.21', '::ffff:192.0.2.22', '::ffff:192.0.2.23', '::ffff:192.0.2.24'] },
  });
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(dns.port), '--ipv6']);
  const events = (e, type) => e.out.split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));

  t.ok(await handshake(await socks(P, 'multi.example', X), 'multi.example'),
    'first address refused: the next one the name has is used, and the site loads');
  t.ok(dns.asked['multi.example/AAAA'] === 1, 'one lookup for it');

  const t0 = Date.now();
  const again = await socks(P, 'multi.example', X);
  const ms = Date.now() - t0;
  t.ok(await handshake(again, 'multi.example'), `second connection loads too (${ms} ms to connect)`);
  t.ok(dns.asked['multi.example/AAAA'] === 1, 'answered from the cache: a 1 s TTL is held to at least 20 s');
  t.ok(!events(eng, 'unreachable').some((e) => e.host === 'multi.example'), 'a name with one working address is not reported');

  // Its only address refuses: the connection fails, and that address is
  // dropped from the cache, so the next connection looks the name up again
  // although DNS said to keep it for 5 minutes.
  let err = await socks(P, 'gone.example', WEB).then(() => null, (e) => e.message);
  t.ok(err === 'SOCKS reply 4', 'every address refused: the client is told "host unreachable"');
  await sleep(300);
  let un = events(eng, 'unreachable').filter((e) => e.host === 'gone.example');
  t.ok(un.length === 1 && un[0].stage === 'connect' && un[0].ips === 1, `reported: ${JSON.stringify(un[0])}`);
  err = await socks(P, 'gone.example', WEB).then(() => null, (e) => e.message);
  t.ok(err === 'SOCKS reply 4' && dns.asked['gone.example/AAAA'] === 2, 'the failed address was dropped: the name is looked up again');
  await sleep(300);
  un = events(eng, 'unreachable').filter((e) => e.host === 'gone.example');
  t.ok(un.length === 1, 'a host retried at once is reported once, not on every retry');

  // Not every dead connection is worth a line: peer-to-peer and game clients
  // behind the system proxy hit dead addresses on odd ports all day.
  err = await socks(P, 'gone-p2p.example', DEAD).then(() => null, (e) => e.message);
  const errIp = await socks(P, '127.0.0.1', WEB).then(() => null, (e) => e.message);
  await sleep(300);
  t.ok(err === 'SOCKS reply 4' && errIp === 'SOCKS reply 4', 'a dead name on another port, and a dead address, still fail for the client');
  t.ok(!events(eng, 'unreachable').some((e) => e.host === 'gone-p2p.example' || e.host === '127.0.0.1'),
    'but only a name on a web port is reported: not another port, not a bare address');

  // A name that does not resolve, asked of an engine without --doh, so only
  // this machine's own resolver is involved and not the public ones.
  const P3 = await freePort();
  const eng3 = await startEngine(P3, ['--auto']);
  err = await socks(P3, 'nowhere.invalid', 443).then(() => null, (e) => e.message);
  await sleep(300);
  un = events(eng3, 'unreachable').filter((e) => e.host === 'nowhere.invalid');
  t.ok(err === 'SOCKS reply 4' && un.length === 1 && un[0].stage === 'dns' && un[0].ips === 0,
    `a name that does not resolve: reported as a DNS failure (${JSON.stringify(un[0])})`);

  // Addresses that never answer at all. TEST-NET addresses (RFC 5737) go
  // nowhere: most networks drop them, which is what these checks need; one
  // that rejects them at once makes the first check trivially true and the
  // second impossible to set up, so that one is skipped there.
  const blackhole = (await directConnect('192.0.2.1', 443, 1500)) === 'timeout';
  const dns2 = await dnsStub({
    'dead8.example': { A: ['192.0.2.11', '192.0.2.12', '192.0.2.13', '192.0.2.14', '192.0.2.15', '192.0.2.16', '192.0.2.17', '192.0.2.18'] },
  });
  const P2 = await freePort();
  const eng2 = await startEngine(P2, ['--auto', '--doh', '--doh-port', String(dns2.port)]);

  // A ladder whose re-dial the budget cuts short. The site's server takes the
  // first connection and says nothing (a silent filter), then stops taking
  // connections at all; its other addresses never answer. The untouched
  // attempt waits 5 s, the re-dial then spends what is left of the 15 s on
  // dead addresses and runs out: the ladder is over — "blocked", and the
  // attempt that never went out is not counted — not "unreachable". (The
  // dead addresses are IPv4 written as IPv6, which Windows does not connect
  // to at all, so there they fail at once and this is not checked.)
  let took = 0;
  const lateCheck = (async () => {
    if (!blackhole || process.platform === 'win32') return null;
    const L = await dualFreePort();
    const silentSrv = net.createServer((c) => { c.on('error', () => {}); silentSrv.close(); });
    await new Promise((r) => silentSrv.listen({ port: L, host: '::1', ipv6Only: true }, r));
    const mark = eng.out.length;
    const raw = await socks(P, 'late.example', L);
    const s = tls.connect({ socket: raw, servername: 'late.example', rejectUnauthorized: false });
    s.on('error', () => {});
    const t1 = Date.now();
    const evs = (type) => eng.out.slice(mark).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));
    while (!evs('blocked').length && !evs('unreachable').length && Date.now() - t1 < 22000) await sleep(100);
    took = Date.now() - t1;
    s.destroy();
    return { blocked: evs('blocked'), unreachable: evs('unreachable') };
  })();

  // The first dial of a name whose 8 addresses all stay silent gives up in
  // about 14 s (8 s, 4 s and what is left), well inside the 30 s a browser
  // gives a SOCKS connect — it used to take 28 s.
  const t2 = Date.now();
  err = await socks(P2, 'dead8.example', 443).then(() => null, (e) => e.message);
  const firstDial = Date.now() - t2;
  t.ok(err === 'SOCKS reply 4' && firstDial < 16500,
    `8 dead addresses: the client hears "unreachable" after ${(firstDial / 1000).toFixed(1)} s${blackhole ? '' : ' (this network rejects them at once)'}`);
  await sleep(300);
  un = events(eng2, 'unreachable').filter((e) => e.host === 'dead8.example');
  t.ok(un.length === 1 && un[0].stage === 'connect', `and reported: ${JSON.stringify(un[0])}`);

  const late = await lateCheck;
  if (!late) {
    console.log('  --  budget-cut re-dial not checked here: needs addresses that never answer (this network or OS fails them at once)');
  } else {
    t.ok(late.blocked.length === 1 && !late.unreachable.length,
      `a re-dial cut short by the budget ends the ladder as "blocked", not "unreachable": ${JSON.stringify(late.blocked[0] || late.unreachable[0])}`);
    t.ok(late.blocked[0].attempts === 1 && late.blocked[0].note === 'silent' && took < 17000,
      `only the attempt that went out is counted (${late.blocked[0].attempts}), within the budget (${took} ms)`);
  }

  t.ok(eng.exited === null && eng2.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err + eng2.err + eng3.err),
    'engine still up, no sanitizer errors');
  eng.stop(); eng2.stop(); eng3.stop(); server.close(); dns.close(); dns2.close();
  console.log(`engine-dial: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
