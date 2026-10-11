'use client';

import { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

const LEVEL = {
  error:   'var(--danger)',
  warning: 'var(--warn)',
  success: 'var(--ok)',
  info:    'var(--accent)',
};

export default function LogsPanel() {
  const { t } = useLanguage();
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('all');
  const endRef = useRef(null);

  useEffect(() => {
    const load = async () => {
      if (typeof window !== 'undefined' && window.electron) setLogs(await window.electron.getLogs());
    };
    load();
    if (typeof window !== 'undefined' && window.electron) {
      window.electron.onNewLog((log) => setLogs((p) => [...p, log]));
      return () => window.electron.removeLogListener();
    }
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [logs]);

  const clear = async () => {
    if (typeof window !== 'undefined' && window.electron) { await window.electron.clearLogs(); setLogs([]); }
  };

  const shown = filter === 'all' ? logs : logs.filter((l) => l.level === filter);
  const filters = ['all', 'info', 'success', 'warning', 'error'];

  return (
    <div className="flex h-full flex-col gap-3 py-4">
      {/* filters */}
      <div className="flex items-center gap-1.5 overflow-x-auto scroll pb-0.5">
        {filters.map((lv) => {
          const on = filter === lv;
          return (
            <button
              key={lv}
              onClick={() => setFilter(lv)}
              className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium capitalize transition-colors"
              style={{
                background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                color: on ? 'var(--accent)' : 'var(--text-dim)',
                border: `1px solid ${on ? 'var(--accent-line)' : 'var(--line)'}`,
              }}
            >
              {t(lv) || lv}
            </button>
          );
        })}
      </div>

      {/* log stream */}
      <div className="card scroll min-h-0 flex-1 overflow-y-auto p-2.5">
        {shown.length === 0 ? (
          <div className="flex h-full min-h-[180px] items-center justify-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
            {t('noLogs')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {shown.map((log, i) => (
              <div key={i} className="flex items-start gap-2 rounded px-1.5 py-1 text-[12px] leading-relaxed">
                <span className="num shrink-0" style={{ color: 'var(--text-faint)' }}>
                  {new Date(log.time || log.timestamp).toLocaleTimeString()}
                </span>
                <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LEVEL[log.level] || 'var(--text-faint)' }} />
                <span className="min-w-0 flex-1 break-words" style={{ color: 'var(--text)' }}>{log.message}</span>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* footer actions */}
      <div className="flex items-center justify-between">
        <span className="num text-[12px]" style={{ color: 'var(--text-faint)' }}>{shown.length}</span>
        <button
          onClick={clear}
          className="rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors"
          style={{ background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--line)' }}
        >
          {t('clearLogs')}
        </button>
      </div>
    </div>
  );
}
