'use client';

import { useEffect, useId, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import {
  BugIcon, ChevronDownIcon, CodeIcon, ExternalLinkIcon, FileTextIcon, GlobeIcon, LockIcon, RefreshIcon,
  ScissorsIcon, SearchIcon, ShuffleIcon, SpinnerIcon, TypeIcon, ZapIcon,
} from './icons';
import { SupportSection } from './Support';
import { updateActions, useUpdate } from './useUpdate';

const LOGO_SRC = './logo.png';
const REPO_URL = 'https://github.com/umutxyp/Shroudly';

function LinkRow({ href, Icon, label }) {
  return (
    <div className="-mx-2 border-t first:border-t-0" style={{ borderColor: 'var(--line)' }}>
    <a href={href} target="_blank" rel="noreferrer"
       className="row-hover my-1 flex w-full items-center gap-3 rounded-[8px] px-2 py-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 text-[14px] font-medium leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>{label}</span>
      <ExternalLinkIcon className="h-4 w-4 rtl:-scale-x-100" style={{ color: 'var(--text-faint)' }} />
    </a>
    </div>
  );
}

function updateLine(u, t) {
  if (!u) return null;
  switch (u.status) {
    case 'checking': return t('updChecking');
    case 'up-to-date': return t('updUpToDate');
    case 'available': case 'manual': return t('updAvailable', { version: u.version });
    case 'downloading': return t('updDownloading', { version: u.version, percent: u.percent || 0 });
    case 'ready': return t('updReady', { version: u.version });
    case 'error': return t('updError');
    case 'unsupported': return t('updUnsupported');
    default: return null;
  }
}

function UpdatesSection({ version }) {
  const { t } = useLanguage();
  const u = useUpdate();
  const busy = u && ['checking', 'downloading'].includes(u.status);
  const line = updateLine(u, t);
  return (
    <Section title={t('updatesTitle')} Icon={RefreshIcon}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          {version && <p className="num text-[13px] font-medium" style={{ color: 'var(--text)' }}>{t('versionLabel', { version })}</p>}
          {line && <p className="mt-0.5 text-[12.5px] leading-snug wrap-anywhere" style={{ color: u.status === 'error' ? 'var(--warn)' : 'var(--text-dim)' }}>{line}</p>}
        </div>
        {u?.status !== 'unsupported' && (
          <button type="button" onClick={updateActions.check} disabled={busy || u?.status === 'ready'}
                  className="btn btn-ghost inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium">
            {busy ? <SpinnerIcon className="h-3.5 w-3.5 spin" /> : <RefreshIcon className="h-3.5 w-3.5" />}
            {t('checkForUpdates')}
          </button>
        )}
      </div>
      <p className="mt-2 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('updatesDesc')}</p>
    </Section>
  );
}

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
    <div className="-mx-2 border-t first:border-t-0" style={{ borderColor: 'var(--line)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className="row-hover my-1 flex w-full items-center gap-3 rounded-[8px] px-2 py-2 text-start"
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
        <p id={id} className="pb-3 pe-2 ps-12 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{desc}</p>
      )}
    </div>
  );
}

export default function InfoPanel({ dpiStatus, version: versionProp, supportFocus = 0 }) {
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

      <UpdatesSection version={version} />

      <SupportSection focus={supportFocus} />

      {/* How it works */}
      <Section title={t('howItWorks')}>
        <TechRow Icon={ScissorsIcon} title={t('technique_frag')}     desc={t('technique_frag_desc')} />
        <TechRow Icon={ShuffleIcon}  title={t('technique_disorder')} desc={t('technique_disorder_desc')} />
        <TechRow Icon={GlobeIcon}    title={t('technique_dns')}      desc={t('technique_dns_desc')} />
        <TechRow Icon={TypeIcon}     title={t('technique_http')}     desc={t('technique_http_desc')} />
        <TechRow Icon={SearchIcon}   title={t('technique_probe')}    desc={t('technique_probe_desc')} />
        <TechRow Icon={ZapIcon}      title={t('technique_advanced')} desc={t('technique_advanced_desc')} />
      </Section>

      {/* Safety */}
      <Section title={t('safetyTitle')} Icon={LockIcon}>
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{t('safetyDesc')}</p>
      </Section>


      {/* Open source */}
      <Section title={t('openSourceTitle')} Icon={CodeIcon}>
        <p className="mb-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{t('openSourceDesc')}</p>
        <LinkRow href={REPO_URL} Icon={CodeIcon} label={t('linkSourceCode')} />
        <LinkRow href={`${REPO_URL}/releases`} Icon={FileTextIcon} label={t('linkReleases')} />
        <LinkRow href={`${REPO_URL}/issues/new`} Icon={BugIcon} label={t('linkIssues')} />
        <LinkRow href="https://codeshare.me" Icon={GlobeIcon} label={t('linkWebsite')} />
      </Section>
    </div>
  );
}
