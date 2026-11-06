'use strict';

/* Tor is slow: the user says yes before it first starts (issue #77).
 * Covered:
 *   - desktop: the engine asking for the last way out (fallback ok:0) asks
 *     the user instead of starting Tor until they said yes; once yes, Tor
 *     starts; with the last way out turned off nothing happens; the Tor
 *     toggle turned on by hand counts as yes; the answer from the window's
 *     card (yes starts Tor and is kept, no turns it off), a notification at
 *     most every 30 minutes, never a window of its own
 *   - Android: the services ask (TorAsk) unless allowed; a notification on a
 *     phone, a message on the screen on a TV; the main screen's card with
 *     "Use Tor" and "No"; Settings' switch is the user's yes
 *   - the Mac App Store app: the tunnel asks unless allowed, the app's card
 *     answers it (torYes), Settings' toggle is the user's yes
 *   - the words in every language */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');
const EngineManager = require('../../electron/engine-manager');

const t = suite('tor-ask');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

(async () => {
  // The desktop's EngineManager, as main.js runs it.
  const mem = {};
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; }, delete: (k) => { delete mem[k]; } };
  const asked = [];
  let needs = 0;
  const tor = { need: () => { needs++; }, stop: () => {}, status: () => ({ state: 'off' }), noteUse: () => {} };
  const em = new EngineManager(store, { torRoute: tor, onTorAsk: (h) => asked.push(h) });
  em._torFile = '/tmp/tor-route.txt';
  const fallback = (host) => em._onLine(JSON.stringify({ type: 'fallback', ok: 0, why: 'does not answer', host }));

  fallback('x.com');
  t.ok(asked.join() === 'x.com' && needs === 0, 'not yet allowed: the user is asked about the site, Tor does not start');
  store.set('torApproved', true);
  fallback('y.com');
  t.ok(needs === 1 && asked.length === 1, 'allowed: Tor starts, nothing asked');
  store.set('torLastResort', false);
  fallback('z.com');
  t.ok(needs === 1 && asked.length === 1, 'the last way out turned off: neither');
  store.set('torLastResort', true); store.set('torApproved', false);
  em._onLine(JSON.stringify({ type: 'fallback', ok: 0, why: 'file unusable' }));
  t.ok(needs === 1 && asked.length === 1, 'an unusable file asks nothing');

  const main = read('electron', 'main.js');
  const ask = main.slice(main.indexOf('function askTor('), main.indexOf('function torUsed('));
  t.ok(/const TOR_ASK_MS = 30 \* 60 \* 1000/.test(main) && /now - torAskedAt >= TOR_ASK_MS/.test(ask) && /notifyAuto\(text\)/.test(ask) && !/showWindow\(|new BrowserWindow|dialog\./.test(ask),
    'desktop: a notification at most every 30 minutes, no window of its own');
  t.ok(/store\.set\('torApproved', true\)[\s\S]{0,200}engine\.tor\.need\(\)/.test(ask) && /store\.set\('torLastResort', false\)[\s\S]{0,200}scheduleEngineRestart\(\)/.test(ask),
    'yes starts Tor and is kept; no turns the last way out off');
  t.ok(/if \(key === 'torLastResort'\) \{ store\.set\('torApproved', value === true\)/.test(main) && /onTorAsk: \(host\) => askTor\(host\)/.test(main) && /torAsk: \(engine && engine\.isActive\(\) && torAsk/.test(main),
    'the toggle by hand is the user\'s yes; the window is told what is asked');
  const cp = read('components', 'ControlPanel.js');
  t.ok(/data-tor-ask/.test(cp) && /answerTor\(true\)/.test(cp) && /answerTor\(false\)/.test(cp) && /t\('torAskYes'\)/.test(cp) && /t\('torAskNo'\)/.test(cp)
    && /answerTor: \(yes\) => ipcRenderer\.invoke\('tor:answer', yes === true\)/.test(read('electron', 'preload.js')),
    'the window\'s card: "Use Tor" and "No"');

  const dir = ['android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly'];
  const ta = read(...dir, 'TorAsk.kt');
  t.ok(/if \(Tv\.isTv\(ctx\)\)[\s\S]{0,300}Toast\.makeText/.test(ta) && /R\.string\.torAskNotice/.test(ta) && /ALERT_CHANNEL/.test(ta) && /EVERY_MS = 30 \* 60 \* 1000L/.test(ta),
    'Android: a notification on a phone, a message on the screen on a TV, at most every 30 minutes');
  for (const svc of ['ShroudlyVpnService.kt', 'ShroudlyProxyService.kt']) {
    const s = read(...dir, svc);
    t.ok(/if \(TorRoute\.approved\(this\)\) torRoute\.need\(\) else TorAsk\.ask\(this, ev\.host\)/.test(s) && /"torYes"/.test(s) && /TorAsk\.reset\(\)/.test(s),
      `Android ${svc}: asks unless allowed, starts Tor on yes, asks again after a new start`);
  }
  const ma = read(...dir, 'MainActivity.kt');
  t.ok(/R\.id\.torAskYes[\s\S]{0,200}TorRoute\.setApproved\(this, true\)[\s\S]{0,200}"torYes"/.test(ma) && /R\.id\.torAskNo[\s\S]{0,200}TorRoute\.setEnabled\(this, false\)/.test(ma)
    && /android:id="@\+id\/torAskCard"/.test(read('android', 'app', 'src', 'main', 'res', 'layout', 'activity_main.xml')),
    'Android: the main screen\'s card answers it');
  t.ok(/putBoolean\("torLastResort", on\)\.putBoolean\("torApproved", on\)/.test(read(...dir, 'TorRoute.kt')), 'Android: Settings\' switch is the user\'s yes');

  const tp = read('apple', 'Tunnel', 'PacketTunnelProvider.swift');
  const tc = read('apple', 'App', 'TunnelController.swift');
  t.ok(/if TorNotice\.approved\(\) \{ self\.torRoute\.need\(\) \}/.test(tp) && /TorNotice\.ask\(host\)/.test(tp) && /case \.torYes:/.test(tp) && /out\["torAsk"\] = a/.test(tp),
    'Mac: the tunnel asks unless allowed, and starts Tor on the app\'s yes');
  t.ok(/func answerTor\(_ yes: Bool\)/.test(tc) && /ProviderMessage\.torYes/.test(tc) && /new\.torLastResort = false/.test(tc)
    && /TorAskCard\(/.test(read('apple', 'App', 'ContentView.swift'))
    && /if old\.torLastResort != new\.torLastResort \{ AppGroup\.defaults\.set\(new\.torLastResort, forKey: "torApproved"\) \}/.test(read('apple', 'App', 'SettingsView.swift')),
    'Mac: the app\'s card answers it; Settings\' toggle is the user\'s yes');

  const langs = fs.readdirSync(path.join(ROOT, 'locales')).filter((f) => f.endsWith('.json'));
  const bad = langs.filter((f) => {
    const d = JSON.parse(read('locales', f));
    return ['torAskTitle', 'torAskNotice', 'torAskCard'].some((k) => !/\{host\}/.test(d[k] || '') || !/Tor/.test(d[k]))
      || ['torAskYes', 'torAskNo', 'lastResortAsks'].some((k) => !d[k]);
  });
  t.ok(!bad.length, `in all ${langs.length} languages${bad.length ? ` (bad: ${bad.join(', ')})` : ''}`);

  console.log(`tor-ask: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
