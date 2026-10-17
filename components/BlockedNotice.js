'use client';

/*
 * The one banner under the header that says what still needs the user.
 *
 * Without it the app looks broken: protection is on, the badge says active,
 * and a site or the Discord app still will not load. Whatever Shroudly can fix
 * by itself it fixes (autopilot.js), and this says, in one line, what it did;
 * what only the user can do (allow a permission, save their work in Studio)
 * is asked plainly. One banner at a time, most urgent first.
 */

import { useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { ShieldAlertIcon, RefreshIcon, CloseIcon, InfoIcon } from './icons';
import { proxyNotice, chromiumNote } from './proxyNotice';

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

/* Dismissals that should survive a restart. Storage can be unavailable. */
function remembered(key) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
function remember(key) { try { localStorage.setItem(key, '1'); } catch {} }

export default function BlockedNotice({ onNavigate, active = false }) {
  const { t, locale, language } = useLanguage();
  const [host, setHost] = useState(null);
  const [hostAsked, setHostAsked] = useState(false); // the autopilot asked for Advanced mode for it
  const [hostAt, setHostAt] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [restartApps, setRestartApps] = useState(null);
  const [dnsAuto, setDnsAuto] = useState(null);
  const [refused, setRefused] = useState(null);   // { host, service }: the site turns the user away itself
  const [proxy, setProxy] = useState(null);       // what really happened to the system proxy
  const [recovery, setRecovery] = useState(null); // macOS: settings from before a restart, still to put back
  const [discord, setDiscord] = useState(null);
  const [apps, setApps] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);     // the autopilot's latest: { id, params, at }
  const [advice, setAdvice] = useState(null);
  const [adv, setAdv] = useState({ available: false, active: false });
  const [hidden, setHidden] = useState({});   // banners closed this session
  const hide = (k) => setHidden((h) => ({ ...h, [k]: true }));
  // A line of the autopilot's the user closed stays closed in the next
  // window too (the window is closed for real when it goes to the tray).
  const hideNotice = (n) => { hide(`auto:${n.at}`); window.electron?.autoDismiss?.(n.at); };

  const refreshAdv = () => window.electron?.advancedAvailable?.()
    .then((r) => { setAdv({ available: !!r?.available, active: !!r?.active }); setAdvanced(!!r?.available); })
    .catch(() => {});
  // Resolves whether Advanced mode is on now; a site that was waiting for it
  // is then no longer a failure to show.
  const startAdvanced = async () => {
    setBusy(true);
    let on = false;
    try { const r = await window.electron?.startAdvanced?.(); on = !!(r && r.success); } catch {}
    await refreshAdv();
    if (on) setHost(null);
    setBusy(false);
    return on;
  };

  const refreshDiscord = () => window.electron?.discordStatus?.().then(setDiscord).catch(() => {});
  const refreshApps = () => window.electron?.appsStatus?.().then(setApps).catch(() => {});

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch {}
    await Promise.all([refreshDiscord(), refreshApps()]);
    setBusy(false);
  };
  const discordRetry = () => run(() => window.electron.discordSet(discord?.pendingOn !== false));
  // A notice is shown while it is news: a quarter of an hour at most.
  const NOTICE_MS = 15 * 60 * 1000;
  // The line about Roblox Studio comes from the apps state (it stays while
  // that Studio runs), so it never replaces another line here.
  const onNotice = (n) => {
    if (!n || !n.id) return;
    if (n.id !== 'autoStudioReopen') setNotice(n);
    // Advanced mode on: the site it was turned on for is no longer a failure.
    if (n.id === 'autoAdvancedOn') setHost(null);
    refreshAdv(); refreshApps(); refreshDiscord();
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.onSiteBlocked) return undefined;
    window.electron.onSiteBlocked(({ host: h, asked }) => { setHost(h); setHostAsked(!!asked); setHostAt(Date.now()); refreshAdv(); });
    const offAdv = window.electron.onAdvancedState?.(() => refreshAdv());
    window.electron.onNeedRestart?.(({ apps }) => { setRestartApps(apps); refreshDiscord(); });
    window.electron.onDnsAutoEnabled?.(({ host: h }) => setDnsAuto(h));
    const offRefused = window.electron.onServiceRefused?.((p) => setRefused(p));
    const offProxy = window.electron.onProxyStatus?.((p) => setProxy(p));
    window.electron.proxyStatus?.().then((p) => p && setProxy(p)).catch(() => {});
    const offRecovery = window.electron.onProxyRecovery?.((r) => setRecovery(r));
    window.electron.proxyRecovery?.().then((r) => setRecovery(r || null)).catch(() => {});
    const offDiscord = window.electron.onDiscordState?.(() => refreshDiscord());
    const offApps = window.electron.onAppsState?.(() => refreshApps());
    window.electron.onAdvice?.((a) => { setAdvice(a); refreshAdv(); });
    const offNotice = window.electron.onAutoNotice?.(onNotice);
    window.electron.autoNotices?.().then((list) => { if (Array.isArray(list) && list[0]) onNotice(list[0]); }).catch(() => {});
    // Listening now: notices that came while there was no window follow.
    window.electron.uiReady?.();
    window.electron.getAdvice?.().then((a) => a && setAdvice(a)).catch(() => {});
    refreshAdv();
    refreshDiscord();
    refreshApps();
    return () => {
      if (typeof offNotice === 'function') offNotice();
      if (typeof offAdv === 'function') offAdv();
      window.electron.removeSiteBlockedListener?.();
      window.electron.removeNeedRestartListener?.();
      window.electron.removeDnsAutoEnabledListener?.();
      if (typeof offDiscord === 'function') offDiscord(); else window.electron.removeDiscordStateListener?.();
      if (typeof offApps === 'function') offApps(); else window.electron.removeAppsStateListener?.();
      if (typeof offRefused === 'function') offRefused();
      if (typeof offProxy === 'function') offProxy();
      if (typeof offRecovery === 'function') offRecovery();
      window.electron.removeAdviceListener?.();
    };
  }, []);


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

  /* Games and apps mode: a proxy of the user's own in the way, a change that
   * could not be made, then a Roblox opened before the change. */
  if (apps?.foreign && !hidden.appsForeign) {
    return <Banner Icon={ShieldAlertIcon} body={t('appForeign')} onClose={() => hide('appsForeign')} closeLabel={closeLabel} />;
  }
  if (apps?.failed && !hidden.appsFailed) {
    return <Banner Icon={ShieldAlertIcon} body={t('appFailed')} onClose={() => hide('appsFailed')} closeLabel={closeLabel} />;
  }
  /* The system proxy is what routes browsers and most programs: when it is
   * not in place, nothing else here matters, so this comes first. Which
   * banner, and its button, is decided in proxyNotice.js. */
  const pn = proxyNotice(proxy, { active, recovery });
  if (pn && !hidden[pn.id]) {
    const actions = {
      admin: { label: 'proxyAdminButton', go: async () => { const r = await window.electron.proxyApplyAsAdmin(); if (r && r.ok) setProxy({ ...proxy, ok: true }); } },
      reapply: { label: 'proxyReapply', go: () => window.electron.proxyReapply() },
      recover: { label: 'proxyRecoverButton', go: async () => { const r = await window.electron.proxyRecoverAsAdmin(); if (r && r.ok) setRecovery(null); } },
    };
    const a = pn.action ? actions[pn.action] : null;
    return (
      <Banner Icon={pn.icon === 'info' ? InfoIcon : ShieldAlertIcon} title={pn.title ? t(pn.title) : null} body={t(pn.body, pn.params)}
              onClose={() => hide(pn.id)} closeLabel={closeLabel}>
        {a && (
          <Actions>
            <button type="button" disabled={busy} onClick={() => run(a.go)}
                    className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t(a.label)}</button>
          </Actions>
        )}
      </Banner>
    );
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

  /* Roblox Studio open around Shroudly. Shroudly never closes Studio itself:
   * it may hold work that is not saved. Said while that Studio runs; a later
   * Studio is a new line, even if this one was closed. */
  const studioAt = apps?.studioReopenAt || 0;
  if (active && studioAt && !hidden[`studio:${studioAt}`]) {
    return <Banner tone="accent" Icon={RefreshIcon} body={t('autoStudioReopen')}
                   onClose={() => hide(`studio:${studioAt}`)} closeLabel={closeLabel} />;
  }

  /* What the autopilot just did by itself. Advanced mode that was declined
   * or could not start keeps its button, while it is still off: turning it
   * on then is the user's call. Once it is on, that line has nothing to say. */
  const advNotice = notice && (notice.id === 'autoAdvancedDeclined' || notice.id === 'autoAdvancedFailed');
  // A site that failed after this line, and that the autopilot did not ask
  // about, is newer news than the line.
  const hostNewer = host && !hostAsked && hostAt > (notice ? notice.at : 0);
  const noticeShown = notice && Date.now() - notice.at < NOTICE_MS && !hidden[`auto:${notice.at}`]
    && !(advNotice && adv.active) && !(notice.id === 'autoAdvancedAsk' && adv.active)
    && !(notice.id === 'autoAdvancedOn' && !adv.active) && !hostNewer;
  if (noticeShown) {
    const offer = advNotice && adv.available && !adv.active;
    return (
      <Banner tone="accent" Icon={offer ? ShieldAlertIcon : InfoIcon} body={t(notice.id, notice.params || {})}
              onClose={() => hideNotice(notice)} closeLabel={closeLabel}>
        {offer && (
          <Actions>
            <button type="button" onClick={startAdvanced} disabled={busy}
                    className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('tryAdvanced')}</button>
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

  /* A site that connects and is then cut: what a blank page looks like on a
   * network that follows whole connections. What to say depends on what this
   * machine can still do about it. */
  /* Programs that were open before protection started keep using the
   * connection they were given at launch; this is the usual reason a site
   * loads in the browser but not in its own app. Discord needs more than a
   * restart: its updater runs before the app and ignores the proxy. */
  if (restartApps && restartApps.length) {
    return (
      <Banner Icon={RefreshIcon}
              title={t('restartAppsTitle', { apps: restartApps.join(', ') })}
              body={t('restartAppsBody', { apps: restartApps.join(', ') })}
              onClose={() => setRestartApps(null)} closeLabel={closeLabel} />
    );
  }

  /* A site no technique opened. Where the autopilot asked for Advanced mode
   * for it, its own lines say what happened (above). Otherwise: Advanced mode
   * one click away where it can still be turned on, else what is left. */
  if (host && !hostAsked) {
    const offer = advanced && !adv.active;
    return (
      <Banner Icon={ShieldAlertIcon} title={t('blockedNoticeTitle', { host })}
              body={advanced ? null : t('blockedNoticeNoAdvanced')}
              onClose={() => setHost(null)} closeLabel={closeLabel}>
        <Actions>
          {offer ? (
            <button type="button" onClick={startAdvanced} disabled={busy}
                    className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('tryAdvanced')}</button>
          ) : (
            <button type="button"
                    onClick={() => { if (typeof onNavigate === 'function') onNavigate('logs'); setHost(null); }}
                    className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
              {t('blockedNoticeOpenLogs')}
            </button>
          )}
        </Actions>
      </Banner>
    );
  }

  /* XFCE, LXQt and other desktops: Chromium browsers and apps opened before
   * Shroudly answered at its address may go around it until reopened. Said
   * once; closing it is remembered. */
  const cn = chromiumNote(proxy, { active });
  if (cn && !hidden[cn.id] && !remembered('shroudly_chromium_restart')) {
    return <Banner tone="accent" Icon={InfoIcon} body={t(cn.body)}
                   onClose={() => { remember('shroudly_chromium_restart'); hide(cn.id); }} closeLabel={closeLabel} />;
  }

  /* Encrypted DNS blocked on every route. Rare now, and it heals itself, but
   * while it lasts the user should know why some sites may misbehave. */
  if (active && advice?.dnsDown && !hidden.dns) {
    return <Banner Icon={ShieldAlertIcon} title={t('dnsDownTitle')} body={t('dnsDownBody')}
                   onClose={() => hide('dns')} closeLabel={closeLabel} />;
  }

  /* A site that connects and is then cut. Informational and shown last, so it
   * never hides the banners above. */
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

  return null;
}
