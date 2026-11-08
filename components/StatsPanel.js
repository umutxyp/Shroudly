'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import {
  ArrowDownIcon, ArrowUpIcon, ClockIcon, DatabaseIcon, InfoIcon, LinkIcon, SearchIcon, ShieldCheckIcon, UsersIcon,
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

/* subSlot: a line kept under the value even without a sub, so the values of
 * a row's cards stand at the same height (Connections carries its total). */
function Stat({ Icon, label, value, sub, wide = false, subSlot = false }) {
  return (
    <div className={`card-2 flex min-w-0 flex-col p-3.5 ${wide ? 'col-span-2' : ''}`}>
      <div className="flex min-w-0 items-start gap-1.5 text-[12px] font-medium leading-snug" style={{ color: 'var(--text-dim)' }}>
        <Icon className="mt-[1px] h-3.5 w-3.5" style={{ color: 'var(--text-faint)' }} />
        <span className="min-w-0 wrap-anywhere">{label}</span>
      </div>
      <div className="num mt-auto truncate pt-1.5 text-[22px] font-semibold leading-tight" dir="ltr"
           style={{ color: 'var(--text)', textAlign: 'start' }} title={String(value)}>
        {value}
      </div>
      {sub != null ? <div className="num mt-1 truncate text-[11.5px]" style={{ color: 'var(--text-faint)' }} title={sub}>{sub}</div>
        : subSlot && <div className="mt-1 text-[11.5px]" aria-hidden="true">{'\u00a0'}</div>}
    </div>
  );
}


/* A name as typed into the search box, if it could be a site's name. */
const NAME = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/* What went through Shroudly, by site (issue #74): open now, the data each
 * way, how it went out; a site blocked here has its connections ended and
 * new ones refused (electron/engine-manager.js setBlocked). Names Shroudly
 * itself uses are marked, and blocking one asks first. */
function Connections({ active }) {
  const { t } = useLanguage();
  const [data, setData] = useState({ rows: [], blocked: [], torSites: [] });
  const [q, setQ] = useState('');
  useEffect(() => {
    const e = typeof window !== 'undefined' ? window.electron : null;
    if (!e?.getConnections) return undefined;
    let alive = true;
    const load = () => { if (document.visibilityState === 'visible') e.getConnections().then((d) => { if (alive && d) setData(d); }).catch(() => {}); };
    load();
    const timer = setInterval(load, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [active]);
  // A name Shroudly itself needs (its DNS, Tor, codeshare.me, the user's own
  // server) has no Block: blocking it would only break Shroudly.
  const block = async (host, on) => {
    try {
      const r = await window.electron.setBlocked(host, on);
      if (r && r.ok) setData((d) => ({ ...d, blocked: r.blocked, rows: d.rows.map((x) => (x.host === host || x.host.endsWith(`.${host}`) ? { ...x, blocked: on ? 1 : 0, active: on ? 0 : x.active } : x)) }));
    } catch {}
  };
  // Through Tor (the last way out): for a site that turns the user's
  // country away itself; choosing it is the consent to Tor (main.js).
  const torSite = async (host, on) => {
    try {
      const r = await window.electron.setTorSite(host, on);
      if (r && r.ok) setData((d) => ({ ...d, torSites: r.torSites }));
    } catch {}
  };
  const torSites = data.torSites || [];
  const viaTor = (h) => torSites.some((n) => h === n || h.endsWith(`.${n}`));
  const needle = q.trim().toLowerCase();
  const rows = data.rows.filter((r) => !needle || r.host.includes(needle)).slice(0, 100);
  const blockedOnly = (data.blocked || []).filter((h) => !data.rows.some((r) => r.host === h) && (!needle || h.includes(needle)));
  const canBlockTyped = NAME.test(needle) && !(data.blocked || []).includes(needle) && !data.rows.some((r) => r.host === needle)
    && !(data.ownNames || []).some((n) => needle === n || needle.endsWith(`.${n}`));
  const canTorTyped = canBlockTyped && data.torOk && !viaTor(needle);
  const torOnly = torSites.filter((h) => !data.rows.some((r) => r.host === h) && (!needle || h.includes(needle)));
  const route = (r) => (r.route === 'tor' ? t('connsRouteTor') : r.route === 'server' ? t('connsRouteServer') : r.route === 'technique' ? t('connsRouteTechnique') : null);
  const badge = (text, color) => (
    <span className="shrink-0 rounded-full px-1.5 py-[1px] text-[10.5px] font-semibold" style={{ background: 'var(--surface-2)', color }}>{text}</span>
  );
  const btn = 'btn btn-ghost shrink-0 rounded-[7px] px-2.5 py-1 text-[11.5px] font-semibold';
  return (
    <div className="card flex flex-col gap-2.5 p-4">
      <div>
        <p className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>{t('connsTitle')}</p>
        <p className="mt-0.5 text-[11.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('connsDesc')}</p>
        {data.torOk && <p className="mt-1 text-[11.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('connsTorDesc')}</p>}
      </div>
      <label className="flex items-center gap-2 rounded-[8px] px-2.5 py-1.5" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
        <SearchIcon className="h-3.5 w-3.5" style={{ color: 'var(--text-faint)' }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('connsSearch')} dir="ltr" spellCheck={false}
               className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" style={{ color: 'var(--text)' }} />
      </label>
      {canBlockTyped && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { block(needle, true); setQ(''); }} className={btn}>{t('connsBlockName', { host: needle })}</button>
          {canTorTyped && <button type="button" onClick={() => { torSite(needle, true); setQ(''); }} className={btn}>{t('connsTorName', { host: needle })}</button>}
        </div>
      )}
      {!rows.length && !blockedOnly.length && !torOnly.length && !canBlockTyped && (
        <p className="py-2 text-[12px]" style={{ color: 'var(--text-faint)' }}>{active ? t('connsEmpty') : t('statsInactiveHint')}</p>
      )}
      <div className="flex flex-col divide-y" style={{ borderColor: 'var(--line)' }}>
        {rows.map((r) => (
          <div key={r.host} className="flex min-w-0 items-center gap-2 py-2">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.blocked ? 'var(--warn)' : r.active > 0 ? 'var(--ok)' : 'var(--line)' }} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[12.5px] font-medium" dir="ltr" style={{ color: 'var(--text)' }} title={r.host}>{r.host}</span>
                {r.system && badge(t('connsSystem'), 'var(--accent)')}
                {route(r) && badge(route(r), 'var(--text-dim)')}
                {viaTor(r.host) && r.route !== 'tor' && badge(t('connsTorChosen'), 'var(--accent)')}
              </div>
              <div className="num mt-0.5 flex flex-wrap gap-x-2.5 text-[11px]" dir="ltr" style={{ color: 'var(--text-faint)', justifyContent: 'flex-start' }}>
                {r.blocked
                  ? <span style={{ color: 'var(--warn)' }}>{t('connsBlocked')}{r.refused > 0 ? ` · ${t('connsRefused', { count: r.refused })}` : ''}</span>
                  : <>
                      <span>↓ {fmtBytes(r.down)}</span><span>↑ {fmtBytes(r.up)}</span>
                      {r.active > 0 && <span>{t('connsOpen', { count: r.active })}</span>}
                    </>}
              </div>
            </div>
            {!r.blocked && !r.system && data.torOk && (viaTor(r.host)
              ? <button type="button" onClick={() => torSite(torSites.find((n) => r.host === n || r.host.endsWith(`.${n}`)), false)} className={btn} style={{ color: 'var(--accent)' }}>{t('connsTorBack')}</button>
              : <button type="button" onClick={() => torSite(r.host, true)} className={btn}>{t('connsTor')}</button>)}
            {r.blocked
              ? <button type="button" onClick={() => block(r.host, false)} className={btn}>{t('connsAllow')}</button>
              : !r.system && <button type="button" onClick={() => block(r.host, true)} className={btn}>{t('connsBlock')}</button>}
          </div>
        ))}
        {torOnly.map((h) => (
          <div key={`t-${h}`} className="flex min-w-0 items-center gap-2 py-2">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" dir="ltr" style={{ color: 'var(--text)' }}>{h}</span>
            <span className="text-[11px]" style={{ color: 'var(--accent)' }}>{t('connsTorChosen')}</span>
            <button type="button" onClick={() => torSite(h, false)} className={btn}>{t('connsTorBack')}</button>
          </div>
        ))}
        {blockedOnly.map((h) => (
          <div key={`b-${h}`} className="flex min-w-0 items-center gap-2 py-2">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--warn)' }} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" dir="ltr" style={{ color: 'var(--text)' }}>{h}</span>
            <span className="text-[11px]" style={{ color: 'var(--warn)' }}>{t('connsBlocked')}</span>
            <button type="button" onClick={() => block(h, false)} className={btn}>{t('connsAllow')}</button>
          </div>
        ))}
      </div>
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
        {/* Upload in a colour of its own: with the emerald accent both were the same green. */}
        <Rate Icon={ArrowUpIcon} label={t('upload')} value={fmtRate(ulRate)} color="var(--text-dim)" data={ulHist} />
      </div>

      {/* counters */}
      <div className="grid grid-cols-2 gap-3">
        <Stat Icon={LinkIcon} label={t('connections')} value={s.connsActive ?? 0}
              sub={t('totalCount', { count: s.connsTotal ?? 0 })} />
        {/* Connections a technique got through; how many were TLS ("TLS
            1650" under it) meant nothing to anyone reading it. */}
        <Stat Icon={ShieldCheckIcon} label={t('bypassed')} value={s.desync ?? 0} subSlot />
        <Stat Icon={DatabaseIcon} label={t('dataTransferred')} value={fmtBytes((s.bytesUp || 0) + (s.bytesDown || 0))} />
        <Stat Icon={ClockIcon} label={t('uptime')} value={s.uptime ? fmtUptime(s.uptime) : '—'} />
        {/* The ad blocker at work, once it has blocked something; on its
            own row, the counters above staying two by two. */}
        {s.adsBlocked > 0 && <Stat Icon={ShieldCheckIcon} label={t('adsBlocked')} value={s.adsBlocked} wide />}
      </div>

      <Connections active={active} />
    </div>
  );
}
