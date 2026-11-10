'use strict';

/* Two lists the user keeps in the Connections list and Settings:
 *   - TOR <name>: a site that turns the user's country away itself (a
 *     geo-block, which no technique changes) goes straight through the last
 *     way out (Tor), with every name under it; UNTOR brings it back. Not
 *     usable (no last way out set) it goes the usual way.
 *   - ONLY <name> with ONLY-MODE 1: Shroudly works on the listed names
 *     alone; any other goes out as it is, with the network's own DNS (so a
 *     name only Shroudly's resolver knows is not found), and comes back
 *     with ONLY-MODE 0.
 * The Connections list says which names go through Tor by choice. */

const fs = require('fs');
const os = require('os');
const tls = require('tls');
const path = require('path');
const H = require('./helpers');

const t = H.suite('engine-tor-only');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-toronly-'));
const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));

/* GET https://host/ through the engine: the status line, or what failed. */
async function get(P, host, port, timeoutMs = 15000) {
  let raw;
  try { raw = await H.socks(P, host, port); } catch { return 'refused'; }
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername: host, ...H.testClientOptions(), ALPNProtocols: ['http/1.1'] });
    let out = '';
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('secureConnect', () => s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => done(out.split('\r\n')[0] || 'empty'));
    s.on('error', () => done('error'));
    setTimeout(() => done('timeout'), timeoutMs);
  });
}

const site = (status) => tls.createServer(H.testServerOptions(), (s) => {
  s.on('error', () => {});
  s.once('data', () => s.end(`HTTP/1.1 ${status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok`));
});

(async () => {
  // The site as the user's country sees it (it turns them away), and as Tor
  // reaches it (from elsewhere).
  const here = site('403 Forbidden').listen({ port: 0, host: '::1', ipv6Only: true });
  await listening(here);
  const world = site('200 OK').listen(0, '127.0.0.1');
  await listening(world);
  const tor = H.socksServer(world.address().port);
  await listening(tor);
  const torFile = path.join(dir, 'tor.txt');
  fs.writeFileSync(torFile, `socks5://127.0.0.1:${tor.address().port}\n`, { mode: 0o600 });
  const port = here.address().port;

  const dns = await H.dnsStub({ 'geo.example': { AAAA: ['::1'] }, 'api.geo.example': { AAAA: ['::1'] },
    'listed.example': { AAAA: ['::1'] }, 'unlisted.example': { AAAA: ['::1'] } });
  const base = ['--auto', '--doh', '--doh-port', String(dns.port), '--ipv6'];

  {
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--fallback-file', torFile]);
    t.ok(await get(P, 'geo.example', port) === 'HTTP/1.1 403 Forbidden', 'a site that turns this country away answers 403 the usual way');
    eng.proc.stdin.write('TOR geo.example\n');
    await H.sleep(200);
    t.ok(/"type":"tor_site","ok":1/.test(eng.out), 'TOR is taken');
    const a = await get(P, 'geo.example', port);
    const b = await get(P, 'api.geo.example', port);
    t.ok(a === 'HTTP/1.1 200 OK' && b === 'HTTP/1.1 200 OK' && tor.asked.some((x) => x.host === 'geo.example') && tor.asked.some((x) => x.host === 'api.geo.example'),
      `sent through Tor it opens, and a name under it too, asked by name (${a}, ${b})`);
    const before = eng.out.length;
    eng.proc.stdin.write('CONNS\n');
    await H.sleep(300);
    const row = eng.out.slice(before).split('\n').find((l) => l.includes('"host":"geo.example"'));
    t.ok(row && /"tor":1/.test(row) && /"route":"tor"/.test(row), `the Connections list says it goes through Tor by choice (${row})`);
    eng.proc.stdin.write('UNTOR geo.example\n');
    await H.sleep(200);
    t.ok(await get(P, 'geo.example', port) === 'HTTP/1.1 403 Forbidden', 'UNTOR brings it back the usual way');
    eng.stop();
  }

  {
    /* An app picked in "Apps through Tor" that connects by address
     * (Telegram): TOR <address>/<bits> sends every address in the range
     * there at once, without first waiting on the address itself (TEST-NET
     * ranges answer nobody, so the usual way would wait for the dial). */
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--fallback-file', torFile]);
    const open = async (host) => {
      const t0 = Date.now();
      const n0 = tor.asked.length;
      try { const s = await H.socks(P, host, 443); s.destroy(); } catch { return { ok: false, ms: Date.now() - t0, asked: null }; }
      return { ok: true, ms: Date.now() - t0, asked: tor.asked.slice(n0).map((x) => x.host) };
    };
    eng.proc.stdin.write('TOR 192.0.2.0/24\nTOR 2001:db8::/32\nTOR 192.0.2.0/33\nTOR 10.0.0.1/8x\n');
    await H.sleep(300);
    t.ok((eng.out.match(/"type":"tor_site","ok":1/g) || []).length === 2, 'two ranges taken, the malformed ones not');
    const a = await open('192.0.2.7');
    t.ok(a.ok && a.ms < 3000 && a.asked.join() === '192.0.2.7', `an address in the range goes through Tor at once (${a.ms} ms, ${a.asked})`);
    const b = await open('2001:db8::5');
    t.ok(b.ok && b.ms < 3000 && b.asked.join() === 'v6', `an IPv6 one too (the stand-in notes an IPv6 address as v6) (${b.ms} ms, ${b.asked})`);
    const before = eng.out.length;
    eng.proc.stdin.write('CONNS\n');
    await H.sleep(300);
    const row = eng.out.slice(before).split('\n').find((l) => l.includes('"host":"192.0.2.7"'));
    t.ok(row && /"route":"tor"/.test(row), `the Connections list shows it went through Tor (${row})`);
    eng.proc.stdin.write('UNTOR 192.0.2.0/24\n');
    await H.sleep(200);
    const c = await open('192.0.2.8');
    t.ok(c.ms > 3000, `UNTOR: the usual way again, the address itself tried first (${c.ms} ms)`);
    // TOR-CLEAR then the list again (how the Mac app sends a change): what
    // left the list is forgotten as carried, not kept through Tor.
    eng.proc.stdin.write('TOR 198.51.100.0/24\n');
    await H.sleep(200);
    const d = await open('198.51.100.9');
    eng.proc.stdin.write('TOR-CLEAR\n');
    await H.sleep(200);
    const e = await open('198.51.100.9');
    t.ok(d.ms < 3000 && e.ms > 3000, `TOR-CLEAR: an address that left the list goes the usual way again (${d.ms} ms, then ${e.ms} ms)`);
    eng.stop();
  }

  {
    // No last way out set (the lite APK, or Tor turned off): the usual way.
    const P = await H.freePort();
    const eng = await H.startEngine(P, base);
    eng.proc.stdin.write('TOR geo.example\n');
    await H.sleep(200);
    t.ok(await get(P, 'geo.example', port) === 'HTTP/1.1 403 Forbidden', 'with no last way out the listed site goes the usual way, not nowhere');
    eng.stop();
  }

  {
    // Only listed names: the rest out as they are, with the network's DNS.
    const P = await H.freePort();
    const eng = await H.startEngine(P, base);
    t.ok(await get(P, 'unlisted.example', port) === 'HTTP/1.1 403 Forbidden', 'every name worked on: one only our resolver knows opens');
    eng.proc.stdin.write('ONLY listed.example\nONLY-MODE 1\n');
    await H.sleep(200);
    t.ok(await get(P, 'listed.example', port) === 'HTTP/1.1 403 Forbidden', 'ONLY: a listed name is still worked on (our resolver)');
    t.ok(await get(P, 'unlisted.example', port) === 'refused', 'ONLY: another name goes out as it is, with the network\'s DNS, which does not know it');
    eng.proc.stdin.write('ONLY-MODE 0\n');
    await H.sleep(200);
    t.ok(await get(P, 'unlisted.example', port) === 'HTTP/1.1 403 Forbidden', 'ONLY-MODE 0: every name worked on again');
    eng.stop();
  }

  here.close(); world.close(); tor.close(); dns.close();
  console.log(`engine-tor-only: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
