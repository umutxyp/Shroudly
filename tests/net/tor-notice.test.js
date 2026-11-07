'use strict';

/* Tor is the last of all ways, and the user is told when it is used.
 * Covered:
 *   - desktop: a site that only the last way out opened is said in a
 *     notification and a line in the window (torUsedDesktop), once per site
 *     a session and at most once every 15 minutes; Advanced mode coming on
 *     makes the engine forget the names Tor carried (FALLBACK-FORGET), so
 *     they try it first
 *   - Android: a notification on a phone or tablet (torUsedPhone), a message
 *     on the screen on a TV (torUsedTv), from both the VPN and Proxy only,
 *     said again after a new start
 *   - the Mac App Store app: a notification from the tunnel in the app's
 *     words, with the system's permission asked by the app
 *   - the words in every language, naming the site */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const t = suite('tor-notice');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

(async () => {
  const main = read('electron', 'main.js');
  t.ok(/if \(kind === 'fallback'\) torUsed\(host\);/.test(main), 'desktop: the engine\'s "fallback" event is told');
  const fn = main.slice(main.indexOf('function torUsed('), main.indexOf('function advancedState('));
  t.ok(/torTold\.has\(h\)/.test(fn) && /now - torToldAt < TOR_TELL_MS/.test(fn) && /const TOR_TELL_MS = 15 \* 60 \* 1000/.test(main) && /autoTell\('torUsedDesktop', \{ host: h \}\)/.test(fn),
    'once per site a session, at most every 15 minutes, as a notification and a line in the window');
  t.ok(/if \(active && engine\) \{ try \{ engine\.forgetFallback\(\); \} catch \{\} \}/.test(main) && /forgetFallback\(\) \{ return this\._command\('FALLBACK-FORGET'\); \}/.test(read('electron', 'engine-manager.js')),
    'Advanced mode on: the names Tor carried go back to the techniques first');
  t.ok(/"FALLBACK-FORGET"\)\) engine_fallback_forget\(\)/.test(read('core', 'src', 'main.c')), 'the engine takes FALLBACK-FORGET (tests/net/engine-fallback.test.js tries it)');

  const dir = ['android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly'];
  const tn = read(...dir, 'TorNotice.kt');
  t.ok(/if \(Tv\.isTv\(ctx\)\)[\s\S]{0,200}R\.string\.torUsedTv[\s\S]{0,300}Toast\.makeText/.test(tn) && /R\.string\.torUsedPhone[\s\S]{0,300}ALERT_CHANNEL/.test(tn),
    'Android: a message on the screen on a TV, a notification on a phone');
  for (const svc of ['ShroudlyVpnService.kt', 'ShroudlyProxyService.kt']) {
    const s = read(...dir, svc);
    t.ok(/if \(ev\.host\.isNotEmpty\(\)\) TorNotice\.used\(this, ev\.host\)/.test(s) && /torRoute\.(stop|linger)\(\)\r?\n\s+TorNotice\.reset\(\)/.test(s), `Android ${svc}: told, and again after a new start`);
  }

  const tr = read('apple', 'Tunnel', 'TorRoute.swift');
  const tp = read('apple', 'Tunnel', 'PacketTunnelProvider.swift');
  const tc = read('apple', 'App', 'TunnelController.swift');
  t.ok(/enum TorNotice/.test(tr) && /UNUserNotificationCenter\.current\(\)\.add/.test(tr) && /TorNotice\.used\(what\)/.test(tp),
    'Mac: the tunnel posts a notification when Tor carried a site');
  t.ok(/AppGroup\.defaults\.set\(tr\("torUsedDesktop"\), forKey: "torUsedText"\)/.test(tc) && /requestAuthorization/.test(tc) && /static let textKey = "torUsedText"/.test(tr),
    'in the app\'s words, with the permission the app asks for');

  const langs = fs.readdirSync(path.join(ROOT, 'locales')).filter((f) => f.endsWith('.json'));
  const bad = langs.filter((f) => { const d = JSON.parse(read('locales', f)); return ['torUsedDesktop', 'torUsedPhone', 'torUsedTv'].some((k) => !/\{host\}/.test(d[k] || '') || !/Tor/.test(d[k])); });
  t.ok(!bad.length, `in all ${langs.length} languages, naming the site and Tor${bad.length ? ` (bad: ${bad.join(', ')})` : ''}`);

  console.log(`tor-notice: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
