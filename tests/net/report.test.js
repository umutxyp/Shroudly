'use strict';

/* "Something not working?" on the desktop (electron/report.js): one report
 * an hour and three a day, references kept 60 days, the body the server
 * takes (codeshare.me/api/shroudly/report), and what the server's answers
 * become. The server is a stand-in here. */

const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { ROOT, suite } = require('./helpers');

const Report = require(path.join(ROOT, 'electron', 'report.js'));
const t = suite('report');

const H = 3600 * 1000;
const D = 24 * H;
const ref = (n) => `SR-AAAA-BBBB-${String(n).padStart(4, '0').replace(/[ILOU]/g, '0')}`;

/* A stand-in for electron's net.request, on node's http. */
function request({ method, url }) {
  const u = new URL(url);
  const headers = {};
  let req = null;
  const handlers = {};
  return {
    setHeader(k, v) { headers[k] = v; },
    on(ev, fn) { handlers[ev] = fn; },
    abort() { if (req) req.destroy(); },
    end(body) {
      req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => handlers.response && handlers.response(res));
      req.on('error', (e) => handlers.error && handlers.error(e));
      req.end(body);
    },
  };
}

function server(reply) {
  return new Promise((resolve) => {
    const got = [];
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        got.push({ type: req.headers['content-type'], app: req.headers['x-shroudly-app'], pow: req.headers['x-shroudly-pow'], body: b });
        const [status, json] = reply(got.length);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof json === 'string' ? json : JSON.stringify(json));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, got, url: `http://127.0.0.1:${s.address().port}/api/shroudly/report` }));
  });
}

(async () => {
  const now = Date.UTC(2026, 10, 7, 12);

  // ── history: newest first, 60 days, only real references
  const h = Report.history([
    { ref: ref(1), at: now - 61 * D }, { ref: ref(2), at: now - 2 * D }, { ref: ref(3), at: now - H / 2 },
    { ref: 'nonsense', at: now }, { ref: ref(4), at: NaN }, null,
  ], now);
  t.ok(h.length === 2 && h[0].ref === ref(3) && h[1].ref === ref(2), 'references: newest first, gone after 60 days, junk left out');

  // ── limits: one an hour, three a day
  t.ok(Report.wait([], now).ms === 0, 'nothing sent: one may go');
  let w = Report.wait([{ ref: ref(1), at: now - 20 * 60000 }], now);
  t.ok(w.ms === 40 * 60000 && w.limit === 'hour', 'one sent 20 minutes ago: wait 40 minutes (the hour)');
  t.ok(Report.wait([{ ref: ref(1), at: now - 61 * 60000 }], now).ms === 0, 'an hour later: one may go');
  w = Report.wait([{ ref: ref(1), at: now - 2 * H }, { ref: ref(2), at: now - 5 * H }, { ref: ref(3), at: now - 9 * H }], now);
  t.ok(w.limit === 'day' && w.ms === 15 * H, `three today: wait until the first of them is a day old (${w.ms / H} h)`);

  // ── the body
  const log = `${'x'.repeat(3 * 1024 * 1024)}\nthe end\n`;
  const p = Report.payload({ fields: { what: '  YouTube  ', site: 's'.repeat(400), contact: 5 }, version: '2.6.60', platform: 'windows', os: 'Windows 11', device: 'x64', lang: 'tr', log });
  const unpacked = zlib.gunzipSync(Buffer.from(p.log, 'base64')).toString('utf8');
  t.ok(p.v === 1 && p.app.platform === 'windows' && p.what === 'YouTube' && p.site.length === Report.FIELD_MAX.site && p.contact === '',
    'fields: trimmed, cut to what the server takes, non-strings dropped');
  t.ok(unpacked.endsWith('the end\n') && unpacked.startsWith('[… the start was cut]') && unpacked.length < 2.1 * 1024 * 1024,
    'a long log keeps its end');
  t.ok(JSON.stringify(p).length < 600 * 1024, `the body stays under the server's limit (${Math.round(JSON.stringify(p).length / 1024)} KB)`);

  // ── the proof of work the server asks for (server/shroudly/report.ts powOk)
  const crypto = require('crypto');
  const t0 = Date.now();
  const proof = await Report.proofOfWork('{"v":1}');
  const [at, nonce] = proof.split('.');
  const bh = crypto.createHash('sha256').update('{"v":1}').digest('hex');
  const ph = crypto.createHash('sha256').update(`shroudly-report-v1\n${at}\n${bh}\n${nonce}`).digest();
  const zero = ph[0] === 0 && ph[1] === 0 && (ph[2] & 0xc0) === 0;
  t.ok(zero && Math.abs(Number(at) - Date.now() / 1000) < 5, `a proof of work with 18 zero bits, made now (${Date.now() - t0} ms)`);
  t.ok(Report.chars('ab😀') === 3 && Report.WHAT_MIN === 50 && Report.WHAT_MAX === 1000, 'characters counted as the server counts them (50 to 1000)');

  // ── what the server says
  let srv = await server(() => [200, { ok: true, ref: 'SR-7K2Q-M9XD-4TPA' }]);
  let r = await Report.send(request, p, { url: srv.url });
  t.ok(r.ok && r.ref === 'SR-7K2Q-M9XD-4TPA' && srv.got[0].type === 'application/json' && srv.got[0].app === 'windows/2.6.60' && /^\d{10}\.[0-9a-f]+$/.test(srv.got[0].pow),
    'taken: the reference comes back; sent as JSON with the app\'s header and its proof of work');
  srv.s.close();
  srv = await server(() => [200, { ok: true, ref: 'not-a-ref' }]);
  r = await Report.send(request, p, { url: srv.url });
  t.ok(!r.ok && r.error === 'network', 'a reference that is not one is not shown');
  srv.s.close();
  srv = await server(() => [429, { ok: false, error: 'rate', retryAfter: 1200 }]);
  r = await Report.send(request, p, { url: srv.url });
  t.ok(!r.ok && r.error === 'rate' && r.retryAfter === 1200, 'the server\'s limit: said as such');
  srv.s.close();
  srv = await server(() => [502, '<html>bad gateway</html>']);
  r = await Report.send(request, p, { url: srv.url });
  t.ok(!r.ok && r.error === 'network', 'a page that is not ours: not sent');
  srv.s.close();
  r = await Report.send(request, p, { url: 'http://127.0.0.1:9/x', timeoutMs: 3000 });
  t.ok(!r.ok && r.error === 'network', 'nothing there: not sent');

  // The Connections list in the report: what Shroudly did something to first.
  const ct = Report.connsText([
    { host: 'auth.riotgames.com', route: 'direct', conns: 9 },
    { host: 'discord.com', route: 'technique', conns: 2 },
    { host: 'pulsar.roblox.com', route: 'tor', conns: 1, refused: 2 },
    { host: 'x.com', route: 'direct', conns: 30, blocked: 1 },
    { host: 'news.example', route: 'direct', conns: 50 },
  ], 60, (h) => h.endsWith('riotgames.com') || h === 'x.com').split('\n');
  t.ok(ct[0].startsWith('pulsar.roblox.com  tor  1 conns  (2 refused)') && ct[1].startsWith('discord.com  technique') && ct[2].startsWith('x.com  direct  30 conns  (blocked by the user)') && ct[3].startsWith('auth.riotgames.com  direct  9'),
    'connections: Tor, then techniques, then the busiest untouched');
  t.ok(ct.length === 4 && !ct.some((l) => l.includes('news.example')), 'connections: other untouched names (the browsing) left out');
  t.ok(Report.connsText([]) === '(none)' && Report.connsText(null) === '(none)', 'connections: none');
  // What each row says beyond its count: open now, bytes each way, last used.
  const det = Report.connsText([{ host: 'gateway.discord.gg', route: 'technique', conns: 1, active: 1, up: 1500, down: 0, ago: 70000 },
    { host: 'discord.com', route: 'technique', conns: 3, active: 0, up: 20480, down: 2300000, ago: 5000, refused: 1 }]).split('\n');
  t.ok(det[0] === 'discord.com  technique  3 conns  up 20 KB, down 2.2 MB, last 5 s ago  (1 refused)'
    && det[1] === 'gateway.discord.gg  technique  1 conns  1 open, up 1 KB, down 0 B, last 70 s ago',
    'connections: open, up and down, last used');
  const ev = Report.siteEventsSection([{ at: Date.UTC(2026, 10, 8, 1, 2, 3), type: 'cut', host: 'gateway.discord.gg', strategy: 'split-sni', note: 'stall', attempts: 2 }]);
  t.ok(ev === '== Recent site events ==\n01:02:03 cut gateway.discord.gg strategy=split-sni note=stall attempts=2' && /\(none\)$/.test(Report.siteEventsSection(null)),
    'recent site events: one line each, with what the engine said');
  const EM = require('../../electron/engine-manager');
  const em = new EM({ get: (k, d) => d, set: () => {} }, {});
  em._noteSiteEvent({ type: 'bypass', host: 'a.example', strategy: 'x' });
  for (let i = 0; i < 90; i++) em._noteSiteEvent({ type: 'blocked', host: `h${i}.example`, attempts: 5 });
  t.ok(em.siteEvents.length === 80 && em.siteEvents[0].host === 'h10.example' && !em.siteEvents.some((e) => e.type === 'bypass'),
    'recent site events: the troubles only, the last 80');
  const mainJs = require('fs').readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  t.ok(/Report\.siteEventsSection\(engine && engine\.siteEvents\)/.test(mainJs) && /== Apps ==/.test(mainJs) && /async function reportApps\(\)/.test(mainJs),
    'the report carries the recent site events and the Discord apps');
  const many = Report.connsText(Array.from({ length: 70 }, (_, i) => ({ host: `h${i}.example`, route: 'technique', conns: i })), 60).split('\n');
  t.ok(many.length === 61 && many[60] === '(+10 more)', 'connections: at most 60, the rest counted');

  // Off at the time of the report: the last session's list, said as such.
  t.ok(Report.connsSection(true, [{ host: 'discord.com', route: 'technique', conns: 1 }], null).startsWith('== Connections this session ==\ndiscord.com'), 'on: this session');
  t.ok(/^== Connections last session \(ended 2026-11-07T09:00:00\.000Z\) ==\ndiscord\.com  technique/.test(Report.connsSection(false, [], { rows: [{ host: 'discord.com', route: 'technique', conns: 1 }], at: Date.UTC(2026, 10, 7, 9) })), 'off: the last session, with when it ended');
  t.ok(/has not run/.test(Report.connsSection(false, [], null)), 'off and never on: said');

  console.log(`report: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
