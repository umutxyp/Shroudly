'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import Toast from './Toast';

const safeNetworkOverrides = {
  allowSystemNetworkChanges: false,
  customDNS: false,
  nativeFrag: false,
  ttlManipulation: false,
};

export default function ControlPanel({ dpiStatus, onStatusChange }) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [config, setConfig] = useState({
    fragmentHTTP: true,
    fragmentHTTPS: true,
    fragmentSize: 2,
    ttlManipulation: false,
    ttlValue: 5,
    sniFragmentation: true,
    sniFakePackets: true,
    wrongChecksum: true,
    nativeFrag: false,
    customDNS: false,
    dnsServers: ['1.1.1.1', '1.0.0.1'],
    autoMode: true,
    aggressiveMode: true,
  });

  useEffect(() => {
    loadSettings();

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        loadSettings();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const loadSettings = async () => {
    if (typeof window !== 'undefined' && window.electron) {
      const saved = await window.electron.getAllSettings();
      if (saved && Object.keys(saved).length > 0) {
        setConfig((prev) => ({ ...prev, ...saved, ...safeNetworkOverrides }));
      }
    }
  };

  const handleStart = async () => {
    setLoading(true);

    try {
      await loadSettings();
      const result = await window.electron.startDPI({ ...config, ...safeNetworkOverrides });

      if (result.success) {
        onStatusChange();
        setToast({ message: `${t('success')}! ${t('dpiBypassRunning')}`, type: 'success' });
      } else {
        setToast({ message: `Error: ${result.error}`, type: 'error' });
      }
    } catch (error) {
      setToast({ message: `Error: ${error.message}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);

    try {
      const result = await window.electron.stopDPI();

      if (result.success) {
        onStatusChange();
        setToast({ message: t('dpiBypassStopped'), type: 'success' });
      } else {
        setToast({ message: `Error: ${result.error}`, type: 'error' });
      }
    } catch (error) {
      setToast({ message: `Error: ${error.message}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const active = dpiStatus.active;

  return (
    <>
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      <section className="app-panel flex flex-col items-center justify-between px-5 py-6 text-center">
        <div className="w-full">
          <div className={`mx-auto flex h-32 w-32 items-center justify-center rounded-full border ${
            active
              ? 'border-emerald-400/80 bg-emerald-500/10 shadow-[0_0_40px_rgba(16,185,129,0.22)]'
              : 'border-blue-500/80 bg-blue-500/10 shadow-[0_0_40px_rgba(59,130,246,0.18)]'
          }`}>
            <div className={`flex h-16 w-16 items-center justify-center rounded-full ${
              active ? 'text-emerald-300' : 'text-blue-300'
            }`}>
              <svg className="h-14 w-14 drop-shadow-[0_0_10px_currentColor]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3.75l6.25 2.3v5.32c0 4.05-2.6 7.8-6.25 8.88-3.65-1.08-6.25-4.83-6.25-8.88V6.05L12 3.75z" />
              </svg>
            </div>
          </div>

          <h2 className={`mt-6 text-3xl font-black uppercase tracking-[0.22em] ${
            active ? 'text-emerald-300' : 'text-blue-300'
          }`}>
            {active ? t('protected') : t('inactive')}
          </h2>

          <p className="mt-3 text-base text-white/85">
            {active ? t('dpiBypassRunning') : t('dpiBypassStopped')}
          </p>

          <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-1.5 text-sm text-white/80 shadow-inner">
            <span className={`h-2 w-2 rounded-full ${active ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span>{active ? t('active') : t('status')}</span>
          </div>
        </div>

        <button
          onClick={active ? handleStop : handleStart}
          disabled={loading}
          className={`window-no-drag mt-6 flex w-full items-center justify-center gap-3 rounded-[22px] px-6 py-4 text-xl font-black uppercase tracking-[0.12em] transition-all ${
            active
              ? 'bg-red-500 text-white shadow-[0_12px_32px_rgba(239,68,68,0.35)] hover:bg-red-400'
              : 'bg-white text-slate-950 shadow-[0_12px_32px_rgba(255,255,255,0.16)] hover:bg-blue-50'
          } ${loading ? 'cursor-wait opacity-70' : ''}`}
        >
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 3v9m6.36-5.36a9 9 0 11-12.72 0" />
          </svg>
          {loading ? (active ? t('stopping') : t('starting')) : (active ? t('stop') : t('start'))}
        </button>
      </section>
    </>
  );
}
