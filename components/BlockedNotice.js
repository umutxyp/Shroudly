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

/* "Iran", "China" ... in the user's language, from the system's own data. */
function countryName(code, locale) {
  try { return new Intl.DisplayNames([locale || 'en'], { type: 'region' }).of(code) || code; } catch { return code; }
}

/* Dismissals that should survive a restart (a region offer declined once is
 * not offered again on the same network). Storage can be unavailable. */
function remembered(key) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
function remember(key) { try { localStorage.setItem(key, '1'); } catch {} }

export default function BlockedNotice({ onNavigate, active = false }) {
  const { t, locale, language } = useLanguage();
  const [host, setHost] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [restartApps, setRestartApps] = useState(null);
  const [dnsAuto, setDnsAuto] = useState(null);
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
  const refreshApps = () => window.electron?.appsStatus?.().then(setApps).catch(() => {});

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
    window.electron.onDiscordState?.(() => refreshDiscord());
    window.electron.onAppsState?.(() => refreshApps());
    window.electron.onAdvice?.((a) => { setAdvice(a); refreshAdv(); });
    window.electron.getAdvice?.().then((a) => a && setAdvice(a)).catch(() => {});
    refreshAdv();
    refreshDiscord();
    refreshApps();
    return () => {
      window.electron.removeSiteBlockedListener?.();
      window.electron.removeNeedRestartListener?.();
      window.electron.removeDnsAutoEnabledListener?.();
      window.electron.removeDiscordStateListener?.();
      window.electron.removeAppsStateListener?.();
      window.electron.removeAdviceListener?.();
    };
  }, []);

  // Roblox (or its installer) being opened, and an open copy being restarted,
  // happen on their own: look again while the answer would change a banner.
  useEffect(() => {
    if (!apps?.available) return undefined;
    refreshApps();
    const waiting = apps.needsRestart || (active && apps.mode == null && !appOfferHidden);
    if (!waiting) return undefined;
    const iv = setInterval(refreshApps, 5000);
    return () => clearInterval(iv);
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

  /* The network's DNS answers match a country whose filters follow whole
   * connections. Say so before the user has to find out, and offer the mode
   * made for it — once per country, where this machine has it. */
  const region = advice?.region;
  const regionKey = region ? `shroudly_region_${region.country}` : '';
  if (active && region?.stateful && adv.available && !adv.active && !hidden.region && !remembered(regionKey)) {
    const country = countryName(region.country, locale || language);
    return (
      <Banner tone="accent" Icon={ShieldAlertIcon} title={t('regionTitle', { country })} body={t('regionBody')}>
        <Actions>
          <button type="button" onClick={startAdvanced} disabled={busy}
                  className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('tryAdvanced')}</button>
          <button type="button" onClick={() => { remember(regionKey); hide('region'); }}
                  className="btn btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('notNow')}</button>
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

  /* Asked once, while protection is on, where Roblox is installed or being
   * installed. It changes what every newly started program is told about
   * proxies, so it is offered, never done unasked. */
  if (active && apps?.available && (apps.robloxInstalled || apps.robloxRunning) && apps.mode == null && !appOfferHidden) {
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
