'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { translations } from '../translations';

const LanguageContext = createContext();

export const availableLanguages = [
  { code: 'en', name: 'English', flag: 'GB' },
  { code: 'zh', name: '中文', flag: 'CN' },
  { code: 'hi', name: 'हिन्दी', flag: 'IN' },
  { code: 'es', name: 'Español', flag: 'ES' },
  { code: 'ar', name: 'العربية', flag: 'SA' },
  { code: 'ru', name: 'Русский', flag: 'RU' },
  { code: 'pt', name: 'Português', flag: 'PT' },
  { code: 'fr', name: 'Français', flag: 'FR' },
  { code: 'fa', name: 'فارسی', flag: 'IR' },
  { code: 'tr', name: 'Türkçe', flag: 'TR' },
  { code: 'bn', name: 'বাংলা', flag: 'BD' },
  { code: 'ur', name: 'اردو', flag: 'PK' },
  { code: 'id', name: 'Bahasa Indonesia', flag: 'ID' },
  { code: 'ja', name: '日本語', flag: 'JP' },
  { code: 'de', name: 'Deutsch', flag: 'DE' },
];

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState('en');
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const loadLanguage = async () => {
      let savedLang = null;

      if (typeof window !== 'undefined' && window.electron) {
        try {
          savedLang = await window.electron.getSetting('language');
          console.log('Language loaded from Electron Store:', savedLang);
        } catch (error) {
          console.error('Failed to load language from Electron Store:', error);
        }
      }

      if (!savedLang && typeof window !== 'undefined') {
        try {
          savedLang = localStorage.getItem('shroudly_language');
          console.log('Language loaded from localStorage:', savedLang);
        } catch (error) {
          console.error('Failed to load language from localStorage:', error);
        }
      }

      // Auto-detect system language on first run (no saved preference yet)
      if (!savedLang && typeof navigator !== 'undefined' && navigator.language) {
        const sysCode = navigator.language.split('-')[0].toLowerCase();
        const matched = availableLanguages.find((l) => l.code === sysCode);
        if (matched) {
          savedLang = matched.code;
          console.log('Language auto-detected from system:', savedLang);
        }
      }

      if (savedLang && availableLanguages.find((item) => item.code === savedLang)) {
        setLanguageState(savedLang);
        console.log('Language set to:', savedLang);
      } else {
        setLanguageState('en');
        console.log('Using default language: en');
      }

      setIsLoaded(true);
    };

    loadLanguage();
  }, []);

  const setLanguage = async (lang) => {
    if (!availableLanguages.find((item) => item.code === lang)) {
      return;
    }

    console.log('Changing language to:', lang);
    setLanguageState(lang);

    if (typeof window !== 'undefined' && window.electron) {
      try {
        await window.electron.setSetting('language', lang);
        console.log('Language saved to Electron Store:', lang);
      } catch (error) {
        console.error('Failed to save language to Electron Store:', error);
      }
    }

    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('shroudly_language', lang);
        console.log('Language saved to localStorage:', lang);
      } catch (error) {
        console.error('Failed to save language to localStorage:', error);
      }
    }
  };

  const t = (key) => translations[language]?.[key] || translations.en[key] || key;

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, availableLanguages, isLoaded }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);

  if (!context) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }

  return context;
}
