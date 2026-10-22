'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import {
  ArrowDownIcon, ArrowUpIcon, ClockIcon, DatabaseIcon, InfoIcon, LinkIcon, ShieldCheckIcon, UsersIcon,
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
  /* Before any traffic there is nothing to plot, but the space is still
   * reserved so the card does not jump when the first sample arrives. Draw a
   * resting baseline in it: an empty box of the same height reads as a
   * rendering fault rather than as "no traffic yet". */
  if (!data.length) {
    return (
      <svg viewBox="0 0 100 34" className="block w-full" style={{ height: 34 }}
           preserveAspectRatio="none" aria-hidden>
        <line x1="0" y1="32" x2="100" y2="32" style={{ stroke: color, opacity: 0.35 }}
              strokeWidth="1.5" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
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
  const { t, locale } = useLanguage();
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
        // Rates come from the engine's own sample times: the UI's poll and the
        // engine's are not in step, so a sample can be read twice (would show
        // 0) or skipped (would show double).
        const t = s.sampledAt || 0;
        if (!t) { setDlRate(0); setUlRate(0); prev.current = null; return; }
        if (prev.current && t === prev.current.t) return;
        if (prev.current) {
          const dt = (t - prev.current.t) / 1000;
          if (dt > 0) {
            const dl = Math.max(0, (s.bytesDown - prev.current.down) / dt);
            const ul = Math.max(0, (s.bytesUp - prev.current.up) / dt);
            setDlRate(dl); setUlRate(ul); push(setDlHist, dl); push(setUlHist, ul);
          }
        }
        prev.current = { t, down: s.bytesDown, up: s.bytesUp };
      } catch {}
    };
    poll();
    const timer = setInterval(poll, 500);
    return () => clearInterval(timer);
  }, []);

  // Live number of Shroudly apps running right now (all users, anonymous)
  const [online, setOnline] = useState(null);
  useEffect(() => {
    const e = typeof window !== 'undefined' ? window.electron : null;
    if (!e?.getOnlineCount) return undefined;
    e.getOnlineCount().then((n) => { if (n != null) setOnline(n); }).catch(() => {});
    e.onOnlineCount?.((n) => setOnline(n));
    // While this tab is on screen, re-read the count so it follows others
    // joining and leaving; skipped while the window is hidden.
    const refresh = () => { if (document.visibilityState === 'visible') e.refreshOnlineCount?.().catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => { clearInterval(timer); e.removeOnlineCountListener?.(); };
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

      {/* live user count */}
      <div className="card flex items-center gap-3 p-4">
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>
          <UsersIcon className="h-[18px] w-[18px]" />
          <span aria-hidden className="live-dot absolute -end-0.5 -top-0.5 h-2.5 w-2.5 rounded-full"
                style={{ background: 'var(--ok)', border: '2px solid var(--surface)' }} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium leading-snug" style={{ color: 'var(--text-dim)' }}>{t('onlineNow')}</p>
          <p className="text-[11.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('onlineNowDesc')}</p>
        </div>
        <span className="num shrink-0 text-[24px] font-semibold leading-none" dir="ltr" style={{ color: 'var(--text)' }}>
          {online == null ? '—' : online.toLocaleString(locale)}
        </span>
      </div>

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
        {s.adsBlocked > 0 && <Stat Icon={ShieldCheckIcon} label={t('adsBlocked')} value={s.adsBlocked} />}
      </div>
    </div>
  );
}
