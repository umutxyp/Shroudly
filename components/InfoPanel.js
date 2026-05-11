'use client';

import { useState, useEffect } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

function Section({ title, children }) {
  return (
    <div className="glass-dark rounded-lg p-4">
      <p className="text-[10px] uppercase tracking-widest font-bold text-primary-400 mb-3">{title}</p>
      {children}
    </div>
  );
}

function TechRow({ icon, title, desc }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="cursor-pointer select-none"
      onClick={() => setOpen(!open)}
    >
      <div className="flex items-center gap-2 py-1.5">
        <span className="text-base">{icon}</span>
        <span className="text-[12px] font-bold text-white/90 flex-1">{title}</span>
        <span className={`text-[10px] text-white/30 transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </div>
      {open && (
        <p className="text-[11px] text-white/55 leading-relaxed pl-7 pb-1.5">{desc}</p>
      )}
    </div>
  );
}

function StatusRow({ ok, label }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className={`h-2 w-2 rounded-full shrink-0 ${ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
      <span className={`text-[11px] ${ok ? 'text-white/75' : 'text-red-400/80'}`}>{label}</span>
    </div>
  );
}

export default function InfoPanel({ dpiStatus }) {
  const { t } = useLanguage();
  const [isAdmin, setIsAdmin] = useState(null);
  const [version, setVersion] = useState('1.2.0');

  useEffect(() => {
    const load = async () => {
      if (typeof window !== 'undefined' && window.electron?.getAppInfo) {
        try {
          const info = await window.electron.getAppInfo();
          if (info?.isAdmin != null) setIsAdmin(info.isAdmin);
          if (info?.version)        setVersion(info.version);
        } catch {}
      }
    };
    load();
  }, []);

  return (
    <div className="flex flex-col gap-3 pb-2">
      {/* Header */}
      <div className="glass-dark rounded-lg p-4 flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-primary-500/40 bg-primary-500/10">
          <svg className="h-7 w-7 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
              d="M12 3.75l6.25 2.3v5.32c0 4.05-2.6 7.8-6.25 8.88-3.65-1.08-6.25-4.83-6.25-8.88V6.05L12 3.75z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-black uppercase tracking-widest text-white">Shroudly</p>
          <p className="text-[10px] text-white/40">v{version} · {t('madeBy')}</p>
          <p className="text-[10px] italic text-primary-400/70 mt-0.5">{t('tagline')}</p>
        </div>
      </div>

      {/* System Status */}
      <Section title={t('systemStatus')}>
        <StatusRow
          ok={isAdmin !== false}
          label={isAdmin === false ? t('notRunningAsAdmin') : t('runningAsAdmin')}
        />
        <StatusRow
          ok={dpiStatus?.active}
          label={dpiStatus?.active ? t('dpiBypassRunning') : t('dpiBypassStopped')}
        />
      </Section>

      {/* Usage */}
      <Section title={t('usageTitle')}>
        <p className="text-[11px] text-white/60 leading-relaxed">{t('usageDesc')}</p>
      </Section>

      {/* How it works */}
      <Section title={t('howItWorks')}>
        <div className="divide-y divide-white/5">
          <TechRow icon="✂️" title={t('technique_frag')}    desc={t('technique_frag_desc')} />
          <TechRow icon="👻" title={t('technique_fake')}    desc={t('technique_fake_desc')} />
          <TechRow icon="🔀" title={t('technique_disorder')} desc={t('technique_disorder_desc')} />
          <TechRow icon="🔤" title={t('technique_http')}    desc={t('technique_http_desc')} />
        </div>
      </Section>

      {/* Why DNS/TTL disabled */}
      <Section title={t('whyDisabled')}>
        <p className="text-[11px] text-white/55 leading-relaxed">{t('whyDisabledDesc')}</p>
      </Section>
    </div>
  );
}
