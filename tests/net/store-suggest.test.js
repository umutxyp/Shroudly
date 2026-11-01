'use strict';

/* The Mac copy from GitHub suggesting the Mac App Store one
 * (electron/store-suggest.js):
 *   - only while stores.json says it is live, with an App Store address, in
 *     this Mac's country (countries, less exclude), and never on a file
 *     that could not be read or a country not known
 *   - at most twice, 30 days apart; "Open the App Store" or a second
 *     "Not now" ends it; a clock set back shows nothing early
 *   - never in the App Store's own copy, off macOS, or unpackaged */

const path = require('path');
const { ROOT, suite } = require('./helpers');
const { StoreSuggest, availableIn, due, GAP_MS } = require(path.join(ROOT, 'electron', 'store-suggest.js'));

const t = suite('store-suggest');
const URL = 'https://apps.apple.com/app/id6700000000';
const live = (more = {}) => ({ live: true, url: URL, countries: ['*'], exclude: [], ...more });

t.ok(availableIn(live(), 'tr') && availableIn(live({ countries: ['TR', 'DE'] }), 'DE') && availableIn({ live: true, url: URL }, 'US'),
  'live, here: "*", a list with this country, or the older file without lists');
t.ok(!availableIn(live({ exclude: ['CN'] }), 'cn') && !availableIn(live({ countries: ['DE'] }), 'TR'),
  'taken down here (exclude), or not listed here: nothing');
t.ok(!availableIn(live(), '') && !availableIn(live(), 'Turkey') && !availableIn(null, 'TR') && !availableIn({ ...live(), live: false }, 'TR')
  && !availableIn({ ...live(), url: '' }, 'TR') && !availableIn({ ...live(), url: 'http://example.com' }, 'TR'),
  'a country not known, a file not read, not live yet, or no App Store address: nothing');

t.ok(due(null, 1) && due({ shown: 1, at: 100 }, 100 + GAP_MS) && !due({ shown: 1, at: 100 }, 100 + GAP_MS - 1),
  'first time at once; the second 30 days after the first');
t.ok(!due({ shown: 2, at: 1 }, 10 * GAP_MS) && !due({ shown: 1, at: 1, done: true }, 10 * GAP_MS) && !due({ shown: 1, at: 5 * GAP_MS }, GAP_MS),
  'never a third time, never after "Open", never early with the clock set back');

(async () => {
  const mem = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
  let now = 1000;
  let fetches = 0;
  let file = { macAppStore: live() };
  const make = (o = {}) => new StoreSuggest({ store: mem(), fetchJson: async () => { fetches++; if (file instanceof Error) throw file; return file; }, country: () => 'TR', platform: 'darwin', now: () => now, ...o });

  const s = make();
  t.ok((await s.pending()).url === URL, 'the GitHub copy on a Mac in a country where it is live: suggested');
  s.shown(); s.answered(false);
  t.ok(await s.pending() === null, '"Not now": not again soon');
  now += GAP_MS;
  t.ok((await s.pending()).url === URL && fetches === 2, '30 days on: once more (the file asked again, its answer being old)');
  s.shown(); s.answered(false);
  now += 10 * GAP_MS;
  t.ok(await s.pending() === null, 'after the second "Not now": never again');

  const o = make(); await o.pending(); o.shown(); o.answered(true); now += 10 * GAP_MS;
  t.ok(await o.pending() === null, '"Open the App Store": done for good');

  file = new Error('offline');
  t.ok(await make().pending() === null, 'the file could not be read: nothing');
  file = { macAppStore: live() };
  t.ok(await make({ mas: true }).pending() === null && await make({ platform: 'win32' }).pending() === null
    && await make({ packaged: false }).pending() === null && await make({ country: () => { throw new Error('no region'); } }).pending() === null,
  "the App Store's own copy, Windows, a copy run from source, or no region: nothing");

  // Wired in: main.js answers the window, which shows it last of all.
  const fs = require('fs');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const notice = fs.readFileSync(path.join(ROOT, 'components', 'BlockedNotice.js'), 'utf8');
  const stores = JSON.parse(fs.readFileSync(path.join(ROOT, 'stores.json'), 'utf8'));
  t.ok(/ipcMain\.handle\('app:storeSuggest'/.test(main) && /app\.getLocaleCountryCode\(\)/.test(main) && /storeSuggestAnswer/.test(notice)
    && notice.indexOf("t('masTitle')") > notice.indexOf("t('cutTitle'"), 'wired in, and shown only when no other notice is');
  t.ok(stores.macAppStore && stores.macAppStore.live === false && Array.isArray(stores.macAppStore.exclude),
    'stores.json: the Mac App Store copy not live yet, with its country lists');
  console.log(`store-suggest: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
