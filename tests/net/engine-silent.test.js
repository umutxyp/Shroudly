'use strict';

/* Networks that drop a censored handshake without a word instead of
 * resetting it (Turkcell Superonline's filter, among others). A fake censor
 * reads the first TLS record the way such a filter does and, when it names a
 * blocked site, swallows the connection: nothing is forwarded, nothing comes
 * back, nothing is closed. The engine has to keep going through its
 * techniques on such a site, remember the one that works, and say so — and
 * still not mistake a server that is merely slow for a censored one. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-silent');
const BLOCKED = ['silent.test.local'];

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  let slowMs = 0;
  const censor = net.createServer((c) => {
    let buf = Buffer.alloc(0); let u = null;
    const delay = slowMs; const opened = Date.now();
    c.on('error', () => {});
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      buf = Buffer.concat([buf, d]);
      if (buf.length < 5 || buf.length < 5 + buf.readUInt16BE(3)) return;   // the whole first record
      const first = buf.subarray(0, 5 + buf.readUInt16BE(3));
      if (BLOCKED.some((h) => first.includes(Buffer.from(h)))) { c.removeAllListeners('data'); return; } // swallowed
      u = net.connect(server.address().port, '127.0.0.1');
      u.on('error', () => c.destroy());
      // A slow server: its first answer arrives `delay` ms after the connection opened.
      u.once('data', (a) => {
        setTimeout(() => { if (!c.destroyed) { c.write(a); u.pipe(c); } }, Math.max(0, delay - (Date.now() - opened)));
      });
      u.write(buf);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));
  // Swallows everything, whatever it is: no technique gets past this one.
  const hole = net.createServer((c) => { c.on('error', () => {}); }).listen(0, '127.0.0.1');
  await new Promise((r) => hole.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--strategy', 'split(sni)', '--auto']);
  const events = (from, type) => eng.out.slice(from).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));
  async function visit(port, host, wait = 20000) {
    const mark = eng.out.length;
    const s0 = await eng.stats();
    const t0 = Date.now();
    const raw = await socks(P, '127.0.0.1', port);
    const ok = await new Promise((resolve) => {
      const s = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false });
      const done = (v) => { s.destroy(); resolve(v); };
      s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { if (d.includes('200 OK')) done(true); });
      s.on('error', () => done(false)); s.on('close', () => done(false));
      setTimeout(() => done(false), wait);
    });
    const ms = Date.now() - t0;
    await sleep(300);
    const s1 = await eng.stats();
    return { ok, ms, mark, desync: s1.desync - s0.desync };
  }

  let r = await visit(censor.address().port, 'silent.test.local');
  let ev = events(r.mark, 'bypass');
  t.ok(r.ok, `ClientHello silently dropped: a technique gets through, page loads (${r.ms} ms)`);
  t.ok(ev.length === 1 && ev[0].note === 'silent' && ev[0].attempts >= 2,
    `reported as a bypass of a silent drop: ${JSON.stringify(ev[0])}`);
  r = await visit(censor.address().port, 'silent.test.local');
  t.ok(r.ok && r.ms < 2000 && r.desync === 1, `remembered: the next connection uses it straight away (${r.ms} ms)`);
  t.ok(!events(r.mark, 'bypass').length, 'and is not reported again');

  r = await visit(censor.address().port, 'fine.test.local');
  t.ok(r.ok && r.desync === 0 && r.ms < 2000, 'a site that is not blocked is relayed untouched');

  // Slow, not censored: answers 6 s after the connection opens, longer than
  // the engine waits before trying a technique. The untouched connection is
  // kept open meanwhile, so its late answer is used, and nothing is learned.
  slowMs = 6000;
  r = await visit(censor.address().port, 'slow.test.local');
  slowMs = 0;
  t.ok(r.ok && r.ms < 9000, `slow server (6 s): still served, by the connection it was slow on (${r.ms} ms)`);
  t.ok(!events(r.mark, 'bypass').length && !events(r.mark, 'blocked').length, 'no bypass or block reported for it');
  r = await visit(censor.address().port, 'slow.test.local');
  t.ok(r.ok && r.desync === 0, 'and the next connection to it goes untouched: nothing was learned');

  // Everything dropped: the engine works through the ladder within its time
  // budget, then says the site is blocked and that the drop was silent.
  const mark = eng.out.length;
  const t0 = Date.now();
  const raw = await socks(P, '127.0.0.1', hole.address().port);
  const s = tls.connect({ socket: raw, servername: 'dead.test.local', rejectUnauthorized: false });
  s.on('error', () => {});
  while (!events(mark, 'blocked').length && Date.now() - t0 < 25000) await sleep(100);
  const took = Date.now() - t0;
  s.destroy();
  ev = events(mark, 'blocked');
  t.ok(ev.length === 1 && ev[0].note === 'silent', `everything dropped: "blocked" reported as silent: ${JSON.stringify(ev[0])}`);
  t.ok(ev[0].attempts >= 4, `kept going past the second silent attempt (${ev[0].attempts} tried)`);
  t.ok(took <= 17000, `within the 15 s budget, give or take the handshake (${took} ms)`);

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); censor.close(); hole.close();
  console.log(`engine-silent: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
