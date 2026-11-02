'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { SparklesIcon } from './icons';

/* The version whose notes are still to be shown (electron/whats-new.js), or
 * null, and close() for the card's button. */
export function useWhatsNew() {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      let v = null;
      try { v = await window.electron?.getSetting?.('whatsNew'); } catch {}
      if (live && typeof v === 'string' && v) setVersion(v);
    })();
    return () => { live = false; };
  }, []);
  const close = () => {
    setVersion(null);
    try { window.electron?.setSetting?.('whatsNew', null); } catch {}
  };
  return { version, close };
}

/* After an update, once: what changed, in the user's own language (the
 * locales' whatsNewDesktop, a line each), on the Protection panel until
 * closed. */
export function WhatsNewBanner({ show, news }) {
  const { t } = useLanguage();
  if (!show || !news.version) return null;
  const lines = t('whatsNewDesktop').split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <div role="note" data-testid="whats-new" className="no-drag mx-4 mb-3 rounded-[var(--radius-sm)] border py-2.5 pe-2 ps-3 sm:mx-5"
         style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
      <div className="flex items-start gap-2.5">
        <SparklesIcon className="mt-[1px] h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>
            {t('whatsNewTitle', { version: news.version })}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 ps-4 text-[12.5px] leading-snug" style={{ color: 'var(--text-dim)' }}>
            {lines.map((line) => (
              <li key={line} className="wrap-anywhere">
                {/* A command is never broken across lines. */}
                {line.split(/(shroudly --[\w-]+)/).map((part, i) => (i % 2
                  ? <span key={part} dir="ltr" className="mono whitespace-nowrap">{part}</span>
                  : part))}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={news.close}
                className="btn btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium">{t('whatsNewOk')}</button>
      </div>
    </div>
  );
}
