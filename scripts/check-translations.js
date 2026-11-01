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
  // Any other key the main process reads the same way (tr().winhttpReset):
  // used, not "possibly unused".
  for (const match of source.matchAll(/\b(?:tr\(\)|s)\.([a-z]\w*)/g)) if (translations.en && match[1] in translations.en) allSource += `'${match[1]}'\n`;
}

// Linux's polkit action (scripts/gen-polkit.js) reads its own keys by name.
allSource += fs.readFileSync(path.join(root, 'scripts', 'gen-polkit.js'), 'utf8') + '\n';

// The Android app uses keys as string resources (android/scripts/gen-strings.js):
// R.string.key and @string/key, with a trailing _ where the key is a Java keyword.
(function walkAndroid(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!/^(values.*|build)$/.test(entry.name)) walkAndroid(fullPath); continue; }
    if (!/\.(kt|xml)$/.test(entry.name)) continue;
    const source = fs.readFileSync(fullPath, 'utf8');
    for (const match of source.matchAll(/(?<!android\.)\bR\.string\.(\w+)|(?<!android:)@string\/(\w+)/g)) {
      const key = (match[1] || match[2]).replace(/_$/, '');
      if (key !== 'app_name') { usedKeys.add(key); allSource += `'${key}'\n`; }
    }
  }
})(path.join(root, 'android', 'app', 'src'));

// The Apple app uses keys as tr("key") and labelKey: "key" in its Swift
// sources (apple/scripts/gen-strings.js, whose own keys for the system's
// prompts are counted as referenced).
for (const sub of ['App', 'Shared', 'Tunnel', 'scripts']) {
  (function walkApple(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!/\.xcassets$/.test(entry.name)) walkApple(fullPath); continue; }
      if (entry.name.endsWith('.js')) { allSource += fs.readFileSync(fullPath, 'utf8') + '\n'; continue; }
      if (!entry.name.endsWith('.swift')) continue;
      const source = fs.readFileSync(fullPath, 'utf8');
      for (const match of source.matchAll(/\btr\(\s*"(\w+)"|\blabelKey:\s*"(\w+)"/g)) {
        const key = match[1] || match[2];
        usedKeys.add(key);
        allSource += `'${key}'\n`;
      }
    }
  })(path.join(root, 'apple', sub));
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

// Every language's text has the same {placeholders} as the English one: one
// missing shows nothing where a host or a count belongs, one misspelt shows
// the braces themselves.
const holders = (v) => [...new Set(String(v).match(/\{\w+\}/g) || [])].sort().join(',');
for (const language of languages) {
  if (language === 'en') continue;
  for (const [key, value] of Object.entries(translations.en)) {
    const theirs = translations[language][key];
    if (typeof theirs === 'string' && holders(theirs) !== holders(value)) {
      failed = true;
      console.error(`${language}.${key}: placeholders ${holders(theirs) || '(none)'} instead of ${holders(value) || '(none)'}`);
    }
  }
}

// A text left in English: the four Discord and rival lines were, in 29
// languages, and this check let them through. The same words are right
// where a language writes them so (German "Status", French "Mode").
const SAME_AS_ENGLISH = {
  testPlaceholder: '*',
  supportBankName: 'az de id ku ms tk uz',
  trayStatus: 'de id ms',
  androidAppsSection: 'de es pt',
  totalCount: 'es id pt',
  versionLabel: 'de fr',
  androidModeTitle: 'fr id',
  dnsKindTcp: 'ja zh',
  routing: 'de',
  menuEdit: 'id ms',
  logInfo: 'de',
  updatesTitle: 'de',
  androidDetails: 'de',
  logError: 'es',
  navProtection: 'fr',
  navStats: 'fr',
  appSection: 'fr',
  openSourceTitle: 'fr',
  dnsServer: 'uz',
};
for (const language of languages) {
  if (language === 'en') continue;
  for (const [key, value] of Object.entries(translations.en)) {
    if (translations[language][key] !== value || !/[a-z]{3}/.test(String(value).replace(/\{\w+\}/g, ''))) continue;
    const ok = SAME_AS_ENGLISH[key];
    if (ok === '*' || (ok && ok.split(' ').includes(language))) continue;
    failed = true;
    console.error(`${language}.${key}: still in English ("${String(value).slice(0, 60)}"); translate it, or list it in SAME_AS_ENGLISH if ${language} writes it so`);
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
