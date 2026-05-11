'use client';

import { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

const HISTORY = 30;

function fmt(bps) {
  if (bps == null || bps === 0) return '0 B/s';
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`;
  if (bps >= 1024)    return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function Sparkline({ data, color, height = 44 }) {
  if (!data || data.length < 2) {
    return <div className="h-11 w-full rounded bg-white/[0.03]" />;
  }
  const max = Math.max(...data, 1);
  const w = 200;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = height - (v / max) * height * 0.88 - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      className="w-full"
      style={{ height }}
      preserveAspectRatio="none"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

function StatCard({ label, value, unit, history, color, icon }) {
  return (
    <div className="glass-dark rounded-lg p-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">{label}</span>
        <span className="text-[10px] text-white/30">{icon}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-black tabular-nums ${color}`}>{value}</span>
        {unit && <span className="text-[11px] text-white/40">{unit}</span>}
      </div>
      <div className="mt-0.5">
        <Sparkline data={history} color={color.replace('text-', 'var(--tw-')} />
      </div>
    </div>
  );
}

function PingCard({ label, value, history, measuring }) {
  const color =
    value == null   ? 'text-white/30'
    : value < 50   ? 'text-emerald-400'
    : value < 120  ? 'text-yellow-400'
    : 'text-red-400';

  const strokeColor =
    value == null  ? '#6b7280'
    : value < 50  ? '#34d399'
    : value < 120 ? '#facc15'
    : '#f87171';

  return (
    <div className="glass-dark rounded-lg p-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">{label}</span>
        <span className="text-[10px] text-white/30">◎</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-black tabular-nums transition-colors duration-300 ${color}`}>
          {measuring ? '…' : value != null ? value : '—'}
        </span>
        <span className="text-[11px] text-white/40">ms</span>
      </div>
      <div className="mt-0.5">
        <Sparkline data={history} color={strokeColor} />
      </div>
    </div>
  );
}

export default function StatsPanel() {
  const { t } = useLanguage();
  const [measuring, setMeasuring]     = useState(true);
  const [ping, setPing]               = useState(null);
  const [dl, setDl]                   = useState(null);
  const [ul, setUl]                   = useState(null);
  const [pingHist, setPingHist]       = useState([]);
  const [dlHist, setDlHist]           = useState([]);
  const [ulHist, setUlHist]           = useState([]);
  const timerRef                       = useRef(null);

  const push = (setter, val) =>
    setter((prev) => [...prev.slice(-(HISTORY - 1)), val ?? 0]);

  const poll = async () => {
    if (typeof window === 'undefined' || !window.electron?.getNetStats) return;
    try {
      const stats = await window.electron.getNetStats();
      setPing(stats.ping);
      setDl(stats.dl);
      setUl(stats.ul);
      push(setPingHist, stats.ping);
      push(setDlHist,   stats.dl);
      push(setUlHist,   stats.ul);
    } catch {
      /* ignore */
    } finally {
      setMeasuring(false);
    }
  };

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, 2000);
    return () => clearInterval(timerRef.current);
  }, []);

  return (
    <div className="flex flex-col gap-3 pb-2">
      <PingCard
        label={t('ping')}
        value={ping}
        history={pingHist}
        measuring={measuring}
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="glass-dark rounded-lg p-3 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">
              {t('download')}
            </span>
            <span className="text-[10px] text-sky-400/50">↓</span>
          </div>
          <span className="text-lg font-black tabular-nums text-sky-400 leading-none">
            {measuring ? t('measuring') : fmt(dl)}
          </span>
          <div className="mt-0.5">
            <Sparkline data={dlHist} color="#38bdf8" />
          </div>
        </div>

        <div className="glass-dark rounded-lg p-3 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">
              {t('upload')}
            </span>
            <span className="text-[10px] text-violet-400/50">↑</span>
          </div>
          <span className="text-lg font-black tabular-nums text-violet-400 leading-none">
            {measuring ? t('measuring') : fmt(ul)}
          </span>
          <div className="mt-0.5">
            <Sparkline data={ulHist} color="#a78bfa" />
          </div>
        </div>
      </div>

      <div className="glass-dark rounded-lg p-3 space-y-1.5">
        <p className="text-[10px] uppercase tracking-widest font-bold text-white/40 mb-2">
          {t('networkStats')}
        </p>
        <Row label={t('ping')}     value={ping != null ? `${ping} ms` : '—'} />
        <Row label={t('download')} value={fmt(dl)} />
        <Row label={t('upload')}   value={fmt(ul)} />
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-white/45">{label}</span>
      <span className="font-semibold tabular-nums text-white/80">{value}</span>
    </div>
  );
}
