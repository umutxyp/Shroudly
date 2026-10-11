'use client';

import { useEffect } from 'react';

const TONE = {
  success: { fg: 'var(--ok)',     bg: 'var(--ok-soft)',     line: 'rgba(52,211,153,0.4)' },
  error:   { fg: 'var(--danger)', bg: 'var(--danger-soft)', line: 'rgba(248,113,113,0.4)' },
  warning: { fg: 'var(--warn)',   bg: 'var(--warn-soft)',   line: 'rgba(251,191,36,0.4)' },
  info:    { fg: 'var(--accent)', bg: 'var(--accent-soft)', line: 'var(--accent-line)' },
};

export default function Toast({ message, type = 'info', onClose, duration = 2800 }) {
  useEffect(() => {
    if (duration > 0) { const t = setTimeout(onClose, duration); return () => clearTimeout(t); }
  }, [duration, onClose]);

  const tone = TONE[type] || TONE.info;

  return (
    <div
      className="rise fixed left-1/2 top-3 z-50 flex max-w-[92%] -translate-x-1/2 items-center gap-2.5 rounded-full px-4 py-2 text-[13px] font-medium backdrop-blur"
      style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.line}` }}
      role="status"
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'currentColor' }} />
      <span className="truncate">{message}</span>
    </div>
  );
}
