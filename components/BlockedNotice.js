'use client';

/*
 * Shown when a site defeated every technique.
 *
 * Without this the app looks broken: protection is on, the badge says active,
 * and a site still will not load. Saying so plainly — and pointing at the one
 * thing that might still work — is the difference between "this app is
 * useless" and "I know what to try next".
 */

import { useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { ShieldAlertIcon, RefreshIcon, CloseIcon } from './icons';

export default function BlockedNotice({ onNavigate }) {
  const { t } = useLanguage();
  const [host, setHost] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [restartApps, setRestartApps] = useState(null);
  const [adv, setAdv] = useState({ available: false, active: false });
  const [advBusy, setAdvBusy] = useState(false);
  const [dnsAuto, setDnsAuto] = useState(null);

  const refreshAdv = () => window.electron?.advancedAvailable?.()
    .then((r) => { setAdv({ available: !!r?.available, active: !!r?.active }); setAdvanced(!!r?.available); })
    .catch(() => {});

  const startAdv = async () => {
    if (!window.electron?.startAdvanced) return;
    setAdvBusy(true);
    try { await window.electron.startAdvanced(); } catch {}
    await refreshAdv();
    setAdvBusy(false);
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.onSiteBlocked) return undefined;
    window.electron.onSiteBlocked(({ host: h }) => setHost(h));
    window.electron.onNeedRestart?.(({ apps }) => { setRestartApps(apps); refreshAdv(); });
    window.electron.onDnsAutoEnabled?.(({ host: h }) => setDnsAuto(h));
    refreshAdv();
    return () => {
      window.electron.removeSiteBlockedListener?.();
      window.electron.removeNeedRestartListener?.();
      window.electron.removeDnsAutoEnabledListener?.();
    };
  }, []);

  if (dnsAuto && !restartApps) {
    return (
      <div role="status" className="no-drag mx-4 mb-3 rounded-[var(--radius-sm)] border px-3 py-2.5 sm:mx-5"
           style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}>
        <div className="flex items-start gap-2.5">
          <ShieldAlertIcon className="mt-[1px] h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>
            {t('dnsAutoEnabledNotice', { host: dnsAuto })}
          </p>
          <button type="button" onClick={() => setDnsAuto(null)} aria-label={t('obSkip')}
                  className="shrink-0 rounded-md p-1 transition-opacity hover:opacity-70" style={{ color: 'var(--text-faint)' }}>
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  /* Programs that were open before protection started keep using the
   * connection they were given at launch; this is the usual reason a site
   * loads in the browser but not in its own app. */
  if (restartApps && restartApps.length) {
    return (
      <div
        role="status"
        className="no-drag mx-4 mb-3 rounded-[var(--radius-sm)] border px-3 py-2.5 sm:mx-5"
        style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn-line)' }}
      >
        <div className="flex items-start gap-2.5">
          <RefreshIcon className="mt-[1px] h-4 w-4 shrink-0" style={{ color: 'var(--warn)' }} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>
              {t('restartAppsTitle', { apps: restartApps.join(', ') })}
            </p>
            <p className="mt-1 text-[12px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>
              {t('restartAppsBody', { apps: restartApps.join(', ') })}
            </p>
            {/* Discord's own updater runs before the app and ignores the system
                proxy, so restarting alone may not be enough. What helps depends
                on what this machine can do: the packet-level mode catches it
                where it exists, and where it does not the honest answer is the
                web version, which uses the protected connection. */}
            {restartApps.includes('Discord') && (
              adv.available && !adv.active ? (
                <div className="mt-2">
                  <p className="text-[12px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>{t('discordNeedsAdvanced')}</p>
                  <button
                    type="button" onClick={startAdv} disabled={advBusy}
                    className="btn btn-warn mt-2 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold"
                  >
                    {t('tryAdvanced')}
                  </button>
                </div>
              ) : !adv.available ? (
                <p className="mt-2 text-[12px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>{t('discordUseWeb')}</p>
              ) : null
            )}
          </div>
          <button
            type="button" onClick={() => setRestartApps(null)} aria-label={t('obSkip')}
            className="shrink-0 rounded-md p-1 transition-opacity hover:opacity-70"
            style={{ color: 'var(--text-faint)' }}
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  if (!host) return null;

  return (
    <div
      role="status"
      className="no-drag mx-4 mb-3 rounded-[var(--radius-sm)] border px-3 py-2.5 sm:mx-5"
      style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn-line)' }}
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlertIcon className="mt-[1px] h-4 w-4 shrink-0" style={{ color: 'var(--warn)' }} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>
            {t('blockedNoticeTitle', { host })}
          </p>
          <p className="mt-1 text-[12px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>
            {advanced ? t('blockedNoticeAdvanced') : t('blockedNoticeNoAdvanced')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { if (typeof onNavigate === 'function') onNavigate(advanced ? 'settings' : 'logs'); setHost(null); }}
              className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold"
            >
              {advanced ? t('blockedNoticeOpenSettings') : t('blockedNoticeOpenLogs')}
            </button>
          </div>
        </div>
        <button
          type="button" onClick={() => setHost(null)} aria-label={t('obSkip')}
          className="shrink-0 rounded-md p-1 transition-opacity hover:opacity-70"
          style={{ color: 'var(--text-faint)' }}
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
