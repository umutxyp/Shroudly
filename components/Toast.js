'use client';

import { useEffect, useRef } from 'react';
import { AlertTriangleIcon, CheckCircleIcon, InfoIcon, XCircleIcon } from './icons';

const TONE = {
  success: { fg: 'var(--ok)',     line: 'var(--ok-line)',     Icon: CheckCircleIcon },
  error:   { fg: 'var(--danger)', line: 'var(--danger-line)', Icon: XCircleIcon },
  warning: { fg: 'var(--warn)',   line: 'var(--warn-line)',   Icon: AlertTriangleIcon },
  info:    { fg: 'var(--accent)', line: 'var(--accent-line)', Icon: InfoIcon },
};

/* Toast: sits just below the title bar (never over the drag region), wraps
   long messages instead of cutting them off, closes on click or after a delay. */
export default function Toast({ message, detail, type = 'info', onClose, duration }) {
  // Keep the latest onClose without restarting the timer on every parent render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const ms = duration ?? (type === 'error' ? 6000 : 2800);
  useEffect(() => {
    if (ms <= 0) return undefined;
    const id = setTimeout(() => closeRef.current?.(), ms);
    return () => clearTimeout(id);
  }, [ms, message, detail]);

  const tone = TONE[type] || TONE.info;
  const { Icon } = tone;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-[90] flex justify-center px-4">
      <div
        role={type === 'error' ? 'alert' : 'status'}
        aria-live={type === 'error' ? 'assertive' : 'polite'}
        onClick={() => closeRef.current?.()}
        className="rise pointer-events-auto flex max-w-[420px] cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] px-3.5 py-2.5 text-[13px] font-medium"
        style={{ background: 'var(--surface-2)', color: 'var(--text)', border: `1px solid ${tone.line}`, boxShadow: 'var(--shadow-pop)' }}
      >
        <Icon className="mt-[1px] h-[18px] w-[18px]" style={{ color: tone.fg }} />
        <div className="min-w-0 flex-1 wrap-anywhere">
          <p className="leading-snug">{message}</p>
          {detail && (
            <p className="mono mt-1 line-clamp-3 text-[11.5px] font-normal leading-snug" dir="auto" style={{ color: 'var(--text-dim)' }}>
              {detail}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
