'use client';

import { useLanguage } from '../contexts/LanguageContext';
import { DownloadIcon, ExternalLinkIcon, RefreshIcon } from './icons';
import { RELEASES_URL, updateActions, useCountdown, useUpdate } from './useUpdate';

/* Shown above the content while an update is available, downloading or ready. */
export default function UpdateBanner() {
  const { t } = useLanguage();
  const u = useUpdate();
  const seconds = useCountdown(u?.status === 'ready' ? u.restartAt : null);
  if (!u || !['available', 'downloading', 'ready', 'manual'].includes(u.status)) return null;

  const version = u.version;
  let text;
  let detail = null;
  let actions = null;

  if (u.status === 'downloading') {
    text = t('updDownloading', { version, percent: u.percent || 0 });
  } else if (u.status === 'ready') {
    text = seconds != null ? t('updRestartIn', { seconds }) : t('updReady', { version });
    if (seconds == null) detail = t('updLaterHint');
    actions = (
      <>
        <button type="button" onClick={updateActions.install} className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
          {t('updRestartNow')}
        </button>
        {seconds != null && (
          <button type="button" onClick={updateActions.postpone} className="btn btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium">
            {t('updLater')}
          </button>
        )}
      </>
    );
  } else if (u.status === 'manual') {
    text = t('updAvailable', { version });
    detail = t('updManual');
    actions = (
      <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="btn btn-primary inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
        <ExternalLinkIcon className="h-3.5 w-3.5" />{t('updOpenDownload')}
      </a>
    );
  } else {
    text = t('updAvailable', { version });
    actions = (
      <button type="button" onClick={updateActions.download} className="btn btn-primary inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
        <DownloadIcon className="h-3.5 w-3.5" />{t('updDownload')}
      </button>
    );
  }

  return (
    <div role="status" className="no-drag mx-4 mb-3 rounded-[var(--radius-sm)] border px-3 py-2.5 sm:mx-5"
         style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-medium leading-snug" style={{ color: 'var(--text)' }}>
          <RefreshIcon className={`h-4 w-4 ${u.status === 'downloading' ? 'spin' : ''}`} style={{ color: 'var(--accent)' }} />
          <span className="min-w-0 wrap-anywhere">{text}</span>
        </span>
        {actions && <span className="flex shrink-0 flex-wrap gap-2">{actions}</span>}
      </div>
      {u.status === 'downloading' && (
        <div className="mt-2 h-1 overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
          <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${u.percent || 0}%`, background: 'var(--accent)' }} />
        </div>
      )}
      {detail && <p className="mt-1.5 text-[12px] leading-snug" style={{ color: 'var(--text-dim)' }}>{detail}</p>}
    </div>
  );
}
