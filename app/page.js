'use client';

import { useEffect, useState } from 'react';
import TitleBar from '../components/TitleBar';
import ControlPanel from '../components/ControlPanel';
import SettingsPanel from '../components/SettingsPanel';
import LogsPanel from '../components/LogsPanel';
import StatsPanel from '../components/StatsPanel';
import InfoPanel from '../components/InfoPanel';
import { useLanguage } from '../contexts/LanguageContext';

function HomeContent() {
  const [activeTab, setActiveTab] = useState('control');
  const { t } = useLanguage();
  const [dpiStatus, setDpiStatus] = useState({
    active: false,
    stats: {},
  });
  const [appInfo, setAppInfo] = useState({
    version: '1.2.0',
    year: new Date().getFullYear(),
  });

  useEffect(() => {
    checkDPIStatus();
    loadAppInfo();

    if (typeof window !== 'undefined' && window.electron?.onDPIStatusChanged) {
      window.electron.onDPIStatusChanged(() => {
        checkDPIStatus();
      });
    }

    const interval = setInterval(checkDPIStatus, 1000);

    return () => {
      clearInterval(interval);
      if (typeof window !== 'undefined' && window.electron?.removeDPIStatusListener) {
        window.electron.removeDPIStatusListener();
      }
    };
  }, []);

  const checkDPIStatus = async () => {
    if (typeof window !== 'undefined' && window.electron) {
      try {
        const status = await window.electron.getDPIStatus();
        setDpiStatus(status);
      } catch (error) {
        console.error('Failed to get DPI status:', error);
      }
    }
  };

  const loadAppInfo = async () => {
    if (typeof window !== 'undefined' && window.electron?.getAppInfo) {
      try {
        const info = await window.electron.getAppInfo();
        setAppInfo((prev) => ({ ...prev, ...info }));
      } catch (error) {
        console.error('Failed to get app info:', error);
      }
    }
  };

  const navItems = [
    {
      id: 'settings',
      label: t('settings'),
      icon: (
        <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.3 4.3c.44-1.73 2.9-1.73 3.34 0a1.72 1.72 0 002.57 1.06c1.54-.91 3.28.83 2.37 2.37a1.72 1.72 0 001.06 2.57c1.73.44 1.73 2.9 0 3.34a1.72 1.72 0 00-1.06 2.57c.91 1.54-.83 3.28-2.37 2.37a1.72 1.72 0 00-2.57 1.06c-.44 1.73-2.9 1.73-3.34 0a1.72 1.72 0 00-2.57-1.06c-1.54.91-3.28-.83-2.37-2.37a1.72 1.72 0 00-1.06-2.57c-1.73-.44-1.73-2.9 0-3.34a1.72 1.72 0 001.06-2.57c-.91-1.54.83-3.28 2.37-2.37a1.72 1.72 0 002.57-1.06z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z" />
        </svg>
      ),
    },
    {
      id: 'control',
      label: t('controlPanel'),
      icon: (
        <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3.75l6.25 2.3v5.32c0 4.05-2.6 7.8-6.25 8.88-3.65-1.08-6.25-4.83-6.25-8.88V6.05L12 3.75z" />
        </svg>
      ),
    },
    {
      id: 'stats',
      label: t('networkStats'),
      icon: (
        <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 17l4-8 4 4 4-6 4 4" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 20h18" />
        </svg>
      ),
    },
    {
      id: 'logs',
      label: t('logs'),
      icon: (
        <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7h8M8 11h8M8 15h5M6 3.75h8.25L18 7.5v12.75H6V3.75z" />
        </svg>
      ),
    },
    {
      id: 'info',
      label: t('info'),
      icon: (
        <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" strokeWidth={1.8} />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 11v5M12 8h.01" />
        </svg>
      ),
    },
  ];

  return (
    <div className="app-shell flex min-h-screen flex-col text-white">
      <TitleBar />

      <main className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="relative h-11 w-11 shrink-0">
              <img src="./logo.png" alt="Shroudly" className="h-full w-full object-contain drop-shadow-[0_0_20px_rgba(56,189,248,0.22)]" />
              <span className={`absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full ring-2 ring-[#0f1117] transition-colors duration-300 ${
                dpiStatus.active
                  ? 'bg-emerald-400 shadow-[0_0_8px_3px_rgba(52,211,153,0.55)]'
                  : 'bg-red-500 shadow-[0_0_8px_3px_rgba(239,68,68,0.45)]'
              }`} />
            </div>
            <div>
              <h1 className="text-lg font-black uppercase tracking-[0.18em] text-white drop-shadow">
                {t('appName')}
              </h1>
              <p className="text-[10px] uppercase tracking-[0.22em] text-white/45">v{appInfo.version}</p>
            </div>
          </div>

          <div className={`shrink-0 rounded-full border px-4 py-2 text-xs font-black uppercase tracking-[0.15em] ${
            dpiStatus.active
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
              : 'border-red-500/30 bg-red-500/10 text-red-400'
          }`}>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-current" />
            {dpiStatus.active ? t('active') : t('inactive')}
          </div>
        </header>

        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4 fade-in">
          {activeTab === 'control'  && <ControlPanel dpiStatus={dpiStatus} onStatusChange={checkDPIStatus} />}
          {activeTab === 'settings' && <SettingsPanel />}
          {activeTab === 'stats'    && <StatsPanel />}
          {activeTab === 'logs'     && <LogsPanel />}
          {activeTab === 'info'     && <InfoPanel dpiStatus={dpiStatus} />}
        </div>

        <footer className="border-t border-white/5 px-4 py-2 text-center text-[10px] text-white/35">
          © {appInfo.year} Codeshare Technology Ltd. {t('allRightsReserved')}
        </footer>

        <nav className="grid grid-cols-5 border-t border-white/5 bg-black/20 px-1 py-2">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`window-no-drag flex flex-col items-center gap-1 text-[9px] font-black uppercase tracking-[0.1em] transition px-0.5 ${
                activeTab === item.id ? 'text-white' : 'text-white/50 hover:text-white'
              }`}
            >
              <span className="[&>svg]:h-4 [&>svg]:w-4">{item.icon}</span>
              <span className="truncate w-full text-center">{item.label}</span>
            </button>
          ))}
        </nav>
      </main>
    </div>
  );
}

export default function Home() {
  return <HomeContent />;
}
