'use strict';

/* Follow Shroudly: Codeshare's accounts and its developer's, on every
 * platform. Covered:
 *   - the desktop's list (components/follow.json) is the one Android
 *     (FollowActivity.kt) and the Apple apps (AboutView.swift) carry, in
 *     the same order
 *   - every address is https, and none is a private address (the public
 *     contact is contact@codeshare.me, never a personal mailbox)
 *   - each app shows it: the desktop's About, Android's About row and page,
 *     the Apple apps' About; a TV shows the addresses to open elsewhere
 *   - its words are in every language */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const t = suite('follow');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const F = JSON.parse(read('components', 'follow.json'));

(async () => {
  const all = [...F.codeshare, ...F.developer];
  t.ok(F.codeshare.length >= 5 && F.developer.length >= 5, `two groups (${F.codeshare.length} and ${F.developer.length})`);
  t.ok(all.every((l) => /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(l.url) || /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(l.url)), 'every address is https');
  t.ok(!all.some((l) => /mailto:|gmail|@codeshare\.me/i.test(l.url)), 'no mailbox among them');

  const kt = read('android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly', 'FollowActivity.kt');
  const sw = read('apple', 'App', 'AboutView.swift');
  const ktList = (name) => [...kt.split(`val ${name} = listOf(`)[1].split('\n        )')[0].matchAll(/Link\("([^"]+)", "([^"]+)", "([^"]+)"\)/g)].map((m) => ({ name: m[1], handle: m[2], url: m[3] }));
  const swList = (name) => [...sw.split(`static let ${name}: [Account] = [`)[1].split('\n    ]')[0].matchAll(/Account\(name: "([^"]+)", handle: "([^"]+)", url: "([^"]+)"\)/g)].map((m) => ({ name: m[1], handle: m[2], url: m[3] }));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  t.ok(same(ktList('CODESHARE'), F.codeshare) && same(ktList('DEVELOPER'), F.developer), 'Android carries the same list, in the same order');
  t.ok(same(swList('codeshare'), F.codeshare) && same(swList('developer'), F.developer), 'the Apple apps carry the same list, in the same order');
  // The developer's accounts first everywhere: news, new versions and urgent
  // notices are posted there; Codeshare's accounts come after.
  const ip = read('components', 'InfoPanel.js');
  const before = (text, a, b) => text.indexOf(a) >= 0 && text.indexOf(a) < text.indexOf(b);
  t.ok(Object.keys(F)[0] === 'developer' && before(ip, "t('followDeveloper')", "t('followCodeshare')")
    && before(kt, 'R.string.followDeveloper), DEVELOPER', 'R.string.followCodeshare), CODESHARE')
    && before(sw, 'Section(tr("followDeveloper"))', 'Section(tr("followCodeshare"))'),
    'the developer\'s accounts come first on every device, Codeshare\'s after');

  const info = read('components', 'InfoPanel.js');
  const page = read('app', 'page.js');
  t.ok(/import FOLLOW from '\.\/follow\.json'/.test(info) && /\{ id: 'follow', +label: t\('navFollow'\)/.test(page) && /activeTab === 'follow' +&& <div[^>]*><FollowSection \/><\/div>/.test(page) && /grid-cols-6/.test(page),
    'desktop: a tab of its own');
  const layout = read('android', 'app', 'src', 'main', 'res', 'layout', 'activity_main.xml');
  const main = read('android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly', 'MainActivity.kt');
  const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  t.ok(/@string\/navFollow" \/>\s*<LinearLayout[\s\S]{0,400}@\+id\/followRow/.test(layout) && !/@\+id\/about"[\s\S]{0,300}followRow/.test(layout)
    && /@\+id\/followRow/.test(layout) && /R\.id\.followRow\)\.setOnClickListener \{ startActivity\(android\.content\.Intent\(this, FollowActivity::class\.java\)\) \}/.test(main)
    && /android:name="\.FollowActivity"/.test(manifest), 'Android: a section of its own on the main screen opens the page');
  t.ok(/if \(tv\) root\.addView\(label\(13f, R\.color\.text_dim\)\.apply \{ setText\(R\.string\.followTv\)/.test(kt) && /ActivityNotFoundException/.test(kt),
    'Android TV: the addresses shown in full, and a tap with nothing to open it says the address');
  const cv = read('apple', 'App', 'ContentView.swift');
  // iPhone, iPad and Mac: one of the desktop's tabs at the bottom, before
  // About; Apple TV: one of the system's tabs along the top, and it says to
  // open them elsewhere.
  t.ok(/case protection, stats, settings, logs, follow, about/.test(cv) && /case \.follow: FollowView\(\)/.test(cv)
    && /NavigationStack \{ FollowView\(\)[^}]*\}\s*\.tabItem \{ Image\(systemName: "person\.2"\)\.accessibilityLabel\(tr\("navFollow"\)\) \}/.test(cv)
    && /#if os\(tvOS\)[\s\S]{0,200}Text\(tr\("followTv"\)\)/.test(sw),
    'Apple: a tab of its own beside About; Apple TV says to open them elsewhere');

  const keys = ['navFollow', 'followTitle', 'followDesc', 'followCodeshare', 'followDeveloper', 'followTv'];
  const langs = fs.readdirSync(path.join(ROOT, 'locales')).filter((f) => f.endsWith('.json'));
  const missing = langs.filter((f) => { const d = JSON.parse(read('locales', f)); return keys.some((k) => !d[k] || !String(d[k]).trim()); });
  t.ok(!missing.length && langs.length === 31, `its words in all ${langs.length} languages${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

  console.log(`follow: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
