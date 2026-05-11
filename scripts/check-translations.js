const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sourceDirs = ['app', 'components'];
const usedKeys = new Set();

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
    for (const match of source.matchAll(/\bt\(['"]([^'"]+)['"]\)/g)) {
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

if (failed) {
  process.exit(1);
}

console.log(`Translation check passed: ${languages.length} languages, ${usedKeys.size} UI keys.`);
