'use client';

import { useLanguage } from '../contexts/LanguageContext';

export default function ConnectionDashboard({ statusText, tone, checkedAt, readFailed, unavailable, onRefresh }) {
  const { t, locale } = useLanguage();
  const checked = checkedAt == null ? null : new Date(checkedAt);

  return (
    <section className="card flex flex-col gap-2.5 p-4" aria-labelledby="connection-dashboard-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="connection-dashboard-title" className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
          {t('connectionDashboard')}
        </h2>
        <button type="button" className="btn btn-ghost rounded-full px-3 py-1.5 text-[12px] font-medium"
                onClick={onRefresh} disabled={unavailable}>
          {t('connectionRefresh')}
        </button>
      </div>
      <p role="status" className="text-[13px] font-medium"
         style={{ color: readFailed ? 'var(--warn)' : checked ? `var(--${tone})` : 'var(--text-dim)' }}>
        {unavailable ? t('desktopOnly') : readFailed ? t('connectionStatusError') : checked ? statusText : '—'}
      </p>
      {checked && (
        <p className="flex flex-wrap items-baseline gap-1.5 text-[12px]" style={{ color: 'var(--text-dim)' }}>
          <span>{t('connectionLastChecked')}</span>
          <time dateTime={checked.toISOString()} className="num" dir="ltr">
            {checked.toLocaleTimeString(locale, { timeStyle: 'medium' })}
          </time>
        </p>
      )}
    </section>
  );
}
