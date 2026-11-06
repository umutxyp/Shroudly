'use strict';

/* DNS that goes around a device's tunnel (core/src/engine.c dns_way). On a
 * phone or tablet the tunnel answers lookups with stand-in addresses
 * (--fake-net) and connections come to the engine by name. Covered:
 *   - connections that keep coming by a real address, carrying a site's
 *     name, with none by name: {"type":"dns_around"} once, naming a site,
 *     after DNS_AROUND_AFTER (20 s) and DNS_AROUND_MIN (12) of them
 *   - not before both, and never twice
 *   - one connection by name (the tunnel's own lookup at work): never
 *   - without --fake-net (a computer): never */

const tls = require('tls');
const H = require('./helpers');

const t = H.suite('engine-dns-around');
const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));

async function hello(P, host, port, name) {
  const raw = await H.socks(P, host, port);
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername: name, ...H.testClientOptions() });
    const end = (ok) => { s.destroy(); resolve(ok); };
    s.on('secureConnect', () => end(true));
    s.on('error', () => end(false));
    setTimeout(() => end(false), 5000);
  });
}
const said = (eng) => (eng.out.match(/\{"type":"dns_around"[^\n]*\}/g) || []);

(async () => {
  const site = tls.createServer(H.testServerOptions(), (s) => { s.on('error', () => {}); s.end(); }).listen(0, '127.0.0.1');
  await listening(site);
  const port = site.address().port;

  // A DNS profile: every connection by address.
  {
    const P = await H.freePort();
    const eng = await H.startEngine(P, ['--fake-net', '198.18.0.0/15']);
    for (let i = 0; i < 14; i++) await hello(P, '127.0.0.1', port, `app${i}.example`);
    await H.sleep(200);
    t.ok(said(eng).length === 0, 'not in the first 20 seconds, however many');
    await H.sleep(20500);
    for (let i = 0; i < 3; i++) await hello(P, '127.0.0.1', port, `late${i}.example`);
    await H.sleep(200);
    const lines = said(eng);
    t.ok(lines.length === 1 && /"host":"late0\.example"/.test(lines[0]) && /"n":15/.test(lines[0]),
      `then said once, naming a site (${lines[0]})`);
    for (let i = 0; i < 3; i++) await hello(P, '127.0.0.1', port, `more${i}.example`);
    await H.sleep(200);
    t.ok(said(eng).length === 1, 'and never again in this run');
    eng.stop();
  }

  // The tunnel's lookup at work: one connection came by name.
  {
    const P = await H.freePort();
    const eng = await H.startEngine(P, ['--fake-net', '198.18.0.0/15']);
    await hello(P, 'localhost', port, 'named.example');
    for (let i = 0; i < 14; i++) await hello(P, '127.0.0.1', port, `app${i}.example`);
    await H.sleep(20500);
    for (let i = 0; i < 3; i++) await hello(P, '127.0.0.1', port, `late${i}.example`);
    await H.sleep(200);
    t.ok(said(eng).length === 0, 'with a connection by name (the tunnel\'s own lookup used): never');
    eng.stop();
  }

  // A computer (no stand-in addresses): never.
  {
    const P = await H.freePort();
    const eng = await H.startEngine(P, []);
    for (let i = 0; i < 14; i++) await hello(P, '127.0.0.1', port, `app${i}.example`);
    await H.sleep(20500);
    for (let i = 0; i < 3; i++) await hello(P, '127.0.0.1', port, `late${i}.example`);
    await H.sleep(200);
    t.ok(said(eng).length === 0, 'without --fake-net (a computer): never');
    eng.stop();
  }

  site.close();
  console.log(`engine-dns-around: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
