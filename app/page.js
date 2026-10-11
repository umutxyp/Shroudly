'use client';

import { useEffect, useState } from 'react';
import TitleBar from '../components/TitleBar';
import ControlPanel from '../components/ControlPanel';
import SettingsPanel from '../components/SettingsPanel';
import LogsPanel from '../components/LogsPanel';
import StatsPanel from '../components/StatsPanel';
import InfoPanel from '../components/InfoPanel';
import { useLanguage } from '../contexts/LanguageContext';

/* Minimal line icons (1.75 stroke), sized by CSS. */
const Icon = {
  shield: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...p}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d="M12 3.5l6.5 2.4v5.3c0 4.1-2.7 7.9-6.5 9-3.8-1.1-6.5-4.9-6.5-9V5.9L12 3.5z"/></svg>),
  gear:   (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...p}><circle cx="12" cy="12" r="3.1" strokeWidth="1.75"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d="M19.4 12a7.4 7.4 0 00-.1-1.1l2-1.6-2-3.4-2.4 1a7.3 7.3 0 00-1.9-1.1l-.4-2.5h-4l-.4 2.5c-.7.3-1.3.6-1.9 1.1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.2l-2 1.6 2 3.4 2.4-1c.6.5 1.2.8 1.9 1.1l.4 2.5h4l.4-2.5c.7-.3 1.3-.6 1.9-1.1l2.4 1 2-3.4-2-1.6c.1-.4.1-.7.1-1.1z"/></svg>),
  chart:  (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...p}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d="M4 19V5m0 14h16M8 16V11m4 5V8m4 8v-3"/></svg>),
  logs:   (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...p}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d="M7 8h10M7 12h10M7 16h6M5 3.5h14v17H5z"/></svg>),
  info:   (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...p}><circle cx="12" cy="12" r="8.5" strokeWidth="1.75"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d="M12 11.5v4.5M12 8h.01"/></svg>),
};

function HomeContent() {
  const [activeTab, setActiveTab] = useState('control');
  const { t } = useLanguage();
  const [dpiStatus, setDpiStatus] = useState({ active: false, stats: {} });
  const [version, setVersion] = useState('2.0.0');

  useEffect(() => {
    const check = async () => {
      if (typeof window !== 'undefined' && window.electron) {
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

  const refresh = async () => {
    if (typeof window !== 'undefined' && window.electron) {
      try { setDpiStatus(await window.electron.getDPIStatus()); } catch {}
    }
  };

  const active = dpiStatus.active;

  const nav = [
    { id: 'control',  label: t('controlPanel'),  icon: Icon.shield },
    { id: 'stats',    label: t('networkStats'),  icon: Icon.chart },
    { id: 'settings', label: t('settings'),      icon: Icon.gear },
    { id: 'logs',     label: t('logs'),          icon: Icon.logs },
    { id: 'info',     label: t('info'),          icon: Icon.info },
  ];

  return (
    <div className="shell">
      <TitleBar active={active} />

      {/* Header: logo, wordmark, status */}
      <header className="no-drag flex items-center gap-3 px-4 pt-3 pb-3 sm:px-5">
        <div className="relative h-9 w-9 shrink-0">
          <img src="./logo.png" alt="" className="h-full w-full object-contain" />
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2"
            style={{
              background: active ? 'var(--ok)' : 'var(--danger)',
              borderColor: 'var(--bg)',
              boxShadow: active ? '0 0 8px var(--ok)' : 'none',
            }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">Shroudly</h1>
            <span className="num text-[11px] text-[var(--text-faint)]">v{version}</span>
          </div>
          <p className="truncate text-[11px] text-[var(--text-dim)]">{t('tagline')}</p>
        </div>
        <span
          className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
          style={{
            background: active ? 'var(--ok-soft)' : 'var(--danger-soft)',
            color: active ? 'var(--ok)' : 'var(--danger)',
          }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
          {active ? t('active') : t('inactive')}
        </span>
      </header>

      {/* Content */}
      <main key={activeTab} className="scroll rise min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5">
        {activeTab === 'control'  && <ControlPanel dpiStatus={dpiStatus} onStatusChange={refresh} />}
        {activeTab === 'stats'    && <StatsPanel />}
        {activeTab === 'settings' && <SettingsPanel />}
        {activeTab === 'logs'     && <LogsPanel />}
        {activeTab === 'info'     && <InfoPanel dpiStatus={dpiStatus} />}
      </main>

      {/* Bottom navigation */}
      <nav
        className="no-drag grid shrink-0 grid-cols-5 border-t"
        style={{ borderColor: 'var(--line)', background: 'var(--bg-sunk)',
                 paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {nav.map((item) => {
          const on = activeTab === item.id;
          const I = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className="group flex flex-col items-center gap-1 py-2.5 transition-colors"
              style={{ color: on ? 'var(--accent)' : 'var(--text-faint)' }}
            >
              <I className="h-[22px] w-[22px]" />
              <span className="max-w-full truncate px-0.5 text-[10px] font-medium leading-none">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export default function Home() { return <HomeContent />; }
