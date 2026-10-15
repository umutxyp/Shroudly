'use strict';

/* A name whose addresses of one family are all dead (blocked by address, or
 * a family the network does not route) while the other family's work. The
 * engine dials the families in turn (RFC 8305: the preferred one's first
 * address, then the other's first, ...) and starts the next address beside one
 * that has not connected within a second, so a working address is reached
 * within a second or two — every time, however many dead addresses come
 * first. 2.5.4 took 8 s here; a version that gave the preferred family the
 * whole dial budget failed outright with three dead addresses, then worked,
 * then failed again, as it forgot the dead ones and looked them up afresh.
 * The same holds within one family: dead addresses ahead of a working one
 * (2.5.4 only ever tried the first). And the address that won is remembered
 * for the name, so its next connections — and every re-dial of a ladder,
 * whose budget a second each would eat — go straight to it.
 *
 * A local DNS server stands in for the app's encrypted-DNS forwarder. The
 * dead addresses are TEST-NET ones (RFC 5737), which go nowhere on most
 * networks; one that rejects them at once has nothing to show here. (A
 * working IPv4 address behind dead IPv6 ones cannot be staged this way: the
 * engine's resolver rightly refuses loopback and private IPv4 answers.) */

const tls = require('tls');
const net = require('net');
const { startEngine, freePort, socks, dnsStub, testServerOptions, suite } = require('./helpers');

const t = suite('engine-family');

/* A port free on ::1 and on 127.0.0.1 alike. */
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

function directConnect(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done('open')); s.on('error', () => done('refused'));
    setTimeout(() => done('timeout'), ms);
  });
}

/* Connect through the engine and finish a TLS handshake: ms taken, or null. */
async function reach(P, name, port) {
  const t0 = Date.now();
  let raw;
  try { raw = await socks(P, name, port); } catch { return null; }
  const ok = await new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('secureConnect', () => done(true)); s.on('error', () => done(false));
    setTimeout(() => done(false), 8000);
  });
  return ok ? Date.now() - t0 : null;
}

(async () => {
  if ((await directConnect('192.0.2.1', 443, 1500)) !== 'timeout') {
    console.log('  --  not checked here: this network rejects TEST-NET addresses at once, so none of them is dead in the way this needs');
    console.log('engine-family: 0 passed (skipped)');
    process.exit(0);
  }
  const X = await dualFreePort();
  const v6 = tls.createServer(testServerOptions(), (s) => s.on('error', () => {}));
  await new Promise((r) => v6.listen({ port: X, host: '::1', ipv6Only: true }, r));
  const v4 = tls.createServer(testServerOptions(), (s) => s.on('error', () => {}));
  await new Promise((r) => v4.listen({ port: X, host: '127.0.0.1' }, r));

  const dead = (n, from) => Array.from({ length: n }, (_, i) => `192.0.2.${from + i}`);
  const dns = await dnsStub({
    'v4dead3.example': { A: dead(3, 31), AAAA: ['::1'], ttl: 300 },
    'v4dead8.example': { A: dead(8, 41), AAAA: ['::1'], ttl: 300 },
    // IPv4 written as IPv6 is a dead "IPv6" address on any machine that has
    // dual-stack sockets (Windows does not connect to these at all).
    'v6late.example': { AAAA: ['::ffff:192.0.2.51', '::ffff:192.0.2.52', '::1'], ttl: 300 },
  });

  // IPv4 preferred (the default): its addresses are dead, IPv6 works.
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(dns.port)]);
  for (const [name, n] of [['v4dead3.example', 3], ['v4dead8.example', 8]]) {
    const times = [];
    for (let k = 0; k < 4; k++) times.push(await reach(P, name, X));
    t.ok(times.every((ms) => ms !== null && ms < 3500),
      `${n} dead IPv4 addresses, working IPv6: reached every time, within seconds (${times.map((ms) => (ms === null ? 'failed' : `${ms} ms`)).join(', ')})`);
    t.ok(times.slice(1).every((ms) => ms !== null && ms < 700), 'and after the first time at once: the working address is remembered');
  }
  t.ok(!eng.out.includes('"unreachable"'), 'and never reported unreachable');

  // IPv6 preferred (--ipv6): two dead addresses ahead of the working one.
  if (process.platform !== 'win32') {
    const P6 = await freePort();
    const eng6 = await startEngine(P6, ['--auto', '--doh', '--doh-port', String(dns.port), '--ipv6']);
    const times = [];
    for (let k = 0; k < 3; k++) times.push(await reach(P6, 'v6late.example', X));
    t.ok(times.every((ms) => ms !== null && ms < 4500) && times.slice(1).every((ms) => ms !== null && ms < 700),
      `--ipv6, two dead addresses before the working one: reached within seconds, then at once (${times.map((ms) => (ms === null ? 'failed' : `${ms} ms`)).join(', ')})`);
    t.ok(eng6.exited === null && !/AddressSanitizer|runtime error:/.test(eng6.err), 'engine (--ipv6) still up, no sanitizer errors');
    eng6.stop();
  }

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); v6.close(); v4.close(); dns.close();
  console.log(`engine-family: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
