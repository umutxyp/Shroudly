'use strict';

/* SOCKS4 and SOCKS4a, which Firefox's system "SOCKS" setting, WinINet's
 * "socks=" and PAC "SOCKS" lines use. A SOCKS4 client resolves names itself,
 * through the system's DNS — the one a censor poisons — so when it asks for a
 * known block page the engine takes the real name from the TLS server name or
 * the HTTP Host and resolves that with its own resolver. 0.0.0.0 and loopback
 * are NOT treated so: a hosts-file ad blocker, Pi-hole/AdGuard/NextDNS in
 * null-IP mode or a developer's override answers with those on purpose, and
 * the engine must connect where it was asked, like for any other address.
 * A local DNS server stands in for the app's encrypted-DNS forwarder; nothing
 * here needs the internet. */

const tls = require('tls');
const net = require('net');
const http = require('http');
const { startEngine, sleep, freePort, socks4, dnsStub, testServerOptions, suite } = require('./helpers');

const t = suite('engine-socks4');
const BLOCK_PAGE = '203.0.113.10';   // stands in for one of the app's --block-ip addresses

function handshake(raw, servername) {
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername, rejectUnauthorized: false });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.on('secureConnect', () => done(true)); s.on('error', () => done(false));
    setTimeout(() => done(false), 8000);
  });
}

/* A port free on ::1 and on 127.0.0.1 alike, so a "public" server and a local
 * one can listen on the same number. */
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

/* What a plain TCP connect to host:port does from here, without the engine. */
function directConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(true)); s.on('error', () => done(false));
    setTimeout(() => done(false), 3000);
  });
}

/* A web port nothing on this machine answers on (::1 and 127.0.0.1): the
 * "unreachable" report is only made for 80 and 443. */
async function deadWebPort() {
  for (const p of [443, 80]) {
    if (!(await directConnect('::1', p)) && !(await directConnect('127.0.0.1', p))) return p;
  }
  throw new Error('something listens on port 443 and port 80 of this machine; this test needs one of them free');
}

function server(host, port, onConn) {
  const s = tls.createServer(testServerOptions(), (c) => c.on('error', () => {}));
  s.on('connection', () => onConn && onConn());
  return new Promise((r) => s.listen({ port, host, ipv6Only: host === '::1' }, () => r(s)));
}

(async () => {
  // The real sites live on ::1 only; the block page the poisoned DNS pointed
  // at is somewhere else entirely. X serves on both ::1 ("public") and
  // 127.0.0.1 ("local"), so the tests can tell which one a connection reached.
  const X = await dualFreePort();
  let publicHits = 0, localHits = 0;
  const pub = await server('::1', X, () => publicHits++);
  const loc = await server('127.0.0.1', X, () => localHits++);
  const H = await freePort();
  const web = http.createServer((req, res) => res.end(`real site: ${req.headers.host}`));
  await new Promise((r) => web.listen({ port: H, host: '::1', ipv6Only: true }, r));
  const WEB = await deadWebPort();

  const dns = await dnsStub({
    'socks4a.example': { AAAA: ['::1'] },
    'sinkholed.example': { AAAA: ['::1'] },
    'sinkholed-http.example': { AAAA: ['::1'] },
    'gone-blockpage.example': { AAAA: ['::1'] },
    // What the public DNS says; the user's hosts file / filtering DNS says
    // 127.0.0.1 and 0.0.0.0, and that is what the client asks the engine for.
    'api.company.example': { AAAA: ['::1'] },
    'ads.tracker.example': { AAAA: ['::1'] },
  });
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(dns.port), '--ipv6', '--block-ip', BLOCK_PAGE]);
  const events = (type) => eng.out.split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));

  t.ok(await handshake(await socks4(P, 'socks4a.example', X), 'socks4a.example'),
    'SOCKS4a: the engine resolves the name itself and connects (reply 0x5A)');

  let before = publicHits;
  t.ok(await handshake(await socks4(P, '195.175.254.2', X), 'sinkholed.example') && publicHits === before + 1,
    'SOCKS4 to the built-in block page: the real name comes from the TLS server name and loads');
  t.ok(dns.asked['sinkholed.example/AAAA'] >= 1, 'and that name went to our resolver, not the system one');

  const raw = await socks4(P, BLOCK_PAGE, H);
  const body = await new Promise((resolve) => {
    let b = ''; raw.on('data', (d) => { b += d; }); raw.on('end', () => resolve(b)); raw.on('error', () => resolve(b));
    raw.write(`GET / HTTP/1.1\r\nHost: sinkholed-http.example:${H}\r\nConnection: close\r\n\r\n`);
    setTimeout(() => resolve(b), 8000);
  });
  t.ok(/200 OK/.test(body) && body.includes('real site: sinkholed-http.example'),
    'SOCKS4 to a block page the app registered (--block-ip), plain HTTP: the name comes from the Host header');

  // The user's own DNS decisions. A hosts file mapping a real name to
  // 127.0.0.1 points it at a local server on purpose.
  before = publicHits; let beforeLocal = localHits;
  const okLocal = await handshake(await socks4(P, '127.0.0.1', X), 'api.company.example');
  await sleep(200);
  t.ok(okLocal && localHits === beforeLocal + 1 && publicHits === before,
    `SOCKS4 to 127.0.0.1 for a public name: reaches the LOCAL server, never the public one (local +${localHits - beforeLocal}, public +${publicHits - before})`);
  t.ok(!dns.asked['api.company.example/AAAA'] && !dns.asked['api.company.example/A'], 'and the name is not looked up behind the user\'s back');

  // 0.0.0.0 from an ad blocker: connected to as given, which is whatever a
  // connect to 0.0.0.0 does on this OS — this machine, on macOS and Linux; an
  // error on Windows (where Node itself quietly rewrites it to 127.0.0.1, so
  // Node's own connect is no guide there) — and never the real ad server.
  before = publicHits;
  const direct = process.platform === 'win32' ? false : await directConnect('0.0.0.0', X);
  let viaEngine = false;
  try { viaEngine = await handshake(await socks4(P, '0.0.0.0', X), 'ads.tracker.example'); } catch { viaEngine = false; }
  await sleep(200);
  t.ok(publicHits === before && viaEngine === direct,
    `SOCKS4 to 0.0.0.0 (ad-blocked name): never reaches the public server, does what a connect to 0.0.0.0 does here (${direct ? 'this machine' : 'fails'})`);
  t.ok(!dns.asked['ads.tracker.example/AAAA'] && !dns.asked['ads.tracker.example/A'], 'and the blocked name is not looked up either');

  t.ok(await handshake(await socks4(P, '127.0.0.1', X), 'localhost'),
    'SOCKS4 to 127.0.0.1 for a local name stays local');
  t.ok(!Object.keys(dns.asked).some((k) => k.startsWith('localhost')), 'and the local name is never sent to a resolver');

  // Block page, but the real name cannot be reached either: the log names the
  // site the user meant, never the block page's address.
  const r2 = await socks4(P, BLOCK_PAGE, WEB);
  const s2 = tls.connect({ socket: r2, servername: 'gone-blockpage.example', rejectUnauthorized: false });
  s2.on('error', () => {});
  const closed = new Promise((resolve) => { r2.on('close', resolve); setTimeout(resolve, 16000); });
  for (let i = 0; i < 50 && !events('unreachable').some((e) => e.host === 'gone-blockpage.example'); i++) await sleep(100);
  const un = events('unreachable').filter((e) => e.host === 'gone-blockpage.example');
  t.ok(un.length === 1 && un[0].stage === 'connect', `the recovered name is reported unreachable: ${JSON.stringify(un[0])}`);
  await closed;   // the engine then tried the block page itself, as the client asked
  s2.destroy();
  t.ok(!events('unreachable').some((e) => e.host === BLOCK_PAGE || e.host === '0.0.0.0' || e.host === '127.0.0.1'),
    'no "unreachable" line ever names an address');

  let err = await socks4(P, '127.0.0.1', X, { cmd: 2 }).then(() => null, (e) => e.message);
  t.ok(err === 'SOCKS4 reply 91', 'BIND is refused with 0x5B');

  // A SOCKS4a name nobody can resolve. Asked of an engine without --doh, so
  // only this machine's own resolver is involved, not the public ones.
  const P2 = await freePort();
  const eng2 = await startEngine(P2, ['--auto']);
  err = await socks4(P2, 'nowhere.invalid', 443).then(() => null, (e) => e.message);
  t.ok(err === 'SOCKS4 reply 91', 'SOCKS4a name that does not resolve: 0x5B');

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err + eng2.err), 'engine still up, no sanitizer errors');
  eng.stop(); eng2.stop(); pub.close(); loc.close(); web.close(); dns.close();
  console.log(`engine-socks4: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
