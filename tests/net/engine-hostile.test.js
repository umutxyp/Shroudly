'use strict';

/* Hostile servers behind a real handshake: random bytes, impossible record
 * lengths, thousands of empty records, one byte at a time, a broken header,
 * an immediate reset — four at a time. The engine must stay up; under a
 * sanitizer build (SHROUDLY_ENGINE=…, see CI) it must also stay clean. */

const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const { startEngine, sleep, freePort, socks, requestWatcher, testServerOptions, suite } = require('./helpers');

const t = suite('engine-hostile');
const EVIL = {
  garbage: (c) => { for (let i = 0; i < 200; i++) c.write(crypto.randomBytes(1 + (i * 37) % 3000)); },
  hugeRecord: (c) => { c.write(Buffer.from([0x17, 3, 3, 0xff, 0xff])); c.write(crypto.randomBytes(100)); },
  zeroRecords: (c) => { const z = Buffer.alloc(5 * 2000); for (let i = 0; i < 2000; i++) z.set([0x17, 3, 3, 0, 0], i * 5); c.write(z); },
  oneByte: (c) => {
    const r = Buffer.concat([Buffer.from([0x17, 3, 3, 0x10, 0]), crypto.randomBytes(4096)]);
    let i = 0; const iv = setInterval(() => { if (i >= 600 || c.destroyed) { clearInterval(iv); return; } c.write(r.subarray(i, i + 1)); i++; }, 2);
  },
  badHeader: (c) => { c.write(Buffer.from([0x99, 1, 2, 3, 4, 5])); c.write(crypto.randomBytes(5000)); },
  resetNow: (c) => c.resetAndDestroy(),
};

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  let mode = 'garbage';
  let triggered = 0;
  const evil = net.createServer((c) => {
    // The real server does the handshake; once the request has gone out,
    // the hostile behaviour takes over the reply.
    const m = mode; const u = net.connect(server.address().port, '127.0.0.1');
    const sawRequest = requestWatcher(); let done = false;
    c.on('data', (d) => {
      if (done) return;
      if (sawRequest(d)) { done = true; triggered++; u.destroy(); setTimeout(() => EVIL[m](c), 50); return; }
      u.write(d);
    });
    u.on('data', (d) => { if (!done) c.write(d); });
    c.on('error', () => {}); u.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => evil.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--strategy', 'split(sni)', '--auto']);
  let n = 0;
  for (let round = 0; round < 3; round++) {
    for (const m of Object.keys(EVIL)) {
      mode = m;
      await Promise.all([0, 1, 2, 3].map(async (k) => {
        n++;
        const raw = await socks(P, '127.0.0.1', evil.address().port);
        const s = tls.connect({ socket: raw, servername: `${m}${k}.test.local`, rejectUnauthorized: false });
        await new Promise((resolve) => {
          s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\n\r\n'));
          s.on('error', resolve); s.on('close', resolve); setTimeout(resolve, 2500);
        });
        s.destroy();
      }));
    }
  }
  await sleep(1500);
  const st = await eng.stats();
  t.ok(triggered === n, `every connection got a hostile reply (${triggered} of ${n})`);
  t.ok(eng.exited === null && st, `engine still up after ${n} hostile connections`);
  t.ok(!/AddressSanitizer|runtime error:|UndefinedBehaviorSanitizer/.test(eng.err), 'no memory or undefined-behaviour errors');
  eng.stop(); server.close(); evil.close();
  console.log(`engine-hostile: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
