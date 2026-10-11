'use client';

import { useState, useEffect } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

function Section({ title, children }) {
  return (
    <section className="card p-4">
      <h2 className="mb-2.5 text-[13px] font-semibold" style={{ color: 'var(--text-dim)' }}>{title}</h2>
      {children}
    </section>
  );
}

function TechRow({ icon, title, desc }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t first:border-t-0" style={{ borderColor: 'var(--line)' }}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 py-2.5 text-left">
        <span className="text-[15px]">{icon}</span>
        <span className="flex-1 text-[14px] font-medium" style={{ color: 'var(--text)' }}>{title}</span>
        <svg className="h-4 w-4 transition-transform" style={{ color: 'var(--text-faint)', transform: open ? 'rotate(180deg)' : 'none' }}
             viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 9l6 6 6-6"/></svg>
      </button>
      {open && <p className="pb-3 pl-[26px] text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{desc}</p>}
    </div>
  );
}

export default function InfoPanel({ dpiStatus }) {
  const { t } = useLanguage();
  const [version, setVersion] = useState('2.0.0');

  useEffect(() => {
    (async () => {
      if (typeof window !== 'undefined' && window.electron?.getAppInfo) {
        try { const i = await window.electron.getAppInfo(); if (i?.version) setVersion(i.version); } catch {}
      }
    })();
  }, []);

  const active = dpiStatus?.active;

  return (
    <div className="flex flex-col gap-3 py-4">
      {/* Identity */}
      <section className="card flex items-center gap-3 p-4">
        <img src="./logo.png" alt="" className="h-11 w-11 object-contain" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold" style={{ color: 'var(--text)' }}>Shroudly</p>
          <p className="num text-[12px]" style={{ color: 'var(--text-faint)' }}>v{version} · {t('madeBy')}</p>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--accent)' }}>{t('tagline')}</p>
        </div>
      </section>

      {/* Status */}
      <Section title={t('systemStatus')}>
        <div className="flex items-center gap-2 py-0.5">
          <span className="h-2 w-2 rounded-full" style={{ background: active ? 'var(--ok)' : 'var(--danger)' }} />
          <span className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
            {active ? t('dpiBypassRunning') : t('dpiBypassStopped')}
          </span>
        </div>
      </Section>

      {/* How it works */}
      <Section title={t('howItWorks')}>
        <TechRow icon="✂️" title={t('technique_frag')}     desc={t('technique_frag_desc')} />
        <TechRow icon="🔀" title={t('technique_disorder')} desc={t('technique_disorder_desc')} />
        <TechRow icon="🛰️" title={t('technique_dns')}      desc={t('technique_dns_desc')} />
        <TechRow icon="🔤" title={t('technique_http')}     desc={t('technique_http_desc')} />
      </Section>

      {/* Safety */}
      <Section title={t('safetyTitle')}>
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{t('safetyDesc')}</p>
      </Section>
    </div>
  );
}
