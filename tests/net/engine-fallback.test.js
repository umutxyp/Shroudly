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
 *     the engine says so ({"type":"fallback","ok":0}) with the name that
 *     needed it, which is what asks the user (issue #77) or starts it
 *   - Tor up but nothing carried yet (issue #77): a silent site reaches it
 *     without waiting 30 s more for a late answer, and another name of a
 *     site it carries walks a short ladder before it */

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

  // gone.example: encrypted DNS never answers for it (its lookup refused).
  const dns = await H.dnsStub({ 'dropped.example': { AAAA: ['::1'] }, 'cdn.dropped.example': { AAAA: ['::1'] }, 'gone.example': { silent: true },
    'www.roblox.com': { AAAA: ['::1'] }, 'c0.rbxcdn.com': { AAAA: ['::1'] } });
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

    /* A name encrypted DNS says does not exist (NXDOMAIN): Tor cannot reach
     * it either, so it is not started for it (OPPO's retired telemetry name
     * started Tor at every Start). */
    const asked = tor.asked.length;
    const nx = await get(P, 'nosuch.example', 443, 8000);
    await H.sleep(200);
    t.ok(nx !== 'HTTP/1.1 200 OK' && tor.asked.length === asked && !/"type":"fallback"[^\n]*nosuch\.example/.test(eng.out),
      `a name that does not exist is not sent to the last way out (${nx}, ${tor.asked.length - asked} asked)`);

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

    // FALLBACK-FORGET (Advanced mode came on): Tor is never a name's habit;
    // the next connection walks every technique again before it.
    eng.proc.stdin.write('FALLBACK-FORGET\n');
    await H.sleep(100);
    const blockedBefore = (eng.out.match(/"type":"blocked","host":"dropped\.example"/g) || []).length;
    const e2 = await get(P, 'dropped.example', silentPort, 60000);
    const blockedAfter = (eng.out.match(/"type":"blocked","host":"dropped\.example"/g) || []).length;
    t.ok(e2 === 'HTTP/1.1 200 OK' && tor.asked.length === 4 && blockedAfter === blockedBefore + 1,
      `after FALLBACK-FORGET the techniques are tried again first, Tor only after them (${blockedBefore} -> ${blockedAfter} ladders)`);

    // This computer: never through it.
    const dead = await H.freePort();
    const d = await get(P, '127.0.0.1', dead, 8000);
    t.ok(d !== 'HTTP/1.1 200 OK' && tor.asked.length === 4, `an address on this computer never goes through the last way out (${d})`);
    eng.stop();
  }

  // Tor up, nothing carried yet by this engine (issue #77).
  {
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--fallback-file', torFile]);
    const n0 = tor.asked.length;
    const t0 = Date.now();
    const a = await get(P, 'dropped.example', silentPort, 60000);
    const first = Date.now() - t0;
    t.ok(a === 'HTTP/1.1 200 OK' && tor.asked.length === n0 + 1 && first < 25000,
      `Tor up, nothing carried yet: a silent site reaches it without the 30 s wait for a late answer (${first} ms)`);
    const t1 = Date.now();
    const b = await get(P, 'cdn.dropped.example', silentPort, 60000);
    const sib = Date.now() - t1;
    const sibLadder = /"type":"blocked","host":"cdn\.dropped\.example"/.test(eng.out);
    t.ok(b === 'HTTP/1.1 200 OK' && tor.asked.length === n0 + 2 && sibLadder && sib < 12000 && sib < first,
      `another name of that site: the techniques first, briefly, then Tor (${sib} ms against ${first} ms)`);
    /* Another domain of the same service (SITE_FAMILY: roblox.com and
     * rbxcdn.com) is not "that site": it keeps its whole ladder. Since 2.6.58
     * the family was taken for one site here, and the game's maps and items
     * on rbxcdn.com went to Tor after 6 s because a roblox.com name had. */
    await get(P, 'www.roblox.com', silentPort, 60000);
    const t2 = Date.now();
    await get(P, 'c0.rbxcdn.com', silentPort, 60000);
    const fam = Date.now() - t2;
    t.ok(fam > 12000, `another domain of the same service keeps its whole ladder (${fam} ms against ${sib} ms)`);
    eng.stop();
  }

  // A site the network lets open and then cuts, every time (Iran's
  // WhatsApp): after a few, its next connection goes to the last way out.
  {
    // A censor in front of a working site: the handshake passes, the request
    // is answered with a reset.
    const site = tls.createServer(H.testServerOptions(), (s) => { s.on('error', () => {}); s.on('data', () => {}); });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    const cutter = net.createServer((c) => {
      const u = net.connect(site.address().port, '127.0.0.1');
      const sawRequest = H.requestWatcher();
      c.on('error', () => {}); u.on('error', () => {});
      c.on('data', (d) => { if (sawRequest(d)) { c.resetAndDestroy(); u.destroy(); return; } u.write(d); });
      u.on('data', (d) => { if (!c.destroyed) c.write(d); });
    });
    await new Promise((r) => cutter.listen({ port: 0, host: '::1', ipv6Only: true }, r));
    const cutPort = cutter.address().port;
    const dns2 = await H.dnsStub({ 'cut.example': { AAAA: ['::1'] } });
    const P = await H.freePort();
    const eng = await H.startEngine(P, ['--auto', '--doh', '--doh-port', String(dns2.port), '--ipv6', '--fallback-file', torFile]);
    const n0 = tor.asked.length;
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push(await get(P, 'cut.example', cutPort, 20000));
    const cuts = (eng.out.match(/"type":"cut","host":"cut\.example"/g) || []).length;
    t.ok(cuts >= 3 && tor.asked.length > n0 && tor.asked[tor.asked.length - 1].host === 'cut.example' && seen[seen.length - 1] === 'HTTP/1.1 200 OK',
      `cut once open, again and again (${cuts} cuts): its next connection goes through the last way out (${seen.join(', ')})`);
    eng.stop(); cutter.close(); site.close(); dns2.close();
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
    t.ok(r !== 'HTTP/1.1 200 OK' && /"type":"fallback","ok":0,"why":"does not answer","host":"gone\.example"/.test(eng.out),
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
