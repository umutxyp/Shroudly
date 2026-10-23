'use strict';

/* A site the addresses from encrypted DNS do not reach, while the network's
 * own DNS gives one that does: a CDN's cache inside the country, as YouTube's
 * video servers in Iran (issue #37). The engine's resolver (a forwarder
 * standing in) gives the name an address nothing answers at (192.0.2.1, a
 * documentation address); the system's resolver gives 127.0.0.1, where a
 * TLS server is. What it proves:
 *   - the very first connection, once nothing answers at the address from
 *     encrypted DNS, goes on to where the network's DNS says and is
 *     answered: no second try needed (issue #40);
 *   - the next ones go there at once; the engine says so (a "try", then an
 *     "ok" line), once;
 *   - with "Only this server" (--dns-strict) the network's DNS is never
 *     asked: both connections fail.
 * The system's resolver is this computer's real one: 127.0.0.1.nip.io
 * resolves to 127.0.0.1 through public DNS. Where it does not, the test says
 * so and checks nothing. (--raw-local lets the engine take a loopback
 * address from the network's DNS, which it never does otherwise.) */

const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { startEngine, sleep, freePort, socks, dnsStub, testServerOptions, suite } = require('./helpers');

const t = suite('engine-netdns');
const NAME = '127.0.0.1.nip.io';
const lines = (eng, from) => eng.out.slice(from).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/* A TLS handshake through the engine to NAME: true when the server answered
 * with its certificate (test.local's, checked against it as a CA). */
async function handshake(P, port) {
  let s;
  try { s = await socks(P, NAME, port); } catch { return false; }
  return new Promise((resolve) => {
    const c = tls.connect({ socket: s, servername: 'test.local', ca: testServerOptions().cert });
    const done = (ok) => { clearTimeout(timer); c.destroy(); s.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), 20000);
    c.on('secureConnect', () => done(true));
    c.on('error', () => done(false));
    c.on('close', () => done(false));
  });
}

(async () => {
  const sys = await new Promise((r) => dns.lookup(NAME, { all: true }, (e, a) => r(e ? null : a.map((x) => x.address))));
  if (!sys || !sys.includes('127.0.0.1')) {
    console.log(`  --  ${NAME} does not resolve to 127.0.0.1 here (${JSON.stringify(sys)}): nothing checked`);
    console.log('engine-netdns: skipped');
    process.exit(0);
  }
  const srv = tls.createServer(testServerOptions(), (c) => { c.on('error', () => {}); c.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const stub = await dnsStub({ [NAME]: { A: ['192.0.2.1'] } });
  let eng = null;
  try {
    let P = await freePort();
    eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(stub.port), '--raw-local']);
    let from = eng.out.length;
    let t0 = Date.now();
    t.ok(await handshake(P, port), `encrypted DNS's address answers nothing: the same connection goes where the network's DNS says (127.0.0.1) and is answered (${Date.now() - t0} ms)`);
    t0 = Date.now();
    t.ok(await handshake(P, port), `the next one goes there at once (${Date.now() - t0} ms)`);
    t.ok(Date.now() - t0 < 3000, 'without waiting on the address that answers nothing');
    const nd = lines(eng, from).filter((l) => l.type === 'netdns');
    t.ok(nd.length === 2 && nd[0].stage === 'try' && nd[1].stage === 'ok' && nd.every((l) => l.addr === '127.0.0.1'),
      `said once, as it happened: ${nd.map((l) => `${l.stage} ${l.addr}`).join(', ')}`);
    eng.stop(); await sleep(200);

    // "Only this server": its answers and no other's.
    P = await freePort();
    eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(stub.port), '--raw-local', '--dns-strict']);
    from = eng.out.length;
    const a = await handshake(P, port);
    const b = await handshake(P, port);
    t.ok(!a && !b && !lines(eng, from).some((l) => l.type === 'netdns'), 'with Only this server: never the network\'s DNS, both fail');
  } finally {
    if (eng) eng.stop();
    stub.close(); srv.close();
  }
  console.log(`engine-netdns: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
