'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { ACCENTS, applyAppearance, readAppearance } from './Appearance';
import {
  AlertTriangleIcon, CheckCircleIcon, CheckIcon, GlobeIcon, PaletteIcon, InfoIcon, LanguagesIcon, SearchIcon, ShieldAlertIcon,
  SpinnerIcon, XCircleIcon, ZapIcon,
} from './icons';
import Select from './Select';
import { probeView } from './probeView';

const STRATEGIES = [
  { id: 'auto', labelKey: 'stratAuto', spec: 'split(sni)', auto: true },
  { id: 'split-sni', labelKey: 'stratSplitSni', spec: 'split(sni)', auto: false },
  { id: 'disorder-sni', labelKey: 'stratDisorderSni', spec: 'disorder(sni)', auto: false },
  { id: 'split-sni-mid', labelKey: 'stratSplitMid', spec: 'split(sni_mid)', auto: false },
  { id: 'double-split', labelKey: 'stratDoubleSplit', spec: 'split(1),split(sni)', auto: false },
  { id: 'split2', labelKey: 'stratSplit2', spec: 'split(2)', auto: false },
];

/* advancedAvailable().reasonCode → translation key */
const ADV_REASON_KEYS = {
  mac_unsupported: 'advReasonMacUnsupported',
  arch_unsupported: 'advReasonArchUnsupported',
  not_built: 'advReasonNotBuilt',
  windivert_missing: 'advReasonWindivertMissing',
  linux_lib_missing: 'advReasonLinuxLibMissing',
  platform_unsupported: 'advReasonPlatformUnsupported',
};
/* startAdvanced().code → translation key */
const ADV_ERROR_KEYS = {
  declined: 'advErrorDeclined',
  elevation_unavailable: 'advErrorElevationUnavailable',
  start_failed: 'advErrorStartFailed',
  timeout: 'advErrorTimeout',
};
const LINUX_LIB_COMMAND = 'sudo apt install libnetfilter-queue1';
const PROBE_TIMEOUT_MS = 25000;

function advReasonText(info, t) {
  const key = info && ADV_REASON_KEYS[info.reasonCode];
  if (key) return t(key, { command: info.installCommand || LINUX_LIB_COMMAND });
  return info?.reason || t('advancedUnavailable');
}

function advErrorMessage(r, t) {
  const key = r && ADV_ERROR_KEYS[r.code];
  if (key) {
    return {
      text: t(key),
      detail: r.code === 'start_failed' ? r.error : null,
      tone: r.code === 'declined' ? 'warn' : 'danger',
    };
  }
  if (r?.error) return { text: t('advErrorGeneric'), detail: r.error, tone: 'danger' };
  return { text: t('advErrorGeneric'), detail: null, tone: 'danger' };
}

function normalizeHost(input) {
  let h = String(input || '').trim();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');   // scheme
  h = h.split(/[/?#]/)[0];                          // path, query
  h = h.replace(/^[^@]*@/, '');                     // credentials
  return h.toLowerCase();
}

/* Mirrors SystemProxy.isHostname in the main process. The list is written into
 * the file the browser consults for EVERY request, so a malformed entry would
 * not simply be ignored — it would stop proxy resolution and take all browsing
 * with it. Rather than fail quietly, bad lines are dropped and named. */
function isHostname(d) {
  if (typeof d !== 'string' || d.length < 3 || d.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(d)) return false;
  if (d.startsWith('.') || d.endsWith('.') || d.includes('..')) return false;
  const labels = d.split('.');
  if (labels.length < 2) return false;
  return labels.every((l) => l.length >= 1 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-'));
}

function Section({ title, Icon, titleId, tour, children }) {
  return (
    <section className="card p-4" data-tour={tour}>
      {title && (
        <h2 id={titleId} className="mb-3 flex items-center gap-2 text-[13px] font-semibold leading-snug" style={{ color: 'var(--text-dim)' }}>
          {Icon && <Icon className="h-4 w-4" style={{ color: 'var(--text-faint)' }} />}
          <span className="min-w-0">{title}</span>
        </h2>
      )}
      {children}
    </section>
  );
}

/* Whole row is the switch: bigger click target, label read by screen readers. */
function Toggle({ label, desc, checked, onChange, disabled }) {
  const { isRTL } = useLanguage();
  const descId = useId();
  const shift = checked ? (isRTL ? -20 : 20) : 0;
  return (
    <div className="-mx-2">
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-describedby={desc ? descId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="row-hover my-1 flex w-full items-center justify-between gap-4 rounded-[8px] px-2 py-2 text-start disabled:opacity-55"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium leading-snug" style={{ color: 'var(--text)' }}>{label}</span>
        {desc && (
          <span id={descId} className="mt-0.5 block text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{desc}</span>
        )}
      </span>
      <span aria-hidden className="switch-track relative h-6 w-11 shrink-0 rounded-full" data-on={!!checked}>
        <span
          className="switch-knob absolute top-[2px] h-[18px] w-[18px] rounded-full"
          style={{ insetInlineStart: 2, transform: `translateX(${shift}px)` }}
        />
      </span>
    </button>
    </div>
  );
}

function Notice({ tone = 'info', Icon, children }) {
  const c = {
    info:   { bg: 'var(--accent-soft)', line: 'var(--accent-line)', fg: 'var(--accent)' },
    ok:     { bg: 'var(--ok-soft)', line: 'var(--ok-line)', fg: 'var(--ok)' },
    warn:   { bg: 'var(--warn-soft)', line: 'var(--warn-line)', fg: 'var(--warn)' },
    danger: { bg: 'var(--danger-soft)', line: 'var(--danger-line)', fg: 'var(--danger)' },
  }[tone];
  return (
    <div className="flex items-start gap-2.5 rounded-[var(--radius-sm)] p-3 text-[13px] leading-snug"
         style={{ background: c.bg, border: `1px solid ${c.line}` }}>
      {Icon && <Icon className="mt-[1px] h-4 w-4" style={{ color: c.fg }} />}
      <div className="min-w-0 flex-1 wrap-anywhere">{children}</div>
    </div>
  );
}

export default function SettingsPanel({ active = false }) {
  const { language, setLanguage, t, availableLanguages, locale } = useLanguage();
  const strategyLabelId = useId();
  const languageLabelId = useId();
  const [testHost, setTestHost] = useState('');
  const [testing, setTesting] = useState(null);       // host being tested
  const [testNote, setTestNote] = useState(null);     // 'needsProtection' | 'noAnswer'
  const [probeResult, setProbeResult] = useState(null);
  const [advInfo, setAdvInfo] = useState({ available: false, active: false, reason: null, reasonCode: null });
  const [advBusy, setAdvBusy] = useState(false);
  const [advError, setAdvError] = useState(null);
  const testingRef = useRef(null);
  const timeoutRef = useRef(null);
  const [settings, setSettings] = useState({
    strategyId: 'auto', autoMode: true, dnsProtection: true, preferIpv6: false, routeMode: 'all',
    autoStart: false, minimizeToTray: true, showNotifications: true,
  });
  // null while unknown; false greys out "Prefer IPv6" on IPv4-only networks
  const [ipv6Ok, setIpv6Ok] = useState(null);
  // Discord app mode: shown only where the Discord app has been used
  const [discord, setDiscord] = useState({ installed: false, on: false });
  // Games and apps mode: shown on the systems where it works (Windows, macOS)
  const [apps, setApps] = useState({ available: false, on: false, platform: '', canInstall: false, installed: false, store: false, installing: false });
  const [defaultList, setDefaultList] = useState([]);
  const [siteText, setSiteText] = useState(null);   // textarea draft (null until loaded)
  const [badEntries, setBadEntries] = useState([]); // lines dropped as unusable
  const [look, setLook] = useState({ accent: 'sky', surface: 'solid' });

  useEffect(() => { setLook(readAppearance()); }, []);
  const setAppearance = (next) => { const v = { ...look, ...next }; setLook(v); applyAppearance(v); };

  // The automatic list, and when it was last built; it can change while the
  // window is open.
  const [listInfo, setListInfo] = useState(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.defaultSiteList) return undefined;
    const load = () => {
      window.electron.defaultSiteList().then((l) => Array.isArray(l) && setDefaultList(l)).catch(() => {});
      window.electron.siteListInfo?.().then(setListInfo).catch(() => {});
    };
    load();
    window.electron.onSiteListChanged?.(load);
    return () => window.electron.removeSiteListListener?.();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.ipv6Available) return;
    window.electron.ipv6Available().then(setIpv6Ok).catch(() => {});
  }, []);

  useEffect(() => {
    window.electron?.discordStatus?.()
      .then((d) => setDiscord({ installed: !!d?.installed, on: d?.mode === true }))
      .catch(() => {});
  }, []);

  async function setDiscordMode(on) {
    setDiscord((d) => ({ ...d, on }));
    try {
      const r = await window.electron.discordSet(on);
      if (!r?.success) setDiscord((d) => ({ ...d, on: !on }));
    } catch { setDiscord((d) => ({ ...d, on: !on })); }
  }

  const loadApps = (running) => window.electron?.appsStatus?.({ running: running === true })
    .then((a) => setApps({
      available: !!a?.available, on: a?.mode === true, platform: a?.platform || '',
      canInstall: !!a?.canInstall, installed: !!a?.robloxInstalled, store: !!a?.storeEdition,
      installing: !!a?.installing,
    }))
    .catch(() => {});
  useEffect(() => {
    loadApps(true);
    const off = window.electron?.onAppsState?.(() => loadApps());
    return () => { if (typeof off === 'function') off(); };
  }, []);
  const [robloxMsg, setRobloxMsg] = useState(null);
  async function robloxAction(kind) {
    setRobloxMsg(kind === 'install' ? { tone: 'dim', text: t('appInstalling') } : null);
    try {
      const r = kind === 'install' ? await window.electron.appsInstallRoblox() : await window.electron.appsOpenRoblox();
      if (r?.success) setRobloxMsg(kind === 'install' ? { tone: 'ok', text: t('appInstallStarted') } : null);
      else if (r?.code === 'not_installed') setRobloxMsg({ tone: 'warn', text: t('appNotInstalled') });
      else if (r?.code === 'protection_off') setRobloxMsg({ tone: 'warn', text: t('testNeedsProtection') });
      else if (r?.code === 'unsigned') setRobloxMsg({ tone: 'warn', text: t('appInstallUnsigned') });
      else setRobloxMsg({ tone: 'warn', text: t('appInstallFailed') });
    } catch { setRobloxMsg({ tone: 'warn', text: t('appInstallFailed') }); }
    loadApps();
  }

  async function setAppMode(on) {
    setApps((a) => ({ ...a, on }));
    try {
      const r = await window.electron.appsSet(on);
      if (!r?.success) setApps((a) => ({ ...a, on: !on }));
    } catch { setApps((a) => ({ ...a, on: !on })); }
  }

  useEffect(() => {
    (async () => {
      if (typeof window === 'undefined' || !window.electron?.getAllSettings) return;
      try {
        const all = await window.electron.getAllSettings();
        setSettings((p) => ({ ...p, ...all }));
        if (Array.isArray(all.siteList)) setSiteText(all.siteList.join('\n'));
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron) return undefined;
    window.electron.advancedAvailable?.().then((i) => i && setAdvInfo(i)).catch(() => {});
    window.electron.onProbeResult?.((p) => {
      // Only show results for the host the user is testing here (auto mode
      // probes other sites in the background).
      const want = testingRef.current;
      if (!want || !p?.host || normalizeHost(p.host) !== want) return;
      clearTimeout(timeoutRef.current);
      testingRef.current = null;
      setTesting(null);
      setProbeResult(p);
    });
    return () => {
      clearTimeout(timeoutRef.current);
      window.electron.removeProbeListener?.();
    };
  }, []);

  async function save(key, value) {
    const before = settings[key];
    setSettings((p) => ({ ...p, [key]: value }));
    if (typeof window !== 'undefined' && window.electron?.setSetting) {
      try {
        const r = await window.electron.setSetting(key, value);
        if (r && r.success === false) setSettings((p) => ({ ...p, [key]: before }));
      } catch { setSettings((p) => ({ ...p, [key]: before })); }
    }
  }

  async function onStrategyChange(id) {
    const s = STRATEGIES.find((x) => x.id === id) || STRATEGIES[0];
    setSettings((p) => ({ ...p, strategyId: id, ...(s.auto ? { autoMode: true } : {}) }));
    if (typeof window !== 'undefined' && window.electron?.setSetting) {
      try {
        await window.electron.setSetting('strategyId', id);
        await window.electron.setSetting('strategy', s.spec);
        if (s.auto) await window.electron.setSetting('autoMode', true);
      } catch {}
    }
  }

  async function runTest() {
    const host = normalizeHost(testHost);
    if (!host || testing) return;
    setProbeResult(null);
    setAdvError(null);
    setTestNote(null);
    if (!active) { setTestNote('needsProtection'); return; }
    if (typeof window === 'undefined' || !window.electron?.probeHost) return;
    testingRef.current = host;
    setTesting(host);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (testingRef.current !== host) return;
      testingRef.current = null;
      setTesting(null);
      setTestNote('noAnswer');
    }, PROBE_TIMEOUT_MS);
    try { await window.electron.probeHost(host); } catch {}
  }

  async function refreshAdv() {
    try { const i = await window.electron.advancedAvailable(); if (i) setAdvInfo(i); } catch {}
  }

  async function enableAdvanced() {
    if (!window.electron?.startAdvanced) return;
    setAdvBusy(true);
    setAdvError(null);
    try {
      const r = await window.electron.startAdvanced();
      if (!r?.success) setAdvError(advErrorMessage(r, t));
    } catch (e) {
      setAdvError(advErrorMessage({ error: e?.message }, t));
    }
    await refreshAdv();
    setAdvBusy(false);
  }

  async function disableAdvanced() {
    if (!window.electron?.stopAdvanced) return;
    setAdvBusy(true);
    try { await window.electron.stopAdvanced(); } catch {}
    await refreshAdv();
    setAdvBusy(false);
  }

  const languageOptions = availableLanguages.map((l) => ({
    value: l.code,
    label: l.name,
    lang: l.locale,
    leading: (
      <span className="mono inline-flex h-[22px] min-w-[30px] shrink-0 items-center justify-center rounded-[6px] px-1 text-[10.5px] font-semibold uppercase tracking-wide"
            style={{ background: 'var(--surface-hover)', color: 'var(--text-dim)', border: '1px solid var(--line)' }}>
        {l.code}
      </span>
    ),
  }));

  const strategyOptions = STRATEGIES.map((s) => ({ value: s.id, label: t(s.labelKey), hint: s.spec }));

  const probeShown = probeView(probeResult);
  const probeBlocked = probeShown.blocked;

  return (
    <div className="flex flex-col gap-3 py-4">
      {/* Language */}
      <Section title={t('language')} Icon={LanguagesIcon} titleId={languageLabelId}>
        <Select
          value={language}
          options={languageOptions}
          onChange={setLanguage}
          ariaLabelledBy={languageLabelId}
        />
      </Section>

      {/* Bypass */}
      <Section title={t('appearance')} Icon={PaletteIcon}>
        <p className="mb-3 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('accentColour')}</p>
        {/* A nine-column grid rather than a wrapping row: the swatches scale
            with the window instead of spilling into a stray second line at
            narrow widths, which read as a layout accident. */}
        <div className="grid grid-cols-9 gap-1.5 sm:gap-2.5">
          {ACCENTS.map((a) => {
            const on = look.accent === a.id;
            return (
              <button
                key={a.id}
                type="button"
                aria-label={a.id}
                aria-pressed={on}
                onClick={() => setAppearance({ accent: a.id })}
                className="relative aspect-square w-full rounded-full transition-transform duration-150 hover:scale-110"
                style={{
                  background: a.swatch,
                  boxShadow: on
                    ? `0 0 0 2px var(--surface), 0 0 0 4px ${a.swatch}`
                    : 'inset 0 1px 0 rgba(255,255,255,.25)',
                }}
              >
                {on && <CheckIcon className="absolute inset-0 m-auto h-[14px] w-[14px]" style={{ color: 'rgba(0,0,0,.7)' }} />}
              </button>
            );
          })}
        </div>

        <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
          <Toggle
            label={t('glassSurface')}
            desc={t('glassSurfaceDesc')}
            checked={look.surface === 'glass'}
            onChange={(v) => setAppearance({ surface: v ? 'glass' : 'solid' })}
          />
        </div>
      </Section>

      <Section title={t('dpiBypassTechniques')}>
        <p id={strategyLabelId} className="mb-1.5 text-[12px] font-medium" style={{ color: 'var(--text-faint)' }}>{t('strategy')}</p>
        <div className="mb-2">
          <Select
            value={settings.strategyId}
            options={strategyOptions}
            onChange={onStrategyChange}
            ariaLabelledBy={strategyLabelId}
          />
        </div>

        <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
          <Toggle label={t('autoMode')} desc={t('autoModeDesc')} checked={settings.autoMode} onChange={(v) => save('autoMode', v)} />
          <Toggle label={t('dnsProtection')} desc={t('dnsProtectionDesc')} checked={settings.dnsProtection !== false} onChange={(v) => save('dnsProtection', v)} />
          <Toggle label={t('preferIpv6')}
                  desc={ipv6Ok === false ? t('ipv6Unavailable') : t('preferIpv6Desc')}
                  checked={settings.preferIpv6}
                  disabled={ipv6Ok === false && !settings.preferIpv6}
                  onChange={(v) => save('preferIpv6', v)} />
          {discord.installed && (
            <Toggle label={t('discordModeLabel')} desc={t('discordModeDesc')}
                    checked={discord.on} onChange={setDiscordMode} />
          )}
          {apps.available && (
            <Toggle label={t('appModeLabel')}
                    desc={apps.platform === 'win32' ? `${t('appModeDesc')} ${t('appBrowserNote')}` : t('appModeDesc')}
                    checked={apps.on} onChange={setAppMode} />
          )}
          {apps.available && apps.on && (
            <div className="px-1 pb-1">
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => robloxAction('open')} disabled={apps.installing}
                        className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('appOpenRoblox')}</button>
                {apps.canInstall && (
                  <button type="button" onClick={() => robloxAction('install')} disabled={apps.installing || !active}
                          className="btn btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
                    {apps.installing ? t('appInstalling') : t('appInstallRoblox')}
                  </button>
                )}
              </div>
              {apps.store && (
                <p className="mt-2 text-[12px] leading-snug" style={{ color: 'var(--warn)' }}>{t('appStoreEdition')}</p>
              )}
              {robloxMsg && (
                <p role="status" className="mt-2 text-[12px] leading-snug"
                   style={{ color: robloxMsg.tone === 'warn' ? 'var(--warn)' : robloxMsg.tone === 'ok' ? 'var(--ok)' : 'var(--text-dim)' }}>{robloxMsg.text}</p>
              )}
            </div>
          )}
        </div>

        {active && (
          <p className="mt-2 flex items-start gap-2 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>
            <InfoIcon className="mt-[1px] h-3.5 w-3.5" />
            <span className="min-w-0">{t('restartToApply')}</span>
          </p>
        )}
      </Section>

      {/* Routing: which sites go through Shroudly */}
      <Section title={t('routing')} Icon={GlobeIcon} tour="routing">
        <Select
          value={settings.routeMode === 'listed' ? 'listed' : 'all'}
          options={[
            { value: 'listed', label: t('routeListed') },
            { value: 'all', label: t('routeAll') },
          ]}
          onChange={(v) => save('routeMode', v)}
        />
        <p className="mt-2 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>
          {settings.routeMode === 'listed' ? t('routeListedDesc') : t('routeAllDesc')}
        </p>

        {settings.routeMode === 'listed' && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-faint)' }}>{t('siteListLabel')}</span>
              {Array.isArray(settings.siteList) && (
                <button type="button"
                        onClick={() => { setSiteText(null); setBadEntries([]); save('siteList', null); setListInfo((i) => i && { ...i, custom: false }); }}
                        className="text-[12px] underline" style={{ color: 'var(--text-dim)' }}>
                  {t('siteListUseAuto')}
                </button>
              )}
            </div>
            <p className="mb-1.5 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>
              {Array.isArray(settings.siteList)
                ? t('siteListCustom')
                : t('siteListAuto', {
                  count: (listInfo?.count || defaultList.length).toLocaleString(locale || undefined),
                  date: listInfo?.generated ? new Date(listInfo.generated).toLocaleDateString(locale || undefined) : '—',
                })}
            </p>
            <textarea
              value={siteText == null ? (settings.siteList || defaultList).join('\n') : siteText}
              onChange={(e) => setSiteText(e.target.value)}
              onBlur={() => {
                // Nothing typed: the box shows the list in use, and leaving it
                // must not save anything (an empty draft is not an empty list).
                if (siteText == null) return;
                const entries = siteText
                  .split(/[\s,]+/)
                  .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*?\./, '').replace(/\/.*$/, ''))
                  .filter(Boolean);
                const list = [...new Set(entries.filter(isHostname))];
                const dropped = [...new Set(entries.filter((d) => !isHostname(d)))];
                setBadEntries(dropped);
                // Only an actual edit makes the list the user's own: merely
                // clicking into the box must not stop it updating itself.
                const current = Array.isArray(settings.siteList) ? settings.siteList : defaultList;
                if (list.length === current.length && list.every((d, i) => d === current[i])) { setSiteText(null); return; }
                setSiteText(list.join('\n'));   // show the cleaned list back
                save('siteList', list);
              }}
              spellCheck={false} rows={6} dir="ltr"
              placeholder={'discord.com\nroblox.com'}
              className="mono w-full resize-y rounded-[var(--radius-sm)] p-2.5 text-[12.5px] leading-relaxed outline-none"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
            />
            {badEntries.length > 0 && (
              <p className="mt-1.5 flex items-start gap-2 text-[12px] leading-snug" style={{ color: 'var(--warn)' }}>
                <AlertTriangleIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 wrap-anywhere">
                  {t('siteListDropped', { entries: badEntries.slice(0, 4).join(', ') + (badEntries.length > 4 ? '…' : '') })}
                </span>
              </p>
            )}
            <p className="mt-1.5 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('siteListHint')}</p>
          </div>
        )}

        {active && (
          <p className="mt-2 flex items-start gap-2 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>
            <InfoIcon className="mt-[1px] h-3.5 w-3.5" />
            <span className="min-w-0">{t('routeAppliesNow')}</span>
          </p>
        )}
      </Section>

      {/* Test a site */}
      <Section title={t('testSite')} Icon={SearchIcon} tour="sitetest">
        <p className="mb-3 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('testSiteDesc')}</p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => { e.preventDefault(); runTest(); }}
        >
          <input
            value={testHost}
            onChange={(e) => setTestHost(e.target.value)}
            placeholder={t('testPlaceholder')}
            aria-label={t('testSite')}
            dir="ltr"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            className="field min-w-[150px] flex-[1_1_180px] px-3.5 py-2.5 text-[14px]"
            style={{ textAlign: 'start' }}
          />
          <button
            type="submit"
            disabled={!testHost.trim() || !!testing}
            className="btn btn-primary flex-[0_0_auto] rounded-[var(--radius-sm)] px-4 py-2.5 text-[14px] font-semibold"
          >
            {testing && <SpinnerIcon className="spin h-4 w-4" />}
            <span>{testing ? t('testing') : t('test')}</span>
          </button>
        </form>

        {testNote === 'needsProtection' && (
          <div className="mt-3"><Notice tone="info" Icon={InfoIcon}><p style={{ color: 'var(--text-dim)' }}>{t('testNeedsProtection')}</p></Notice></div>
        )}
        {testNote === 'noAnswer' && (
          <div className="mt-3"><Notice tone="warn" Icon={AlertTriangleIcon}><p style={{ color: 'var(--text-dim)' }}>{t('probeNoAnswer')}</p></Notice></div>
        )}

        {probeResult && (
          <div className="mt-3 flex flex-col gap-2" aria-live="polite">
            {probeShown.refused && (
              <Notice tone="warn" Icon={AlertTriangleIcon}>
                <p className="mb-1 font-semibold" style={{ color: 'var(--warn)' }}>{t(probeResult.service === 'stall' ? 'probeStallTitle' : 'probeServiceTitle', { host: probeResult.host })}</p>
                <p className="text-[12.5px]" style={{ color: 'var(--text-dim)' }}>{t(probeResult.service === 'stall' ? 'probeStallBody' : 'probeServiceBody', { host: probeResult.host })}</p>
              </Notice>
            )}
            {probeShown.works && probeResult.strategy === 'none' && (
              <Notice tone={probeResult.dns_blocked ? 'ok' : 'info'} Icon={probeResult.dns_blocked ? CheckCircleIcon : InfoIcon}>
                <p style={{ color: probeResult.dns_blocked ? 'var(--ok)' : 'var(--text-dim)' }}>
                  {probeResult.dns_blocked
                    ? t('probeDnsBlocked', { host: probeResult.host })
                    : t('probeNotBlocked', { host: probeResult.host })}
                </p>
              </Notice>
            )}
            {probeShown.works && probeResult.strategy !== 'none' && (
              <Notice tone="ok" Icon={CheckCircleIcon}>
                <p style={{ color: 'var(--ok)' }}>
                  {t('probeWorks', { host: probeResult.host, strategy: probeResult.strategy || '—' })}
                </p>
              </Notice>
            )}
            {probeBlocked && (
              <Notice tone="warn" Icon={AlertTriangleIcon}>
                <p className="mb-1 font-semibold" style={{ color: 'var(--warn)' }}>{t('probeBlockedTitle', { host: probeResult.host })}</p>
                {/* This test exercises the normal mode only. With Advanced mode on,
                    "still blocked" here says nothing about what the packet-level
                    engine is doing, and telling the user to try a mode that is
                    already running reads as the app contradicting itself. */}
                <p className="mb-3 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
                  {advInfo.active ? t('probeBlockedAdvancedOn', { host: probeResult.host }) : t('probeBlockedDesc')}
                </p>
                {advInfo.available ? (
                  advInfo.active ? (
                    <p className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--ok)' }}>
                      <CheckCircleIcon className="h-4 w-4" />
                      <span>{t('advancedOn')}</span>
                    </p>
                  ) : (
                    <div className="flex flex-col items-start gap-1.5">
                      <button
                        type="button"
                        onClick={enableAdvanced}
                        disabled={advBusy}
                        className="btn btn-warn rounded-[9px] px-3.5 py-2 text-[13px] font-semibold"
                      >
                        {advBusy ? <SpinnerIcon className="spin h-4 w-4" /> : <ZapIcon className="h-4 w-4" />}
                        <span>{advBusy ? t('starting') : t('tryAdvanced')}</span>
                      </button>
                      <p className="flex items-start gap-1.5 text-[12px]" style={{ color: 'var(--text-faint)' }}>
                        <ShieldAlertIcon className="mt-[1px] h-3.5 w-3.5" />
                        <span className="min-w-0">{t('advancedAdminHint')}</span>
                      </p>
                    </div>
                  )
                ) : (
                  <p className="flex items-start gap-1.5 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
                    <InfoIcon className="mt-[1px] h-3.5 w-3.5" style={{ color: 'var(--text-faint)' }} />
                    <span className="min-w-0">{advReasonText(advInfo, t)}</span>
                  </p>
                )}
              </Notice>
            )}
          </div>
        )}

        {/* Always here, not only after a site test says "still blocked": on
            networks that let the handshake through and cut the rest (Iran),
            the test says the site works, and the one mode that helps would
            otherwise never be shown. */}
        {!advInfo.active && (
          <div className="mt-4 rounded-[var(--radius-sm)] p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            <p className="flex items-center gap-1.5 text-[13.5px] font-semibold" style={{ color: 'var(--text)' }}>
              <ZapIcon className="h-4 w-4" style={{ color: advInfo.available ? 'var(--warn)' : 'var(--text-faint)' }} />
              <span>{t('advancedRowTitle')}</span>
            </p>
            <p className="mt-1 text-[12.5px] leading-snug" style={{ color: 'var(--text-dim)' }}>{t('advancedRowDesc')}</p>
            {advInfo.available ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <button type="button" onClick={enableAdvanced} disabled={advBusy}
                        className="btn btn-warn rounded-[9px] px-3.5 py-2 text-[13px] font-semibold">
                  {advBusy ? <SpinnerIcon className="spin h-4 w-4" /> : <ZapIcon className="h-4 w-4" />}
                  <span>{advBusy ? t('starting') : t('advancedTurnOn')}</span>
                </button>
                <span className="flex items-start gap-1.5 text-[12px]" style={{ color: 'var(--text-faint)' }}>
                  <ShieldAlertIcon className="mt-[1px] h-3.5 w-3.5" />
                  <span className="min-w-0">{t('advancedAdminHint')}</span>
                </span>
              </div>
            ) : (
              <p className="mt-2 flex items-start gap-1.5 text-[12px]" style={{ color: 'var(--text-faint)' }}>
                <InfoIcon className="mt-[1px] h-3.5 w-3.5" />
                <span className="min-w-0">{advReasonText(advInfo, t)}</span>
              </p>
            )}
          </div>
        )}

        {advError && (
          <div className="mt-3">
            <Notice tone={advError.tone} Icon={advError.tone === 'warn' ? AlertTriangleIcon : XCircleIcon}>
              <p style={{ color: advError.tone === 'warn' ? 'var(--warn)' : 'var(--danger)' }}>{advError.text}</p>
              {advError.detail && (
                <p className="mono mt-1 text-[11.5px]" dir="auto" style={{ color: 'var(--text-dim)' }}>{advError.detail}</p>
              )}
            </Notice>
          </div>
        )}

        {advInfo.active && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[var(--radius-sm)] p-3"
               style={{ background: 'var(--ok-soft)', border: '1px solid var(--ok-line)' }}>
            <span className="flex min-w-0 flex-1 items-start gap-2 text-[12.5px] leading-snug" style={{ color: 'var(--ok)' }}>
              <ZapIcon className="mt-[1px] h-4 w-4" />
              <span className="min-w-0">{t('advancedActive')}</span>
            </span>
            <button
              type="button"
              onClick={disableAdvanced}
              disabled={advBusy}
              className="btn btn-ghost rounded-full px-3 py-1.5 text-[12px] font-medium"
            >
              {advBusy && <SpinnerIcon className="spin h-3.5 w-3.5" />}
              <span>{t('advancedTurnOff')}</span>
            </button>
          </div>
        )}
      </Section>

      {/* App */}
      <Section title={t('appSection')}>
        <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
          <Toggle label={t('startOnBoot')} desc={t('startOnBootDesc')} checked={settings.autoStart} onChange={(v) => save('autoStart', v)} />
          <Toggle label={t('minimizeToTray')} desc={t('minimizeToTrayDesc')} checked={settings.minimizeToTray} onChange={(v) => save('minimizeToTray', v)} />
          <Toggle
            label={t('shareOnlineCount')}
            desc={t('shareOnlineCountDesc')}
            checked={settings.shareOnlineCount !== false}
            onChange={(v) => save('shareOnlineCount', v)}
          />
          <Toggle label={t('showNotifications')} desc={t('showNotificationsDesc')} checked={settings.showNotifications} onChange={(v) => save('showNotifications', v)} />
          <Toggle label={t('autoUpdate')} desc={t('autoUpdateDesc')} checked={settings.autoUpdate !== false} onChange={(v) => save('autoUpdate', v)} />
        </div>
        {/* Quitting is otherwise only in the tray menu, which some desktops
            (stock GNOME) never show. Quitting restores every setting. */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="m-0 min-w-0 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('quitAppDesc')}</p>
          <button type="button" onClick={() => window.electron?.quitApp?.()}
                  className="btn btn-ghost shrink-0 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('quitApp')}</button>
        </div>
      </Section>
    </div>
  );
}
