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
import { ShieldAlertIcon, RefreshIcon, CloseIcon, InfoIcon } from './icons';

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
  const { t, locale, language } = useLanguage();
  const [host, setHost] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [restartApps, setRestartApps] = useState(null);
  const [dnsAuto, setDnsAuto] = useState(null);
  const [refused, setRefused] = useState(null);   // { host, service }: the site turns the user away itself
  const [proxy, setProxy] = useState(null);       // what really happened to the system proxy
  const [discord, setDiscord] = useState(null);
  const [apps, setApps] = useState(null);
  const [busy, setBusy] = useState(false);
  const [offerHidden, setOfferHidden] = useState(false);
  const [appOfferHidden, setAppOfferHidden] = useState(false);
  const [advice, setAdvice] = useState(null);
  const [adv, setAdv] = useState({ available: false, active: false });
  const [hidden, setHidden] = useState({});   // banners closed this session
  const hide = (k) => setHidden((h) => ({ ...h, [k]: true }));

  const refreshAdv = () => window.electron?.advancedAvailable?.()
    .then((r) => { setAdv({ available: !!r?.available, active: !!r?.active }); setAdvanced(!!r?.available); })
    .catch(() => {});
  const startAdvanced = async () => {
    setBusy(true);
    try { await window.electron?.startAdvanced?.(); } catch {}
    await refreshAdv();
    setBusy(false);
  };

  const refreshDiscord = () => window.electron?.discordStatus?.().then(setDiscord).catch(() => {});
  // withRunning: also look whether Roblox is running (lists the programs, so
  // only when the window comes into view).
  const refreshApps = (withRunning) => window.electron?.appsStatus?.({ running: withRunning === true }).then(setApps).catch(() => {});

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch {}
    await Promise.all([refreshDiscord(), refreshApps()]);
    setBusy(false);
  };
  const discordOn = () => run(() => window.electron.discordSet(true));
  const discordRetry = () => run(() => window.electron.discordSet(discord?.pendingOn !== false));
  const discordRestart = () => run(() => window.electron.discordRestart());
  const discordDecline = () => { setOfferHidden(true); window.electron?.discordDecline?.().then(refreshDiscord).catch(() => {}); };
  const appsOn = () => run(() => window.electron.appsSet(true));
  const appsRestart = () => run(() => window.electron.appsRestartRoblox());
  const appsDecline = () => { setAppOfferHidden(true); window.electron?.appsDecline?.().then(refreshApps).catch(() => {}); };
  // Starting Roblox from a browser that was already open: Windows hands it the
  // browser's own, older environment.
  const browserNote = apps?.platform === 'win32' ? ` ${t('appBrowserNote')}` : '';

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.onSiteBlocked) return undefined;
    window.electron.onSiteBlocked(({ host: h }) => setHost(h));
    window.electron.onNeedRestart?.(({ apps }) => { setRestartApps(apps); refreshDiscord(); });
    window.electron.onDnsAutoEnabled?.(({ host: h }) => setDnsAuto(h));
    const offRefused = window.electron.onServiceRefused?.((p) => setRefused(p));
    const offProxy = window.electron.onProxyStatus?.((p) => setProxy(p));
    window.electron.proxyStatus?.().then((p) => p && setProxy(p)).catch(() => {});
    window.electron.onDiscordState?.(() => refreshDiscord());
    const offApps = window.electron.onAppsState?.(() => refreshApps());
    window.electron.onAdvice?.((a) => { setAdvice(a); refreshAdv(); });
    // Listening now: notices that came while there was no window follow.
    window.electron.uiReady?.();
    window.electron.getAdvice?.().then((a) => a && setAdvice(a)).catch(() => {});
    refreshAdv();
    refreshDiscord();
    refreshApps(true);
    return () => {
      window.electron.removeSiteBlockedListener?.();
      window.electron.removeNeedRestartListener?.();
      window.electron.removeDnsAutoEnabledListener?.();
      window.electron.removeDiscordStateListener?.();
      if (typeof offApps === 'function') offApps(); else window.electron.removeAppsStateListener?.();
      if (typeof offRefused === 'function') offRefused();
      if (typeof offProxy === 'function') offProxy();
      window.electron.removeAdviceListener?.();
    };
  }, []);

  // Roblox (or its installer) being opened, and an open copy being restarted,
  // happen on their own: look again while the answer would change a banner,
  // and only while the window is on screen, so nothing runs from the tray.
  useEffect(() => {
    if (!apps?.available) return undefined;
    const restart = apps.needsRestart;
    const offer = active && apps.mode == null && !appOfferHidden;
    if (!restart && !offer) return undefined;
    // A restart pending: its process ids are checked, nothing is started.
    // The offer: looked at again whenever the window comes back into view.
    const iv = restart ? setInterval(() => { if (!document.hidden) refreshApps(); }, 4000) : null;
    const onShow = () => { if (!document.hidden) refreshApps(true); };
    document.addEventListener('visibilitychange', onShow);
    return () => { if (iv) clearInterval(iv); document.removeEventListener('visibilitychange', onShow); };
  }, [active, apps?.available, apps?.needsRestart, apps?.mode, appOfferHidden]);

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

  /* Games and apps mode: a proxy of the user's own in the way, a change that
   * could not be made, then a Roblox opened before the change. */
  if (apps?.foreign && !hidden.appsForeign) {
    return <Banner Icon={ShieldAlertIcon} body={t('appForeign')} onClose={() => hide('appsForeign')} closeLabel={closeLabel} />;
  }
  if (apps?.failed && !hidden.appsFailed) {
    return <Banner Icon={ShieldAlertIcon} body={t('appFailed')} onClose={() => hide('appsFailed')} closeLabel={closeLabel} />;
  }
  /* The system proxy is what routes browsers and most programs: when it is
   * not in place, nothing else here matters, so this comes first. */
  if (active && proxy && !proxy.ok && !hidden[`proxy:${proxy.code}`]) {
    const close = () => hide(`proxy:${proxy.code}`);
    if (proxy.code === 'needs_admin') {
      return (
        <Banner Icon={ShieldAlertIcon} title={t('proxyAdminTitle')} body={t('proxyAdminBody')} onClose={close} closeLabel={closeLabel}>
          <Actions>
            <button type="button" disabled={busy} onClick={() => run(async () => { const r = await window.electron.proxyApplyAsAdmin(); if (r && r.ok) setProxy({ ...proxy, ok: true }); })}
                    className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('proxyAdminButton')}</button>
          </Actions>
        </Banner>
      );
    }
    if (proxy.code === 'replaced') {
      return (
        <Banner Icon={ShieldAlertIcon} title={t('proxyReplacedTitle')} body={t('proxyReplacedBody')} onClose={close} closeLabel={closeLabel}>
          <Actions>
            <button type="button" disabled={busy} onClick={() => run(() => window.electron.proxyReapply())}
                    className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('proxyReapply')}</button>
          </Actions>
        </Banner>
      );
    }
    /* XFCE, LXQt and other desktops without a proxy setting: Firefox follows
     * GNOME's setting, Chromium browsers the environment they started with. */
    if (proxy.code === 'partial_env') {
      const pac = proxy.pacUrl || '';
      const body = proxy.chromiumNow ? t('proxyEnvChromiumNow', { pac })
        : !proxy.chromiumAfterRelogin ? t('proxyEnvFirefoxOnly')
          : proxy.firefox ? t('proxyEnvFirefoxNow')
            : t('proxyEnvRelogin', { pac });
      return <Banner Icon={InfoIcon} body={body} onClose={close} closeLabel={closeLabel} />;
    }
    if (proxy.code === 'no_system_proxy') {
      return <Banner Icon={InfoIcon} body={t('proxyNoneBody', { pac: proxy.pacUrl || '' })} onClose={close} closeLabel={closeLabel} />;
    }
    return <Banner Icon={ShieldAlertIcon} body={t('proxyFailedBody')} onClose={close} closeLabel={closeLabel} />;
  }

  /* The site itself turns this user away (by country or policy): nothing a
   * technique can change, said the same way for every site and country. */
  if (refused && !hidden[`refused:${refused.host}`]) {
    return (
      <Banner Icon={ShieldAlertIcon}
              title={t(refused.service === 'stall' ? 'probeStallTitle' : 'probeServiceTitle', { host: refused.host })}
              body={t(refused.service === 'stall' ? 'probeStallBody' : 'probeServiceBody', { host: refused.host })}
              onClose={() => hide(`refused:${refused.host}`)} closeLabel={closeLabel} />
    );
  }

  /* Running, but nothing of it goes through Shroudly: started by a browser
   * that was open before the setting. Shroudly can start it properly. */
  if (apps?.bypassing && !apps.needsRestart && !hidden.appsBypass) {
    return (
      <Banner tone="accent" Icon={ShieldAlertIcon} title={t('appBypassTitle')} body={t('appBypassBody')}
              onClose={() => hide('appsBypass')} closeLabel={closeLabel}>
        <Actions>
          <button type="button" onClick={appsRestart} disabled={busy}
                  className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('appRestartThrough')}</button>
        </Actions>
      </Banner>
    );
  }
  if (apps?.needsRestart && apps.robloxRunning) {
    return (
      <Banner tone="accent" Icon={RefreshIcon} body={`${t('appRestartNeeded')}${browserNote}`}>
        {apps.robloxInstalled && (
          <Actions>
            <button type="button" onClick={appsRestart} disabled={busy}
                    className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('appRestartBtn')}</button>
          </Actions>
        )}
      </Banner>
    );
  }

  /* Another VPN or bypass tool steering the same connections: the most
   * common reason nothing works, and the user rarely suspects it. */
  const conflicts = advice?.conflicts || [];
  if (conflicts.length && !hidden.conflict) {
    const tools = conflicts.join(', ');
    return <Banner Icon={ShieldAlertIcon} title={t('conflictTitle', { tools })} body={t('conflictBody', { tools })}
                   onClose={() => hide('conflict')} closeLabel={closeLabel} />;
  }

  /* A site that connects and is then cut: what a blank page on Iran's or
   * Russia's networks looks like. What to say depends on what this machine
   * can still do about it. */
  const cut = advice?.cut;
  if (cut && !hidden[`cut:${cut.host}`]) {
    const body = adv.active ? t('cutBodyAdvancedOn') : adv.available ? t('cutBodyAdvanced') : t('cutBodyNoAdvanced');
    return (
      <Banner Icon={ShieldAlertIcon} title={t('cutTitle', { host: cut.host })} body={body}
              onClose={() => hide(`cut:${cut.host}`)} closeLabel={closeLabel}>
        {adv.available && !adv.active && (
          <Actions>
            <button type="button" onClick={startAdvanced} disabled={busy}
                    className="btn btn-warn rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('tryAdvanced')}</button>
          </Actions>
        )}
      </Banner>
    );
  }

  /* Programs that were open before protection started keep using the
   * connection they were given at launch; this is the usual reason a site
   * loads in the browser but not in its own app. Discord needs more than a
   * restart: its updater runs before the app and ignores the proxy. */
  if (restartApps && restartApps.length) {
    const offerDiscord = restartApps.includes('Discord') && discord?.installed && discord.mode !== true;
    // Restarting alone does not help Roblox either: it never uses the system proxy.
    const offerApps = restartApps.includes('Roblox') && apps?.available && apps.mode !== true;
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
        {offerApps && (
          <>
            <p className="mt-2 text-[12px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>{t('appOfferBody')}</p>
            <Actions>
              <button type="button" onClick={appsOn} disabled={busy}
                      className="btn btn-warn rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('appOfferYes')}</button>
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

  /* Encrypted DNS blocked on every route. Rare now, and it heals itself, but
   * while it lasts the user should know why some sites may misbehave. */
  if (active && advice?.dnsDown && !hidden.dns) {
    return <Banner Icon={ShieldAlertIcon} title={t('dnsDownTitle')} body={t('dnsDownBody')}
                   onClose={() => hide('dns')} closeLabel={closeLabel} />;
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

  /* Offered while protection is on, where Roblox is installed or being
   * installed, or once Roblox's own servers were seen blocked on this network
   * (then the installer is the first thing to fail). It changes what every newly started program is told
   * about proxies, so it is offered, never done unasked; "Not now" asks again
   * in two weeks. */
  if (active && apps?.available && (apps.robloxInstalled || apps.robloxRunning || apps.robloxBlocked)
      && apps.mode == null && !apps.offerSnoozed && !appOfferHidden) {
    return (
      <Banner tone="accent" Icon={ShieldAlertIcon} title={t('appOfferTitle')} body={t('appOfferBody')}>
        <Actions>
          <button type="button" onClick={appsOn} disabled={busy}
                  className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('appOfferYes')}</button>
          <button type="button" onClick={appsDecline}
                  className="btn btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('notNow')}</button>
        </Actions>
      </Banner>
    );
  }

  return null;
}
