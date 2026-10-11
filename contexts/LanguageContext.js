'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { translations } from '../translations';

const LanguageContext = createContext(null);

/* `locale` is the BCP-47 tag used for Intl formatting (times, numbers). */
export const availableLanguages = [
  { code: 'en', name: 'English', locale: 'en-US' },
  { code: 'zh', name: '中文', locale: 'zh-CN' },
  { code: 'hi', name: 'हिन्दी', locale: 'hi-IN' },
  { code: 'es', name: 'Español', locale: 'es' },
  { code: 'ar', name: 'العربية', locale: 'ar' },
  { code: 'ru', name: 'Русский', locale: 'ru-RU' },
  { code: 'pt', name: 'Português', locale: 'pt-BR' },
  { code: 'fr', name: 'Français', locale: 'fr-FR' },
  { code: 'fa', name: 'فارسی', locale: 'fa-IR' },
  { code: 'tr', name: 'Türkçe', locale: 'tr-TR' },
  { code: 'bn', name: 'বাংলা', locale: 'bn-BD' },
  { code: 'ur', name: 'اردو', locale: 'ur-PK' },
  { code: 'id', name: 'Bahasa Indonesia', locale: 'id-ID' },
  { code: 'ja', name: '日本語', locale: 'ja-JP' },
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
];

const RTL_LANGUAGES = new Set(['ar', 'fa', 'ur']);
const STORAGE_KEY = 'shroudly_language';

/* Map an OS / browser language tag (e.g. "tr-TR", "zh-Hans-CN", "zh-TW",
   "pt_BR", "in") to one of our language codes, or null. This is the same rule
   electron/main-i18n.js uses for the tray menu, so tray and UI always agree:
   base code before "-"/"_", lower-cased, legacy "in" → "id". */
export function matchLanguage(tag) {
  if (!tag || typeof tag !== 'string') return null;
  let base = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (base === 'in') base = 'id';
  return availableLanguages.some((l) => l.code === base) ? base : null;
}

function firstMatch(tags) {
  for (const tag of tags || []) {
    const code = matchLanguage(tag);
    if (code) return code;
  }
  return null;
}

/* Explicit user choice only (never the auto-detected language). In the app
   the electron-store key 'language' is the single source of truth (the main
   process reads it too); localStorage is only used when running in a plain
   browser during development. */
async function loadSavedLanguage() {
  if (typeof window === 'undefined') return null;
  if (window.electron?.getSetting) {
    try {
      const v = await window.electron.getSetting('language');
      if (matchLanguage(v) === v) return v;
    } catch {}
    return null;
  }
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (matchLanguage(v) === v) return v;
  } catch {}
  return null;
}

async function detectSystemLanguage() {
  if (typeof window === 'undefined') return null;
  if (window.electron?.getSystemLanguages) {
    try {
      const code = firstMatch(await window.electron.getSystemLanguages());
      if (code) return code;
    } catch {}
  }
  if (typeof navigator !== 'undefined') {
    return firstMatch(navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]);
  }
  return null;
}

const ISOLATE_START = '⁨'; // FIRST STRONG ISOLATE
const ISOLATE_END = '⁩';   // POP DIRECTIONAL ISOLATE

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState('en');
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Never leave the UI blank if the IPC bridge hangs.
    const fallback = setTimeout(() => { if (!cancelled) setIsLoaded(true); }, 1500);
    (async () => {
      const code = (await loadSavedLanguage()) || (await detectSystemLanguage()) || 'en';
      if (cancelled) return;
      setLanguageState(code);
      setIsLoaded(true);
    })();
    return () => { cancelled = true; clearTimeout(fallback); };
  }, []);

  const meta = availableLanguages.find((l) => l.code === language) || availableLanguages[0];
  const dir = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = meta.locale;
    document.documentElement.dir = dir;
  }, [meta.locale, dir]);

  const setLanguage = useCallback(async (lang) => {
    if (!availableLanguages.some((item) => item.code === lang)) return;
    setLanguageState(lang);
    if (typeof window === 'undefined') return;
    if (window.electron?.setSetting) {
      try { await window.electron.setSetting('language', lang); } catch {}
    }
    try { window.localStorage.setItem(STORAGE_KEY, lang); } catch {}
  }, []);

  /* t(name) or t(name, { param: value }) — "{param}" placeholders are replaced.
     In RTL languages values are wrapped in Unicode isolates so Latin host
     names, numbers and strategy specs don't scramble the sentence order. */
  const t = useCallback((key, params) => {
    let s = translations[language]?.[key] ?? translations.en[key] ?? key;
    if (params) {
      const rtl = RTL_LANGUAGES.has(language);
      s = s.replace(/\{(\w+)\}/g, (m, name) => {
        if (!(name in params)) return m;
        const v = String(params[name]);
        return rtl ? ISOLATE_START + v + ISOLATE_END : v;
      });
    }
    return s;
  }, [language]);

  const value = useMemo(() => ({
    language, setLanguage, t, availableLanguages, isLoaded, dir, isRTL: dir === 'rtl', locale: meta.locale,
  }), [language, setLanguage, t, isLoaded, dir, meta.locale]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
}
