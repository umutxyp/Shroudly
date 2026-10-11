'use client';

import { useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import Toast from './Toast';

export default function ControlPanel({ dpiStatus, onStatusChange }) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const active = dpiStatus.active;

  const act = async (fn, okMsg) => {
    setLoading(true);
    try {
      const r = await window.electron[fn]();
      if (r?.success) { onStatusChange(); setToast({ message: okMsg, type: 'success' }); }
      else setToast({ message: r?.error || t('error'), type: 'error' });
    } catch (e) {
      setToast({ message: e.message, type: 'error' });
    } finally { setLoading(false); }
  };

  const onClick = () => active
    ? act('stopDPI', t('dpiBypassStopped'))
    : act('startDPI', `${t('dpiBypassRunning')}`);

  return (
    <>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="flex min-h-full flex-col items-center justify-center gap-7 py-6">
        {/* The shield — the one bold moment */}
        <div className="relative flex items-center justify-center">
          {active && (
            <span
              className="halo absolute rounded-full"
              style={{
                width: 180, height: 180,
                background: 'radial-gradient(circle, var(--accent-soft) 0%, transparent 70%)',
              }}
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
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor"
              className="h-16 w-16 transition-colors duration-500"
              style={{ color: active ? 'var(--accent)' : 'var(--text-faint)' }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
                    d="M12 3.5l6.5 2.4v5.3c0 4.1-2.7 7.9-6.5 9-3.8-1.1-6.5-4.9-6.5-9V5.9L12 3.5z" />
              {active && (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6"
                      d="M9 12l2 2 4-4" />
              )}
            </svg>
          </div>
        </div>

        {/* Status text */}
        <div className="text-center">
          <h2 className="text-2xl font-semibold tracking-tight"
              style={{ color: active ? 'var(--accent)' : 'var(--text)' }}>
            {active ? t('protected') : t('notProtected')}
          </h2>
          <p className="mt-1.5 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            {active ? t('dpiBypassRunning') : t('dpiBypassStopped')}
          </p>
        </div>

        {/* Primary action */}
        <button
          onClick={onClick}
          disabled={loading}
          className="w-full max-w-xs rounded-[var(--radius)] px-6 py-3.5 text-[15px] font-semibold transition-all active:scale-[0.99] disabled:opacity-60"
          style={
            active
              ? { background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid rgba(248,113,113,0.35)' }
              : { background: 'var(--accent)', color: '#07101c', border: '1px solid transparent' }
          }
        >
          {loading ? (active ? t('stopping') : t('starting')) : (active ? t('stop') : t('start'))}
        </button>
      </div>
    </>
  );
}
