#!/usr/bin/env node
/*
 * translations.js stays the one file people edit (and the one
 * check-translations.js reads). The window, though, only ever needs English
 * and the language in use, so this writes each language to locales/<code>.json
 * before every build; contexts/LanguageContext.js loads them one at a time
 * instead of parsing all 31 (about 1 MB) on every start. Generated, not
 * committed.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const out = path.join(root, 'locales');

let src = fs.readFileSync(path.join(root, 'translations.js'), 'utf8');
src = src.replace(/export\s+const\s+translations\s*=/, 'const translations =') + '\nmodule.exports = translations;';
const ctx = { module: { exports: null } };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const all = ctx.module.exports;
if (!all || !all.en) throw new Error('translations.js: no English strings found');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [code, strings] of Object.entries(all)) {
  if (!/^[a-z]{2,3}$/.test(code)) throw new Error(`translations.js: unexpected language code "${code}"`);
  fs.writeFileSync(path.join(out, `${code}.json`), JSON.stringify(strings));
}
console.log(`[i18n] ${Object.keys(all).length} languages written to locales/`);
