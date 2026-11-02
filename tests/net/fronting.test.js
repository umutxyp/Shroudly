'use strict';

/* CDN fronting for Shroudly's own downloads from GitHub (electron/fronting.js):
 *   - here, with GitHub's name refused on the way: the site list and the ad
 *     list come through a front instead, the front's certificate checked and
 *     the list's Host asked for; a front that fails is passed over; the
 *     direct request still goes first, and nothing is fronted when it works;
 *   - for real: every front listed still hands GitHub's raw files over today
 *     (Fastly), straight and through the engine, and the CDNs that refuse it
 *     are not listed. */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const https = require('https');
const { ROOT, startEngine, freePort, fixture, suite } = require('./helpers');

const Fronting = require(path.join(ROOT, 'electron', 'fronting.js'));
const SiteList = require(path.join(ROOT, 'electron', 'site-list.js'));
const { AdblockList } = require(path.join(ROOT, 'electron', 'adblock.js'));

/* A SOCKS5 stand-in for the engine on a network that blocks `blocked`: a
 * connection to that name is cut, any other name goes to `to`. */
function blockingSocks(to, blocked) {
  const asked = [];
  const srv = net.createServer((c) => {
    c.on('error', () => {});
    let b = Buffer.alloc(0); let st = 'hello';
    c.on('data', function on(d) {
      b = Buffer.concat([b, d]);
      if (st === 'hello' && b.length >= 2 + b[1]) { b = b.subarray(2 + b[1]); c.write(Buffer.from([5, 0])); st = 'req'; }
      if (st === 'req' && b.length >= 5 && b[3] === 3 && b.length >= 7 + b[4]) {
        const host = b.subarray(5, 5 + b[4]).toString();
        const rest = b.subarray(7 + b[4]);
        asked.push(host);
        c.removeListener('data', on);
        if (host === blocked) { c.destroy(); return; }
        const up = net.connect(to, '127.0.0.1', () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) up.write(rest);
          c.pipe(up); up.pipe(c);
        });
        up.on('error', () => c.destroy());
      }
    });
  }).listen(0, '127.0.0.1');
  srv.asked = asked;
  return srv;
}

function get(front, host, p) {
  return new Promise((resolve) => {
    const req = https.request({ host: front, servername: front, port: 443, path: p, headers: { host, 'user-agent': 'Shroudly' }, timeout: 15000 }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 200000) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
}

(async () => {
  const t = suite('fronting');

  t.ok(JSON.stringify(Fronting.frontsFor('raw.githubusercontent.com')) === JSON.stringify(Fronting.FRONTS['raw.githubusercontent.com'])
    && Fronting.frontsFor('RAW.githubusercontent.com').length > 0 && Fronting.frontsFor('github.com').length === 0 && Fronting.frontsFor(null).length === 0,
  'fronts only for GitHub\'s raw files (Fastly), none for anything else');

  // ── here: GitHub's name refused, the lists come through a front ──
  const LIST_HOST = 'blocked.local';
  Fronting.FRONTS[LIST_HOST] = ['broken.local', 'test.local'];
  const good = { v: 1, generated: new Date(Date.now() - 3600e3).toISOString(), domains: Array.from({ length: 80 }, (_, i) => `site${i}.org`) };
  const hosts = [];
  const tlsSrv = https.createServer({ key: fixture('test-only-key.pem'), cert: fixture('test-only-cert.pem') }, (req, res) => {
    hosts.push(req.headers.host);
    // The list's own host (blocked on the way here) and test.local (not) serve it.
    if (!String(req.headers.host).startsWith(LIST_HOST) && !String(req.headers.host).startsWith('test.local')) { res.writeHead(404); res.end(); return; }
    if (req.url.endsWith('/adblock.txt')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ads.example\ntracker.example\n'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(good));
  });
  await new Promise((r) => tlsSrv.listen(0, '127.0.0.1', r));
  const port = tlsSrv.address().port;
  // broken.local: a front that answers nothing (connects to a closed port).
  const socksSrv = blockingSocks(port, LIST_HOST);
  await new Promise((r) => socksSrv.on('listening', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-fronting-'));
  const bundled = path.join(dir, 'bundled.json');
  fs.writeFileSync(bundled, JSON.stringify({ v: 1, generated: '2026-10-01T00:00:00Z', domains: good.domains.slice(0, 60) }));
  const sl = new SiteList({ bundled, cacheFile: path.join(dir, 'c.json'), url: `https://${LIST_HOST}:${port}/sites.json`, ca: fixture('test-only-cert.pem'), getSocksPort: () => socksSrv.address().port });
  const changed = await sl.refresh();
  t.ok(changed === true && sl.info().count === 80, `the site list arrives through a front (${sl.info().count} sites)`);
  t.ok(JSON.stringify(socksSrv.asked) === JSON.stringify([LIST_HOST, 'broken.local', 'test.local']),
    `the list's own name first, then the fronts in turn (${socksSrv.asked.join(' → ')})`);
  t.ok(hosts.length >= 1 && hosts.every((h) => h === `${LIST_HOST}:${port}`), 'each fronted request asks for the list\'s Host, on the front\'s connection and certificate');

  // The front's certificate is checked: one that does not check out is refused.
  socksSrv.asked.length = 0;
  const unchecked = new SiteList({ bundled, cacheFile: path.join(dir, 'c2.json'), url: `https://${LIST_HOST}:${port}/sites.json`, getSocksPort: () => socksSrv.address().port });
  t.ok((await unchecked.refresh()) === false, 'a front whose certificate does not check out: nothing taken');

  // The ad list, the same way.
  const ab = new AdblockList({ dir, source: { host: LIST_HOST, path: '/x/adblock.txt' }, tls: { ca: fixture('test-only-cert.pem') },
    connect: (sp, host, p) => new Promise((resolve, reject) => {
      const s = net.connect(sp, '127.0.0.1', () => {
        s.write(Buffer.from([5, 1, 0]));
        s.once('data', () => {
          const h = Buffer.from(host);
          s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([p >> 8, p & 255])]));
          s.once('data', (d) => (d[1] === 0 ? resolve(s) : reject(new Error('refused'))));
          s.once('close', () => reject(new Error('cut')));
        });
      });
      s.on('error', reject);
    }) });
  const tmp = await ab.fetch(socksSrv.address().port).catch((e) => `error: ${e.message}`);
  t.ok(typeof tmp === 'string' && !tmp.startsWith('error') && fs.readFileSync(tmp, 'utf8').includes('tracker.example'), 'the ad list arrives through a front too');

  // Nothing blocked: no front is used.
  const open = blockingSocks(port, 'nothing-blocked.local');
  await new Promise((r) => open.on('listening', r));
  const direct = new SiteList({ bundled, cacheFile: path.join(dir, 'c3.json'), url: `https://test.local:${port}/sites.json`, ca: fixture('test-only-cert.pem'), getSocksPort: () => open.address().port });
  Fronting.FRONTS['test.local'] = ['must-not-be-used.local'];
  hosts.length = 0;
  await direct.refresh();
  t.ok(JSON.stringify(open.asked) === '["test.local"]', 'GitHub reachable: the direct request only, no front');
  delete Fronting.FRONTS['test.local'];
  delete Fronting.FRONTS[LIST_HOST];
  tlsSrv.close(); socksSrv.close(); open.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // ── for real: the fronts hand GitHub's raw files over today ──
  // Real CDNs, so one moment of the runner not reaching one says nothing:
  // each is tried a few times before it counts.
  const FILE = '/umutxyp/Shroudly/main/package.json';
  for (const front of Fronting.frontsFor('raw.githubusercontent.com')) {
    let r = null;
    for (let i = 0; i < 3; i++) {
      r = await get(front, 'raw.githubusercontent.com', FILE);
      if (r.status === 200 && /"name":\s*"shroudly"/.test(r.body)) break;
      await new Promise((x) => setTimeout(x, 2000));
    }
    t.ok(r.status === 200 && /"name":\s*"shroudly"/.test(r.body), `${front} hands GitHub's raw file over (HTTP ${r.status})`);
  }
  // And through the engine, the way the app fetches.
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh']);
  let body = '';
  for (let i = 0; i < 3; i++) {
    try { body = (await SiteList.fetchThrough(P, `https://raw.githubusercontent.com${FILE}`, { front: 'www.python.org' })).body; } catch (e) { body = `error: ${e.message}`; }
    if (/"name":\s*"shroudly"/.test(body)) break;
    await new Promise((x) => setTimeout(x, 3000));
  }
  eng.stop();
  t.ok(/"name":\s*"shroudly"/.test(body), 'through the engine, as the app fetches: GitHub\'s file via www.python.org');

  // Why no other CDN is listed: they refuse a Host that is not the
  // connection's name (measured when this was written; informational).
  const others = [['www.google.com', 'dns.google', '/resolve?name=example.com'], ['www.cloudflare.com', 'cloudflare-dns.com', '/dns-query?name=example.com']];
  for (const [front, host, p] of others) {
    const r = await get(front, host, p);
    console.log(`  --  ${front} asked for ${host}: HTTP ${r.status} (refused, so not used)`);
  }

  console.log(`fronting: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
