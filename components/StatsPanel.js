'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import {
  ArrowDownIcon, ArrowUpIcon, ClockIcon, DatabaseIcon, InfoIcon, LinkIcon, ShieldCheckIcon,
} from './icons';

const HISTORY = 40;

/* Byte units are technical symbols (B, KB, MB…) and stay as-is in every language. */
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
const fmtRate = (b) => `${fmtBytes(b)}/s`;

/* Uptime as H:MM:SS — digits only, so it needs no per-language unit words. */
function fmtUptime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(s)}`;
}

function Spark({ data, color }) {
  const gid = useId().replace(/:/g, '');
  if (!data.length) return <div style={{ height: 34 }} />;
  const max = Math.max(...data, 1);
  const w = 100, h = 34;
  const pts = data.map((v, i) => `${(i / (HISTORY - 1)) * w},${h - (v / max) * (h - 4) - 2}`);
  const line = pts.join(' ');
  const lastX = ((data.length - 1) / (HISTORY - 1)) * w;
  const area = `0,${h} ${line} ${lastX},${h}`;
  return (
    // Time always runs left→right, also in RTL layouts.
    <svg viewBox={`0 0 ${w} ${h}`} className="block w-full" style={{ height: 34, direction: 'ltr' }} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.28 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#g${gid})`} />
      <polyline points={line} fill="none" style={{ stroke: color }} strokeWidth="1.5"
                strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Rate({ Icon, label, value, color, data }) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
          <Icon className="h-3.5 w-3.5" style={{ color }} />
          <span className="min-w-0 wrap-anywhere">{label}</span>
        </span>
        <span className="num text-[15px] font-semibold" dir="ltr" style={{ color }}>{value}</span>
      </div>
      <div className="mt-2"><Spark data={data} color={color} /></div>
    </div>
  );
}

function Stat({ Icon, label, value, sub }) {
  return (
    <div className="card-2 flex min-w-0 flex-col p-3.5">
      <div className="flex min-w-0 items-start gap-1.5 text-[12px] font-medium leading-snug" style={{ color: 'var(--text-dim)' }}>
        <Icon className="mt-[1px] h-3.5 w-3.5" style={{ color: 'var(--text-faint)' }} />
        <span className="min-w-0 wrap-anywhere">{label}</span>
      </div>
      <div className="num mt-auto truncate pt-1.5 text-[22px] font-semibold leading-tight" dir="ltr"
           style={{ color: 'var(--text)', textAlign: 'start' }} title={String(value)}>
        {value}
      </div>
      {sub != null && <div className="num mt-1 truncate text-[11.5px]" style={{ color: 'var(--text-faint)' }} title={sub}>{sub}</div>}
    </div>
  );
}

export default function StatsPanel({ active }) {
  const { t } = useLanguage();
  const [stats, setStats] = useState(null);
  const [dlRate, setDlRate] = useState(0);
  const [ulRate, setUlRate] = useState(0);
  const [dlHist, setDlHist] = useState([]);
  const [ulHist, setUlHist] = useState([]);
  const prev = useRef(null);
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
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, []);

  const s = stats || {};

  return (
    <div className="flex flex-col gap-3 py-4">
      {!active && (
        <div className="flex items-start gap-2.5 rounded-[var(--radius-sm)] px-3.5 py-3 text-[12.5px] leading-snug"
             style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', color: 'var(--text-dim)' }}>
          <InfoIcon className="mt-[1px] h-4 w-4" style={{ color: 'var(--accent)' }} />
          <p className="min-w-0">{t('statsInactiveHint')}</p>
        </div>
      )}

      {/* throughput */}
      <div className="card flex flex-col gap-4 p-4">
        <Rate Icon={ArrowDownIcon} label={t('download')} value={fmtRate(dlRate)} color="var(--accent)" data={dlHist} />
        <Rate Icon={ArrowUpIcon} label={t('upload')} value={fmtRate(ulRate)} color="var(--ok)" data={ulHist} />
      </div>

      {/* counters */}
      <div className="grid grid-cols-2 gap-3">
        <Stat Icon={LinkIcon} label={t('connections')} value={s.connsActive ?? 0}
              sub={t('totalCount', { count: s.connsTotal ?? 0 })} />
        <Stat Icon={ShieldCheckIcon} label={t('bypassed')} value={s.desync ?? 0} sub={`TLS ${s.tlsSeen ?? 0}`} />
        <Stat Icon={DatabaseIcon} label={t('dataTransferred')} value={fmtBytes((s.bytesUp || 0) + (s.bytesDown || 0))} />
        <Stat Icon={ClockIcon} label={t('uptime')} value={s.uptime ? fmtUptime(s.uptime) : '—'} />
      </div>
    </div>
  );
}
