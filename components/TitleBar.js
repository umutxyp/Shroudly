'use client';

import { useLanguage } from '../contexts/LanguageContext';
import { CloseIcon, MinusIcon, SquareIcon } from './icons';

/* Frameless-window title bar. Kept left-to-right in every language so the
   window buttons stay where the OS puts them. */
export default function TitleBar() {
  const { t } = useLanguage();
  const call = (fn) => () => { if (typeof window !== 'undefined' && window.electron?.[fn]) window.electron[fn](); };

  const buttons = [
    { fn: 'minimizeWindow', label: t('windowMinimize'), Icon: MinusIcon },
    { fn: 'maximizeWindow', label: t('windowMaximize'), Icon: SquareIcon },
    { fn: 'closeWindow', label: t('windowClose'), Icon: CloseIcon, close: true },
  ];

  return (
    <div
      dir="ltr"
      className="drag flex h-9 shrink-0 items-center justify-between ps-3"
      style={{ borderBottom: '1px solid var(--line)' }}
    >
      <span className="select-none text-[11px] font-medium tracking-wide" style={{ color: 'var(--text-faint)' }}>
        Shroudly
      </span>
      <div className="flex h-full">
        {buttons.map(({ fn, label, Icon, close }) => (
          <button
            key={fn}
            type="button"
            onClick={call(fn)}
            aria-label={label}
            title={label}
            className={`no-drag win-btn flex h-full w-11 items-center justify-center ${close ? 'win-btn-close' : ''}`}
          >
            <Icon className={fn === 'maximizeWindow' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          </button>
        ))}
      </div>
    </div>
  );
}
