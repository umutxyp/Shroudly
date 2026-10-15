'use strict';

/* The site test's last question (electron/service-check.js): once the network
 * is out of the way, does the site itself turn this user away? Local HTTPS
 * servers stand in for the cases: a page that says the service is not
 * offered in this country (Cloudflare's error 1009 among them), HTTP 451, a
 * server that completes the handshake and then never answers (Roblox towards
 * Vietnam), and ordinary sites, which must never be flagged: a plain 403 or
 * "Access denied" is what storage and CDN servers answer everyone. */

const fs = require('fs');
const os = require('os');
const https = require('https');
const net = require('net');
const path = require('path');
const { ROOT, fixture, suite, sleep } = require('./helpers');

const ServiceCheck = require(path.join(ROOT, 'electron', 'service-check.js'));
const { serviceCheck } = ServiceCheck;
const t = suite('servicecheck');

function server(handler) {
  return new Promise((resolve) => {
    const s = https.createServer({ key: fixture('test-only-key.pem'), cert: fixture('test-only-cert.pem') }, handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
function close(s) { s.close(); if (s.closeAllConnections) s.closeAllConnections(); }
// Stands in for the engine: the "SOCKS connection" goes straight to the test server.
const via = (port) => () => new Promise((resolve, reject) => { const c = net.connect(port, '127.0.0.1', () => resolve(c)); c.on('error', reject); });
const ca = fixture('test-only-cert.pem');
const page = (status, body, type = 'text/html') => (req, res) => { res.writeHead(status, { 'content-type': type }); res.end(body); };

/* Stands in for the engine trying techniques before the handshake gets
 * through: the ClientHello is held for holdMs, everything after it passes. */
function slowRelay(port, holdMs) {
  const r = net.createServer((c) => {
    const up = net.connect(port, '127.0.0.1');
    const queue = [];
    let open = false;
    setTimeout(() => { open = true; for (const d of queue) up.write(d); }, holdMs);
    c.on('data', (d) => { if (open) up.write(d); else queue.push(d); });
    up.pipe(c);
    c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
    c.on('close', () => up.destroy());
  });
  return new Promise((resolve) => r.listen(0, '127.0.0.1', () => resolve(r)));
}

const CLOUDFLARE_1009 = '<!DOCTYPE html><html><head><title>Access denied | example.com used Cloudflare to restrict access</title></head><body>' +
  '<h1><span data-translate="error">Error</span> <span>1009</span></h1><h2 class="cf-subheadline">Access denied</h2>' +
  '<p>The owner of this website (example.com) has banned the country or region your IP address is in (VN) from accessing this website.</p></body></html>';

(async () => {
  const cases = [
    ["Cloudflare's country ban (error 1009)", page(403, CLOUDFLARE_1009), 'region'],
    ['a page saying the service is not available in this country', page(403, '<html><h1>Sorry!</h1><p>This service is <b>not available in your country</b>.</p></html>'), 'region'],
    ['a page saying it is unavailable in this region', page(403, '<html>Our games are unavailable in your region.</html>'), 'region'],
    ['HTTP 451', page(451, 'Unavailable For Legal Reasons'), 'region'],
    ['an ordinary page', page(200, '<html>hello</html>'), null],
    ['a 403 that is not a block page (a login wall)', page(403, '<html>Please sign in</html>'), null],
    ['a storage bucket answering / (S3, Google Cloud Storage)', page(403, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', 'application/xml'), null],
    ["a CDN's own 403 (Akamai)", page(403, '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>You don\'t have permission to access "http://setup.rbxcdn.com/" on this server.</BODY></HTML>'), null],
    ["Cloudflare's firewall page (bots, rules; not a country)", page(403, '<html><title>Attention Required!</title><h1>Sorry, you have been blocked</h1><p>You are unable to access example.com</p></html>'), null],
    ['a redirect', (req, res) => { res.writeHead(302, { location: '/login' }); res.end(); }, null],
    ['handshake, then silence', () => {}, 'stall'],
  ];
  for (const [what, handler, want] of cases) {
    const s = await server(handler);
    const got = await serviceCheck('test.local', 1, via(s.address().port), { timeoutMs: 2500, ca });
    close(s);
    t.ok(got === want, `${what}: ${JSON.stringify(got)}`);
  }
  // Nothing listening (the network, not the site): never blamed on the site.
  const dead = await serviceCheck('test.local', 1, () => Promise.reject(new Error('refused')), { timeoutMs: 1000, ca });
  t.ok(dead === null, 'unreachable: not reported as the site refusing');
  // A certificate that is not the site's (an interceptor): not the site's refusal either.
  let s = await server(page(403, CLOUDFLARE_1009));
  const wrong = await serviceCheck('other.example', 1, via(s.address().port), { timeoutMs: 2500, ca });
  close(s);
  t.ok(wrong === null, 'a certificate for another name: ignored');

  // The time the engine spends getting the handshake through is the
  // network's: only silence after it is the site's.
  s = await server((req, res) => setTimeout(() => { res.writeHead(200); res.end('ok'); }, 1500));
  let relay = await slowRelay(s.address().port, 1500);
  const t0 = Date.now();
  const slow = await serviceCheck('test.local', 1, via(relay.address().port), { timeoutMs: 2500, ca });
  t.ok(slow === null, `a handshake that took 1.5 s, then an answer 1.5 s later: not a stall (${JSON.stringify(slow)} after ${Date.now() - t0} ms)`);
  relay.close(); close(s);
  s = await server(page(200, 'ok'));
  relay = await slowRelay(s.address().port, 60000);
  const never = await serviceCheck('test.local', 1, via(relay.address().port), { timeoutMs: 500, connectMs: 1500, ca });
  t.ok(never === null, 'a handshake that never completes: the network, not the site');
  relay.close(); close(s);

  // Asked the way a browser asks: nothing names Shroudly to the site.
  let ua = '';
  s = await server((req, res) => { ua = req.headers['user-agent'] || ''; res.writeHead(200); res.end('ok'); });
  await serviceCheck('test.local', 1, via(s.address().port), { timeoutMs: 2500, ca });
  close(s);
  t.ok(/^Mozilla\/5\.0 \([^)]+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(ua) && !/shroudly/i.test(ua), `a current browser's User-Agent is sent (${ua})`);
  t.ok(/Chrome\/151\.0\.0\.0/.test(ServiceCheck.browserUserAgent('win32', '151.0.7000.12')) && /Windows NT 10\.0/.test(ServiceCheck.browserUserAgent('win32', '151.0.1'))
    && /Macintosh/.test(ServiceCheck.browserUserAgent('darwin', '151.0.1')) && /X11; Linux/.test(ServiceCheck.browserUserAgent('linux', '151.0.1')), "the User-Agent follows Electron's own Chromium and the OS");

  // Only a site's own page is asked, never the hosts it loads its parts from.
  const main = ['roblox.com', 'www.roblox.com', 'discord.com', 'bbc.co.uk', 'www.example.com.tr', 'example.org.'];
  const parts = ['setup.rbxcdn.com', 'js.rbxcdn.com', 'c0.rbxcdn.com', 'apis.roblox.com', 'discord-attachments-uploads-prd.storage.googleapis.com',
    'cdn.discordapp.com', 'gateway.discord.gg', '104.16.1.1', '', 'localhost'];
  t.ok(main.every(ServiceCheck.isMainName), `a site's own page: ${main.join(', ')}`);
  t.ok(!parts.some(ServiceCheck.isMainName), `not CDN, API or storage hosts: ${parts.filter(Boolean).slice(0, 5).join(', ')}…`);

  // The same count the engine needs before it believes a cut.
  const cut = ServiceCheck.cutCounter();
  let now = 1e6;
  t.ok(cut('a.example', 'stall', now) === false, 'one cut: not enough');
  t.ok(cut('a.example', 'reset', now + 1000) === true, 'two stalls or resets within minutes: counted');
  t.ok(cut('a.example', 'stall', now + 2000) === false && cut('a.example', 'stall', now + 3000) === false, '…once per host');
  now = 2e6;
  t.ok(cut('b.example', 'stall', now) === false && cut('b.example', 'stall', now + 4 * 60 * 1000) === false, 'two cuts far apart: not counted');
  t.ok(['noreply', 'noreply', 'noreply'].every((r, i) => cut('c.example', r, now + i) === false) && cut('c.example', 'noreply', now + 5) === true,
    'unanswered requests (weak: a long-poll looks the same) need four');
  t.ok(cut('', 'stall', now) === false && cut(null, 'reset', now) === false, 'no host: nothing');

  // What the site test then shows (components/probeView.js, an ES module for
  // the window, loaded here as CommonJS): a site that says it does not serve
  // this country does not hide that the network test got through.
  const src = fs.readFileSync(path.join(ROOT, 'components', 'probeView.js'), 'utf8').replace(/export function /g, 'function ');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-pv-'));
  fs.writeFileSync(path.join(dir, 'm.js'), `${src}\nmodule.exports = { probeView };`);
  const { probeView } = require(path.join(dir, 'm.js'));
  fs.rmSync(dir, { recursive: true, force: true });
  const v = (p) => JSON.stringify(probeView(p));
  t.ok(v({ host: 'a.example', ok: true, strategy: 'tlsrec', service: 'region' }) === '{"refused":true,"works":true,"blocked":false}', 'site test: a refusal page and a network that was got through are both shown');
  t.ok(v({ host: 'a.example', ok: true, strategy: 'none', service: 'stall' }) === '{"refused":true,"works":false,"blocked":false}', 'site test: silence after connecting is not shown as working');
  t.ok(v({ host: 'a.example', ok: true, strategy: 'none' }) === '{"refused":false,"works":true,"blocked":false}'
    && v({ host: 'a.example', ok: false }) === '{"refused":false,"works":false,"blocked":true}' && v(null) === '{"refused":false,"works":false,"blocked":false}', 'site test: the plain outcomes as before');
  await sleep(10);
  console.log(`servicecheck: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
