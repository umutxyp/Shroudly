'use client';

import { useState, useEffect } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

export default function LogsPanel() {
  const { t } = useLanguage();
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    loadLogs();

    // Listen for new logs
    if (typeof window !== 'undefined' && window.electron) {
      window.electron.onNewLog((log) => {
        setLogs(prev => [...prev, log]);
      });

      return () => {
        window.electron.removeLogListener();
      };
    }
  }, []);

  const loadLogs = async () => {
    if (typeof window !== 'undefined' && window.electron) {
      const systemLogs = await window.electron.getLogs();
      setLogs(systemLogs);
    }
  };

  const handleClearLogs = async () => {
    if (typeof window !== 'undefined' && window.electron) {
      await window.electron.clearLogs();
      setLogs([]);
    }
  };

  const getLevelColor = (level) => {
    switch (level) {
      case 'error': return 'text-red-400';
      case 'warning': return 'text-yellow-400';
      case 'success': return 'text-green-400';
      case 'info': return 'text-blue-400';
      default: return 'text-gray-400';
    }
  };

  const getLevelIcon = (level) => {
    switch (level) {
      case 'error': return '❌';
      case 'warning': return '⚠️';
      case 'success': return '✅';
      case 'info': return 'ℹ️';
      default: return '•';
    }
  };

  const filteredLogs = filter === 'all' 
    ? logs 
    : logs.filter(log => log.level === filter);

  return (
    <div className="glass-dark rounded-lg p-4 flex flex-col" style={{ minHeight: 0 }}>
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-base font-bold text-primary-400">{t('systemLogs')}</h2>
        <div className="flex flex-wrap gap-1">
          {['all', 'info', 'success', 'warning', 'error'].map((level) => (
            <button
              key={level}
              onClick={() => setFilter(level)}
              className={`px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                filter === level
                  ? 'bg-primary-500 text-white'
                  : 'bg-dark-400 text-gray-400 hover:bg-dark-300'
              }`}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      {/* Log area — grows with window, min 200px */}
      <div
        className="bg-dark-400 rounded-lg p-3 overflow-y-auto thin-scrollbar font-mono text-[11px] leading-relaxed space-y-0.5 flex-1"
        style={{ minHeight: '200px', maxHeight: 'calc(100vh - 400px)' }}
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-xs">
            {t('noLogs')}
          </div>
        ) : (
          filteredLogs.map((log, index) => (
            <div
              key={index}
              className="flex items-start gap-2 hover:bg-dark-300 px-1.5 py-0.5 rounded transition-colors"
            >
              <span className="text-gray-600 whitespace-nowrap shrink-0 tabular-nums">
                {new Date(log.time).toLocaleTimeString()}
              </span>
              <span className={`shrink-0 ${getLevelColor(log.level)}`}>
                {getLevelIcon(log.level)}
              </span>
              <span className="flex-1 text-gray-300 break-all min-w-0">{log.message}</span>
            </div>
          ))
        )}
      </div>

      {/* Actions */}
      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-[10px] text-gray-600">
          {filteredLogs.length} {t('logs') || 'logs'}
        </span>
        <button
          onClick={handleClearLogs}
          className="bg-red-600/80 hover:bg-red-600 px-3 py-1 rounded text-xs font-medium transition-colors"
        >
          {t('clearLogs')}
        </button>
      </div>
    </div>
  );
}
