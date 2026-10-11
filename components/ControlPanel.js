'use client';

import { useCallback, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { PowerIcon, ShieldCheckIcon, ShieldIcon, SpinnerIcon } from './icons';
import Toast from './Toast';

export default function ControlPanel({ dpiStatus, onStatusChange }) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const active = !!dpiStatus.active;
  const closeToast = useCallback(() => setToast(null), []);

  const act = async (fn, okKey, failKey) => {
    if (typeof window === 'undefined' || !window.electron?.[fn]) {
      setToast({ message: t('desktopOnly'), type: 'warning' });
      return;
    }
    setLoading(true);
    try {
      const r = await window.electron[fn]();
      if (r?.success) {
        onStatusChange();
        setToast({ message: t(okKey), type: 'success' });
      } else {
        setToast({ message: t(failKey), detail: r?.error, type: 'error' });
      }
    } catch (e) {
      setToast({ message: t(failKey), detail: e?.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const onClick = () => (active
    ? act('stopDPI', 'protectionStopped', 'stopFailed')
    : act('startDPI', 'protectionStarted', 'startFailed'));

  const ShieldGlyph = active ? ShieldCheckIcon : ShieldIcon;
  const label = loading ? (active ? t('stopping') : t('starting')) : (active ? t('stop') : t('start'));

  return (
    <>
      {toast && <Toast message={toast.message} detail={toast.detail} type={toast.type} onClose={closeToast} />}

      <div className="flex min-h-full flex-col items-center justify-center gap-7 py-6">
        {/* The shield — the one bold moment */}
        <div className="relative flex shrink-0 items-center justify-center" aria-hidden>
          {active && (
            <span
              className="halo absolute rounded-full"
              style={{ width: 180, height: 180, background: 'radial-gradient(circle, var(--accent-soft) 0%, transparent 70%)' }}
            />
          )}
          <div
            className="relative flex items-center justify-center rounded-full border transition-all duration-500"
            style={{
              width: 150, height: 150,
              borderColor: active ? 'var(--accent-line)' : 'var(--line-strong)',
              background: active ? 'var(--accent-soft)' : 'var(--surface)',
            }}
          >
            <ShieldGlyph
              className="h-16 w-16 transition-colors duration-500"
              strokeWidth={1.5}
              style={{ color: active ? 'var(--accent)' : 'var(--text-faint)' }}
            />
          </div>
        </div>

        {/* Status text */}
        <div className="w-full max-w-sm text-center" aria-live="polite">
          <h2 className="text-2xl font-semibold leading-tight tracking-tight wrap-anywhere"
              style={{ color: active ? 'var(--accent)' : 'var(--text)' }}>
            {active ? t('protected') : t('notProtected')}
          </h2>
          <p className="mt-1.5 text-[13px] leading-snug" style={{ color: 'var(--text-dim)' }}>
            {active ? t('dpiBypassRunning') : t('dpiBypassStopped')}
          </p>
        </div>

        {/* Primary action */}
        <button
          type="button"
          onClick={onClick}
          disabled={loading}
          aria-busy={loading}
          className={`btn w-full max-w-xs rounded-[var(--radius)] px-5 py-3.5 text-[15px] font-semibold ${active ? 'btn-danger' : 'btn-primary'}`}
        >
          {loading
            ? <SpinnerIcon className="spin h-[18px] w-[18px]" />
            : <PowerIcon className="h-[18px] w-[18px]" />}
          <span className="min-w-0 wrap-anywhere">{label}</span>
        </button>
      </div>
    </>
  );
}
