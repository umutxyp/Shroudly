'use strict';

/* The last way out (--fallback-file; Tor on the device, tor-route.js): used
 * only for a connection nothing else got through. Covered:
 *   - a name with no address to be reached (blocked by its addresses, or its
 *     lookup refused): carried through the last way out, asked by name
 *   - a site that stays silent to every technique (a filter that drops):
 *     the ladder gives up and the same request goes through the last way
 *     out; the TLS handshake and the page come back whole, in under 25 s
 *     once it has carried something (a browser gives up at 30)
 *   - after that the name goes straight there, without the ladder, and the
 *     engine says it once ({"type":"fallback","ok":1,"host":...})
 *   - an address on this computer or its network: never through it
 *   - the user's own server set: that one carries everything, this is not used
 *   - not running (Tor not started yet): the connection fails as before, and
 *     the engine says so ({"type":"fallback","ok":0}), which is what starts it */

const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const H = require('./helpers');

const t = H.suite('engine-fallback');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-fallback-'));
const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text, { mode: 0o600 }); return f; };
const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));

/* GET https://host/ through the engine, as a browser would. */
async function get(P, host, port, timeoutMs = 40000) {
  let raw;
  try { raw = await H.socks(P, host, port); } catch { return 'refused'; }
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    let out = '';
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('secureConnect', () => s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => done(out.split('\r\n')[0] || 'empty'));
    s.on('error', () => done('error'));
    setTimeout(() => done('timeout'), timeoutMs);
  });
}

(async () => {
  // The world, as Tor reaches it: a TLS site behind a SOCKS5 stand-in.
  const world = tls.createServer(H.testServerOptions(), (s) => {
    s.on('error', () => {});
    s.once('data', () => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  }).listen(0, '127.0.0.1');
  await listening(world);
  const tor = H.socksServer(world.address().port);
  await listening(tor);
  const torFile = file('tor.txt', `socks5://127.0.0.1:${tor.address().port}\n`);

  // A site the network drops: takes the connection, never answers.
  const silent = net.createServer((c) => { c.on('error', () => {}); c.on('data', () => {}); });
  await new Promise((r) => silent.listen({ port: 0, host: '::1', ipv6Only: true }, r));
  const silentPort = silent.address().port;

  const dns = await H.dnsStub({ 'dropped.example': { AAAA: ['::1'] } });
  const base = ['--auto', '--doh', '--doh-port', String(dns.port), '--ipv6'];

  {
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--fallback-file', torFile]);

    // No address at all: straight to the last way out, by name.
    const a = await get(P, 'gone.example', 443);
    t.ok(a === 'HTTP/1.1 200 OK' && tor.asked.length === 1 && tor.asked[0].atyp === 3 && tor.asked[0].host === 'gone.example',
      `a name with no address to be reached comes back through the last way out, asked by name (${a}, ${JSON.stringify(tor.asked)})`);
    await H.sleep(200);
    t.ok((eng.out.match(/"type":"fallback","ok":1,"host":"gone\.example"/g) || []).length === 1, 'and the engine says so once');

    // Silent to every technique: the ladder gives up, then the last way out.
    const t0 = Date.now();
    const b = await get(P, 'dropped.example', silentPort, 60000);
    const took = Date.now() - t0;
    const gaveUp = (eng.out.match(/\{"type":"blocked","host":"dropped\.example"[^\n]*/) || [''])[0];
    const attempts = Number((gaveUp.match(/"attempts":(\d+)/) || [])[1] || 0);
    t.ok(b === 'HTTP/1.1 200 OK' && tor.asked.length === 2 && tor.asked[1].host === 'dropped.example' && attempts > 1 && took < 25000,
      `a site that stays silent to every technique (${attempts} tried) comes back through the last way out, handshake and page whole (${b}, ${took} ms)`);

    // Next time: straight there, without the ladder.
    const t1 = Date.now();
    const c = await get(P, 'dropped.example', silentPort);
    const took2 = Date.now() - t1;
    t.ok(c === 'HTTP/1.1 200 OK' && tor.asked.length === 3 && took2 < 3000,
      `after that the name goes straight through it (${took2} ms)`);
    await H.sleep(200);
    t.ok((eng.out.match(/"type":"fallback","ok":1,"host":"dropped\.example"/g) || []).length === 1, 'said once, not per connection');

    // This computer: never through it.
    const dead = await H.freePort();
    const d = await get(P, '127.0.0.1', dead, 8000);
    t.ok(d !== 'HTTP/1.1 200 OK' && tor.asked.length === 3, `an address on this computer never goes through the last way out (${d})`);
    eng.stop();
  }

  // The user's own server set: it carries everything, the last way out is not used.
  {
    const own = H.socksServer(world.address().port);
    await listening(own);
    const P = await H.freePort();
    const before = tor.asked.length;
    const eng = await H.startEngine(P, [...base, '--upstream-file', file('own.txt', `socks5://127.0.0.1:${own.address().port}`), '--fallback-file', torFile]);
    const r = await get(P, 'gone.example', 443);
    t.ok(r === 'HTTP/1.1 200 OK' && own.asked.length === 1 && tor.asked.length === before, 'with the user\'s own server set, that one carries it and the last way out is left alone');
    eng.stop(); own.close();
  }

  // Not running yet: the connection fails as before, and the engine says so.
  {
    const deadPort = await H.freePort();
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--fallback-file', file('dead.txt', `socks5://127.0.0.1:${deadPort}`)]);
    const r = await get(P, 'gone.example', 443, 15000);
    await H.sleep(300);
    t.ok(r !== 'HTTP/1.1 200 OK' && /"type":"fallback","ok":0,"why":"does not answer"/.test(eng.out),
      `not running: the connection fails as before (${r}), and the engine says so, which starts it`);
    eng.stop();
  }

  // An unusable file: the engine starts without it and says so.
  {
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--fallback-file', file('bad.txt', 'ftp://x:1')]);
    await H.sleep(200);
    t.ok(/"type":"fallback","ok":0,"why":"file unusable"/.test(eng.out), 'an unusable file: the engine runs without it and says so');
    eng.stop();
  }

  world.close(); tor.close(); silent.close(); dns.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`engine-fallback: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
