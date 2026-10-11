'use client';

import { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

/* Strategy presets exposed in the UI. "auto" lets the engine probe per host. */
const STRATEGIES = [
  { id: 'auto', label: 'Auto (recommended)', spec: 'split(sni)', auto: true },
  { id: 'split-sni', label: 'Split at SNI', spec: 'split(sni)', auto: false },
  { id: 'disorder-sni', label: 'Disorder at SNI', spec: 'disorder(sni)', auto: false },
  { id: 'split-sni-mid', label: 'Split mid-SNI', spec: 'split(sni_mid)', auto: false },
  { id: 'double-split', label: 'Double split', spec: 'split(1),split(sni)', auto: false },
  { id: 'split2', label: 'Split at byte 2', spec: 'split(2)', auto: false },
];

function Toggle({ label, desc, checked, onChange }) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="pr-3">
        <p className="text-sm font-semibold">{label}</p>
        {desc ? <p className="text-xs text-gray-400 leading-snug">{desc}</p> : null}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-primary-500' : 'bg-dark-300'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

export default function SettingsPanel() {
  const { language, setLanguage, t, availableLanguages } = useLanguage();
  const languageSelectorRef = useRef(null);
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [languageChangeNotif, setLanguageChangeNotif] = useState(false);
  const [testHost, setTestHost] = useState('');
  const [saved, setSaved] = useState(false);
  const [probeResult, setProbeResult] = useState(null);   // {host, ok, suggest}
  const [advInfo, setAdvInfo] = useState({ available: false, active: false, reason: null });
  const [advBusy, setAdvBusy] = useState(false);

  const [settings, setSettings] = useState({
    strategyId: 'auto',
    autoMode: true,
    dnsProtection: false,
    preferIpv6: false,
    autoStart: false,
    minimizeToTray: true,
    showNotifications: true,
  });

  useEffect(() => { loadSettings(); }, []);

  async function loadSettings() {
    if (typeof window === 'undefined' || !window.electron) return;
    try {
      const all = await window.electron.getAllSettings();
      setSettings((prev) => ({ ...prev, ...all }));
    } catch {}
  }

  async function save(key, value) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    if (typeof window === 'undefined' || !window.electron) return;
    try { await window.electron.setSetting(key, value); } catch {}
    flashSaved();
  }

  async function onStrategyChange(id) {
    const s = STRATEGIES.find((x) => x.id === id) || STRATEGIES[0];
    setSettings((prev) => ({ ...prev, strategyId: id, autoMode: s.auto ? prev.autoMode : prev.autoMode }));
    if (typeof window !== 'undefined' && window.electron) {
      await window.electron.setSetting('strategyId', id);
      await window.electron.setSetting('strategy', s.spec);
      // "auto" strategy implies the auto-probe; others keep the user's autoMode.
      if (s.auto) await window.electron.setSetting('autoMode', true);
    }
    flashSaved();
  }

  function flashSaved() { setSaved(true); setTimeout(() => setSaved(false), 1500); }

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
      const info = await window.electron.advancedAvailable();
      setAdvInfo(info);
      if (!r?.success && r?.error) setProbeResult((p) => p ? { ...p, advError: r.error } : p);
    } catch {}
    setAdvBusy(false);
  }

  async function disableAdvanced() {
    if (!window.electron?.stopAdvanced) return;
    setAdvBusy(true);
    try { await window.electron.stopAdvanced(); const info = await window.electron.advancedAvailable(); setAdvInfo(info); } catch {}
    setAdvBusy(false);
  }

  // Listen for probe results (incl. suggest:"advanced") and load advanced status.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron) return;
    window.electron.advancedAvailable?.().then(setAdvInfo).catch(() => {});
    if (window.electron.onProbeResult) {
      window.electron.onProbeResult((p) => setProbeResult(p));
    }
    return () => { window.electron.removeProbeListener?.(); };
  }, []);

  useEffect(() => {
    const onClick = (e) => {
      if (languageSelectorRef.current && !languageSelectorRef.current.contains(e.target)) {
        setShowLanguageSelector(false);
      }
    };
    if (showLanguageSelector) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showLanguageSelector]);

  return (
    <div className="w-full space-y-4">
      {saved && (
        <div className="fixed top-14 right-4 z-[200] bg-green-600 text-white text-xs px-3 py-2 rounded-lg shadow-lg">
          {t('settingsSaved')}
        </div>
      )}

      {/* Language */}
      <div className="glass-dark rounded-lg p-4 relative z-40 overflow-visible">
        <h2 className="text-base font-bold text-primary-400 mb-3">{t('language')}</h2>
        <div className="relative z-50" ref={languageSelectorRef}>
          <button
            onClick={() => setShowLanguageSelector(!showLanguageSelector)}
            className="w-full bg-dark-400 hover:bg-dark-300 px-4 py-3 rounded-lg flex items-center justify-between transition-colors"
          >
            <span className="flex items-center space-x-3">
              <span className="text-2xl">{availableLanguages.find((l) => l.code === language)?.flag}</span>
              <span>{availableLanguages.find((l) => l.code === language)?.name}</span>
            </span>
            <svg className={`w-5 h-5 transition-transform ${showLanguageSelector ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showLanguageSelector && (
            <>
              <div className="fixed inset-0 z-[100]" onClick={() => setShowLanguageSelector(false)} />
              <div className="absolute z-[101] w-full mt-2 bg-dark-400 border border-primary-800 rounded-lg shadow-2xl max-h-96 overflow-y-auto thin-scrollbar" onClick={(e) => e.stopPropagation()}>
                {availableLanguages.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => { setLanguage(lang.code); setShowLanguageSelector(false); setLanguageChangeNotif(true); setTimeout(() => setLanguageChangeNotif(false), 3000); }}
                    className={`w-full px-4 py-3 flex items-center space-x-3 hover:bg-dark-300 transition-colors ${language === lang.code ? 'bg-primary-500' : ''}`}
                  >
                    <span className="text-2xl">{lang.flag}</span>
                    <span>{lang.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {languageChangeNotif && (
          <div className="mt-4 bg-green-500 text-white px-4 py-3 rounded-lg text-sm font-semibold">{t('languageSaved')}</div>
        )}
      </div>

      {/* Bypass strategy */}
      <div className="glass-dark rounded-lg p-4">
        <h2 className="text-base font-bold text-primary-400 mb-3">{t('dpiBypassTechniques')}</h2>

        <label className="text-xs text-gray-400">{t('strategy')}</label>
        <select
          value={settings.strategyId}
          onChange={(e) => onStrategyChange(e.target.value)}
          className="w-full mt-1 mb-3 bg-dark-400 px-3 py-2 rounded-lg text-sm"
        >
          {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>

        <Toggle
          label={t('autoMode')} desc={t('autoModeDesc')}
          checked={settings.autoMode}
          onChange={(v) => save('autoMode', v)}
        />
        <Toggle
          label={t('dnsProtection')} desc={t('dnsProtectionDesc')}
          checked={settings.dnsProtection}
          onChange={(v) => save('dnsProtection', v)}
        />
        <Toggle
          label={t('preferIpv6')} desc={t('preferIpv6Desc')}
          checked={settings.preferIpv6}
          onChange={(v) => save('preferIpv6', v)}
        />
      </div>

      {/* Test a site */}
      <div className="glass-dark rounded-lg p-4">
        <h2 className="text-base font-bold text-primary-400 mb-2">{t('testSite')}</h2>
        <p className="text-xs text-gray-400 mb-3">{t('testSiteDesc')}</p>
        <div className="flex gap-2">
          <input
            value={testHost}
            onChange={(e) => setTestHost(e.target.value)}
            placeholder="example.com"
            className="flex-1 bg-dark-400 px-3 py-2 rounded-lg text-sm"
          />
          <button onClick={runTest} className="bg-primary-500 hover:bg-primary-600 px-4 py-2 rounded-lg text-sm font-semibold">
            {t('test')}
          </button>
        </div>

        {probeResult && (
          <div className="mt-3 text-xs">
            {probeResult.ok && probeResult.strategy === 'none' && (
              <p className="text-gray-400">{probeResult.host}: {t('probeNotBlocked')}</p>
            )}
            {probeResult.ok && probeResult.strategy && probeResult.strategy !== 'none' && (
              <p className="text-emerald-400">{probeResult.host}: {t('probeWorks')} ({probeResult.strategy})</p>
            )}
            {!probeResult.ok && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="text-amber-300 font-semibold mb-1">{t('probeBlockedTitle')}</p>
                <p className="text-amber-200/80 mb-2">{t('probeBlockedDesc')}</p>
                {advInfo.available ? (
                  advInfo.active ? (
                    <p className="text-emerald-400">{t('advancedOn')}</p>
                  ) : (
                    <button
                      onClick={enableAdvanced}
                      disabled={advBusy}
                      className="bg-amber-500 hover:bg-amber-600 text-black px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50">
                      {advBusy ? '…' : t('tryAdvanced')}
                    </button>
                  )
                ) : (
                  <p className="text-amber-200/60">{advInfo.reason || t('advancedUnavailable')}</p>
                )}
                {probeResult.advError && <p className="text-red-400 mt-1">{probeResult.advError}</p>}
              </div>
            )}
          </div>
        )}

        {advInfo.active && (
          <div className="mt-3 flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5">
            <span className="text-xs text-emerald-300">{t('advancedActive')}</span>
            <button onClick={disableAdvanced} disabled={advBusy}
              className="text-xs text-white/70 hover:text-white underline disabled:opacity-50">
              {t('advancedTurnOff')}
            </button>
          </div>
        )}
      </div>

      {/* App */}
      <div className="glass-dark rounded-lg p-4">
        <h2 className="text-base font-bold text-primary-400 mb-3">{t('advanced')}</h2>
        <Toggle label={t('startOnBoot')} desc={t('startOnBootDesc')} checked={settings.autoStart} onChange={(v) => save('autoStart', v)} />
        <Toggle label={t('minimizeToTray')} desc={t('minimizeToTrayDesc')} checked={settings.minimizeToTray} onChange={(v) => save('minimizeToTray', v)} />
        <Toggle label={t('showNotifications')} desc={t('showNotificationsDesc')} checked={settings.showNotifications} onChange={(v) => save('showNotifications', v)} />
      </div>
    </div>
  );
}
