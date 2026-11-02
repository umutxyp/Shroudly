'use strict';

/* "Help people in censored countries" (electron/snowflake.js and its hidden
 * page, electron/snowflake/): what can be checked without a window (the
 * end-to-end test, tests/e2e/snowflake.test.js, drives the real thing):
 *   - only Tor's broker, its probe and its relays (wss) leave the hidden
 *     window, and the page's own two files; the test's stand-ins only when
 *     the test sets them
 *   - the page speaks Tor's protocol (poll 1.3 with a session id, the
 *     answer under the same one, the relay pattern) and takes a relay only
 *     on Tor's pattern
 *   - the window is sandboxed, without Node.js, never shown, and its page
 *     loads no code from anywhere (CSP: its own script only) */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const Snowflake = require(path.join(ROOT, 'electron', 'snowflake.js'));

(async () => {
  const t = suite('snowflake');
  const real = Snowflake.pageConfig();
  t.ok(real.broker === 'https://snowflake-broker.torproject.net/' && real.relayPattern === 'snowflake.torproject.net' && real.insecureRelay === false
    && real.probe === 'https://snowflake-broker.torproject.net:8443/probe' && real.pollMs === 60000,
  'Tor\'s broker, probe and relay pattern; no plain-ws relay; a poll a minute unless the broker says');
  const page = path.join(ROOT, 'electron', 'snowflake', 'proxy.html');
  const file = (p) => `file://${p.split(path.sep).join('/')}`;
  const A = (u, c = real) => Snowflake.allowedUrl(u, c);
  t.ok(A(file(page)) && A(file(path.join(ROOT, 'electron', 'snowflake', 'proxy.js')))
    && !A(file(path.join(ROOT, 'electron', 'main.js'))) && !A(file(path.join(ROOT, 'electron', 'snowflake-preload.js'))),
  'its own page and script load; no other file of the app');
  t.ok(A('https://snowflake-broker.torproject.net/proxy') && A('https://snowflake-broker.torproject.net/answer') && A('https://snowflake-broker.torproject.net:8443/probe'),
    'the broker and the NAT probe');
  t.ok(A('wss://snowflake.torproject.net/?client_ip=1.2.3.4') && A('wss://01.snowflake.torproject.net/'),
    'Tor\'s relays (wss)');
  t.ok(!A('ws://snowflake.torproject.net/') && !A('wss://snowflake.torproject.net.evil.example/') && !A('wss://evilsnowflake.torproject.net/')
    && !A('https://example.com/') && !A('http://127.0.0.1:9/') && !A('https://snowflake-broker.torproject.net.evil.example/') && !A('devtools://x') && !A('not a url'),
  'nothing else: plain ws, look-alike hosts, sites, local ports');
  const test = Snowflake.pageConfig({ test: { broker: 'http://127.0.0.1:5/', relay: 'ws://127.0.0.1:6/', relayPattern: '^127.0.0.1' } });
  t.ok(Snowflake.allowedUrl('ws://127.0.0.1:6/', test) && Snowflake.allowedUrl('http://127.0.0.1:5/proxy', test) && !Snowflake.allowedUrl('http://127.0.0.1:7/', test)
    && !A('ws://127.0.0.1:6/') && test.probe === null,
  'the test\'s stand-ins only under the test\'s settings');
  t.ok(Snowflake.pageConfig({ nat: 'restricted', natAt: 5 }).nat === 'restricted' && Snowflake.pageConfig({ nat: 'bogus' }).nat === null,
    'a NAT type found before is kept (two days), nothing else taken from the store');

  const js = fs.readFileSync(path.join(ROOT, 'electron', 'snowflake', 'proxy.js'), 'utf8');
  t.ok(/Version: '1\.3', Sid: id, Type: '', NAT: nat/.test(js) && /AcceptedRelayPattern: cfg\.relayPattern/.test(js)
    && /\{ Version: '1\.0', Sid: id, Answer: JSON\.stringify\(answer\) \}/.test(js) && /`\$\{cfg\.broker\}proxy`/.test(js) && /`\$\{cfg\.broker\}answer`/.test(js),
  'the page polls with version 1.3 and answers under the poll\'s session id, as Tor\'s proxy does');
  t.ok(/if \(offer && offer\.type === 'offer' && relayAllowed\(relay\)\)/.test(js) && /u\.protocol !== 'wss:'/.test(js),
    'a relay is taken only on Tor\'s pattern, over wss');
  t.ok(!/\beval\(|new Function|importScripts|innerHTML|document\.write/.test(js), 'no code made from strings, nothing written into the page');

  const html = fs.readFileSync(page, 'utf8');
  t.ok(/default-src 'none'; script-src 'self';/.test(html) && /<script src="proxy\.js"><\/script>/.test(html) && !/https?:\/\/[^"]*\.js/.test(html),
    'the page runs its own script only (CSP), none from anywhere else');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'snowflake.js'), 'utf8');
  t.ok(/show: false/.test(main) && /skipTaskbar: true/.test(main) && /sandbox: true, contextIsolation: true, nodeIntegration: false/.test(main)
    && /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/.test(main) && /will-navigate', \(e\) => e\.preventDefault\(\)/.test(main)
    && /setPermissionRequestHandler\(\(wc, perm, cb\) => cb\(false\)\)/.test(main) && /setProxy\(\{ mode: 'direct' \}\)/.test(main),
  'its window: hidden, sandboxed, no Node.js, no new windows, no navigation, no permissions, a direct session of its own');
  const pre = fs.readFileSync(path.join(ROOT, 'electron', 'snowflake-preload.js'), 'utf8');
  t.ok((pre.match(/ipcRenderer\.(invoke|send|on)\(/g) || []).length === 3 && /'snowflake:config'/.test(pre) && /'snowflake:report'/.test(pre) && /'snowflake:stop'/.test(pre),
    'its only link to the app: its settings, its counts, the word to stop');
  t.ok(/e\.sender !== this\.win\.webContents/.test(main) && (main.match(/e\.sender !== this\.win\.webContents/g) || []).length === 2,
    'and the app answers only that window on those channels');
  const mainJs = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  t.ok(/process\.env\.SHROUDLY_E2E === '1' && process\.env\.SHROUDLY_SNOWFLAKE_TEST/.test(mainJs) && /store\.get\('snowflakeOn'\) === true/.test(mainJs)
    && /if \(snowflake && snowflake\.on\) snowflake\.stop\(\)/.test(mainJs),
  'stand-ins only in the end-to-end test; on at start only when left on; stopped at quit');

  console.log(`snowflake: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
