'use strict';

/* One site, many names. A filter almost always treats www., api., cdn. and
 * gateway-us-east1-b. of one site alike, so what the engine learns for one
 * name it keeps for the site, and another name of the site with nothing of
 * its own starts there: its first attempt already gets through, instead of a
 * refusal first (or, on a network that drops silently, five seconds). A
 * name's own entry wins over the site's, and names under shared hosting
 * (x.github.io, y.github.io: different owners) share nothing.
 *
 * The fake censor resets every handshake for a blocked name whose first TLS
 * record holds the whole name — untouched, or split at the TCP level only —
 * and lets one split into records inside the name through. For one stricter
 * name it lets through only a split in the middle of the name. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-site');
const BLOCKED = ['.blocked.example', '.github.io'];
const STRICT = 'own.blocked.example';

/* The server name and the shape of a first flight, once the whole ClientHello
 * is in: 'one' (one record holding the whole name), 'sni+1' (records split one
 * byte into the name), 'mid' (split further in); null while it is arriving. */
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
      return { name, shape: inFirst >= name.length ? 'one' : inFirst <= 1 ? 'sni+1' : 'mid' };
    }
  }
  return null;
}

/* The server name of a ClientHello handshake message. */
function sni(h) {
  let p = 4 + 2 + 32;
  p += 1 + h[p];                       // session id
  p += 2 + h.readUInt16BE(p);          // cipher suites
  p += 1 + h[p];                       // compression
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

  const seen = [];   // every attempt: { name, shape, passed }
  const censor = net.createServer((c) => {
    let buf = Buffer.alloc(0), u = null, decided = false;
    c.on('error', () => {});
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      if (decided) return;
      buf = Buffer.concat([buf, d]);
      const k = look(buf);
      if (!k) return;
      decided = true;
      const blocked = BLOCKED.some((s) => k.name.endsWith(s));
      const passed = !blocked || (k.name === STRICT ? k.shape === 'mid' : k.shape !== 'one');
      seen.push({ ...k, passed });
      if (!passed) { c.resetAndDestroy(); return; }
      u = net.connect(server.address().port, '127.0.0.1');
      u.on('error', () => c.destroy());
      u.write(buf); u.pipe(c);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--auto']);
  const events = (from, type) => eng.out.slice(from).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));

  async function visit(name) {
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
    await sleep(200);
    return { ok, ms, tries: seen.slice(from), bypass: events(mark, 'bypass')[0] };
  }
  const shapes = (r) => r.tries.map((x) => `${x.shape}${x.passed ? '' : ' (reset)'}`).join(', ');

  let r = await visit('a.blocked.example');
  t.ok(r.ok && r.bypass && r.bypass.attempts === 2, `a.blocked.example: refused untouched, opened with ${r.bypass && r.bypass.strategy} (${shapes(r)})`);
  const learnedA = r.bypass.strategy;

  r = await visit('b.blocked.example');
  t.ok(r.ok && r.tries.length === 1 && r.tries[0].passed && r.ms < 2000,
    `b.blocked.example opens on its FIRST attempt with what the site learned: no refusal (${shapes(r)}, ${r.ms} ms)`);
  t.ok(!r.bypass, 'and it is not reported as a new bypass');

  // A stricter name of the same site: what the site learned does not work for
  // it, so its ladder goes on and it learns its own.
  r = await visit(STRICT);
  t.ok(r.ok && r.tries[0].shape === 'sni+1' && !r.tries[0].passed,
    `${STRICT} starts with the site's technique, which this name refuses (${shapes(r)})`);
  t.ok(r.bypass && r.bypass.strategy !== learnedA && r.tries[r.tries.length - 1].shape === 'mid',
    `and learns one of its own: ${r.bypass && r.bypass.strategy}`);

  // That is now the site's latest, but a name with its own entry keeps it.
  r = await visit('a.blocked.example');
  t.ok(r.ok && r.tries.length === 1 && r.tries[0].shape === 'sni+1',
    `a.blocked.example keeps its own (${learnedA}) over the site's latest (${shapes(r)})`);
  r = await visit('b.blocked.example');
  t.ok(r.ok && r.tries.length === 1 && r.tries[0].shape === 'mid',
    `b.blocked.example, with nothing of its own, follows the site (${shapes(r)})`);

  // Shared hosting: neighbours are strangers.
  r = await visit('x.github.io');
  t.ok(r.ok && r.bypass && r.bypass.attempts === 2, `x.github.io: refused untouched, opened with a technique (${shapes(r)})`);
  r = await visit('y.github.io');
  t.ok(r.ok && r.tries.length === 2 && r.tries[0].shape === 'one' && !r.tries[0].passed && r.bypass,
    `y.github.io inherits nothing from x.github.io: it starts untouched and learns for itself (${shapes(r)})`);

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); censor.close();
  console.log(`engine-site: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
