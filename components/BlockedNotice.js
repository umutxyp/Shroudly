'use client';

/*
 * The one banner under the header that says what still needs the user.
 *
 * Without it the app looks broken: protection is on, the badge says active,
 * and a site or the Discord app still will not load. Saying so plainly — and
 * offering the one thing that will fix it — is the difference between "this
 * app is useless" and "I know what to do next". One banner at a time, most
 * urgent first.
 */

import { useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { ShieldAlertIcon, RefreshIcon, CloseIcon } from './icons';

function Banner({ tone = 'warn', Icon, title, body, children, onClose, closeLabel }) {
  const c = tone === 'accent'
    ? { bg: 'var(--accent-soft)', line: 'var(--accent-line)', icon: 'var(--accent)' }
    : { bg: 'var(--warn-soft)', line: 'var(--warn-line)', icon: 'var(--warn)' };
  return (
    <div role="status" className="no-drag mx-4 mb-3 rounded-[var(--radius-sm)] border px-3 py-2.5 sm:mx-5"
         style={{ background: c.bg, borderColor: c.line }}>
      <div className="flex items-start gap-2.5">
        <Icon className="mt-[1px] h-4 w-4 shrink-0" style={{ color: c.icon }} />
        <div className="min-w-0 flex-1">
          {title && <p className="text-[13px] font-medium leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>{title}</p>}
          {body && (
            <p className={`${title ? 'mt-1 text-[12px]' : 'text-[12.5px]'} leading-snug wrap-anywhere`}
               style={{ color: title ? 'var(--text-dim)' : 'var(--text)' }}>{body}</p>
          )}
          {children}
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label={closeLabel}
                  className="shrink-0 rounded-md p-1 transition-opacity hover:opacity-70" style={{ color: 'var(--text-faint)' }}>
            <CloseIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function Actions({ children }) {
  return <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>;
}

export default function BlockedNotice({ onNavigate, active = false }) {
  const { t } = useLanguage();
  const [host, setHost] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [restartApps, setRestartApps] = useState(null);
  const [dnsAuto, setDnsAuto] = useState(null);
  const [discord, setDiscord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [offerHidden, setOfferHidden] = useState(false);

  const refreshDiscord = () => window.electron?.discordStatus?.().then(setDiscord).catch(() => {});

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch {}
    await refreshDiscord();
    setBusy(false);
  };
  const discordOn = () => run(() => window.electron.discordSet(true));
  const discordRetry = () => run(() => window.electron.discordSet(discord?.pendingOn !== false));
  const discordRestart = () => run(() => window.electron.discordRestart());
  const discordDecline = () => { setOfferHidden(true); window.electron?.discordDecline?.().then(refreshDiscord).catch(() => {}); };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.onSiteBlocked) return undefined;
    window.electron.onSiteBlocked(({ host: h }) => setHost(h));
    window.electron.onNeedRestart?.(({ apps }) => { setRestartApps(apps); refreshDiscord(); });
    window.electron.onDnsAutoEnabled?.(({ host: h }) => setDnsAuto(h));
    window.electron.onDiscordState?.(() => refreshDiscord());
    window.electron.advancedAvailable?.().then((r) => setAdvanced(!!r?.available)).catch(() => {});
    refreshDiscord();
    return () => {
      window.electron.removeSiteBlockedListener?.();
      window.electron.removeNeedRestartListener?.();
      window.electron.removeDnsAutoEnabledListener?.();
      window.electron.removeDiscordStateListener?.();
    };
  }, []);

  // Whether Discord is open, and whether it has reached the relay yet, change
  // on their own: look again while there is something to look for.
  useEffect(() => {
    if (!discord?.installed) return undefined;
    refreshDiscord();
    if (!discord.needsRestart) return undefined;
    const iv = setInterval(refreshDiscord, 4000);
    return () => clearInterval(iv);
  }, [active, discord?.installed, discord?.needsRestart]);

  const closeLabel = t('obSkip');

  if (dnsAuto && !restartApps) {
    return <Banner tone="accent" Icon={ShieldAlertIcon} body={t('dnsAutoEnabledNotice', { host: dnsAuto })}
                   onClose={() => setDnsAuto(null)} closeLabel={closeLabel} />;
  }

  /* Discord app mode, most urgent first: the change could not be made, then
   * the change is made but the open Discord has not picked it up. */
  if (discord?.needsPermission) {
    return (
      <Banner Icon={ShieldAlertIcon} body={t('discordPermission')}>
        <Actions>
          <button type="button" onClick={discordRetry} disabled={busy}
                  className="btn btn-warn rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('discordPermissionBtn')}</button>
        </Actions>
      </Banner>
    );
  }
  if (discord?.editFailed) {
    return <Banner Icon={ShieldAlertIcon} body={t('discordEditFailed', { line: discord.editFailed })} />;
  }
  if (discord?.needsRestart && discord.running) {
    return (
      <Banner tone="accent" Icon={RefreshIcon} body={t('discordRestartNeeded')}>
        <Actions>
          <button type="button" onClick={discordRestart} disabled={busy}
                  className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('discordRestartBtn')}</button>
        </Actions>
      </Banner>
    );
  }

  /* Programs that were open before protection started keep using the
   * connection they were given at launch; this is the usual reason a site
   * loads in the browser but not in its own app. Discord needs more than a
   * restart: its updater runs before the app and ignores the proxy. */
  if (restartApps && restartApps.length) {
    const offerDiscord = restartApps.includes('Discord') && discord?.installed && discord.mode !== true;
    return (
      <Banner Icon={RefreshIcon}
              title={t('restartAppsTitle', { apps: restartApps.join(', ') })}
              body={t('restartAppsBody', { apps: restartApps.join(', ') })}
              onClose={() => setRestartApps(null)} closeLabel={closeLabel}>
        {offerDiscord && (
          <>
            <p className="mt-2 text-[12px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>{t('discordOfferBody')}</p>
            <Actions>
              <button type="button" onClick={discordOn} disabled={busy}
                      className="btn btn-warn rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('discordOfferYes')}</button>
            </Actions>
          </>
        )}
      </Banner>
    );
  }

  if (host) {
    return (
      <Banner Icon={ShieldAlertIcon} title={t('blockedNoticeTitle', { host })}
              body={advanced ? t('blockedNoticeAdvanced') : t('blockedNoticeNoAdvanced')}
              onClose={() => setHost(null)} closeLabel={closeLabel}>
        <Actions>
          <button type="button"
                  onClick={() => { if (typeof onNavigate === 'function') onNavigate(advanced ? 'settings' : 'logs'); setHost(null); }}
                  className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
            {advanced ? t('blockedNoticeOpenSettings') : t('blockedNoticeOpenLogs')}
          </button>
        </Actions>
      </Banner>
    );
  }

  /* Asked once, while protection is on — the moment the user expects
   * Discord to work. It changes another program's file, so it is offered,
   * never done unasked. */
  if (active && discord?.installed && discord.mode == null && !offerHidden) {
    return (
      <Banner tone="accent" Icon={ShieldAlertIcon} title={t('discordOfferTitle')} body={t('discordOfferBody')}>
        <Actions>
          <button type="button" onClick={discordOn} disabled={busy}
                  className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('discordOfferYes')}</button>
          <button type="button" onClick={discordDecline}
                  className="btn btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('discordOfferNo')}</button>
        </Actions>
      </Banner>
    );
  }

  return null;
}
