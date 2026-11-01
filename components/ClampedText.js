'use client';

/*
 * A notice's text, a few lines at most until "More" is clicked: three in a
 * banner, five under the Protection panel's status, where there is more
 * room. A long one (what to set by hand on Linux, an administrator's
 * password on macOS) in a small window, or in a language that takes more
 * words, otherwise pushed the status and the Start/Stop button off the
 * screen. "More" shows only when something is cut, also after the window is
 * resized.
 */

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

// Whole class names, for Tailwind to find.
const CLAMP = { 3: 'line-clamp-3', 5: 'line-clamp-5' };

export default function ClampedText({ text, lines = 3, className = '', style }) {
  const { t } = useLanguage();
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || open) return undefined;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open, lines]);

  return (
    <>
      <p ref={ref} className={`${className} wrap-anywhere ${open ? '' : CLAMP[lines] || CLAMP[3]}`} style={style}>{text}</p>
      {cut && !open && (
        <button type="button" onClick={() => setOpen(true)}
                className="mt-0.5 rounded text-[12px] font-medium hover:underline" style={{ color: 'var(--accent)' }}>
          {t('bannerMore')}
        </button>
      )}
    </>
  );
}
