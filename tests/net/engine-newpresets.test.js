'use strict';

/* The techniques added at the end of the list in 2.6.83 (core/src/strategy.c)
 * reach the server whole and cut where they say:
 *   - ByeByeDPI's default, oob(1),tlsrec(sni_end-5) (and split(1) with the
 *     same record cut): the first record ends five bytes before the name's
 *     end;
 *   - tlsrec(midsld): the record cut in the middle of the name's own label
 *     ("googl|evideo"), for a filter that looks for the domain's bytes in
 *     any one record, which a cut in the middle of a long CDN name
 *     (sni_mid, in the subdomain) or near its end leaves whole.
 * The fake censor resets everything else, so each is what the ladder ends on. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-newpresets');
const BBD = 'www.bbd-default.example';
const GV = 'rr3---sn-4g5edndr.googlevideo.com';

/* The records of a first flight once the whole ClientHello is in (null while
 * it arrives), and the server name. */
function records(buf) {
  let p = 0; const recs = []; let body = Buffer.alloc(0);
  while (p + 5 <= buf.length) {
    if (buf[p] !== 0x16) return { recs: [], name: '' };
    const len = buf.readUInt16BE(p + 3);
    if (p + 5 + len > buf.length) return null;
    recs.push(buf.subarray(p + 5, p + 5 + len));
    body = Buffer.concat([body, buf.subarray(p + 5, p + 5 + len)]);
    p += 5 + len;
    if (body.length >= 4 && body.length >= 4 + body.readUIntBE(1, 3)) {
      let q = 4 + 2 + 32; q += 1 + body[q]; q += 2 + body.readUInt16BE(q); q += 1 + body[q];
      const end = q + 2 + body.readUInt16BE(q); q += 2;
      let name = '';
      while (q + 4 <= end) {
        const type = body.readUInt16BE(q), l = body.readUInt16BE(q + 2); q += 4;
        if (type === 0) { name = body.subarray(q + 5, q + 5 + body.readUInt16BE(q + 3)).toString(); break; }
        q += l;
      }
      return { recs, name, nameEnd: name ? body.indexOf(name) + name.length : -1 };
    }
  }
  return null;
}

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  const seen = [];
  const censor = net.createServer((c) => {
    let buf = Buffer.alloc(0), u = null, decided = false;
    c.on('error', () => {});
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      if (decided) return;
      buf = Buffer.concat([buf, d]);
      const k = records(buf);
      if (!k) return;
      decided = true;
      let pass = false;
      if (k.name === BBD) pass = k.recs.length === 2 && k.recs[0].length === k.nameEnd - 5;
      else if (k.name === GV) pass = k.recs.length >= 2 && !k.recs.some((r) => r.includes(Buffer.from('googlevid')));
      seen.push({ name: k.name, recs: k.recs.length, pass });
      if (!pass) { c.resetAndDestroy(); return; }
      u = net.connect(server.address().port, '127.0.0.1');
      u.on('error', () => c.destroy());
      u.write(buf); u.pipe(c);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--auto']);
  const ready = JSON.parse(eng.out.split('\n').find((l) => l.includes('"ready"')));
  async function visit(name) {
    const mark = eng.out.length;
    const raw = await socks(P, '127.0.0.1', censor.address().port);
    const ok = await new Promise((resolve) => {
      const s = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false });
      const done = (v) => { s.destroy(); resolve(v); };
      s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { if (d.includes('200 OK')) done(true); });
      s.on('error', () => done(false)); s.on('close', () => done(false));
      setTimeout(() => done(false), 20000);
    });
    await sleep(200);
    const by = eng.out.slice(mark).split('\n').filter((l) => l.includes('"type":"bypass"')).map((l) => JSON.parse(l))[0];
    return { ok, by };
  }

  t.ok(ready.techniques >= 22, `the engine has the new techniques (${ready.techniques} usable here)`);
  let r = await visit(BBD);
  t.ok(r.ok && r.by && /^(oob|split)-tlsrec-end$/.test(r.by.strategy),
    `a filter only ByeByeDPI's default gets past: opened with ${r.by && r.by.strategy}, the handshake whole at the server`);
  // (Which of the two: the censor here is a program on this computer, and
  // macOS hands it the urgent byte inside the stream, so there the split(1)
  // twin is the one that gets through; a server's system leaves it out.)
  r = await visit(GV);
  t.ok(r.ok && r.by && r.by.strategy === 'tlsrec-midsld',
    `a filter that looks for the domain in any one record: opened with ${r.by && r.by.strategy}, cut inside "googlevideo"`);
  r = await visit(GV);
  t.ok(r.ok && !r.by && seen[seen.length - 1].pass && seen[seen.length - 1].name === GV, 'and its next connection opens with it at once');

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); censor.close();
  console.log(`engine-newpresets: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
