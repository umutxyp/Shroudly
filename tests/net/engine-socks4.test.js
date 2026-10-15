'use strict';

/* SOCKS4 and SOCKS4a, which Firefox's system "SOCKS" setting, WinINet's
 * "socks=" and PAC "SOCKS" lines use. A SOCKS4 client resolves names itself,
 * through the system's DNS — the one a censor poisons — so when it asks for a
 * block page or a sinkhole the engine takes the real name from the TLS server
 * name or the HTTP Host and resolves that with its own resolver. A local DNS
 * server stands in for the app's encrypted-DNS forwarder. */

const tls = require('tls');
const net = require('net');
const http = require('http');
const dnsLookup = require('dns').promises.lookup;
const { startEngine, freePort, socks4, dnsStub, testServerOptions, suite } = require('./helpers');

const t = suite('engine-socks4');

function handshake(raw, servername) {
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername, rejectUnauthorized: false });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.on('secureConnect', () => done(true)); s.on('error', () => done(false));
    setTimeout(() => done(false), 8000);
  });
}

(async () => {
  // The real sites live on ::1 only; the block page the poisoned DNS pointed
  // at is somewhere else entirely.
  const X = await freePort();
  const v6 = tls.createServer(testServerOptions(), (s) => s.on('error', () => {}));
  await new Promise((r) => v6.listen({ port: X, host: '::1', ipv6Only: true }, r));
  const H = await freePort();
  const web = http.createServer((req, res) => res.end(`real site: ${req.headers.host}`));
  await new Promise((r) => web.listen({ port: H, host: '::1', ipv6Only: true }, r));
  const L = await freePort();
  const local = tls.createServer(testServerOptions(), (s) => s.on('error', () => {}));
  await new Promise((r) => local.listen(L, '127.0.0.1', r));

  const dns = await dnsStub({
    'socks4a.example': { AAAA: ['::1'] },
    'sinkholed.example': { AAAA: ['::1'] },
    'sinkholed-http.example': { AAAA: ['::1'] },
  });
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(dns.port), '--ipv6']);

  t.ok(await handshake(await socks4(P, 'socks4a.example', X), 'socks4a.example'),
    'SOCKS4a: the engine resolves the name itself and connects (reply 0x5A)');

  t.ok(await handshake(await socks4(P, '195.175.254.2', X), 'sinkholed.example'),
    'SOCKS4 to a known block page: the real name comes from the TLS server name and loads');
  t.ok(dns.asked['sinkholed.example/AAAA'] >= 1, 'and that name went to our resolver, not the system one');

  const raw = await socks4(P, '0.0.0.0', H);
  const body = await new Promise((resolve) => {
    let b = ''; raw.on('data', (d) => { b += d; }); raw.on('end', () => resolve(b)); raw.on('error', () => resolve(b));
    raw.write(`GET / HTTP/1.1\r\nHost: sinkholed-http.example:${H}\r\nConnection: close\r\n\r\n`);
    setTimeout(() => resolve(b), 8000);
  });
  t.ok(/200 OK/.test(body) && body.includes('real site: sinkholed-http.example'),
    'SOCKS4 to 0.0.0.0 over plain HTTP: the name comes from the Host header');

  t.ok(await handshake(await socks4(P, '127.0.0.1', L), 'localhost'),
    'SOCKS4 to 127.0.0.1 for a local name stays local');
  t.ok(!Object.keys(dns.asked).some((k) => k.startsWith('localhost')), 'and the local name is never sent to a resolver');

  let err = await socks4(P, '127.0.0.1', L, { cmd: 2 }).then(() => null, (e) => e.message);
  t.ok(err === 'SOCKS4 reply 91', 'BIND is refused with 0x5B');
  err = await socks4(P, 'nowhere.invalid', 443).then(() => null, (e) => e.message);
  t.ok(err === 'SOCKS4 reply 91', 'SOCKS4a name that does not resolve: 0x5B');

  // An ordinary SOCKS4 request for a real address on the real internet.
  let ok = false; let ip = '';
  for (let i = 0; i < 2 && !ok; i++) {
    try {
      ip = (await dnsLookup('example.com', { family: 4 })).address;
      ok = await handshake(await socks4(P, ip, 443), 'example.com');
    } catch { ok = false; }
  }
  t.ok(ok, `plain SOCKS4 to a public address (example.com, ${ip}) connects`);

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); v6.close(); web.close(); local.close(); dns.close();
  console.log(`engine-socks4: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
