'use strict';

/*
 * Strings shown by the main process itself (tray menu, OS notifications,
 * dialogs). They live in the same per-language files as the window's
 * (locales/<code>.json, the tray*, notify* and discordPick* keys), and only
 * English and the language in use are ever read.
 *
 * Language: the one the user picked in Settings, else the first OS language
 * we support (same rule as the UI), else English.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'locales');
const files = {};
let codes = null;

function supported() {
  if (!codes) {
    try { codes = new Set(fs.readdirSync(DIR).filter((f) => /^[a-z]{2,3}\.json$/.test(f)).map((f) => f.slice(0, -5))); } catch { codes = new Set(); }
    codes.add('en');
  }
  return codes;
}

function load(code) {
  if (!(code in files)) {
    try { files[code] = JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8')); } catch { files[code] = {}; }
  }
  return files[code];
}

// Older tags some systems still report (same as contexts/LanguageContext.js).
const ALIASES = { in: 'id', iw: 'he', kmr: 'ku', zsm: 'ms' };

/* "tr-TR" / "zh_Hant_TW" / "pt-BR" -> a supported code, or null. */
function matchLanguage(tag) {
  if (!tag) return null;
  let base = String(tag).split(/[-_]/)[0].toLowerCase();
  base = ALIASES[base] || base;
  return supported().has(base) ? base : null;
}

function resolveLanguage(saved, systemLanguages) {
  if (saved && supported().has(saved)) return saved;
  for (const tag of systemLanguages || []) {
    const code = matchLanguage(tag);
    if (code) return code;
  }
  return 'en';
}

// A string not translated yet falls back to English rather than to nothing.
const merged = {};
function strings(lang) {
  const code = supported().has(lang) ? lang : 'en';
  if (!merged[code]) merged[code] = { ...load('en'), ...(code === 'en' ? {} : load(code)) };
  return merged[code];
}

module.exports = { resolveLanguage, strings };
