'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import {
  BugIcon, CodeIcon, ExternalLinkIcon, FileTextIcon, GlobeIcon, HeartIcon, InfoIcon, LockIcon, RefreshIcon, SpinnerIcon,
} from './icons';
import { SupportSection } from './Support';
import { updateActions, useUpdate } from './useUpdate';
import FOLLOW from './follow.json';

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

/* Follow Shroudly: its developer's accounts first (news, new versions and
 * urgent notices are posted there), then Codeshare's
 * (components/follow.json; the Android and Apple apps carry the same list,
 * tests/net/follow.test.js). Each opens in the browser. */
function FollowGroup({ title, links }) {
  return (
    <div className="mt-2.5">
      <p className="mb-1.5 text-[12px] font-semibold leading-snug" style={{ color: 'var(--text-faint)' }}>{title}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {links.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer"
             className="row-hover flex min-w-0 items-center gap-2 rounded-[8px] border px-2.5 py-1.5"
             style={{ borderColor: 'var(--line)' }}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium" style={{ color: 'var(--text)' }}>{l.name}</span>
              <span className="block truncate text-[11.5px]" dir="ltr" style={{ color: 'var(--text-faint)' }}>{l.handle}</span>
            </span>
            <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0 rtl:-scale-x-100" style={{ color: 'var(--text-faint)' }} />
          </a>
        ))}
      </div>
    </div>
  );
}

export function FollowSection() {
  const { t } = useLanguage();
  return (
    <Section title={t('followTitle')} Icon={HeartIcon}>
      <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{t('followDesc')}</p>
      <FollowGroup title={t('followDeveloper')} links={FOLLOW.developer} />
      <FollowGroup title={t('followCodeshare')} links={FOLLOW.codeshare} />
    </Section>
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
    case 'no-space': return t('updNoSpace', { version: u.version });
    // A version found but not downloaded is said as such: not "couldn't check".
    case 'error': return u.stage === 'download' && u.version ? t('updDownloadError', { version: u.version }) : t('updError');
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
          {line && <p className="mt-0.5 text-[12.5px] leading-snug wrap-anywhere" style={{ color: ['error', 'no-space'].includes(u.status) ? 'var(--warn)' : 'var(--text-dim)' }}>{line}</p>}
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

/* About: what Shroudly is, in the tour's own plain words, then updates,
 * support, safety and the source. The name, logo, version and status are in
 * the header above (and the version again under Updates); a card repeating
 * them, a "System status" repeating the pill, and six techniques by their
 * engine names ("TCP fragmentation", "HTTP Host scramble") were only more
 * to read. */
export default function InfoPanel({ version: versionProp, supportFocus = 0 }) {
  const { t } = useLanguage();
  const [version, setVersion] = useState(versionProp || null);

  useEffect(() => {
    if (versionProp) { setVersion(versionProp); return; }
    (async () => {
      if (typeof window !== 'undefined' && window.electron?.getAppInfo) {
        try { const i = await window.electron.getAppInfo(); if (i?.version) setVersion(i.version); } catch {}
      }
    })();
  }, [versionProp]);

  return (
    <div className="flex flex-col gap-3 py-4">
      <Section title={t('howItWorks')} Icon={InfoIcon}>
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{t('obBody1')}</p>
      </Section>

      <UpdatesSection version={version} />

      <SupportSection focus={supportFocus} />

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
        <p className="mt-2 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('madeBy')}</p>
      </Section>
    </div>
  );
}
