'use strict';

/* Encrypted DNS: answers on an open network, survives a network that blocks
 * every direct route (through the engine), says when it is blocked outright
 * and recovers by itself, remembers the route that worked — and never accepts
 * an answer from anyone but the real resolver. */

const dgram = require('dgram');
const http2 = require('http2');
const net = require('net');
const path = require('path');
const { ROOT, startEngine, freePort, fixture, suite } = require('./helpers');

const F = require(path.join(ROOT, 'electron', 'doh-forwarder.js'));
const t = suite('doh');

function ask(port, name) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4'); const q = F.buildQuery(name, 1); const t0 = Date.now();
    const to = setTimeout(() => { s.close(); resolve({ ok: false, ms: Date.now() - t0, msg: null }); }, 6000);
    s.on('message', (m) => { clearTimeout(to); s.close(); resolve({ ok: m.readUInt16BE(0) === q.readUInt16BE(0) && m.readUInt16BE(6) > 0, ms: Date.now() - t0, msg: m }); });
    s.send(q, port, '127.0.0.1');
  });
}

/* Which routes a lookup asks, and when, with every route's answer staged:
 * answers[id] = ms after it is asked to answer (anything else: never, until it
 * times out). The routes' own network is not touched. */
async function waves(answers, timeoutMs = 2500) {
  const f = new F(() => {});
  f.setSocksPort(1);                     // the routes through the engine count too
  const asked = [];
  const t0 = Date.now();
  f.query = (r) => {
    asked.push({ id: r.id, at: Date.now() - t0 });
    const ms = answers[r.id];
    return new Promise((res, rej) => setTimeout(() => (ms === undefined ? rej(new Error('timeout')) : res(Buffer.alloc(12))),
      ms === undefined ? timeoutMs : ms));
  };
  const plan = f.ordered().map((r) => r.id);
  const counts = {};
  const probe = (ms) => setTimeout(() => { counts[ms] = asked.length; }, ms);
  [150, 600, 1200, 1850, 2500].forEach(probe);   // between the waves
  const ok = await f.resolve(F.buildQuery('example.com', 1)).then(() => true, () => false);
  const ms = Date.now() - t0;
  await new Promise((res) => setTimeout(res, 2500));   // anything still to come
  f.stop();
  return { ok, ms, asked, counts, plan };
}

(async () => {
  // Waves, with no network at all. A healthy route: answered alone.
  let w = await waves({ 'cloudflare-1': 30 });
  t.ok(w.ok && w.asked.length === 1 && w.ms < 250, `a route that answers at once is the only one asked (${w.ms} ms)`);
  // Nothing answers: the best route, then two, then three at a time.
  w = await waves({});
  t.ok(w.counts[150] === 1 && w.counts[600] === 3 && w.counts[1200] === 6 && w.counts[1850] === 9 && w.counts[2500] === 12,
    `nothing answers: 1, then 3, then 3 more at a time, never all ${w.plan.length} at once (${JSON.stringify(w.counts)})`);
  t.ok(!w.ok && w.asked.length === w.plan.length, 'every route still gets its turn before the lookup fails');
  // The best route first, the second wave's two picked for being of another
  // kind and operator, and after that the ranking as it stands.
  const lead = w.asked.slice(0, 3).map((a) => a.id);
  t.ok(lead[0] === w.plan[0] && w.asked.slice(3).map((a) => a.id).join() === w.plan.filter((id) => !lead.includes(id)).join(),
    `in the order of the ranking, best first (${w.asked.slice(0, 6).map((a) => a.id).join(', ')}, ...)`);
  // The eighth route asked is the one that answers: found in the third
  // extra wave, and the routes after that wave are never asked.
  const id8 = w.asked[7].id;
  w = await waves({ [id8]: 50 });
  t.ok(w.ok && w.asked.length === 9 && w.ms < 1800, `an answer from the eighth route: ${w.asked.length} asked of ${w.plan.length}, ${w.ms} ms`);

  // Open network.
  let f = new F(() => {});
  let port = await f.start();
  let r = await ask(port, 'example.com');
  t.ok(r.ok, `open network: answered in ${r.ms} ms via ${f.preferredId}`);
  const many = await Promise.all(['wikipedia.org', 'github.com', 'discord.com', 'bbc.co.uk', 'telegram.org', 'x.com'].map((n) => ask(port, n)));
  t.ok(many.every((x) => x.ok), `6 parallel lookups, slowest ${Math.max(...many.map((x) => x.ms))} ms`);
  r = await ask(port, 'example.com');
  t.ok(r.ok && r.ms < 50, `cached answer in ${r.ms} ms`);
  f.stop();

  // Every direct route blocked (half refused, half silently dropped).
  const P = await freePort();
  const eng = await startEngine(P, ['--strategy', 'tlsrec(sni+1)', '--auto']);
  f = new F(() => {});
  f.routes.forEach((x, i) => { if (!x.viaEngine) x.ip = i % 2 ? '127.0.0.2' : '10.255.255.1'; });
  port = await f.start();
  f.setSocksPort(P);
  r = await ask(port, 'discord.com');
  t.ok(r.ok, `all direct routes blocked: answered through the engine in ${r.ms} ms via ${f.preferredId}`);
  r = await ask(port, 'wikipedia.org');
  t.ok(r.ok && r.ms < 1500, `next lookup goes straight to the working route (${r.ms} ms)`);
  f.stop();

  // Everything blocked -> "down", then the network recovers -> "ok".
  const states = [];
  f = new F(() => {}, { onState: (s) => states.push(s) });
  const real = f.routes.map((x) => x.ip);
  f.routes.forEach((x) => { x.ip = '127.0.0.2'; });
  port = await f.start();
  for (let i = 0; i < 3; i++) await ask(port, `t${i}.example.com`);
  // The third failure can land a moment after the client gave up on its
  // answer (a slow machine): wait for it rather than race it.
  for (let i = 0; i < 50 && !states.length; i++) await new Promise((res) => setTimeout(res, 100));
  t.ok(states.join() === 'down', 'three failed lookups in a row -> state "down"');
  f.routes.forEach((x, i) => { x.ip = real[i]; x.restUntil = 0; });
  r = await ask(port, 'example.org');
  t.ok(r.ok && states.join() === 'down,ok', 'network recovers -> state "ok" again, by itself');
  f.stop();

  // Remembered route goes first. Which routes answer depends on the network
  // the test runs on, so remember one that is not first in the table and
  // that answers here.
  let remembered = null;
  for (const id of ['google-1', 'adguard-1', 'opendns-1', 'quad9-1', 'cloudflare-2']) {
    const probe = new F(() => {});
    probe.routes = probe.routes.filter((x) => x.id === id);
    const pp = await probe.start();
    const ok = (await ask(pp, 'example.net')).ok;
    probe.stop();
    if (ok) { remembered = id; break; }
  }
  t.ok(!!remembered, `a second resolver answers on this network (${remembered})`);
  let told = null;
  f = new F(() => {}, { preferredId: remembered, onPreferred: (id) => { told = id; } });
  port = await f.start();
  // Asked first, not necessarily answering first: a slow answer on a busy CI
  // runner rightly loses the race to the second wave and becomes the new pick.
  const first = f.ordered()[0].id;
  r = await ask(port, 'example.org');
  t.ok(r.ok && first === remembered && (told === null || told === f.preferredId), `route remembered from the last run is used first (${remembered})`);
  f.stop();

  // Impostors: an on-path attacker with its own certificate, and a real
  // certificate that belongs to a different resolver.
  const fake = http2.createSecureServer({ key: fixture('test-only-key.pem'), cert: fixture('test-only-cert.pem') }, (req, res) => {
    const ch = []; req.on('data', (d) => ch.push(d)); req.on('end', () => {
      const a = Buffer.from(Buffer.concat(ch)); a[2] = 0x81; a[3] = 0x80; a.writeUInt16BE(1, 6);
      res.writeHead(200, { 'content-type': 'application/dns-message' });
      res.end(Buffer.concat([a, Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 6, 6, 6, 6])]));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((res) => fake.once('listening', res));
  const mitm = net.createServer((c) => {
    let st = 0;
    c.on('data', (d) => {
      if (st === 0) { st = 1; c.write(Buffer.from([5, 0])); return; }
      if (st === 1) {
        st = 2;
        const u = net.connect(fake.address().port, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); c.pipe(u); u.pipe(c); });
        u.on('error', () => c.destroy());
      }
    });
    c.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((res) => mitm.once('listening', res));
  f = new F(() => {}); f.routes = f.routes.filter((x) => x.viaEngine); f.setSocksPort(mitm.address().port);
  port = await f.start(); r = await ask(port, 'discord.com');
  t.ok(!r.ok, 'on-path attacker with its own certificate: refused');
  f.stop();
  f = new F(() => {}); f.routes = [{ ...f.routes[0], id: 'x', ip: '1.1.1.1', sni: 'dns.google', viaEngine: false }];
  port = await f.start(); r = await ask(port, 'discord.com');
  t.ok(!r.ok, 'real certificate of a different resolver: refused');
  f.stop();

  eng.stop(); fake.close(); mitm.close();
  console.log(`doh: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
