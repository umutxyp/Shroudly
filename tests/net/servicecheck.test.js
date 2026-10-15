'use strict';

/* The site test's last question (electron/service-check.js): once the network
 * is out of the way, does the site itself turn this user away? Local HTTPS
 * servers stand in for the cases: a country block page (Cloudflare's "Sorry,
 * you have been blocked"), HTTP 451, a server that completes the handshake and
 * then never answers (Roblox towards Vietnam), and an ordinary site, which
 * must never be flagged. */

const https = require('https');
const net = require('net');
const path = require('path');
const { ROOT, fixture, suite } = require('./helpers');

const { serviceCheck } = require(path.join(ROOT, 'electron', 'service-check.js'));
const t = suite('servicecheck');

function server(handler) {
  return new Promise((resolve) => {
    const s = https.createServer({ key: fixture('test-only-key.pem'), cert: fixture('test-only-cert.pem') }, handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
// Stands in for the engine: the "SOCKS connection" goes straight to the test server.
const via = (port) => () => new Promise((resolve, reject) => { const c = net.connect(port, '127.0.0.1', () => resolve(c)); c.on('error', reject); });
const ca = fixture('test-only-cert.pem');

(async () => {
  const cases = [
    ['a country block page (403)', (req, res) => { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html><title>Attention Required!</title><h1>Sorry, you have been blocked</h1><p>You are unable to access roblox.com</p></html>'); }, 'region'],
    ['HTTP 451', (req, res) => { res.writeHead(451); res.end('Unavailable For Legal Reasons'); }, 'region'],
    ['an ordinary page', (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hello</html>'); }, null],
    ['a 403 that is not a block page (a login wall)', (req, res) => { res.writeHead(403); res.end('<html>Please sign in</html>'); }, null],
    ['a redirect', (req, res) => { res.writeHead(302, { location: '/login' }); res.end(); }, null],
    ['handshake, then silence', () => {}, 'stall'],
  ];
  for (const [what, handler, want] of cases) {
    const s = await server(handler);
    const got = await serviceCheck('test.local', 1, via(s.address().port), { timeoutMs: 2500, ca });
    s.close();
    if (s.closeAllConnections) s.closeAllConnections();
    t.ok(got === want, `${what}: ${JSON.stringify(got)}`);
  }
  // Nothing listening (the network, not the site): never blamed on the site.
  const dead = await serviceCheck('test.local', 1, () => Promise.reject(new Error('refused')), { timeoutMs: 1000, ca });
  t.ok(dead === null, 'unreachable: not reported as the site refusing');
  // A certificate that is not the site's (an interceptor): not the site's refusal either.
  const s = await server((req, res) => { res.writeHead(403); res.end('Sorry, you have been blocked'); });
  const wrong = await serviceCheck('other.example', 1, via(s.address().port), { timeoutMs: 2500, ca });
  s.close();
  if (s.closeAllConnections) s.closeAllConnections();
  t.ok(wrong === null, 'a certificate for another name: ignored');
  console.log(`servicecheck: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
