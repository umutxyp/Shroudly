'use client';

export default function TitleBar() {
  const call = (fn) => () => { if (typeof window !== 'undefined' && window.electron?.[fn]) window.electron[fn](); };

  const Btn = ({ onClick, label, danger, children }) => (
    <button
      onClick={onClick}
      aria-label={label}
      className="no-drag flex h-8 w-11 items-center justify-center transition-colors"
      style={{ color: 'var(--text-faint)' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = danger ? 'var(--danger)' : 'var(--surface-hover)'; e.currentTarget.style.color = danger ? '#fff' : 'var(--text)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-faint)'; }}
    >
      {children}
    </button>
  );

  return (
    <div
      className="drag flex h-9 shrink-0 items-center justify-between pl-3"
      style={{ borderBottom: '1px solid var(--line)' }}
    >
      <span className="select-none text-[11px] font-medium tracking-wide" style={{ color: 'var(--text-faint)' }}>
        Shroudly
      </span>
      <div className="flex">
        <Btn onClick={call('minimizeWindow')} label="Minimize">
          <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor"><path strokeWidth="1.3" d="M3 7h8"/></svg>
        </Btn>
        <Btn onClick={call('maximizeWindow')} label="Maximize">
          <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor"><rect x="3.3" y="3.3" width="7.4" height="7.4" rx="1.3" strokeWidth="1.3"/></svg>
        </Btn>
        <Btn onClick={call('closeWindow')} label="Close" danger>
          <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor"><path strokeWidth="1.3" strokeLinecap="round" d="M4 4l6 6M10 4l-6 6"/></svg>
        </Btn>
      </div>
    </div>
  );
}
