'use strict';

/* The background process writes its log in English and the window shows it
 * in the user's language. Every line the network features write must reach a
 * translation, and every language must carry the same placeholders, or a
 * Persian or Russian user sees English or a raw "{host}". */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ROOT, suite } = require('./helpers');

const t = suite('logtext');

// logText.js is an ES module for the web UI; load it as CommonJS here.
function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/export (const|function) /g, '$1 ').replace(/^import .*$/gm, '');
  const names = [...src.matchAll(/^(?:const|function) (\w+)/gm)].map((m) => m[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-lt-'));
  const f = path.join(dir, 'm.js');
  fs.writeFileSync(f, `${src}\nmodule.exports = { ${names.join(', ')} };`);
  try { return require(f); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const translations = {};
for (const f of fs.readdirSync(path.join(ROOT, 'locales')).filter((x) => x.endsWith('.json'))) {
  translations[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', f), 'utf8'));
}
const { localizeLog } = load('components/logText.js');

const LINES = [
  'discord.com: connects, then the network cuts it (stall after 5 KB). This network filters whole connections; Shroudly is trying other techniques for it.',
  'DNS answers on this network match the filtering used in IR.',
  "Your DNS service filters sites; Shroudly's encrypted DNS goes around it.",
  'Encrypted DNS answering via cloudflare-1 23ms, google-1 31ms',
  'The other VPN or bypass tool is no longer running.',
  'Cloudflare WARP is installed but not connected; that does not interfere.',
  'Port 10808 is in use by another program; Shroudly is using 10809 instead.',
  'discord.com could not be opened with encrypted DNS switched off. It has been switched back on.',
  'Discord app mode on: Discord updates through Shroudly',
  'Discord app mode off: Discord settings restored',
  // Bypass and block lines keep translating when the engine adds that the
  // network dropped the attempts silently, and the auto-mode label still fits.
  'discord.com: blocked here, opened with tlsrec-sni (2 tries, ipv4)',
  'discord.com: blocked here, opened with tlsrec-sni (2 tries, ipv4) — the network drops these connections silently instead of refusing them',
  'discord.com: still blocked after 5 techniques (ipv4) — this network may need Advanced mode',
  'discord.com: no answer after 5 techniques (ipv4) — the network may be dropping these connections silently, or the site is down',
  'Shroudly engine active (strategy: auto, 16 techniques)',
  'Settings applied (strategy: auto, 16 techniques)',
];

const langs = Object.keys(translations);
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const line of LINES) {
  const outs = langs.map((l) => localizeLog(line, (k, p) => {
    let v = translations[l][k];
    if (v === undefined) return `MISSING:${k}`;
    for (const [a, b] of Object.entries(p || {})) v = v.split(`{${a}}`).join(b);
    return v;
  }));
  const bad = outs.map((o, i) => [langs[i], o]).filter(([l, o]) => (l !== 'en' && o === line) || /MISSING:|\{\w+\}/.test(o));
  t.ok(!bad.length, bad.length ? `untranslated: "${line.slice(0, 50)}" in ${bad.map((b) => b[0]).join(' ')}` : `translated in all ${langs.length}: ${line.slice(0, 60)}…`);
}
// Placeholders match English in every language, for every key.
const mism = [];
for (const k of Object.keys(translations.en)) for (const l of langs) if (ph(translations[l][k]) !== ph(translations.en[k])) mism.push(`${l}.${k}`);
t.ok(!mism.length, mism.length ? `placeholder mismatch: ${mism.slice(0, 10).join(', ')}` : `placeholders identical across ${langs.length} languages for all ${Object.keys(translations.en).length} keys`);
console.log(`logtext: ${t.count} passed`);
