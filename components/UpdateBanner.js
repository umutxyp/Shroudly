'use client';

import { useLanguage } from '../contexts/LanguageContext';
import { DownloadIcon, ExternalLinkIcon, RefreshIcon } from './icons';
import { RELEASES_URL, updateActions, useCountdown, useUpdate } from './useUpdate';

/* Shown above the content while an update is available, downloading or ready,
 * or cannot go ahead until the user does something (no room on the disk, a
 * folder Shroudly cannot replace itself in). The download page is this copy's
 * own file, from Shroudly's mirror (downloadUrl), where GitHub's page lists
 * every file and may be blocked. */
export default function UpdateBanner() {
  const { t } = useLanguage();
  const u = useUpdate();
  const seconds = useCountdown(u?.status === 'ready' ? u.restartAt : null);
  if (!u || !['available', 'downloading', 'ready', 'manual', 'no-space'].includes(u.status)) return null;

  const version = u.version;
  const page = u.downloadUrl || RELEASES_URL;
  let text;
  let detail = null;
  let actions = null;

  if (u.status === 'downloading') {
    text = t('updDownloading', { version, percent: u.percent || 0 });
  } else if (u.status === 'ready') {
    text = seconds != null ? t('updRestartIn', { seconds }) : t('updReady', { version });
    // Its install failed before: said, with the download page beside the
    // button. An install that asks for permission (a Linux package's
    // password, a Windows administrator's) happens only from the button.
    // Otherwise it installs by itself while nobody is at the computer, or,
    // with automatic installs off, at the next quit.
    if (u.failed) detail = t('updInstallFailed');
    else if (seconds == null && !u.permission) detail = u.byItself ? t('updAwayHint') : t('updLaterHint');
    const label = u.permission === 'password' ? t('updInstallPassword') : u.permission === 'admin' ? t('updInstallAdmin') : t('updRestartNow');
    actions = (
      <>
        <button type="button" onClick={updateActions.install} className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
          {label}
        </button>
        {seconds != null && (
          <button type="button" onClick={updateActions.postpone} className="btn btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium">
            {t('updLater')}
          </button>
        )}
        {u.failed && seconds == null && (
          <a href={page} target="_blank" rel="noreferrer" className="btn btn-ghost inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium">
            <ExternalLinkIcon className="h-3.5 w-3.5" />{t('updOpenDownload')}
          </a>
        )}
      </>
    );
  } else if (u.status === 'no-space') {
    text = t('updNoSpace', { version });
    actions = (
      <button type="button" onClick={updateActions.download} className="btn btn-primary inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
        <DownloadIcon className="h-3.5 w-3.5" />{t('updDownload')}
      </button>
    );
  } else if (u.status === 'manual') {
    text = t('updAvailable', { version });
    detail = u.reason === 'folder' ? t('updManualFolder') : t('updManual');
    // macOS run from its disk image or Downloads: moved to Applications, it
    // can update itself from then on.
    const move = u.reason === 'location';
    actions = (
      <>
        {move && (
          <button type="button" onClick={updateActions.moveToApplications} className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
            {t('updMoveToApps')}
          </button>
        )}
        <a href={page} target="_blank" rel="noreferrer" className={`btn ${move ? 'btn-ghost font-medium' : 'btn-primary font-semibold'} inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px]`}>
          <ExternalLinkIcon className="h-3.5 w-3.5" />{t('updOpenDownload')}
        </a>
      </>
    );
  } else {
    text = t('updAvailable', { version });
    actions = (
      <button type="button" onClick={updateActions.download} className="btn btn-primary inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
        <DownloadIcon className="h-3.5 w-3.5" />{t('updDownload')}
      </button>
    );
  }

  const downloading = u.status === 'downloading';

  /* The message is never cut: "Restarting for the update in 54 s" with its
   * end missing says nothing. It takes the room it needs, and the buttons
   * move under it when the window is too narrow for both on one line. The
   * download progress is a hairline along the bottom edge rather than a row
   * of its own. */
  return (
    <div
      role="status"
      className="no-drag relative mx-4 mb-3 overflow-hidden rounded-[var(--radius-sm)] border py-2 pl-3 pr-2 sm:mx-5"
      style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <RefreshIcon
          className={`h-4 w-4 shrink-0 ${downloading ? 'spin' : ''}`}
          style={{ color: 'var(--accent)' }}
        />
        <span
          className="min-w-[14rem] flex-1 text-[13px] font-medium leading-snug wrap-anywhere"
          style={{ color: 'var(--text)' }}
        >
          {text}
        </span>
        {actions && <span className="ms-auto flex shrink-0 items-center gap-1.5">{actions}</span>}
      </div>

      {/* Only the cases that genuinely need a second line get one. */}
      {detail && !downloading && (
        <p className="mt-1 pl-[26px] text-[12px] leading-snug" style={{ color: 'var(--text-dim)' }}>
          {detail}
        </p>
      )}

      {downloading && (
        <div className="absolute inset-x-0 bottom-0 h-[2px]" style={{ background: 'var(--line)' }}>
          <div
            className="h-full transition-[width] duration-300"
            style={{ width: `${u.percent || 0}%`, background: 'var(--accent)' }}
          />
        </div>
      )}
    </div>
  );
}
