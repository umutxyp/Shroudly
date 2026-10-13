'use strict';

/* The engine notices a network that lets a connection start and then cuts it
 * (stall mid-record, reset, no reply), reports it, and opens the next
 * connection to that site with a different technique. A fake censor sits in
 * front of a real local TLS server; real sites check for false alarms. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, getViaEngine, requestWatcher, testServerOptions, suite } = require('./helpers');

const t = suite('engine-cut');
const BIG = Buffer.alloc(200 * 1024, 'x');

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => { s.write(`HTTP/1.1 200 OK\r\nContent-Length: ${BIG.length}\r\n\r\n`); s.write(BIG); });
    s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  let mode = 'normal';
  const censor = net.createServer((c) => {
    const m = mode;
    const u = net.connect(server.address().port, '127.0.0.1');
    // Everything up to the request passes; the censor acts on the reply.
    const sawRequest = requestWatcher();
    let handshakeDone = false, toClient = 0;
    c.on('data', (d) => { if (sawRequest(d)) handshakeDone = true; u.write(d); });
    u.on('data', (d) => {
      if (!handshakeDone) { c.write(d); return; }
      if (m === 'normal') c.write(d);
      // 6000 bytes of the reply, then nothing: mid-record, as a filter that drops the rest leaves it.
      else if (m === 'stall') { const room = 6000 - toClient; if (room > 0) { c.write(d.subarray(0, room)); toClient += Math.min(room, d.length); } }
      else if (m === 'reset') { c.resetAndDestroy(); u.destroy(); }
      // 'noreply': drop everything
    });
    c.on('error', () => {}); u.on('error', () => {}); c.on('close', () => u.destroy());
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--strategy', 'split(sni)', '--auto']);
  async function visit(m, host) {
    mode = m;
    const before = eng.out.length;
    const s0 = await eng.stats();
    const raw = await socks(P, '127.0.0.1', censor.address().port);
    const s = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false });
    let got = 0;
    await new Promise((resolve) => {
      s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { got += d.length; if (got > BIG.length) resolve(); });
      s.on('error', resolve); s.on('close', resolve);
      setTimeout(resolve, 18000);
    });
    s.destroy();
    await sleep(1200);
    const s1 = await eng.stats();
    const cut = eng.out.slice(before).split('\n').filter((l) => l.includes('"cut"')).map((l) => JSON.parse(l));
    return { got, cut, desync: s1.desync - s0.desync };
  }

  let r = await visit('normal', 'fine.test.local');
  t.ok(r.got > BIG.length && r.cut.length === 0, 'a normal connection is relayed in full, no cut reported');
  r = await visit('stall', 'site.test.local');
  t.ok(r.cut.length === 1 && r.cut[0].strategy === 'stall', 'server stops mid-record -> "stall" reported');
  r = await visit('normal', 'site.test.local');
  t.ok(r.desync === 1 && r.got > BIG.length, 'next connection to the same site uses a technique, and loads');
  r = await visit('normal', 'other.test.local');
  t.ok(r.desync === 0, 'other sites are left untouched');
  r = await visit('reset', 'reset.test.local');
  t.ok(r.cut.length === 1 && r.cut[0].strategy === 'reset', 'reset after the handshake -> "reset" reported');
  r = await visit('noreply', 'quiet.test.local');
  t.ok(r.cut.length === 1 && r.cut[0].strategy === 'noreply', 'request never answered -> "noreply" reported');

  // Real sites: no false alarms.
  const before = eng.out.length;
  const sites = ['discord.com', 'www.wikipedia.org', 'github.com', 'www.bbc.com', 'www.google.com', 'www.cloudflare.com'];
  const res = await Promise.all(sites.map((h) => getViaEngine(P, h)));
  await sleep(1500);
  t.ok(res.every((x) => x.status >= 200 && x.status < 400), `real sites load through the engine: ${res.map((x) => x.status).join(' ')}`);
  t.ok(!eng.out.slice(before).includes('"cut"'), 'no cut reported for any real site');

  eng.stop(); server.close(); censor.close();
  console.log(`engine-cut: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
