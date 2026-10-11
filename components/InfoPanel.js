'use client';

import { useEffect, useId, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { ChevronDownIcon, GlobeIcon, LockIcon, ScissorsIcon, ShuffleIcon, TypeIcon, ZapIcon } from './icons';

const LOGO_SRC = './logo.png';

function Section({ title, Icon, children }) {
  return (
    <section className="card p-4">
      <h2 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold leading-snug" style={{ color: 'var(--text-dim)' }}>
        {Icon && <Icon className="h-4 w-4" style={{ color: 'var(--text-faint)' }} />}
        <span className="min-w-0">{title}</span>
      </h2>
      {children}
    </section>
  );
}

function TechRow({ Icon, title, desc }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="border-t first:border-t-0" style={{ borderColor: 'var(--line)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className="row-hover -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-[8px] px-2 py-2.5 text-start"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 text-[14px] font-medium leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>{title}</span>
        <ChevronDownIcon className="h-4 w-4 transition-transform duration-150"
                         style={{ color: 'var(--text-faint)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      {open && (
        <p id={id} className="pb-3 ps-10 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{desc}</p>
      )}
    </div>
  );
}

export default function InfoPanel({ dpiStatus, version: versionProp }) {
  const { t } = useLanguage();
  const [version, setVersion] = useState(versionProp || null);
  const [advActive, setAdvActive] = useState(false);

  useEffect(() => {
    if (versionProp) { setVersion(versionProp); return; }
    (async () => {
      if (typeof window !== 'undefined' && window.electron?.getAppInfo) {
        try { const i = await window.electron.getAppInfo(); if (i?.version) setVersion(i.version); } catch {}
      }
    })();
  }, [versionProp]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.advancedAvailable) return;
    window.electron.advancedAvailable().then((i) => setAdvActive(!!i?.active)).catch(() => {});
  }, []);

  const active = !!dpiStatus?.active;

  return (
    <div className="flex flex-col gap-3 py-4">
      {/* Identity */}
      <section className="card flex items-center gap-3.5 p-4">
        <img src={LOGO_SRC} alt="" draggable={false} className="h-11 w-11 shrink-0 select-none object-contain" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--text)' }}>Shroudly</p>
          {version && (
            <p className="num mt-0.5 text-[12px]" style={{ color: 'var(--text-faint)' }}>{t('versionLabel', { version })}</p>
          )}
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('madeBy')}</p>
          <p className="mt-1 text-[12px] font-medium leading-snug" style={{ color: 'var(--accent)' }}>{t('tagline')}</p>
        </div>
      </section>

      {/* Status */}
      <Section title={t('systemStatus')}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex w-3.5 shrink-0 justify-center">
              <span className="h-2 w-2 rounded-full" style={{ background: active ? 'var(--ok)' : 'var(--danger)' }} />
            </span>
            <span className="min-w-0 text-[13px] leading-snug" style={{ color: 'var(--text-dim)' }}>
              {active ? t('dpiBypassRunning') : t('dpiBypassStopped')}
            </span>
          </div>
          {advActive && (
            <div className="flex items-center gap-2.5">
              <ZapIcon className="h-3.5 w-3.5" style={{ color: 'var(--ok)' }} />
              <span className="min-w-0 text-[13px] leading-snug" style={{ color: 'var(--text-dim)' }}>{t('advancedActive')}</span>
            </div>
          )}
        </div>
      </Section>

      {/* How it works */}
      <Section title={t('howItWorks')}>
        <TechRow Icon={ScissorsIcon} title={t('technique_frag')}     desc={t('technique_frag_desc')} />
        <TechRow Icon={ShuffleIcon}  title={t('technique_disorder')} desc={t('technique_disorder_desc')} />
        <TechRow Icon={GlobeIcon}    title={t('technique_dns')}      desc={t('technique_dns_desc')} />
        <TechRow Icon={TypeIcon}     title={t('technique_http')}     desc={t('technique_http_desc')} />
      </Section>

      {/* Safety */}
      <Section title={t('safetyTitle')} Icon={LockIcon}>
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{t('safetyDesc')}</p>
      </Section>
    </div>
  );
}
