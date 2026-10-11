'use client';

import { useEffect, useState, useRef } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

const HISTORY = 40;

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
const fmtRate = (b) => `${fmtBytes(b)}/s`;

function Spark({ data, color }) {
  if (!data.length) return <div style={{ height: 34 }} />;
  const max = Math.max(...data, 1);
  const w = 100, h = 34;
  const pts = data.map((v, i) => `${(i / (HISTORY - 1)) * w},${h - (v / max) * (h - 4) - 2}`);
  const line = pts.join(' ');
  const area = `0,${h} ${line} ${w},${h}`;
  const id = color.replace('#', '');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 34 }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#g${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="card-2 p-3.5">
      <div className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>{label}</div>
      <div className="num mt-1 text-[22px] font-semibold leading-none" style={{ color: 'var(--text)' }}>{value}</div>
      {sub != null && <div className="num mt-1.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>{sub}</div>}
    </div>
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
  const push = (set, v) => set((p) => [...p.slice(-(HISTORY - 1)), v]);

  useEffect(() => {
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
            setDlRate(dl); setUlRate(ul); push(setDlHist, dl); push(setUlHist, ul);
          }
        }
        prev.current = { t: now, down: s.bytesDown, up: s.bytesUp };
      } catch {}
    };
    poll();
    timer.current = setInterval(poll, 1000);
    return () => clearInterval(timer.current);
  }, []);

  const s = stats || {};
  const upMin = s.uptime ? Math.floor(s.uptime / 60000) : 0;
  const upSec = s.uptime ? Math.floor((s.uptime % 60000) / 1000) : 0;

  return (
    <div className="flex flex-col gap-3 py-4">
      {/* throughput */}
      <div className="card p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>{t('download')}</span>
          <span className="num text-[15px] font-semibold" style={{ color: 'var(--accent)' }}>{fmtRate(dlRate)}</span>
        </div>
        <div className="mt-2"><Spark data={dlHist} color="#38bdf8" /></div>
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>{t('upload')}</span>
          <span className="num text-[15px] font-semibold" style={{ color: 'var(--ok)' }}>{fmtRate(ulRate)}</span>
        </div>
        <div className="mt-2"><Spark data={ulHist} color="#34d399" /></div>
      </div>

      {/* counters */}
      <div className="grid grid-cols-2 gap-3">
        <Stat label={t('connections')} value={s.connsActive ?? 0} sub={`${t('total')}: ${s.connsTotal ?? 0}`} />
        <Stat label={t('bypassed')} value={s.desync ?? 0} sub={`TLS: ${s.tlsSeen ?? 0}`} />
        <Stat label={t('dataTransferred')} value={fmtBytes((s.bytesUp || 0) + (s.bytesDown || 0))} />
        <Stat label={t('uptime')} value={s.uptime ? `${upMin}m ${upSec}s` : '—'} />
      </div>
    </div>
  );
}
