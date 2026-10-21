'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { CheckIcon, CopyIcon, LogsIcon, TrashIcon } from './icons';
import { localizeLog } from './logText';

const LEVEL = {
  error:   'var(--danger)',
  warning: 'var(--warn)',
  success: 'var(--ok)',
  info:    'var(--accent)',
};

const FILTERS = [
  { id: 'all', key: 'logAll' },
  { id: 'info', key: 'logInfo' },
  { id: 'success', key: 'logSuccess' },
  { id: 'warning', key: 'logWarning' },
  { id: 'error', key: 'logError' },
];

export default function LogsPanel() {
  const { t, locale } = useLanguage();
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('all');
  // "Copy logs": shown as done for a moment after the log went to the clipboard.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(null);
  const listRef = useRef(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.getLogs) return undefined;
    let alive = true;
    window.electron.getLogs().then((l) => { if (alive) setLogs(Array.isArray(l) ? l : []); }).catch(() => {});
    window.electron.onNewLog?.((log) => setLogs((p) => [...p.slice(-499), log]));
    return () => { alive = false; window.electron.removeLogListener?.(); };
  }, []);

  // Follow new entries only while the user is already at the bottom.
  const onScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [logs, filter]);

  const clear = async () => {
    if (typeof window === 'undefined' || !window.electron?.clearLogs) return;
    try {
      await window.electron.clearLogs();
      setLogs(await window.electron.getLogs());
    } catch { setLogs([]); }
  };

  // The whole log as the background process wrote it (English, with times
  // and levels) and a short header: what a report needs, whatever language
  // the window is in. To the clipboard only.
  const copy = async () => {
    if (typeof window === 'undefined' || !window.electron?.copyLogs) return;
    try {
      const r = await window.electron.copyLogs();
      if (!r || !r.ok) return;
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {}
  };
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const timeFmt = useMemo(() => {
    try { return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
    catch { return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  }, [locale]);

  const shown = filter === 'all' ? logs : logs.filter((l) => l.level === filter);

  return (
    <div className="flex h-full min-h-[320px] flex-col gap-3 py-4">
      {/* filters */}
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar">
        {FILTERS.map(({ id, key }) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            aria-pressed={filter === id}
            className="chip inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium leading-snug"
          >
            {id !== 'all' && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LEVEL[id] }} />}
            {t(key)}
          </button>
        ))}
      </div>

      {/* log stream */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="card scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2"
        role="log"
        aria-live="polite"
      >
        {shown.length === 0 ? (
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 px-4 text-center text-[13px]"
               style={{ color: 'var(--text-faint)' }}>
            <LogsIcon className="h-7 w-7" strokeWidth={1.5} />
            <p>{logs.length === 0 ? t('noLogs') : t('noLogsFiltered')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {shown.map((log, i) => {
              const d = new Date(log.time || log.timestamp);
              const time = Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
              return (
                <li key={`${log.timestamp || ''}-${i}`} className="row-hover flex items-start gap-2 rounded-[8px] px-1.5 py-1 text-[12px] leading-relaxed">
                  <span className="num shrink-0" dir="ltr" style={{ color: 'var(--text-faint)' }}>{time}</span>
                  <span className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LEVEL[log.level] || 'var(--text-faint)' }} />
                  <span className="min-w-0 flex-1 select-text wrap-anywhere" dir="auto" style={{ color: 'var(--text)' }}>
                    {localizeLog(log.message, t)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* footer actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="num text-[12px]" style={{ color: 'var(--text-faint)' }}>
          {t('logEntries', { count: shown.length })}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={copy}
            disabled={logs.length === 0}
            data-testid="copy-logs"
            className="btn btn-ghost rounded-full px-3 py-1.5 text-[12px] font-medium"
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
            <span aria-live="polite">{copied ? t('logsCopied') : t('copyLogs')}</span>
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={logs.length === 0}
            className="btn btn-ghost rounded-full px-3 py-1.5 text-[12px] font-medium"
          >
            <TrashIcon className="h-3.5 w-3.5" />
            <span>{t('clearLogs')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
