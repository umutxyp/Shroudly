'use client';

import { useLanguage } from '../contexts/LanguageContext';
import { OWN_SERVER_WHY } from './ownServerText';
import { proxyNotice } from './proxyNotice';

function diagnosis(status, t, isRTL) {
  if (!status.active) {
    if (status.starting) return null;
    if (status.blocked) return { title: t('securityStatus'), action: t('navProtection'), target: 'control' };
    if (status.failed) return { title: t('startFailed'), detail: t('startFailedBody', { repair: t('repairApp') }),
      action: t('navLogs'), target: 'logs' };
    return { detail: t('statsInactiveHint'), action: t('navProtection'), target: 'control' };
  }
  if (status.notRouting) {
    const notice = proxyNotice(status.proxy, { active: true, advanced: status.advanced });
    return { title: notice?.title && t(notice.title), detail: t(notice?.body || 'proxyFailedBody', notice?.params),
      action: t('navProtection'), target: 'control' };
  }
  if (status.ownServerDown) {
    const { server, why } = status.ownServerDown;
    const path = [t('navSettings'), t('tabSharing'), t('ownServer')].join(isRTL ? ' ← ' : ' → ');
    return { title: t('ownServerDown'), detail: t('ownServerDownBody', {
      server, why: t(OWN_SERVER_WHY[why] || 'ownServerWhyProtocol'), path,
    }) };
  }
  if (status.offline) {
    if (status.ownProxy) return { title: t('ownProxyTitle'), detail: t('ownProxyBody'),
      action: t('navProtection'), target: 'control' };
    if (status.nationalOnly) return { title: t('nationalOnlyTitle'), detail: t('nationalOnlyBody') };
    return { detail: t('noInternetBody') };
  }
  return { detail: t('testSiteDesc'), action: t('testSite'), target: 'site-test' };
}

export default function ConnectionDashboard({ dpiStatus, statusText, tone, checkedAt, readFailed, unavailable, onRefresh, onNavigate }) {
  const { t, locale, isRTL } = useLanguage();
  const checked = checkedAt == null ? null : new Date(checkedAt);

  const issue = checked && !readFailed && !unavailable ? diagnosis(dpiStatus, t, isRTL) : null;

  return (
    <section className="card flex flex-col gap-2.5 p-4" aria-labelledby="connection-dashboard-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="connection-dashboard-title" className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
          {t('connectionDashboard')}
        </h2>
        <button type="button" className="btn btn-ghost rounded-full px-3 py-1.5 text-[12px] font-medium"
                onClick={onRefresh} disabled={unavailable}>
          {t('connectionRefresh')}
        </button>
      </div>
      <p role="status" className="text-[13px] font-medium"
         style={{ color: readFailed ? 'var(--warn)' : checked ? `var(--${tone})` : 'var(--text-dim)' }}>
        {unavailable ? t('desktopOnly') : readFailed ? t('connectionStatusError') : checked ? issue?.title || statusText : '—'}
      </p>
      {issue?.detail && (
        <p className="text-[12px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>{issue.detail}</p>
      )}
      {issue?.action && (
        <button type="button" className="btn btn-ghost self-start rounded-full px-3 py-1.5 text-[12px] font-medium"
                onClick={() => onNavigate(issue.target)}>
          {issue.action}
        </button>
      )}
      {checked && (
        <p className="flex flex-wrap items-baseline gap-1.5 text-[12px]" style={{ color: 'var(--text-dim)' }}>
          <span>{t('connectionLastChecked')}</span>
          <time dateTime={checked.toISOString()} className="num" dir="ltr">
            {checked.toLocaleTimeString(locale, { timeStyle: 'medium' })}
          </time>
        </p>
      )}
    </section>
  );
}
