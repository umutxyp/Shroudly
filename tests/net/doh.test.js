'use strict';

/* Encrypted DNS: answers on an open network, survives a network that blocks
 * every direct route (through the engine), says when it is blocked outright
 * and recovers by itself, remembers the route that worked — and never accepts
 * an answer from anyone but the real resolver. A blip is not a block: one
 * lost connection rests a route once, not once per lookup that was waiting
 * on it; routes resting after an outage are still asked; a new start begins
 * with a clean record; and "down" takes lookups failing for 10 s in one
 * streak, not three that failed together, nor two blips with an answer, a
 * sleep or a quiet hour between them. (engine-doh.test.js: the same through
 * the engine.) */

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

/* A forwarder whose routes answer as `answers(r)` says: a number is ms until
 * it answers, anything else ms until it fails. Bookkeeping and waves are the
 * real ones. */
function staged(answers, opts = {}) {
  const f = new F(() => {}, opts);
  f.setSocksPort(1);
  f.query = (r) => {
    const v = answers(r);
    return new Promise((res, rej) => setTimeout(() => (v.ok ? res(Buffer.alloc(12)) : rej(new Error('timeout'))), v.ms));
  };
  return f;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const restS = (r) => Math.max(0, Math.round((r.restUntil - Date.now()) / 1000));

(async () => {
  // One connection lost with ten lookups in flight on it (a blip of 300 ms
  // during a busy page): one failure for each route it touched, rested 2 s.
  // It used to count ten, and rest the best routes for five minutes.
  {
    let silent = true;
    const f = staged(() => (silent ? { ok: false, ms: 2500 } : { ok: true, ms: 20 }));
    const all = Array.from({ length: 10 }, (_, i) => f.resolve(F.buildQuery(`a${i}.example`, 1)).then(() => true, () => false));
    await sleep(300); silent = false;
    const ok = await Promise.all(all);
    await sleep(2400);   // the requests on the lost connection time out now
    const hit = f.routes.filter((r) => r.fails > 0);
    t.ok(ok.every(Boolean) && hit.length > 0 && hit.every((r) => r.fails === 1 && restS(r) <= 2),
      `a lost connection under 10 lookups: every lookup answered, ${hit.map((r) => r.id).join(', ')} counted once, rested ${Math.max(...hit.map(restS))} s`);
    f.stop();
  }

  // After an outage every route rests, and the ones that wake first are
  // routes this network blocks. A lookup still reaches the good ones (asked
  // after the awake ones); it used to ask only the three that woke first,
  // and fail for as long as the others rested.
  {
    const good = new Set(['cloudflare-2', 'cloudflare-3']);
    const f = staged((r) => (good.has(r.id) ? { ok: true, ms: 30 } : { ok: false, ms: 30 }));
    const now = Date.now();
    f.routes.forEach((r, i) => { r.fails = 9; r.failAt = now; r.restUntil = now + (good.has(r.id) ? 280000 : 60000 + i * 1000); });
    const t0 = Date.now();
    const ok = await f.resolve(F.buildQuery('after-outage.example', 1)).then(() => true, () => false);
    t.ok(ok && good.has(f.preferredId), `every route resting, blocked ones waking first: answered by ${f.preferredId} in ${Date.now() - t0} ms`);
    f.stop();
  }

  // A route that answered lately rests at most 20 s, however often it fails;
  // one that never answered here backs off to minutes.
  {
    const f = staged(() => ({ ok: false, ms: 5 }));
    const [proven, never] = f.routes;
    proven.okAt = Date.now() - 1000;
    for (let i = 0; i < 12; i++) { f.failed(proven, Date.now()); f.failed(never, Date.now()); await sleep(2); }
    t.ok(restS(proven) <= 20 && restS(never) >= 200, `after 12 failures: a route that answered a moment ago rests ${restS(proven)} s, one that never did ${restS(never)} s`);
    f.stop();
  }

  // A new start (Stop and Start, an engine restart) begins with a clean record,
  // and so does another network.
  {
    const f = staged(() => ({ ok: true, ms: 10 }));
    await f.start();
    f.routes.forEach((r) => { r.fails = 9; r.restUntil = Date.now() + 300000; });
    f.stop();
    await f.start();
    t.ok(f.routes.every((r) => r.fails === 0 && r.restUntil === 0), 'stop() and start(): no route still resting from the last session');
    // Another network: the old connections go (dead without knowing it), and
    // so do the rests earned on the old network.
    let destroyed = 0;
    f.routes.forEach((r) => { r.fails = 5; r.restUntil = Date.now() + 300000; r.session = { closed: false, destroyed: false, destroy: () => { destroyed++; } }; });
    f.networkChanged();
    t.ok(destroyed === f.routes.length && f.routes.every((r) => !r.session && r.fails === 0 && r.restUntil === 0),
      'networkChanged(): every old connection dropped, no route resting');
    f.stop();
  }

  // "down" is one streak of failed lookups lasting 10 s. An answer between
  // (a warm probe's too) ends a streak, and so does a long gap with nothing
  // failing (the computer asleep, nothing looked up): a blip after either
  // starts afresh. Both used to count a failure from long before.
  {
    const states = [];
    const warned = [];
    const f = new F((level, msg) => warned.push(msg), { onState: (st) => states.push(st) });
    const T = Date.now();
    f.lookupFailed(T);                                   // one blip
    f.succeeded(f.routes[0], 20);                        // a warm probe answers a minute later
    f.lookupFailed(T + 300000); f.lookupFailed(T + 300500); // another blip, minutes later
    t.ok(!states.length && !warned.length && f.failures === 2, 'a failure, an answer, then a blip minutes later: not "down" (the answer ended the streak)');
    f.clearRests();
    f.lookupFailed(T);                                   // the Wi-Fi drops as the lid closes
    f.lookupFailed(T + 3600000); f.lookupFailed(T + 3601000); // an hour asleep, two failures on waking
    t.ok(!states.length && f.failures === 2, 'a failure, an hour asleep, then a blip on waking: not "down" (too long ago to be one streak)');
    f.clearRests();
    f.lookupFailed(T); f.lookupFailed(T + 4000); f.lookupFailed(T + 8000);
    t.ok(!states.length, 'three failures within 8 s: not yet "down"');
    f.lookupFailed(T + 12000);
    t.ok(states.join() === 'down' && warned.length === 1, 'failing on for 12 s: "down", said once');
    // A real block with few lookups (only listed sites through the engine):
    // minutes apart, the warm rounds failing between keep it one streak.
    const g = new F(() => {}, { onState: (st) => states.push(`g:${st}`) });
    g.lookupFailed(T); g.stillFailing(T + 120000); g.lookupFailed(T + 180000); g.stillFailing(T + 300000); g.lookupFailed(T + 360000);
    t.ok(states.includes('g:down'), 'blocked with lookups minutes apart, warm rounds failing between: still one streak, "down"');
    // Two failures, then an hour asleep: the first warm round on waking
    // fails, and so does a lookup. The old streak is over, not revived.
    const z = new F(() => {}, { onState: (st) => states.push(`z:${st}`) });
    z.lookupFailed(T); z.lookupFailed(T + 4000);
    z.stillFailing(T + 3604000); z.lookupFailed(T + 3605000);
    t.ok(!states.includes('z:down') && z.state === 'ok' && z.failures === 1, 'two failures, an hour asleep, a failing warm round and a failed lookup on waking: not "down"');
    z.stop();
    const h = new F(() => {}, {});
    h.lookupFailed(T); h.lookupFailed(T + 180000); h.lookupFailed(T + 360000);
    t.ok(h.state === 'ok' && h.failures === 1, '…with nothing failing for minutes between: no streak');
    // Just woken up: the network comes back in its own time. Lookups failing
    // in the first half minute are no sign of a block; a streak after it is.
    const w = new F(() => {}, { onState: (st) => states.push(`w:${st}`) });
    w.routes[0].restUntil = T + 60000;
    w.resumed(T);
    t.ok(w.routes.every((r) => !r.restUntil && !r.session), 'woken up: every old connection dropped, no route resting');
    for (let i = 0; i <= 25; i += 5) w.lookupFailed(T + i * 1000);
    t.ok(!states.includes('w:down') && w.failures === 0, 'lookups failing for 25 s right after waking: not "down"');
    for (let i = 31; i <= 45; i += 4) w.lookupFailed(T + i * 1000);
    t.ok(states.includes('w:down'), 'failing on after that half minute: "down" as ever');
    // The clock set back an hour: a route resting "until an hour from now"
    // rests at most the longest rest, and failures still count.
    const c = new F(() => {}, {});
    const r0 = c.routes[0];
    r0.restUntil = Date.now() + 3600 * 1000; r0.failAt = Date.now() + 3600 * 1000; r0.fails = 1;
    c.ordered();
    t.ok(r0.restUntil <= Date.now() + 300000 && r0.failAt <= Date.now(), 'clock set back: a rest "until an hour from now" is cut to the longest rest');
    { const until = Date.now() + 5; while (Date.now() < until) { /* a new request, a moment later */ } }
    c.failed(r0, Date.now());
    t.ok(r0.fails === 2, 'and a new failure of that route is counted, not taken for one already counted');
    f.stop(); g.stop(); h.stop();
  }
  // warm(): a round no route answers keeps a streak on; any answer ends it.
  {
    const fail = staged(() => ({ ok: false, ms: 5 }));
    fail.failures = 1; fail.failingSince = fail.lastFailAt = Date.now() - 100000;
    fail.warm(); await sleep(60);
    t.ok(fail.failures === 1 && Date.now() - fail.lastFailAt < 1000, 'warm round with no answer: the streak is still on');
    const ok = staged(() => ({ ok: true, ms: 5 }));
    ok.failures = 2; ok.failingSince = ok.lastFailAt = Date.now() - 5000;
    ok.warm(); await sleep(60);
    t.ok(ok.failures === 0 && ok.failingSince === 0, 'warm round answered: the streak is over');
    fail.stop(); ok.stop();
  }

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

  // A blip that fails several lookups at once is not "down".
  {
    const blip = [];
    const fb = new F(() => {}, { onState: (s) => blip.push(s) });
    fb.routes.forEach((x) => { x.ip = '127.0.0.2'; });
    const pb = await fb.start();
    await Promise.all([0, 1, 2, 3, 4].map((i) => ask(pb, `blip${i}.example`)));
    t.ok(!blip.length, 'five lookups failing together (one blip): not "down"');
    fb.stop();
  }

  // Everything blocked for more than 10 s -> "down", then the network
  // recovers -> "ok".
  const states = [];
  f = new F(() => {}, { onState: (s) => states.push(s) });
  const real = f.routes.map((x) => x.ip);
  f.routes.forEach((x) => { x.ip = '127.0.0.2'; });
  port = await f.start();
  const tDown = Date.now();
  for (let i = 0; i < 3; i++) await ask(port, `t${i}.example.com`);
  // The third failure can land a moment after the client gave up on its
  // answer (a slow machine): wait for it rather than race it.
  for (let i = 0; i < 50 && !states.length; i++) await new Promise((res) => setTimeout(res, 100));
  t.ok(states.join() === 'down' && Date.now() - tDown >= 10000, `lookups failing for over 10 s -> state "down" (after ${((Date.now() - tDown) / 1000).toFixed(1)} s)`);
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
