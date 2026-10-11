'use client';

import { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

const STRATEGIES = [
  { id: 'auto', labelKey: 'stratAuto', spec: 'split(sni)', auto: true },
  { id: 'split-sni', labelKey: 'stratSplitSni', spec: 'split(sni)', auto: false },
  { id: 'disorder-sni', labelKey: 'stratDisorderSni', spec: 'disorder(sni)', auto: false },
  { id: 'split-sni-mid', labelKey: 'stratSplitMid', spec: 'split(sni_mid)', auto: false },
  { id: 'double-split', labelKey: 'stratDoubleSplit', spec: 'split(1),split(sni)', auto: false },
  { id: 'split2', labelKey: 'stratSplit2', spec: 'split(2)', auto: false },
];

function Section({ title, children }) {
  return (
    <section className="card p-4">
      {title && <h2 className="mb-3 text-[13px] font-semibold" style={{ color: 'var(--text-dim)' }}>{title}</h2>}
      {children}
    </section>
  );
}

function Toggle({ label, desc, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-[14px] font-medium" style={{ color: 'var(--text)' }}>{label}</p>
        {desc && <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{desc}</p>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        role="switch" aria-checked={checked}
        className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? 'var(--accent)' : 'var(--surface-hover)' }}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform"
          style={{ left: 2, transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
        />
      </button>
    </div>
  );
}

export default function SettingsPanel() {
  const { language, setLanguage, t, availableLanguages } = useLanguage();
  const langRef = useRef(null);
  const [langOpen, setLangOpen] = useState(false);
  const [testHost, setTestHost] = useState('');
  const [probeResult, setProbeResult] = useState(null);
  const [advInfo, setAdvInfo] = useState({ available: false, active: false, reason: null });
  const [advBusy, setAdvBusy] = useState(false);
  const [settings, setSettings] = useState({
    strategyId: 'auto', autoMode: true, dnsProtection: false, preferIpv6: false,
    autoStart: false, minimizeToTray: true, showNotifications: true,
  });

  useEffect(() => {
    (async () => {
      if (typeof window === 'undefined' || !window.electron) return;
      try { const all = await window.electron.getAllSettings(); setSettings((p) => ({ ...p, ...all })); } catch {}
    })();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron) return;
    window.electron.advancedAvailable?.().then(setAdvInfo).catch(() => {});
    window.electron.onProbeResult?.((p) => setProbeResult(p));
    return () => window.electron.removeProbeListener?.();
  }, []);

  useEffect(() => {
    const onDoc = (e) => { if (langRef.current && !langRef.current.contains(e.target)) setLangOpen(false); };
    if (langOpen) document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [langOpen]);

  async function save(key, value) {
    setSettings((p) => ({ ...p, [key]: value }));
    if (typeof window !== 'undefined' && window.electron) { try { await window.electron.setSetting(key, value); } catch {} }
  }

  async function onStrategyChange(id) {
    const s = STRATEGIES.find((x) => x.id === id) || STRATEGIES[0];
    setSettings((p) => ({ ...p, strategyId: id }));
    if (typeof window !== 'undefined' && window.electron) {
      await window.electron.setSetting('strategyId', id);
      await window.electron.setSetting('strategy', s.spec);
      if (s.auto) await window.electron.setSetting('autoMode', true);
    }
  }

  async function runTest() {
    const host = testHost.trim();
    if (!host || typeof window === 'undefined' || !window.electron) return;
    setProbeResult(null);
    try { await window.electron.probeHost(host); } catch {}
  }

  async function enableAdvanced() {
    if (!window.electron?.startAdvanced) return;
    setAdvBusy(true);
    try {
      const r = await window.electron.startAdvanced();
      setAdvInfo(await window.electron.advancedAvailable());
      if (!r?.success && r?.error) setProbeResult((p) => (p ? { ...p, advError: r.error } : p));
    } catch {}
    setAdvBusy(false);
  }

  async function disableAdvanced() {
    if (!window.electron?.stopAdvanced) return;
    setAdvBusy(true);
    try { await window.electron.stopAdvanced(); setAdvInfo(await window.electron.advancedAvailable()); } catch {}
    setAdvBusy(false);
  }

  const curLang = availableLanguages.find((l) => l.code === language);

  return (
    <div className="flex flex-col gap-3 py-4">
      {/* Language */}
      <Section title={t('language')}>
        <div className="relative" ref={langRef}>
          <button
            onClick={() => setLangOpen((v) => !v)}
            className="card-2 flex w-full items-center justify-between px-3.5 py-3 text-left transition-colors"
          >
            <span className="flex items-center gap-2.5">
              <span className="text-xl">{curLang?.flag}</span>
              <span className="text-[14px]" style={{ color: 'var(--text)' }}>{curLang?.name}</span>
            </span>
            <svg className="h-4 w-4 transition-transform" style={{ color: 'var(--text-faint)', transform: langOpen ? 'rotate(180deg)' : 'none' }}
                 viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 9l6 6 6-6"/></svg>
          </button>
          {langOpen && (
            <div className="scroll absolute left-0 right-0 z-50 mt-2 max-h-72 overflow-y-auto rounded-[var(--radius-sm)] p-1"
                 style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', boxShadow: '0 20px 50px rgba(0,0,0,0.5)' }}>
              {availableLanguages.map((lang) => {
                const on = language === lang.code;
                return (
                  <button
                    key={lang.code}
                    onClick={() => { setLanguage(lang.code); setLangOpen(false); }}
                    className="flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left text-[14px] transition-colors"
                    style={{ background: on ? 'var(--accent-soft)' : 'transparent', color: on ? 'var(--accent)' : 'var(--text)' }}
                  >
                    <span className="text-xl">{lang.flag}</span>
                    <span>{lang.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Section>

      {/* Bypass */}
      <Section title={t('dpiBypassTechniques')}>
        <label className="text-[12px]" style={{ color: 'var(--text-faint)' }}>{t('strategy')}</label>
        <div className="relative mb-3 mt-1.5">
          <select
            value={settings.strategyId}
            onChange={(e) => onStrategyChange(e.target.value)}
            className="card-2 w-full appearance-none px-3.5 py-2.5 pr-9 text-[14px]"
            style={{ color: 'var(--text)' }}
          >
            {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{t(s.labelKey)}</option>)}
          </select>
          <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: 'var(--text-faint)' }}
               viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 9l6 6 6-6"/></svg>
        </div>

        <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
          <Toggle label={t('autoMode')} desc={t('autoModeDesc')} checked={settings.autoMode} onChange={(v) => save('autoMode', v)} />
          <Toggle label={t('dnsProtection')} desc={t('dnsProtectionDesc')} checked={settings.dnsProtection} onChange={(v) => save('dnsProtection', v)} />
          <Toggle label={t('preferIpv6')} desc={t('preferIpv6Desc')} checked={settings.preferIpv6} onChange={(v) => save('preferIpv6', v)} />
        </div>
      </Section>

      {/* Test a site */}
      <Section title={t('testSite')}>
        <p className="mb-3 text-[12px]" style={{ color: 'var(--text-faint)' }}>{t('testSiteDesc')}</p>
        <div className="flex gap-2">
          <input
            value={testHost}
            onChange={(e) => setTestHost(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runTest()}
            placeholder="example.com"
            className="card-2 min-w-0 flex-1 px-3.5 py-2.5 text-[14px]"
          />
          <button
            onClick={runTest}
            className="shrink-0 rounded-[var(--radius-sm)] px-4 py-2.5 text-[14px] font-semibold"
            style={{ background: 'var(--accent)', color: '#07101c' }}
          >
            {t('test')}
          </button>
        </div>

        {probeResult && (
          <div className="mt-3 text-[13px]">
            {probeResult.ok && probeResult.strategy === 'none' && (
              <p style={{ color: 'var(--text-dim)' }}>{probeResult.host}: {t('probeNotBlocked')}</p>
            )}
            {probeResult.ok && probeResult.strategy && probeResult.strategy !== 'none' && (
              <p style={{ color: 'var(--ok)' }}>{probeResult.host}: {t('probeWorks')} ({probeResult.strategy})</p>
            )}
            {!probeResult.ok && (
              <div className="rounded-[var(--radius-sm)] p-3" style={{ background: 'var(--warn-soft)', border: '1px solid rgba(251,191,36,0.3)' }}>
                <p className="mb-1 font-semibold" style={{ color: 'var(--warn)' }}>{t('probeBlockedTitle')}</p>
                <p className="mb-2.5 leading-snug" style={{ color: 'var(--text-dim)' }}>{t('probeBlockedDesc')}</p>
                {advInfo.available ? (
                  advInfo.active ? (
                    <p style={{ color: 'var(--ok)' }}>{t('advancedOn')}</p>
                  ) : (
                    <button onClick={enableAdvanced} disabled={advBusy}
                      className="rounded-[9px] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50"
                      style={{ background: 'var(--warn)', color: '#1a1200' }}>
                      {advBusy ? '…' : t('tryAdvanced')}
                    </button>
                  )
                ) : (
                  <p style={{ color: 'var(--text-faint)' }}>{advInfo.reason || t('advancedUnavailable')}</p>
                )}
                {probeResult.advError && <p className="mt-1" style={{ color: 'var(--danger)' }}>{probeResult.advError}</p>}
              </div>
            )}
          </div>
        )}

        {advInfo.active && (
          <div className="mt-3 flex items-center justify-between rounded-[var(--radius-sm)] p-2.5"
               style={{ background: 'var(--ok-soft)', border: '1px solid rgba(52,211,153,0.3)' }}>
            <span className="text-[12px]" style={{ color: 'var(--ok)' }}>{t('advancedActive')}</span>
            <button onClick={disableAdvanced} disabled={advBusy}
              className="text-[12px] underline disabled:opacity-50" style={{ color: 'var(--text-dim)' }}>
              {t('advancedTurnOff')}
            </button>
          </div>
        )}
      </Section>

      {/* App */}
      <Section title={t('advanced')}>
        <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
          <Toggle label={t('startOnBoot')} desc={t('startOnBootDesc')} checked={settings.autoStart} onChange={(v) => save('autoStart', v)} />
          <Toggle label={t('minimizeToTray')} desc={t('minimizeToTrayDesc')} checked={settings.minimizeToTray} onChange={(v) => save('minimizeToTray', v)} />
          <Toggle label={t('showNotifications')} desc={t('showNotificationsDesc')} checked={settings.showNotifications} onChange={(v) => save('showNotifications', v)} />
        </div>
      </Section>
    </div>
  );
}
