const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sourceDirs = ['app', 'components', 'contexts'];
const usedKeys = new Set();
let allSource = '';

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
      continue;
    }

    const source = fs.readFileSync(fullPath, 'utf8');
    allSource += source + '\n';
    // t('key') and t('key', { params })
    for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]\s*[,)]/g)) {
      usedKeys.add(match[1]);
    }
    // keys referenced indirectly via lookup tables, e.g. labelKey: 'stratAuto' or 'logCleared'
    for (const match of source.matchAll(/(?:labelKey|key):\s*['"]([A-Za-z_]\w*)['"]/g)) {
      usedKeys.add(match[1]);
    }
  }
}

for (const dir of sourceDirs) {
  walk(path.join(root, dir));
}

// One file per language, locales/<code>.json: the same keys in every one.
const localeDir = path.join(root, 'locales');
const translations = {};
for (const file of fs.readdirSync(localeDir).sort()) {
  if (!file.endsWith('.json')) continue;
  const code = file.slice(0, -5);
  if (!/^[a-z]{2,3}$/.test(code)) { console.error(`locales/${file}: not a language code`); process.exitCode = 1; continue; }
  try {
    const strings = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));
    const bad = Object.entries(strings).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
    if (bad.length) { console.error(`locales/${file}: not text: ${bad.join(', ')}`); process.exitCode = 1; }
    translations[code] = strings;
  } catch (e) {
    console.error(`locales/${file}: ${e.message}`);
    process.exitCode = 1;
  }
}
if (!translations.en) { console.error('locales/en.json is missing'); process.exit(1); }

// Every language offered in Settings has a file, and every file is offered.
const offered = [...fs.readFileSync(path.join(root, 'contexts', 'LanguageContext.js'), 'utf8').matchAll(/\{ code: '([a-z]{2,3})'/g)].map((m) => m[1]);
for (const code of offered) if (!translations[code]) { console.error(`${code}: offered in Settings but locales/${code}.json is missing`); process.exitCode = 1; }
for (const code of Object.keys(translations)) if (!offered.includes(code)) { console.error(`locales/${code}.json: not offered in Settings (contexts/LanguageContext.js)`); process.exitCode = 1; }

// The main process uses the tray*, notify* and discordPick* keys (tr().key).
for (const file of fs.readdirSync(path.join(root, 'electron'))) {
  if (!file.endsWith('.js')) continue;
  const source = fs.readFileSync(path.join(root, 'electron', file), 'utf8');
  allSource += source + '\n';
  for (const match of source.matchAll(/\b(?:tr\(\)|s)\.((?:tray|notify|discordPick)[A-Z]\w*)/g)) usedKeys.add(match[1]);
}

const languages = Object.keys(translations);
const englishKeys = Object.keys(translations.en || {});
let failed = false;

for (const language of languages) {
  const languageKeys = translations[language] || {};
  const missingUsed = [...usedKeys].filter((key) => !(key in languageKeys));
  const missingEnglish = englishKeys.filter((key) => !(key in languageKeys));

  if (missingUsed.length || missingEnglish.length) {
    failed = true;
    console.error(`${language}: missing used keys=${missingUsed.join(', ') || '-'}, missing en keys=${missingEnglish.join(', ') || '-'}`);
  } else {
    console.log(`${language}: ok (${Object.keys(languageKeys).length} keys)`);
  }
}

// Stale keys: defined in English but never referenced as a string anywhere in
// the UI sources (warning only — keys can be referenced through lookup tables).
const unused = englishKeys.filter((key) => !usedKeys.has(key) && !allSource.includes(`'${key}'`) && !allSource.includes(`"${key}"`));
if (unused.length) console.warn(`warning: possibly unused keys: ${unused.join(', ')}`);

if (failed || process.exitCode) {
  process.exit(1);
}

console.log(`Translation check passed: ${languages.length} languages, ${usedKeys.size} UI keys.`);
