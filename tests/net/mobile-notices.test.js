'use strict';

/* What phones, tablets and TVs say on their own (Android, iPhone, iPad, Mac
 * App Store, Apple TV). Covered:
 *   - a DNS profile, Private DNS or DNS app in the way (the engine's
 *     dns_around, tests/net/engine-dns-around.test.js): Android tells it in a
 *     notification that opens the network settings, on a TV on the screen,
 *     and in the window; the Apple apps in a card and a notification
 *   - just started: an app open from before may hold its old connections,
 *     said under the status for the first two minutes
 *   - their words in every language, each notice its own id */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const t = suite('mobile-notices');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const A = ['android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly'];

(async () => {
  const ev = read(...A, 'EngineEvent.kt');
  t.ok(/"dns_around" -> DnsAround\(str\("host"\) \?: ""\)/.test(ev), 'Android reads the engine\'s dns_around');
  for (const svc of ['ShroudlyVpnService.kt', 'ShroudlyProxyService.kt']) {
    t.ok(/is EngineEvent\.DnsAround -> DnsNotice\.around\(this\)/.test(read(...A, svc)), `Android ${svc}: told`);
  }
  const dn = read(...A, 'DnsNotice.kt');
  t.ok(/Protection\.dnsAround = true/.test(dn) && /if \(Tv\.isTv\(ctx\)\)[\s\S]{0,200}Toast\.makeText/.test(dn) && /ACTION_WIRELESS_SETTINGS/.test(dn) && /private const val ID = 13/.test(dn),
    'Android: on the screen on a TV, else a notification that opens the network settings (its own id)');
  const main = read(...A, 'MainActivity.kt');
  t.ok(/Protection\.dnsAround -> \{\s*detail\.show\(getString\(R\.string\.dnsAroundAndroid\)\)/.test(main), 'and in the window, until protection stops');
  t.ok(/elapsedRealtime\(\) - Protection\.startedAt < 120_000 -> \{\s*detail\.show\(getString\(R\.string\.reopenAppsHint\)\)/.test(main), 'Android: the first two minutes, apps open from before');

  const eng = read('apple', 'Tunnel', 'Engine.swift');
  const ptp = read('apple', 'Tunnel', 'PacketTunnelProvider.swift');
  const cv = read('apple', 'App', 'ContentView.swift');
  const tc = read('apple', 'App', 'TunnelController.swift');
  t.ok(/case "dns_around":[\s\S]{0,80}onDnsAround\?\(/.test(eng) && /e\.onDnsAround = /.test(ptp) && /if dnsAround \{ out\["dnsAround"\] = true \}/.test(ptp),
    'Apple: the tunnel reads it and tells the app');
  t.ok(/controller\.dnsAround \{\s*\/\/[^\n]*\n\s*Warning\(title: tr\("dnsAroundTitle"\), text: tr\("dnsAroundApple"\)\)/.test(cv) && /AppGroup\.defaults\.set\(tr\("dnsAroundApple"\), forKey: "dnsAroundText"\)/.test(tc),
    'a card in the app, and a notification in its words');
  t.ok(/timeIntervalSince\(since\) < 120[\s\S]{0,120}return tr\("reopenAppsHint"\)/.test(cv), 'Apple: the first two minutes, apps open from before');

  const langs = fs.readdirSync(path.join(ROOT, 'locales')).filter((f) => f.endsWith('.json'));
  const bad = langs.filter((f) => { const d = JSON.parse(read('locales', f)); return ['dnsAroundAndroid', 'dnsAroundApple', 'dnsAroundTitle', 'reopenAppsHint'].some((k) => !String(d[k] || '').trim()); });
  t.ok(!bad.length, `in all ${langs.length} languages${bad.length ? ` (missing: ${bad.join(', ')})` : ''}`);

  console.log(`mobile-notices: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
