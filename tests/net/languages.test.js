'use strict';

/* Which language the system's own leads to (electron/main-i18n.js and
 * contexts/LanguageContext.js, which must agree), and right-to-left text in
 * system notifications:
 *   - Windows' Dari (prs-AF) is Persian, not English (i18n-v02)
 *   - Kurdish in Arabic script (Sorani) is not given our Latin Kurmanji: the
 *     next language the system lists is
 *   - an Arabic, Persian, Hebrew, Urdu or Pashto notification starts right
 *     to left, with each site, version or name in it isolated (i18n-04) */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');
const I = require(path.join(ROOT, 'electron', 'main-i18n.js'));

const t = suite('languages');

t.ok(I.resolveLanguage(null, ['prs-AF']) === 'fa' && I.resolveLanguage(null, ['fa-IR']) === 'fa', "Windows' Dari is Persian");
t.ok(I.resolveLanguage(null, ['ku-Arab-IQ', 'ar-IQ']) === 'ar' && I.resolveLanguage(null, ['ku-Arab-IQ']) === 'en'
  && I.resolveLanguage(null, ['ku-Latn-TR']) === 'ku' && I.resolveLanguage(null, ['ku']) === 'ku',
  'Kurdish in Arabic script goes on to the next language; Latin Kurmanji stays Kurmanji');
t.ok(I.resolveLanguage(null, ['in-ID']) === 'id' && I.resolveLanguage(null, ['iw']) === 'he' && I.resolveLanguage('tr', ['de-DE']) === 'tr',
  'older tags still mapped, and a choice of the user\'s comes first');

// The window's rule is the same: the tables and the Sorani line match.
const ui = fs.readFileSync(path.join(ROOT, 'contexts', 'LanguageContext.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'electron', 'main-i18n.js'), 'utf8');
const table = (src) => (src.match(/const ALIASES = (\{[^}]*\});/) || [])[1];
t.ok(table(ui) && table(ui) === table(main) && /ku\[-_\]arab/.test(ui) && /ku\[-_\]arab/.test(main), 'the window and the tray resolve languages the same way');

// Right to left in a system notification.
const ar = I.bidi('لم يُفتح discord.com بأي أسلوب. الإصدار 2.6.44', 'ar');
t.ok(ar.startsWith('‏') && ar.includes('⁨discord.com⁩') && ar.includes('⁨2.6.44⁩'),
  'Arabic: starts right to left, the site and the version isolated');
t.ok(I.bidi('discord.com did not open', 'en') === 'discord.com did not open' && I.bidi('', 'fa') === '' && I.bidi(null, 'he') === null,
  'other languages, and nothing, as they are');
t.ok(/i18n\.bidi\(title, lang\)/.test(fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8')), 'every notification goes through it');

console.log(`languages: ${t.count} passed`);
process.exit(0);
