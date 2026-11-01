'use strict';

/* "Only this country's network works" (electron/national-net.js): asked
 * once the world's control addresses answer nothing. A site inside the
 * country that completes a TLS handshake with its own valid certificate
 * says the country's network is up:
 *   - the first one that does answers, with its country
 *   - none resolving, none answering, or none in time: nothing (the window
 *     then says "No internet", as before)
 *   - a sign-in page (a hotel's, a cafe's) that every name resolves to, and
 *     that cannot show the sites' certificates, is not taken for the
 *     country's network: a real handshake to a server with a certificate
 *     not for that name fails
 *   - the window shows it with its own words and the guide in the user's
 *     language; the header says it short */

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { ROOT, suite } = require('./helpers');
const { domesticAnswers, DOMESTIC } = require(path.join(ROOT, 'electron', 'national-net.js'));
const { handshake } = require(path.join(ROOT, 'electron', 'blockcheck.js'));

const t = suite('national-net');

(async () => {
  const sites = { IR: ['www.digikala.com', 'www.aparat.com'], RU: ['ya.ru'] };
  const lookup = async (host) => (host === 'ya.ru' ? null : `10.0.0.${host.length}`);
  const hs = async ({ servername }) => (servername === 'www.aparat.com' ? 'ok' : 'timeout');
  const r = await domesticAnswers({ sites, lookup, hs, ms: 200 });
  t.ok(r && r.country === 'IR' && r.host === 'www.aparat.com', `a site inside the country answering with its own certificate: that country (${JSON.stringify(r)})`);

  t.ok(await domesticAnswers({ sites, lookup: async () => null, hs, ms: 200 }) === null, 'no name resolving: nothing');
  t.ok(await domesticAnswers({ sites, lookup, hs: async () => 'ECONNRESET', ms: 200 }) === null, 'none answering: nothing');
  const t0 = Date.now();
  t.ok(await domesticAnswers({ sites, lookup, hs: () => new Promise(() => {}), ms: 100 }) === null && Date.now() - t0 < 1500, 'none in time: nothing, and not waiting long');

  // A sign-in page: every name resolves to it, and it cannot show the
  // sites' certificates. The real handshake refuses it.
  const key = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-only-key.pem'));
  const cert = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-only-cert.pem'));
  const portal = tls.createServer({ key, cert }, (s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((res) => portal.once('listening', res));
  const port = portal.address().port;
  const viaPortal = ({ servername, ms }) => new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername });
    const timer = setTimeout(() => { s.destroy(); resolve('timeout'); }, ms);
    s.once('secureConnect', () => { clearTimeout(timer); s.destroy(); resolve('ok'); });
    s.once('error', (e) => { clearTimeout(timer); resolve(e.code || 'error'); });
  });
  t.ok(await domesticAnswers({ sites, lookup: async () => '127.0.0.1', hs: viaPortal, ms: 1000 }) === null,
    'a sign-in page that every name resolves to: its certificate is not the sites\', so not the country\'s network');
  portal.close();
  t.ok(typeof handshake === 'function' && /rejectUnauthorized: false/.test(fs.readFileSync(path.join(ROOT, 'electron', 'blockcheck.js'), 'utf8')) === false,
    'the handshake it uses checks certificates (nothing in blockcheck.js turns that off)');

  t.ok(Object.keys(DOMESTIC).includes('IR') && DOMESTIC.IR.length >= 3 && Object.values(DOMESTIC).every((l) => l.length && l.every((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h))),
    `countries with shutdowns listed (${Object.keys(DOMESTIC).join(' ')}), Iran with several sites`);

  // The Android app asks the same sites (NationalNet.kt).
  const kt = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly', 'NationalNet.kt'), 'utf8');
  const ktList = Object.fromEntries([...kt.matchAll(/"([A-Z]{2})" to listOf\(([^)]*)\)/g)].map((m) => [m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1])]));
  t.ok(JSON.stringify(ktList) === JSON.stringify(DOMESTIC), 'the Android app asks the same sites as the desktop');

  // The window.
  const panel = fs.readFileSync(path.join(ROOT, 'components', 'ControlPanel.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'app', 'page.js'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
  t.ok(/nationalOnly \? t\('nationalOnlyTitle'\)/.test(panel) && /t\('nationalOnlyBody'\)/.test(panel)
    && /wiki\/Shutdowns-\$\{language\}/.test(panel) && /nationalOnly \? t\('nationalOnlyShort'\)/.test(page)
    && ['nationalOnlyTitle', 'nationalOnlyShort', 'nationalOnlyBody', 'nationalOnlyHelp', 'logNationalOnly'].every((k) => en[k]),
  'the window says it in its own words, links the guide in the user\'s language, and the header says it short');

  console.log(`national-net: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
