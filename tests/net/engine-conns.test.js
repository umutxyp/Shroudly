'use strict';

/* The Connections list (core/src/conns.c, issue #74). Covered:
 *   - CONNS lists what went through by the name it was for (the TLS server
 *     name of a connection asked for by address), with the bytes each way,
 *     how many are open and how many there were
 *   - BLOCK <name> ends the open connections to it at once and refuses new
 *     ones to it and to every name under it (a TLS alert, no connection
 *     made), counted in the list; other names are untouched
 *   - UNBLOCK lifts it, BLOCK-CLEAR lifts all; a malformed name is ignored */

const tls = require('tls');
const H = require('./helpers');

const t = H.suite('engine-conns');
const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));

function lines(eng, from) {
  return eng.out.slice(from).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function conns(eng) {
  const from = eng.out.length;
  eng.proc.stdin.write('CONNS\n');
  for (let i = 0; i < 30; i++) {
    await H.sleep(50);
    const l = lines(eng, from);
    if (l.some((x) => x.type === 'conns_end')) return l.filter((x) => x.type === 'conn');
  }
  return null;
}

/* A TLS connection to the local site through the engine, by address, for `name`. */
async function open(P, port, name) {
  const raw = await H.socks(P, '127.0.0.1', port);
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false });
    let got = '';
    s.on('secureConnect', () => s.write('ping'));
    s.on('data', (d) => { got += d; if (got.includes('pong')) resolve({ s, ok: true }); });
    s.on('error', () => resolve({ s, ok: false }));
    s.on('close', () => resolve({ s, ok: false }));
    setTimeout(() => resolve({ s, ok: false }), 8000);
  });
}

(async () => {
  // A site that answers "pong" and keeps the connection open.
  const site = tls.createServer(H.testServerOptions(), (s) => {
    s.on('error', () => {});
    s.on('data', () => s.write(Buffer.alloc(4096, 0x41).toString() + 'pong'));
  }).listen(0, '127.0.0.1');
  await listening(site);
  const port = site.address().port;
  const P = await H.freePort();
  const eng = await H.startEngine(P, []);

  const a = await open(P, port, 'www.blocked.example');
  const b = await open(P, port, 'other.example');
  t.ok(a.ok && b.ok, 'two sites open through the engine');
  let list = await conns(eng);
  const rowA = list && list.find((r) => r.host === 'www.blocked.example');
  t.ok(rowA && rowA.active === 1 && rowA.conns === 1 && rowA.down >= 4096 && rowA.up >= 4 && rowA.route === 'direct' && rowA.blocked === 0,
    `listed by the name it was for, with its bytes (${JSON.stringify(rowA)})`);
  t.ok(!list.some((r) => r.host === '127.0.0.1'), 'not by the address it was asked for');

  // Blocking the site above it ends the open connection at once.
  const closed = new Promise((r) => { a.s.once('close', () => r(true)); setTimeout(() => r(false), 3000); });
  const from = eng.out.length;
  eng.proc.stdin.write('BLOCK blocked.example\n');
  t.ok(await closed, 'BLOCK ends the open connection to a name under it at once');
  await H.sleep(100);
  t.ok(lines(eng, from).some((x) => x.type === 'block' && x.ok === 1 && x.ended === 1), 'and says how many it ended');
  t.ok(!b.s.destroyed, 'another site\'s connection stays');

  // New connections: refused, subdomains too; others work.
  const c = await open(P, port, 'blocked.example');
  const d = await open(P, port, 'api.blocked.example');
  const e = await open(P, port, 'other.example');
  t.ok(!c.ok && !d.ok && e.ok, 'refused for the name and every name under it; other names work');
  list = await conns(eng);
  const rowC = list.find((r) => r.host === 'blocked.example');
  t.ok(rowC && rowC.blocked === 1 && rowC.refused >= 1, `refusals counted, and the name shown as blocked (${JSON.stringify(rowC)})`);
  t.ok(list.find((r) => r.host === 'www.blocked.example').blocked === 1, 'a name under a blocked one shows as blocked');

  // UNBLOCK lifts it.
  eng.proc.stdin.write('UNBLOCK blocked.example\n');
  await H.sleep(100);
  const f = await open(P, port, 'blocked.example');
  t.ok(f.ok, 'UNBLOCK: the site opens again');

  // BLOCK-CLEAR, and a malformed name ignored.
  eng.proc.stdin.write('BLOCK x.example\nBLOCK-CLEAR\n');
  await H.sleep(100);
  const g = await open(P, port, 'x.example');
  t.ok(g.ok, 'BLOCK-CLEAR lifts every block');
  const from2 = eng.out.length;
  eng.proc.stdin.write('BLOCK bad name!\n');
  await H.sleep(150);
  t.ok(!lines(eng, from2).some((x) => x.type === 'block'), 'a malformed name is ignored');

  for (const x of [b, e, f, g]) x.s.destroy();
  await H.sleep(300);
  list = await conns(eng);
  t.ok(list.every((r) => r.active === 0), 'nothing shown open once every connection has ended');

  eng.stop(); site.close();
  console.log(`engine-conns: ${t.count} passed`);
  process.exit(0);
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
