'use client';

import { useEffect, useState, useRef } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

const HISTORY = 30;

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtRate(bytesPerSec) {
  return `${fmtBytes(bytesPerSec)}/s`;
}

function Sparkline({ data, color }) {
  if (!data.length) return <div className="h-8" />;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (HISTORY - 1)) * 100},${30 - (v / max) * 28}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" className="h-8 w-full" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export default function StatsPanel() {
  const { t } = useLanguage();
  const [stats, setStats] = useState(null);
  const [dlRate, setDlRate] = useState(0);
  const [ulRate, setUlRate] = useState(0);
  const [dlHist, setDlHist] = useState([]);
  const [ulHist, setUlHist] = useState([]);
  const prev = useRef(null);
  const timer = useRef(null);

  const push = (setter, v) => setter((p) => [...p.slice(-(HISTORY - 1)), v]);

  const poll = async () => {
    if (typeof window === 'undefined' || !window.electron?.getNetStats) return;
    try {
      const s = await window.electron.getNetStats();
      setStats(s);
      const now = Date.now();
      if (prev.current) {
        const dt = (now - prev.current.t) / 1000;
        if (dt > 0) {
          const dl = Math.max(0, (s.bytesDown - prev.current.down) / dt);
          const ul = Math.max(0, (s.bytesUp - prev.current.up) / dt);
          setDlRate(dl); setUlRate(ul);
          push(setDlHist, dl); push(setUlHist, ul);
        }
      }
      prev.current = { t: now, down: s.bytesDown, up: s.bytesUp };
    } catch {}
  };

  useEffect(() => {
    poll();
    timer.current = setInterval(poll, 1000);
    return () => clearInterval(timer.current);
  }, []);

  const s = stats || {};

  return (
    <div className="flex flex-col gap-3 pb-2">
      <div className="glass-dark rounded-lg p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">{t('download')}</span>
          <span className="text-[10px] text-sky-400/50">↓</span>
        </div>
        <span className="text-lg font-black tabular-nums text-sky-400 leading-none">{fmtRate(dlRate)}</span>
        <div className="mt-1"><Sparkline data={dlHist} color="#38bdf8" /></div>
      </div>

      <div className="glass-dark rounded-lg p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">{t('upload')}</span>
          <span className="text-[10px] text-emerald-400/50">↑</span>
        </div>
        <span className="text-lg font-black tabular-nums text-emerald-400 leading-none">{fmtRate(ulRate)}</span>
        <div className="mt-1"><Sparkline data={ulHist} color="#34d399" /></div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="glass-dark rounded-lg p-3">
          <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">{t('connections')}</span>
          <div className="text-2xl font-black tabular-nums text-white">{s.connsActive ?? 0}</div>
          <div className="text-[10px] text-white/40">{t('total')}: {s.connsTotal ?? 0}</div>
        </div>
        <div className="glass-dark rounded-lg p-3">
          <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">{t('bypassed')}</span>
          <div className="text-2xl font-black tabular-nums text-white">{s.desync ?? 0}</div>
          <div className="text-[10px] text-white/40">TLS: {s.tlsSeen ?? 0}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="glass-dark rounded-lg p-3">
          <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">{t('dataTransferred')}</span>
          <div className="text-base font-black tabular-nums text-white">{fmtBytes((s.bytesUp || 0) + (s.bytesDown || 0))}</div>
        </div>
        <div className="glass-dark rounded-lg p-3">
          <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">{t('uptime')}</span>
          <div className="text-base font-black tabular-nums text-white">
            {s.uptime ? `${Math.floor(s.uptime / 60000)}m ${Math.floor((s.uptime % 60000) / 1000)}s` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}
