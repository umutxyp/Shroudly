'use strict';

/* The engine notices a network that lets a connection start and then cuts it
 * (stall mid-record, reset, no reply), reports it, and opens the next
 * connection to that site with a different technique. A filter that resets a
 * handshake arriving in pieces (as Türk Telekom's does) makes a technique's
 * later writes fail: that is a refusal like any other, and the engine goes on
 * to the next technique. Fake censors sit in front of a real local TLS server;
 * real sites check for false alarms. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, getViaEngine, requestWatcher, testServerOptions, suite } = require('./helpers');

const t = suite('engine-cut');
const BIG = Buffer.alloc(200 * 1024, 'x');

/* The shape of a first flight once the whole ClientHello is in: 'one' (one
 * record holding the whole name), 'sni+1' (records split one byte into the
 * name), 'mid' (split further in), 'other'; null while it is still arriving.
 * Only the record split in the middle of the name (tlsrec-sni-mid) is 'mid'. */
function shape(buf, name) {
  let p = 0, body = Buffer.alloc(0), first = -1;
  while (p + 5 <= buf.length) {
    if (buf[p] !== 0x16) return 'other';
    const len = buf.readUInt16BE(p + 3);
    if (p + 5 + len > buf.length) return null;
    body = Buffer.concat([body, buf.subarray(p + 5, p + 5 + len)]);
    if (first < 0) first = len;
    p += 5 + len;
    if (body.length >= 4 && body.length >= 4 + body.readUIntBE(1, 3)) {
      const i = body.indexOf(name);
      if (i < 0) return 'other';
      const inFirst = first - i;
      return inFirst >= name.length ? 'one' : inFirst <= 1 ? 'sni+1' : 'mid';
    }
  }
  return null;
}

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
      // Forward the whole reply, then reset the idle connection a moment
      // later, the way Microsoft, Instagram and Discord's gateway drop an
      // idle keep-alive. This is not a censor cut and must not be reported.
      else if (m === 'lateReset') { c.write(d); toClient += d.length; if (toClient >= BIG.length) setTimeout(() => { try { c.resetAndDestroy(); u.destroy(); } catch {} }, 700); }
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
      // lateReset: do not resolve on the full reply; wait for the idle reset
      // that follows, so the relay sees the reset while watching this host.
      s.on('data', (d) => { got += d.length; if (got > BIG.length && m !== 'lateReset') resolve(); });
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
  // A reset on an idle keep-alive, after the whole reply was delivered, is a
  // normal teardown — not a cut. Reporting it turned Microsoft, Instagram and
  // Discord's gateway into "connects then cut, only a VPN" false alarms.
  r = await visit('lateReset', 'keepalive.test.local');
  t.ok(r.got > BIG.length && r.cut.length === 0, 'an idle keep-alive reset after a full exchange is not reported as a cut');

  // A filter that resets a handshake the moment its first piece arrives on its
  // own, before the rest: a technique that sends the handshake in several
  // writes then fails partway through sending. It also resets an untouched
  // handshake and one split one byte into the name; only the record split in
  // the middle of the name gets past. The engine has to treat the failed
  // sends as refusals and keep going, not drop the connection.
  const PIECES = 'pieces.rst-site.local';
  let piecesReset = 0;
  const strict = net.createServer((c) => {
    let buf = Buffer.alloc(0), u = null, chunks = 0;
    c.on('error', () => {});
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      buf = Buffer.concat([buf, d]); chunks++;
      if (chunks === 1 && (buf.length < 5 || buf.length < 5 + buf.readUInt16BE(3))) {
        piecesReset++; c.resetAndDestroy(); return;           // in pieces: reset before the rest
      }
      const k = shape(buf, PIECES);
      if (!k) return;
      if (k !== 'mid') { c.resetAndDestroy(); return; }
      u = net.connect(server.address().port, '127.0.0.1');
      u.on('error', () => c.destroy());
      u.write(buf); u.pipe(c);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => strict.once('listening', resolve));
  const strictVisit = async () => {
    const before = eng.out.length;
    const s0 = await eng.stats();
    const t0 = Date.now();
    const raw = await socks(P, '127.0.0.1', strict.address().port);
    const s = tls.connect({ socket: raw, servername: PIECES, rejectUnauthorized: false });
    let got = 0;
    await new Promise((resolve) => {
      s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { got += d.length; if (got > BIG.length) resolve(); });
      s.on('error', resolve); s.on('close', resolve);
      setTimeout(resolve, 18000);
    });
    const ms = Date.now() - t0;
    s.destroy();
    await sleep(300);
    const s1 = await eng.stats();
    const evs = (type) => eng.out.slice(before).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));
    return { got, ms, desync: s1.desync - s0.desync, bypass: evs('bypass'), failed: evs('send_failed'), blocked: evs('blocked') };
  };
  r = await strictVisit();
  t.ok(r.got > BIG.length, `handshakes reset in pieces (${piecesReset} of them) do not end the ladder: the site loads (${r.ms} ms)`);
  t.ok(!r.failed.length && !r.blocked.length, 'no "send_failed", no "blocked"');
  t.ok(r.bypass.length === 1 && r.bypass[0].strategy === 'tlsrec-sni-mid' && !r.bypass[0].note,
    `learned and reported as a bypass of a refusing filter: ${JSON.stringify(r.bypass[0])}`);
  // Whether a reset lands between two writes of one technique depends on how
  // far apart the engine sends them: off Linux, disorder waits 10 ms between
  // them, which makes it certain; on Linux the pieces may arrive together and
  // be reset as a whole instead. Either way the ladder must go on, which is
  // what is checked above.
  if (process.platform !== 'linux') t.ok(piecesReset >= 1, 'the filter did reset handshakes before the rest of them arrived');
  r = await strictVisit();
  t.ok(r.got > BIG.length && r.desync === 1 && r.ms < 2000 && !r.bypass.length,
    `the next connection opens on its first try (${r.ms} ms)`);
  strict.close();

  // Real sites: no false alarms.
  const before = eng.out.length;
  const sites = ['discord.com', 'www.wikipedia.org', 'github.com', 'www.bbc.com', 'www.google.com', 'www.cloudflare.com'];
  const res = await Promise.all(sites.map((h) => getViaEngine(P, h)));
  // A CI machine's own connection drops one now and then: one more try for a
  // site that did not answer, so only the engine can fail this.
  const good = (x) => x.status >= 200 && x.status < 400;
  for (let i = 0; i < sites.length; i++) if (!good(res[i])) res[i] = await getViaEngine(P, sites[i]);
  await sleep(1500);
  t.ok(res.every((x) => x.status >= 200 && x.status < 400), `real sites load through the engine: ${res.map((x) => x.status).join(' ')}`);
  t.ok(!eng.out.slice(before).includes('"cut"'), 'no cut reported for any real site');

  eng.stop(); server.close(); censor.close();
  console.log(`engine-cut: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
