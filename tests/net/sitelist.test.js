'use strict';

/* The automatic site list: what the weekly build adds and drops, what the app
 * accepts from the network, how it fetches it (through the engine, with the
 * certificate checked), and that a PAC built from thousands of names still
 * answers correctly. */

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const net = require('net');
const path = require('path');
const https = require('https');
const { ROOT, startEngine, freePort, fixture, suite } = require('./helpers');

const U = require(path.join(ROOT, 'scripts', 'site-list', 'update.js'));
const POLICY = require(path.join(ROOT, 'scripts', 'site-list', 'policy.json'));
const SiteList = require(path.join(ROOT, 'electron', 'site-list.js'));
const SystemProxy = require(path.join(ROOT, 'electron', 'system-proxy.js'));
const t = suite('sitelist');

const DAY = 86400000;
const now = new Date('2026-10-14T00:00:00Z');
const row = (domain, m, a, c = 0, f = 0) => ({ domain, measurement_count: m, anomaly_count: a, confirmed_count: c, failure_count: f });
const cats = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
const families = { shared: { captcha: ['hcaptcha.com'] }, families: [{ id: 'f', name: 'F', needs: ['captcha'], domains: ['roblox.com', 'rbxcdn.com', 'jnn-pa.googleapis.com'] }] };

/* A SOCKS5 server that sends every CONNECT to 127.0.0.1:<port>. */
function fakeSocks(toPort) {
  const srv = net.createServer((c) => {
    let st = 0; let b = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', function on(d) {
      b = Buffer.concat([b, d]);
      if (st === 0 && b.length >= 3) { c.write(Buffer.from([5, 0])); b = b.subarray(3); st = 1; }
      if (st === 1 && b.length >= 5) {
        const need = b[3] === 3 ? 7 + b[4] : b[3] === 1 ? 10 : 22;
        if (b.length < need) return;
        c.removeListener('data', on);
        const up = net.connect(toPort, '127.0.0.1', () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          up.pipe(c); c.pipe(up);
        });
        up.on('error', () => c.destroy());
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function pacEval(body) {
  const ctx = {
    isPlainHostName: (h) => !h.includes('.'),
    shExpMatch: (s, p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(s),
    isInNet: () => false,
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  return (host) => ctx.FindProxyForURL(`https://${host}/`, host);
}

(async () => {
  // ── the weekly build ──
  const ooni = {
    tr: [row('www.blockednews.org', 120, 100), row('confirmed.org', 3, 0, 5), row('fine.org', 500, 20), row('few.org', 5, 5),
      row('adult.example', 100, 99), row('mixed.org', 100, 99), row('mezopotamyaajansi44.com', 100, 99),
      row('cdn.cloudfront.net', 100, 99), row('8.8.8.8', 100, 99), row('cdn.roblox.com', 100, 99), row('sub.blockednews.org', 100, 99)],
    ru: null,
  };
  const categories = cats({ 'blockednews.org': ['NEWS'], 'confirmed.org': ['HUMR'], 'fine.org': ['NEWS'], 'few.org': ['NEWS'],
    'adult.example': ['PORN'], 'mixed.org': ['NEWS', 'GMB'], 'mezopotamyaajansi44.com': ['NEWS'], 'cdn.cloudfront.net': ['HOST'],
    '8.8.8.8': ['ANON'], 'cdn.roblox.com': ['GAME'], 'sub.blockednews.org': ['NEWS'] });
  const state = { v: 1, domains: { 'stale.org': { first: '2026-01-01T00:00:00Z', last: new Date(now - 100 * DAY).toISOString(), cc: ['ru'] },
    'recent.org': { first: '2026-01-01T00:00:00Z', last: new Date(now - 10 * DAY).toISOString(), cc: ['ru'] } } };
  const r = U.build({ now, state, previous: null, categories, ooni, families });
  const has = (d) => r.sites.domains.includes(d);
  t.ok(has('roblox.com') && has('rbxcdn.com') && has('hcaptcha.com'), 'families listed whole, with the captcha they need');
  t.ok(has('jnn-pa.googleapis.com') && !has('googleapis.com'), 'a family may name one host on shared infrastructure, never the infrastructure');
  t.ok(has('blockednews.org') && !has('www.blockednews.org'), 'blocked (anomaly rate) and added, www. stripped');
  t.ok(!has('sub.blockednews.org'), 'a name already covered by its parent is not repeated');
  t.ok(has('confirmed.org'), 'blocked (confirmed block page) and added');
  t.ok(!has('fine.org') && !has('few.org'), 'not added: rarely anomalous, or too few measurements');
  t.ok(!has('adult.example') && !has('mixed.org'), 'not added: a disallowed category, even next to an allowed one');
  t.ok(!has('mezopotamyaajansi44.com'), 'not added: excluded by policy, whatever the measurements say');
  t.ok(!has('cdn.cloudfront.net') && !has('8.8.8.8'), 'not added: shared infrastructure, bare addresses');
  t.ok(!has('cdn.roblox.com') && !r.state.domains['cdn.roblox.com'], 'a measured family member adds nothing (the family is already there)');
  t.ok(!has('stale.org') && !r.state.domains['stale.org'], 'dropped after 90 days without a block anywhere');
  t.ok(has('recent.org'), 'kept while blocked within 90 days (a country with no data this week changes nothing)');
  t.ok(r.state.domains['blockednews.org'].cc.includes('tr'), 'remembers where it was blocked');
  const old = (days) => new Date(now - days * DAY).toISOString();
  const many = (days) => ({ v: 1, domains: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`x${i}.org`, { first: old(200), last: old(days), cc: ['tr'] }])) });
  let threw = false;
  try { U.build({ now, state: many(95), previous: null, categories, ooni: {}, families }); } catch { threw = true; }
  t.ok(threw, 'refuses to lose most measured names at once (a fault at the source)');
  t.ok(U.build({ now, state: many(30), previous: null, categories, ooni: {}, families }).sites.domains.includes('x7.org'), 'a week without data loses nothing (90 days of grace)');
  const future = { v: 1, domains: { 'evil.org': { first: old(1), last: '2099-01-01T00:00:00Z', cc: ['tr'] }, 'bad name!': { last: old(1), cc: [] } } };
  const fs2 = U.build({ now, state: future, previous: null, categories, ooni: {}, families }).state.domains;
  t.ok(Date.parse(fs2['evil.org'].last) <= now.getTime() && !fs2['bad name!'], 'state from the future is clamped, malformed entries dropped (cannot pin a name for ever)');
  t.ok(U.isRegistry('com.tr') && U.isRegistry('co.uk') && !U.isRegistry('bbc.co.uk') && !U.isRegistry('t.co'), 'whole registries (com.tr, co.uk) are recognised');

  // ── the list shipped with the app ──
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'data', 'sites.json'), 'utf8'));
  const sh = new Set(shipped.domains);
  const ex = U.makeExcluder(POLICY);
  t.ok(shipped.domains.length > 1000 && shipped.domains.every(U.isHostname), `shipped list: ${shipped.domains.length} plain host names`);
  t.ok(['roblox.com', 'rbxcdn.com', 'discord.com', 'wattpad.com', 't24.com.tr', 'kaosgl.org', 'proton.me', 'jnn-pa.googleapis.com'].every((d) => sh.has(d)), 'shipped list: the services people come for, with their dependencies');
  t.ok(!shipped.domains.some((d) => ex.policy(d) || ex.isInfra(d)), 'shipped list: nothing the policy excludes, no shared infrastructure');

  // ── what the app accepts ──
  const good = { v: 1, generated: now.toISOString(), domains: Array.from({ length: 60 }, (_, i) => `site${i}.org`) };
  t.ok(!(SiteList.validate(good, now.getTime()) instanceof Error), 'a sane list is accepted');
  t.ok(SiteList.validate({ ...good, v: 2 }) instanceof Error, 'unknown format refused');
  t.ok(SiteList.validate({ ...good, generated: '2030-01-01T00:00:00Z' }, now.getTime()) instanceof Error, 'a date in the future refused');
  t.ok(SiteList.validate({ ...good, domains: good.domains.slice(0, 10) }) instanceof Error, 'an implausibly short list refused');
  t.ok(SiteList.validate({ ...good, domains: [...good.domains, ...Array(20).fill('bad host!')] }) instanceof Error, 'a list of non-names refused');
  t.ok(SiteList.validate({ ...good, domains: [...good.domains, 'com.tr'] }) instanceof Error, 'a list naming a whole registry (com.tr) refused');

  // ── fetching, through a SOCKS proxy, certificate checked ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-sitelist-'));
  const bundled = path.join(dir, 'bundled.json');
  fs.writeFileSync(bundled, JSON.stringify({ ...good, generated: '2026-10-01T00:00:00Z' }));
  let served = { ...good, generated: '2026-10-10T00:00:00Z', domains: [...good.domains, 'newly-blocked.org'] };
  let hits = 0; let lastIfNoneMatch = null;
  const tlsSrv = https.createServer({ key: fixture('test-only-key.pem'), cert: fixture('test-only-cert.pem') }, (req, res) => {
    hits++;
    lastIfNoneMatch = req.headers['if-none-match'] || null;
    const body = JSON.stringify(served);
    const tag = `"${require('crypto').createHash('sha1').update(body).digest('hex')}"`;
    if (lastIfNoneMatch === tag) { res.writeHead(304, { etag: tag }); res.end(); return; }
    const gz = /gzip/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'content-type': 'application/json', etag: tag, ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    res.end(gz ? require('zlib').gzipSync(body) : body);
  });
  await new Promise((r2) => tlsSrv.listen(0, '127.0.0.1', r2));
  const socksSrv = await fakeSocks(tlsSrv.address().port);
  let on = true;
  const cacheFile = path.join(dir, 'cache.json');
  const opts = { bundled, cacheFile, url: `https://test.local:${tlsSrv.address().port}/sites.json`, ca: fixture('test-only-cert.pem'), getSocksPort: () => (on ? socksSrv.address().port : null) };
  let sl = new SiteList(opts);
  t.ok(sl.info().count === 60 && sl.info().generated === '2026-10-01T00:00:00.000Z', 'starts from the list shipped with the app');
  {
    const realNow = Date.now;
    Date.now = () => Date.parse('2025-01-01T00:00:00Z');   // a clock almost two years behind
    try { t.ok(new SiteList({ bundled }).domains.length === 60, 'a clock running behind does not throw the shipped list away'); }
    finally { Date.now = realNow; }
  }
  on = false;
  t.ok((await sl.refresh()) === false, 'protection off: nothing is fetched');
  on = true;
  t.ok((await sl.refresh()) === true && sl.domains.includes('newly-blocked.org'), 'protection on: a newer list is fetched through the proxy and used');
  t.ok(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).domains.includes('newly-blocked.org'), '…and kept for the next start');
  t.ok((await sl.refresh()) === false && lastIfNoneMatch, 'unchanged since last time: the server is asked with its tag and answers 304, nothing downloaded');
  served = { ...served, generated: '2026-10-10T12:00:00Z' };
  t.ok((await sl.refresh()) === false && sl.info().generated === '2026-10-10T12:00:00.000Z', 'a new date on the same sites: taken, but nothing to re-apply');
  const kept = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  t.ok(kept.checkedAt > 0 && typeof kept.etag === 'string', 'when it was checked, and its tag, survive a restart (no download at every start)');
  sl = new SiteList(opts);
  t.ok(sl.domains.includes('newly-blocked.org'), 'next start: the kept list, being newer than the shipped one');
  served = { ...good, generated: '2026-09-01T00:00:00Z' };
  t.ok((await sl.refresh()) === false && sl.domains.includes('newly-blocked.org'), 'an older list never replaces a newer one');
  served = { v: 1, generated: '2026-10-11T00:00:00Z', domains: good.domains.slice(0, 55).concat(['a1.org', 'a2.org', 'a3.org', 'a4.org', 'a5.org']) };
  sl.current = { generated: sl.current.generated, domains: Array.from({ length: 200 }, (_, i) => `k${i}.org`) };
  t.ok((await sl.refresh()) === false && sl.domains.length === 200, 'a list that would drop most sites at once is refused');
  served = { v: 1, generated: '2026-10-12T00:00:00Z', domains: ['x.org'] };
  t.ok((await sl.refresh()) === false && sl.domains.length === 200, 'a refused list leaves the current one in place');
  const wrongCa = new SiteList({ ...opts, ca: undefined, cacheFile: path.join(dir, 'c2.json') });
  served = { ...good, generated: '2026-10-13T00:00:00Z' };
  t.ok((await wrongCa.refresh()) === false, 'a certificate that does not check out: refused');
  tlsSrv.close(); socksSrv.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // ── the PAC with the whole list ──
  const sp = new SystemProxy(() => {});
  sp.mode = 'listed';
  sp.list = shipped.domains;
  const find = pacEval(sp.pacBody(10808));
  t.ok(/^SOCKS5 127\.0\.0\.1:10808/.test(find('www.roblox.com')) && /^SOCKS5/.test(find('roblox.com')), 'PAC: a listed site and its subdomains go through Shroudly');
  t.ok(find('roblox.com.attacker.example') === 'DIRECT' && find('notroblox.com') === 'DIRECT', 'PAC: look-alike names do not');
  t.ok(find('example.com') === 'DIRECT' && find('nas') === 'DIRECT' && find('constructor') === 'DIRECT', 'PAC: everything else, local names included, goes direct');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) find(`host${i}.cdn.example.com`);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  t.ok(ms < 2000, `PAC: 20,000 lookups in ${ms.toFixed(0)} ms against ${shipped.domains.length} names`);

  // A new list while applied: the same PAC address answers with it; the
  // system settings are not touched (nothing switched off and on).
  {
    const sp2 = new SystemProxy(() => {});
    sp2.mode = 'listed'; sp2.list = ['first.example'];
    const pacUrl = await sp2.startPacServer(10808);
    sp2.applied = true; sp2.socksPort = 10808;
    const getPac = () => new Promise((r2) => require('http').get(pacUrl, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r2(b)); }));
    const a = await getPac();
    t.ok(sp2.updateList(['second.example']) === true, 'PAC: a new list is taken while applied');
    const b2 = await getPac();
    t.ok(a.includes('first.example') && b2.includes('second.example') && !b2.includes('first.example') && sp2.pacUrl === pacUrl, 'PAC: same address, new list, no system change');
    sp2.applied = false; sp2.stopPacServer();
  }

  // ── for real: GitHub's raw files through the engine, certificate checked ──
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh']);
  let body = '';
  try { body = (await SiteList.fetchThrough(P, 'https://raw.githubusercontent.com/umutxyp/Shroudly/main/package.json')).body; } catch (e) { body = `error: ${e.message}`; }
  eng.stop();
  t.ok(/"name":\s*"shroudly"/i.test(body), 'GitHub raw files arrive through the engine (the path the published list takes)');

  console.log(`sitelist: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
