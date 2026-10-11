const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

let translationSource = fs.readFileSync(path.join(root, 'translations.js'), 'utf8');
translationSource = translationSource.replace(/export\s+const\s+translations\s*=/, 'const translations =');
translationSource += '\nmodule.exports = translations;';

const context = { module: { exports: null } };
vm.createContext(context);
vm.runInContext(translationSource, context);

const translations = context.module.exports;
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
const unused = englishKeys.filter((key) => !allSource.includes(`'${key}'`) && !allSource.includes(`"${key}"`));
if (unused.length) console.warn(`warning: possibly unused keys: ${unused.join(', ')}`);

if (failed) {
  process.exit(1);
}

console.log(`Translation check passed: ${languages.length} languages, ${usedKeys.size} UI keys.`);
