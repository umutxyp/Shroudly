'use client';

import { useEffect, useState } from 'react';
import TitleBar from '../components/TitleBar';
import ControlPanel from '../components/ControlPanel';
import SettingsPanel from '../components/SettingsPanel';
import LogsPanel from '../components/LogsPanel';
import StatsPanel from '../components/StatsPanel';
import InfoPanel, { FollowSection } from '../components/InfoPanel';
import UpdateBanner from '../components/UpdateBanner';
import Onboarding from '../components/Onboarding';
import BlockedNotice from '../components/BlockedNotice';
import Appearance from '../components/Appearance';
import { SupportBanner, useSupport } from '../components/Support';
import { HelpBanner, useHelpNudge } from '../components/HelpBanner';
import { WhatsNewBanner, useWhatsNew } from '../components/WhatsNew';
import { useUpdate } from '../components/useUpdate';
import { ChartIcon, InfoIcon, LogsIcon, SettingsIcon, ShieldIcon, UsersIcon } from '../components/icons';
import { useLanguage } from '../contexts/LanguageContext';

/* Relative path: the exported app is loaded from file://, where "/logo.png"
   would resolve to the filesystem root. */
const LOGO_SRC = './logo.png';
const CODESHARE_URL = 'https://codeshare.me';

/* "A {brand} product": the translation decides where the brand goes. */
function Footer({ t }) {
  const [before, after = ''] = t('footerProduct').split('{brand}');
  return (
    // Its own strip, with the text centred in it: a hairline above keeps it
    // apart from the tab labels, which it otherwise sat right under.
    <footer className="no-drag shrink-0 px-4 py-1.5 text-center text-[11px] leading-snug"
            style={{ background: 'var(--bg-sunk)', color: 'var(--text-faint)', borderTop: '1px solid var(--line)' }}>
      {before}
      <a href={CODESHARE_URL} target="_blank" rel="noreferrer" dir="ltr"
         className="footer-link font-semibold" style={{ color: 'var(--text-dim)' }}>Codeshare</a>
      {after}
    </footer>
  );
}

export default function Home() {
  const [activeTab, setActiveTab] = useState('control');
  const { t, isLoaded } = useLanguage();
  const [dpiStatus, setDpiStatus] = useState({ active: false, stats: {} });
  const [version, setVersion] = useState(null);
  // Bumped to bring "Support Shroudly" into view (the card, the tray).
  const [supportFocus, setSupportFocus] = useState(0);
  const openSupport = () => { setActiveTab('info'); setSupportFocus((n) => n + 1); };
  const update = useUpdate();
  const support = useSupport();
  const help = useHelpNudge();
  const news = useWhatsNew();

  useEffect(() => {
    const check = async () => {
      if (typeof window !== 'undefined' && window.electron?.getDPIStatus) {
        try { setDpiStatus(await window.electron.getDPIStatus()); } catch {}
      }
    };
    const loadInfo = async () => {
      if (typeof window !== 'undefined' && window.electron?.getAppInfo) {
        try { const i = await window.electron.getAppInfo(); if (i?.version) setVersion(i.version); } catch {}
      }
    };
    check(); loadInfo();
    if (typeof window !== 'undefined' && window.electron?.onDPIStatusChanged) {
      window.electron.onDPIStatusChanged(() => check());
    }
    const iv = setInterval(check, 1000);
    return () => {
      clearInterval(iv);
      if (typeof window !== 'undefined' && window.electron?.removeDPIStatusListener) {
        window.electron.removeDPIStatusListener();
      }
    };
  }, []);

  // The main process closes this window when it goes unused (main.js):
  // tell it about use, at most every 20 s, and save what is being typed
  // before it goes (fields save when they lose focus).
  useEffect(() => {
    const e = typeof window !== 'undefined' ? window.electron : null;
    if (!e?.uiActive) return undefined;
    let last = 0;
    const seen = () => { const now = Date.now(); if (now - last > 20000) { last = now; e.uiActive(); } };
    const kinds = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    kinds.forEach((k) => window.addEventListener(k, seen, { passive: true, capture: true }));
    e.onRelease?.(() => { try { document.activeElement?.blur?.(); } catch {} });
    return () => kinds.forEach((k) => window.removeEventListener(k, seen, { capture: true }));
  }, []);

  useEffect(() => {
    const off = typeof window !== 'undefined' ? window.electron?.onNavigate?.((tab) => { if (tab === 'support') openSupport(); }) : null;
    return () => { if (typeof off === 'function') off(); };
  }, []);

  const refresh = async () => {
    if (typeof window !== 'undefined' && window.electron?.getDPIStatus) {
      try { setDpiStatus(await window.electron.getDPIStatus()); } catch {}
    }
  };

  const active = !!dpiStatus.active;
  // On, but browsers are not going through it (main.js notRouting): amber,
  // "Not working yet", never the green "Active".
  const notRouting = active && !!dpiStatus.notRouting;
  // The network itself without internet: amber, and said so (ControlPanel).
  const offline = active && !notRouting && !!dpiStatus.offline;
  // On its way up at launch: "Starting…", not a red "Inactive" (ControlPanel).
  const starting = !active && !!dpiStatus.starting;
  // The user's own server not carrying connections (ControlPanel).
  const ownServerDown = active && !notRouting && !!dpiStatus.ownServerDown;
  const tone = starting ? 'accent' : !active ? 'danger' : notRouting || offline || ownServerDown ? 'warn' : 'ok';
  const nationalOnly = offline && !dpiStatus.ownProxy && !!dpiStatus.nationalOnly;
  const statusText = starting ? t('starting') : !active ? t('inactive') : notRouting || ownServerDown ? t('notWorkingYet') : nationalOnly ? t('nationalOnlyShort') : offline ? t('noInternet') : t('active');
  // A restart for an update that is counting down comes before any other
  // notice: its "Later" must be there to press. Otherwise an update waits
  // while the Protection panel says what is not working yet.
  const updateFirst = !!(update && update.status === 'ready' && update.restartAt);
  // The support card, and the quiet link under the main button: one at a
  // time, and neither where no way of giving works (Support.js).
  const supportCard = activeTab === 'control' && active && !notRouting && support.due && support.canPay;
  const supportLink = support.canPay && !supportCard;
  // Whether the user would like to help people in censored countries: only
  // while protection works, so the card never stands between a problem and
  // its fix (HelpBanner.js).
  const helpCard = activeTab === 'control' && active && !notRouting && !offline && !ownServerDown;

  const nav = [
    { id: 'control',  label: t('navProtection'), Icon: ShieldIcon },
    { id: 'stats',    label: t('navStats'),      Icon: ChartIcon },
    { id: 'settings', label: t('navSettings'),   Icon: SettingsIcon },
    { id: 'logs',     label: t('navLogs'),       Icon: LogsIcon },
    // Follow Shroudly: a tab of its own, not a card deep in About.
    { id: 'follow',   label: t('navFollow'),     Icon: UsersIcon },
    { id: 'info',     label: t('navInfo'),       Icon: InfoIcon },
  ];

  return (
    <div className="shell" style={{ opacity: isLoaded ? 1 : 0 }}>
      <TitleBar />

      {/* Header: logo, wordmark, status (said once, in the pill: a dot on
          the logo said it again) */}
      <header className="no-drag flex items-center gap-3 px-4 py-3 sm:px-5">
        <div className="h-9 w-9 shrink-0">
          <img src={LOGO_SRC} alt="" draggable={false} className="h-full w-full select-none object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-[15px] font-semibold leading-tight tracking-tight" style={{ color: 'var(--text)' }}>Shroudly</h1>
            {version && (
              <span className="num truncate text-[11px]" dir="ltr" style={{ color: 'var(--text-faint)' }}>v{version}</span>
            )}
          </div>
          <p className="truncate text-[11.5px] leading-snug" title={t('tagline')} style={{ color: 'var(--text-dim)' }}>{t('tagline')}</p>
        </div>
        <span
          role="status"
          className="inline-flex max-w-[50%] shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium leading-tight"
          style={{
            background: `var(--${tone}-soft)`,
            color: `var(--${tone})`,
          }}
          title={statusText}
        >
          <span className="dot forced-mark h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'currentColor' }} />
          <span className="truncate">{statusText}</span>
        </span>
      </header>

      <Appearance />

      <Onboarding onNavigate={setActiveTab} />

      {/* Notices sit apart from the header above them, as from the content
          below; with none showing, the space goes too. One at a time, the
          first that has something to say (.notices): stacked, a problem, an
          update and the support card took a small window's whole height,
          and the status and the Start/Stop button went off the screen. */}
      <div className="notices pt-3 empty:hidden">
        {updateFirst && <UpdateBanner />}
        <BlockedNotice onNavigate={setActiveTab} active={active} proxyInPanel={activeTab === 'control'} />
        {!updateFirst && !(notRouting && activeTab === 'control') && <UpdateBanner />}
        <WhatsNewBanner show={activeTab === 'control'} news={news} />
        <SupportBanner show={supportCard} support={support} onOpen={openSupport} />
        <HelpBanner show={helpCard} help={help} />
      </div>

      {/* Content */}
      {/* A maximised window: each screen keeps a readable width, centred,
          instead of rows stretched from edge to edge (on its own children,
          so the screens' heights still follow the window's). */}
      <main
        key={activeTab}
        id="main"
        className="scroll rise min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-4 sm:px-5 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[760px]"
      >
        {activeTab === 'control'  && <ControlPanel dpiStatus={dpiStatus} onStatusChange={refresh} onSupport={supportLink ? openSupport : null} />}
        {activeTab === 'stats'    && <StatsPanel active={active} />}
        {activeTab === 'settings' && <SettingsPanel active={active} />}
        {activeTab === 'logs'     && <LogsPanel />}
        {activeTab === 'follow'   && <div className="flex flex-col gap-3 py-4"><FollowSection /></div>}
        {activeTab === 'info'     && <InfoPanel version={version} supportFocus={supportFocus} />}
      </main>

      {/* Bottom navigation */}
      <nav
        className="no-drag grid shrink-0 grid-cols-6 border-t"
        style={{ borderColor: 'var(--line)', background: 'var(--bg-sunk)',
                 paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {nav.map(({ id, label, Icon }) => {
          const on = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              data-tour={`nav-${id}`}
              aria-current={on ? 'page' : undefined}
              title={label}
              className="nav-btn flex min-w-0 flex-col items-center justify-start gap-1 px-1 pb-2 pt-2.5"
            >
              <Icon className="h-[22px] w-[22px]" />
              <span className="nav-label line-clamp-2 w-full text-center text-[clamp(9px,2.6vw,10.5px)] font-medium leading-[1.25]">
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      <Footer t={t} />
    </div>
  );
}
