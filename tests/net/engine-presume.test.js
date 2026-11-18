'use strict';

/* What opens sites on this network, tried early for the next new name
 * (core/src/engine.c: net_best, st.presumed). Once one technique has opened
 * two different blocked sites, a name with nothing learned for it or its
 * site races that technique against the untouched request: the untouched
 * request still goes first and has a moment to itself (race_head), so a site
 * that is not blocked is relayed untouched as before; a blocked one is
 * answered through the technique a moment later, instead of after a second
 * of silence and the list a batch at a time (a report from Türk Telekom:
 * blocked sites opened visibly slower than with ByeByeDPI, which applies one
 * fixed method from the first packet).
 *
 *   - a network that resets: the third site needs two tries, not the seven
 *     it takes to reach the technique down the list;
 *   - a network that drops without a word (--local-unacked: this computer
 *     acknowledges for the far end, see engine-search.test.js): the third
 *     site opens in well under the second a fresh ladder waits first;
 *   - a site that is not blocked still goes untouched; one whose server
 *     refuses the technique opens untouched; one that is only slow to answer
 *     the untouched request is opened by the technique but nothing is
 *     learned for it (a presumption, not evidence);
 *   - another network (NET-CHANGED) forgets it: the next new site starts
 *     from the top of the list again. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-presume');

/* The server name and the shape of a first flight, once the whole ClientHello
 * is in: 'one' (one record holding the whole name), 'sni+1', 'end' (records
 * split one byte before its end), 'mid'; null while it is arriving (as in
 * engine-site.test.js). */
function look(buf) {
  let p = 0, body = Buffer.alloc(0), first = -1;
  while (p + 5 <= buf.length) {
    if (buf[p] !== 0x16) return { name: '', shape: 'other' };
    const len = buf.readUInt16BE(p + 3);
    if (p + 5 + len > buf.length) return null;
    body = Buffer.concat([body, buf.subarray(p + 5, p + 5 + len)]);
    if (first < 0) first = len;
    p += 5 + len;
    if (body.length >= 4 && body.length >= 4 + body.readUIntBE(1, 3)) {
      const name = sni(body);
      const i = name ? body.indexOf(name) : -1;
      if (i < 0) return { name: '', shape: 'other' };
      const inFirst = first - i;
      return { name, shape: inFirst >= name.length ? 'one' : inFirst <= 1 ? 'sni+1' : inFirst === name.length - 1 ? 'end' : 'mid' };
    }
  }
  return null;
}

function sni(h) {
  let p = 4 + 2 + 32;
  p += 1 + h[p];
  p += 2 + h.readUInt16BE(p);
  p += 1 + h[p];
  const end = p + 2 + h.readUInt16BE(p); p += 2;
  while (p + 4 <= end) {
    const type = h.readUInt16BE(p), len = h.readUInt16BE(p + 2); p += 4;
    if (type === 0) return h.subarray(p + 5, p + 5 + h.readUInt16BE(p + 3)).toString();
    p += len;
  }
  return '';
}

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  /* The rules, by name:
   *   *rst-*.example  reset unless split one byte before the name's end
   *   *drop-*.example swallowed unless split inside the name (mid)
   * (each rst-X.example and drop-X.example a site of its own)
   *   picky.example   not blocked, slow (700 ms), its server resets anything
   *                   but one whole record
   *   slowplain.example  not blocked; answers the untouched request after
   *                   1500 ms and anything else at once
   *   anything else   not blocked */
  const seen = [];
  const censor = net.createServer((c) => {
    let buf = Buffer.alloc(0), u = null, decided = false;
    const opened = Date.now();
    c.on('error', () => {});
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      if (decided) return;
      buf = Buffer.concat([buf, d]);
      const k = look(buf);
      if (!k) return;
      decided = true;
      let pass = true, delay = 0;
      if (/rst-\w+\.example$/.test(k.name)) pass = k.shape === 'end';
      else if (/drop-\w+\.example$/.test(k.name)) pass = k.shape === 'mid';
      else if (k.name === 'picky.example') { pass = k.shape === 'one'; delay = 700; }
      else if (k.name === 'slowplain.example') delay = k.shape === 'one' ? 1500 : 0;
      seen.push({ ...k, passed: pass });
      if (!pass) {
        if (/drop-\w+\.example$/.test(k.name)) return;   // without a word
        c.resetAndDestroy(); return;
      }
      u = net.connect(server.address().port, '127.0.0.1');
      u.on('error', () => c.destroy());
      u.once('data', (a) => {
        setTimeout(() => { if (!c.destroyed) { c.write(a); u.pipe(c); } }, Math.max(0, delay - (Date.now() - opened)));
      });
      u.write(buf);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));

  async function run(extra) {
    const P = await freePort();
    const eng = await startEngine(P, ['--auto', ...extra]);
    const events = (from, type) => eng.out.slice(from).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));
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
        setTimeout(() => done(false), 20000);
      });
      const ms = Date.now() - t0;
      await sleep(300);
      return { ok, ms, tries: seen.slice(from), bypass: events(mark, 'bypass')[0] };
    };
    return eng;
  }
  const shapes = (r) => r.tries.map((x) => `${x.shape}${x.passed ? '' : ' (refused)'}`).join(', ');

  // A network that resets.
  let eng = await run([]);
  let r = await eng.visit('www.rst-one.example');
  const fresh = r.tries.length;
  t.ok(r.ok && r.bypass && fresh > 3, `first blocked site: the technique is found down the list (${fresh} tries: ${shapes(r)})`);
  r = await eng.visit('www.rst-two.example');
  t.ok(r.ok && r.bypass && r.tries.length === fresh, `second blocked site, another site: the same way, nothing presumed from one site (${r.tries.length} tries)`);
  r = await eng.visit('www.rst-three.example');
  t.ok(r.ok && r.tries.length === 2 && r.tries[0].shape === 'one' && r.tries[1].shape === 'end' && r.tries[1].passed,
    `third blocked site: untouched first, then the technique that opened the other two (${shapes(r)}, ${r.ms} ms)`);
  t.ok(r.bypass && r.bypass.attempts === 2, `and, the untouched request refused, learned for it: ${JSON.stringify(r.bypass)}`);
  r = await eng.visit('www.rst-three.example');
  t.ok(r.ok && r.tries.length === 1 && r.tries[0].shape === 'end' && !r.bypass, `its next connection opens with it at once (${shapes(r)})`);

  r = await eng.visit('fine.example');
  t.ok(r.ok && r.tries.length === 1 && r.tries[0].shape === 'one' && r.ms < 1000,
    `a site that is not blocked is still relayed untouched, at once (${shapes(r)}, ${r.ms} ms)`);
  r = await eng.visit('picky.example');
  t.ok(r.ok && r.tries[0].shape === 'one' && r.tries[0].passed && !r.bypass && r.ms < 2500,
    `a slow site whose server refuses the technique opens untouched, nothing learned (${shapes(r)}, ${r.ms} ms)`);
  r = await eng.visit('slowplain.example');
  t.ok(r.ok && r.tries.length === 2 && r.tries[1].shape === 'end' && !r.bypass,
    `a site slow to answer the untouched request: opened by the technique, but not reported or learned as blocked (${shapes(r)}, ${r.ms} ms)`);
  r = await eng.visit('slowplain.example');
  t.ok(r.ok && r.tries[0].shape === 'one', `and its next connection still starts untouched (${shapes(r)})`);

  // Another network: nothing presumed any more.
  eng.proc.stdin.write('NET-CHANGED\n');
  await sleep(200);
  r = await eng.visit('www.rst-four.example');
  t.ok(r.ok && r.tries.length === fresh, `after NET-CHANGED a new blocked site walks the list again (${r.tries.length} tries)`);
  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop();

  // A network that drops without a word.
  eng = await run(['--local-unacked']);
  r = await eng.visit('www.drop-one.example');
  const slow = r.ms;
  t.ok(r.ok && r.bypass && r.bypass.note === 'silent', `silent drop, first site: found after the silence (${r.ms} ms, ${r.tries.length} tries)`);
  r = await eng.visit('www.drop-two.example');
  t.ok(r.ok && r.bypass, `second site: the same (${r.ms} ms)`);
  r = await eng.visit('www.drop-three.example');
  t.ok(r.ok && r.tries.length === 2 && r.tries[1].shape === 'mid' && r.tries[1].passed && r.ms < 900 && r.ms < slow,
    `third site opens through the presumed technique on its first try after the untouched request: ${r.ms} ms, where the first took ${slow} ms (${shapes(r)})`);
  t.ok(r.bypass && r.bypass.attempts === 2 && r.bypass.note === 'silent', `and is learned, the untouched request having never arrived: ${JSON.stringify(r.bypass)}`);
  // Within the client's own time, give or take two ticks of the engine's
  // clock: Windows counts it in steps of about 16 ms (GetTickCount64), so it
  // said 281 ms for a visit the client timed at 271 ms (Windows on ARM in CI).
  t.ok(r.bypass && Number.isInteger(r.bypass.ms) && r.bypass.ms <= r.ms + 32, `the bypass line says how long the site took to open (${r.bypass && r.bypass.ms} ms; the client: ${r.ms} ms)`);
  r = await eng.visit('fine2.example');
  t.ok(r.ok && r.tries.length === 1 && r.tries[0].shape === 'one', `a site that is not blocked is relayed untouched (${shapes(r)})`);
  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop();

  server.close(); censor.close();
  console.log(`engine-presume: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
