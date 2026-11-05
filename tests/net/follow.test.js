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

  const info = read('components', 'InfoPanel.js');
  t.ok(/import FOLLOW from '\.\/follow\.json'/.test(info) && /<FollowSection \/>/.test(info), 'desktop: About shows it');
  const layout = read('android', 'app', 'src', 'main', 'res', 'layout', 'activity_main.xml');
  const main = read('android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly', 'MainActivity.kt');
  const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  t.ok(/@\+id\/followRow/.test(layout) && /R\.id\.followRow\)\.setOnClickListener \{ startActivity\(android\.content\.Intent\(this, FollowActivity::class\.java\)\) \}/.test(main)
    && /android:name="\.FollowActivity"/.test(manifest), 'Android: a row in About opens the page');
  t.ok(/if \(tv\) root\.addView\(label\(13f, R\.color\.text_dim\)\.apply \{ setText\(R\.string\.followTv\)/.test(kt) && /ActivityNotFoundException/.test(kt),
    'Android TV: the addresses shown in full, and a tap with nothing to open it says the address');
  t.ok(/NavigationLink \{\s*FollowView\(\)/.test(sw) && /#if os\(tvOS\)\s*Text\(tr\("followTv"\)\)/.test(sw), 'Apple: About opens it; Apple TV says to open them elsewhere');

  const keys = ['followTitle', 'followDesc', 'followCodeshare', 'followDeveloper', 'followTv'];
  const langs = fs.readdirSync(path.join(ROOT, 'locales')).filter((f) => f.endsWith('.json'));
  const missing = langs.filter((f) => { const d = JSON.parse(read('locales', f)); return keys.some((k) => !d[k] || !String(d[k]).trim()); });
  t.ok(!missing.length && langs.length === 31, `its words in all ${langs.length} languages${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

  console.log(`follow: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
