'use strict';

/* Dialling through the engine's own resolver: every address a name has is
 * tried, not just the first; the answer is kept for its TTL (never less than
 * 20 s); an address that failed is dropped so the next connection does not
 * wait on it again; and a host that cannot be reached at all is reported —
 * once, not on every retry — with whether DNS or the connection failed.
 * A local DNS server stands in for the app's encrypted-DNS forwarder. */

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

(async () => {
  const X = await dualFreePort();
  const server = tls.createServer(testServerOptions(), (s) => s.on('error', () => {}));
  await new Promise((r) => server.listen({ port: X, host: '::1', ipv6Only: true }, r));
  const DEAD = await dualFreePort();   // nothing listens here

  const dns = await dnsStub({
    // The first address refuses (127.0.0.1 on a port only ::1 serves), the second works.
    'multi.example': { AAAA: ['::ffff:127.0.0.1', '::1'], ttl: 1 },
    'gone.example': { AAAA: ['::1'], ttl: 300 },
  });
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(dns.port), '--ipv6']);
  const events = (type) => eng.out.split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));

  t.ok(await handshake(await socks(P, 'multi.example', X), 'multi.example'),
    'first address refused: the next one the name has is used, and the site loads');
  t.ok(dns.asked['multi.example/AAAA'] === 1, 'one lookup for it');

  const t0 = Date.now();
  const again = await socks(P, 'multi.example', X);
  const ms = Date.now() - t0;
  t.ok(await handshake(again, 'multi.example'), `second connection loads too (${ms} ms to connect)`);
  t.ok(dns.asked['multi.example/AAAA'] === 1, 'answered from the cache: a 1 s TTL is held to at least 20 s');
  t.ok(!events('unreachable').some((e) => e.host === 'multi.example'), 'a name with one working address is not reported');

  // Its only address refuses: the connection fails, and that address is
  // dropped from the cache, so the next connection looks the name up again
  // although DNS said to keep it for 5 minutes.
  let err = await socks(P, 'gone.example', DEAD).then(() => null, (e) => e.message);
  t.ok(err === 'SOCKS reply 4', 'every address refused: the client is told "host unreachable"');
  await sleep(300);
  let un = events('unreachable').filter((e) => e.host === 'gone.example');
  t.ok(un.length === 1 && un[0].stage === 'connect' && un[0].ips === 1, `reported: ${JSON.stringify(un[0])}`);
  err = await socks(P, 'gone.example', DEAD).then(() => null, (e) => e.message);
  t.ok(err === 'SOCKS reply 4' && dns.asked['gone.example/AAAA'] === 2, 'the failed address was dropped: the name is looked up again');
  await sleep(300);
  un = events('unreachable').filter((e) => e.host === 'gone.example');
  t.ok(un.length === 1, 'a host retried at once is reported once, not on every retry');

  err = await socks(P, 'nowhere.invalid', 443).then(() => null, (e) => e.message);
  await sleep(300);
  un = events('unreachable').filter((e) => e.host === 'nowhere.invalid');
  t.ok(err === 'SOCKS reply 4' && un.length === 1 && un[0].stage === 'dns' && un[0].ips === 0,
    `a name that does not resolve: reported as a DNS failure (${JSON.stringify(un[0])})`);

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); dns.close();
  console.log(`engine-dial: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
