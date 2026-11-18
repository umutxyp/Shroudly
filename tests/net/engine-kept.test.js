'use strict';

/* A technique that keeps working is not raced again after every restart
 * (core/src/engine.c: hs_keep, HS_VERIFY_MS, the "kept" line).
 *
 * A technique learned more than half an hour ago is raced against the
 * untouched request before it is relied on, the untouched request having a
 * moment to itself (up to a second). Until 2.6.82 the age counted from the
 * learning alone and a race that confirmed the technique told the app
 * nothing, so the age the app gives back at each start (LEARN) only grew:
 * every start had every site the user opens pay that moment on its first
 * connection, for a month. Now:
 *   - a technique confirmed by the race is told to the app ("kept"), and so
 *     is one that opened its name again (at most every ten minutes a name),
 *     so the app gives it back as fresh: no race after the next start;
 *   - a site whose block was lifted is still let go: the race comes for a
 *     technique not used for half an hour, and the untouched request wins. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-kept');

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  // Resets every handshake for *.blocked.example whose first TLS record holds
  // the whole name (untouched, or cut at the TCP level only); lets the rest by.
  const seen = [];
  const censor = net.createServer((c) => {
    let buf = Buffer.alloc(0), u = null;
    c.on('error', () => {});
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      buf = Buffer.concat([buf, d]);
      if (buf.length < 5 || buf.length < 5 + buf.readUInt16BE(3)) return;
      const first = buf.subarray(0, 5 + buf.readUInt16BE(3));
      const m = /[a-z0-9-]+\.blocked\.example|lifted\.example/.exec(buf.toString('latin1'));
      const name = m ? m[0] : '';
      const whole = name && first.includes(Buffer.from(name));
      const blocked = name.endsWith('.blocked.example') && whole;
      seen.push({ name, whole, blocked });
      if (blocked) { c.resetAndDestroy(); return; }
      u = net.connect(server.address().port, '127.0.0.1');
      u.on('error', () => c.destroy());
      u.write(buf); u.pipe(c);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));

  async function engine(learn) {
    const P = await freePort();
    const eng = await startEngine(P, ['--auto']);
    if (learn) { eng.proc.stdin.write(learn); await sleep(300); }
    eng.visit = async (name) => {
      const mark = eng.out.length; const from = seen.length;
      const t0 = Date.now();
      const raw = await socks(P, '127.0.0.1', censor.address().port);
      const ok = await new Promise((resolve) => {
        const s = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false });
        const done = (v) => { s.destroy(); resolve(v); };
        s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
        s.on('data', (d) => { if (d.includes('200 OK')) done(true); });
        s.on('error', () => done(false)); s.on('close', () => done(false));
        setTimeout(() => done(false), 15000);
      });
      const ms = Date.now() - t0;
      await sleep(200);
      const lines = eng.out.slice(mark).split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      return { ok, ms, tries: seen.slice(from), kept: lines.filter((l) => l.type === 'kept'), bypass: lines.filter((l) => l.type === 'bypass') };
    };
    return eng;
  }
  const shapes = (r) => r.tries.map((x) => (x.whole ? 'whole' : 'cut') + (x.blocked ? ' (reset)' : '')).join(', ');

  // Learned two hours ago: raced, confirmed, and the app told.
  let eng = await engine('LEARN www.blocked.example tlsrec-sni-mid 7200\n');
  let r = await eng.visit('www.blocked.example');
  t.ok(r.ok && r.tries.length === 2 && r.tries[0].whole && r.tries[0].blocked && !r.tries[1].whole,
    `a technique learned two hours ago is checked: the untouched request first, then it (${shapes(r)})`);
  t.ok(r.kept.length === 1 && r.kept[0].host === 'www.blocked.example' && r.kept[0].strategy === 'tlsrec-sni-mid' && !r.bypass.length,
    `confirmed: the app is told it still works ("kept"), not of a new bypass: ${JSON.stringify(r.kept)}`);
  r = await eng.visit('www.blocked.example');
  t.ok(r.ok && r.tries.length === 1 && !r.tries[0].whole && !r.kept.length,
    `then used straight away, and not told again within ten minutes (${shapes(r)})`);
  eng.stop();

  // What the app keeps from that ("kept" just now): the next engine uses it
  // at once, no race.
  eng = await engine('LEARN www.blocked.example tlsrec-sni-mid 0\n');
  r = await eng.visit('www.blocked.example');
  t.ok(r.ok && r.tries.length === 1 && !r.tries[0].whole,
    `after a restart, given back as fresh, it opens the site on the first try without the race (${shapes(r)}, ${r.ms} ms)`);
  eng.stop();

  // In use 20 minutes ago (fresh, but the app last heard 20 minutes ago):
  // used at once and the app told; 2 minutes ago: used at once, nothing told.
  eng = await engine('LEARN a.blocked.example tlsrec-sni-mid 1200\nLEARN b.blocked.example tlsrec-sni-mid 120\n');
  r = await eng.visit('a.blocked.example');
  t.ok(r.ok && r.tries.length === 1 && r.kept.length === 1 && r.kept[0].host === 'a.blocked.example',
    `a technique that opens its name again is told to the app, at most every ten minutes (${shapes(r)}, ${JSON.stringify(r.kept)})`);
  r = await eng.visit('b.blocked.example');
  t.ok(r.ok && r.tries.length === 1 && !r.kept.length, `one told two minutes ago is not told again (${shapes(r)})`);
  // A name that only inherits its site's technique: the site's entry is the
  // one kept, and told under the site's name.
  r = await eng.visit('c.blocked.example');
  t.ok(r.ok && r.tries.length === 1 && !r.tries[0].whole && r.kept.length <= 1 && (!r.kept.length || r.kept[0].host === 'blocked.example'),
    `another name of the site opens with the site's technique; if anything is told it is the site's (${shapes(r)}, ${JSON.stringify(r.kept)})`);
  eng.stop();

  // A block that was lifted is still found: unused for two hours, the
  // technique is raced, the untouched request answers, and it is let go.
  eng = await engine('LEARN lifted.example tlsrec-sni-mid 7200\n');
  r = await eng.visit('lifted.example');
  t.ok(r.ok && r.tries[0].whole && !r.tries[0].blocked && !r.kept.length,
    `a lifted block: the untouched request answers the race, nothing kept (${shapes(r)})`);
  r = await eng.visit('lifted.example');
  t.ok(r.ok && r.tries.length === 1 && r.tries[0].whole, `and the technique is let go: the next connection goes untouched (${shapes(r)})`);
  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop();

  server.close(); censor.close();
  console.log(`engine-kept: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
