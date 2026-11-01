'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { ACCENTS, applyAppearance, readAppearance } from './Appearance';
import {
  AlertTriangleIcon, CheckCircleIcon, CheckIcon, ChevronDownIcon, GlobeIcon, PaletteIcon, InfoIcon, LanguagesIcon, SearchIcon, ShieldAlertIcon,
  SpinnerIcon, XCircleIcon, ZapIcon,
} from './icons';
import Select from './Select';
import { probeView } from './probeView';
import { OWN_SERVER_ERRORS, OWN_SERVER_WHY, serverShown } from './ownServerText';

/* The technique, one choice (as on Android): Auto finds what works for each
 * site by itself (the engine's auto mode); any other is that one technique
 * for every site, nothing else tried. Two controls, a list and an "Auto
 * mode" switch, could say opposite things. The engine's specs are not shown:
 * they meant nothing to the person choosing. */
const STRATEGIES = [
  { id: 'auto', labelKey: 'stratAuto', spec: 'split(sni)', auto: true },
  { id: 'split-sni', labelKey: 'stratSplitSni', spec: 'split(sni)', auto: false },
  { id: 'disorder-sni', labelKey: 'stratDisorderSni', spec: 'disorder(sni)', auto: false },
  { id: 'split-sni-mid', labelKey: 'stratSplitMid', spec: 'split(sni_mid)', auto: false },
  { id: 'double-split', labelKey: 'stratDoubleSplit', spec: 'split(1),split(sni)', auto: false },
  { id: 'split2', labelKey: 'stratSplit2', spec: 'split(2)', auto: false },
  // Off: connections untouched, encrypted DNS only (issue #37).
  { id: 'none', labelKey: 'stratNone', spec: 'none', auto: false },
];

/* advancedAvailable().reasonCode → translation key */
const ADV_REASON_KEYS = {
  mac_unsupported: 'advReasonMacUnsupported',
  arch_unsupported: 'advReasonArchUnsupported',
  not_built: 'advReasonNotBuilt',
  windivert_missing: 'advReasonWindivertMissing',
  platform_unsupported: 'advReasonPlatformUnsupported',
  // An installed Shroudly whose Advanced mode files an antivirus took.
  files_missing: 'advReasonFilesMissing',
};
/* startAdvanced().code → translation key */
const ADV_ERROR_KEYS = {
  declined: 'advErrorDeclined',
  elevation_unavailable: 'advErrorElevationUnavailable',
  // Linux: no polkit agent in the session to show the password window.
  no_agent: 'advErrorNoAgent',
  start_failed: 'advErrorStartFailed',
  timeout: 'advErrorTimeout',
  // An antivirus refused it, or took its files (main.js securityBlocked).
  security_blocked: 'advErrorSecurity',
  files_missing: 'advReasonFilesMissing',
};
const PROBE_TIMEOUT_MS = 25000;

function advReasonText(info, t) {
  const key = info && ADV_REASON_KEYS[info.reasonCode];
  if (key) return t(key);
  return info?.reason || t('advancedUnavailable');
}

/* What went wrong, in words. The system's own error ("WinDivertOpen failed:
 * error 577") is in the log, for a report, not here. */
function advErrorMessage(r, t) {
  // The WinDivert driver refused: said with Windows' error code, for a report.
  if (r && r.code === 'security_blocked' && r.kind === 'driver') {
    return { text: t('securityDriverBody', { code: r.win32 ?? '?' }), tone: 'warn' };
  }
  // Ended from outside without a word: an antivirus only may have; what to
  // do, without saying it did.
  if (r && r.code === 'security_blocked' && r.certain === false) {
    return { text: t('securityAdvancedBody'), tone: 'warn' };
  }
  const key = r && ADV_ERROR_KEYS[r.code];
  if (key) return { text: t(key), tone: ['declined', 'security_blocked', 'files_missing'].includes(r.code) ? 'warn' : 'danger' };
  return { text: t('advErrorGeneric'), tone: 'danger' };
}

/* No Advanced mode on this system at all (macOS, an unsupported processor
 * or system): nothing to offer and nothing to say about it. Its files
 * missing or not built in is said, with what to do. */
const NO_ADVANCED_HERE = ['mac_unsupported', 'platform_unsupported', 'arch_unsupported'];

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

function Section({ title, Icon, titleId, children }) {
  return (
    <section className="card p-4">
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
      className="row-hover my-1 flex w-full items-center justify-between gap-4 rounded-[8px] px-2 py-2 text-start"
    >
      <span className="min-w-0 flex-1">
        {/* Unavailable: the label and the switch dimmed, the sentence that
            says why kept readable (globals.css). */}
        <span className="toggle-label block text-[14px] font-medium leading-snug" style={{ color: 'var(--text)' }}>{label}</span>
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

/* "DNS server" (issue #34): automatic (the built-in encrypted DNS) or one of
 * the user's own. What is typed is asked once before it is used, and the
 * answer shown; one that does not answer is used only when the user says
 * so (and, if it stops answering, the built-in one answers meanwhile). */
const DNS_KINDS = [
  { value: 'doh', labelKey: 'dnsKindDoh', example: 'https://dns.google/dns-query' },
  { value: 'dot', labelKey: 'dnsKindDot', example: 'dns.quad9.net' },
  { value: 'tcp', labelKey: 'dnsKindTcp', example: '8.8.8.8' },
  { value: 'udp', labelKey: 'dnsKindUdp', example: '1.1.1.1' },
];
const DNS_ERRORS = { empty: 'dnsErrorEmpty', url: 'dnsErrorUrl', host: 'dnsErrorHost', port: 'dnsErrorPort', kind: 'dnsErrorHost', proxy: 'dnsErrorProxy' };
// A proxy of the user's own for the server's connections (#58): not for UDP.
const proxyFor = (kind) => kind !== 'auto' && kind !== 'udp';

function DnsServer({ value, onSave }) {
  const { t } = useLanguage();
  const labelId = useId();
  const saved = value && typeof value === 'object' ? value : null;
  const [kind, setKind] = useState(saved ? saved.kind : 'auto');
  const [text, setText] = useState(saved ? saved.server : '');
  const [strict, setStrict] = useState(!!(saved && saved.strict));
  const [proxy, setProxy] = useState((saved && saved.proxy) || '');
  const [state, setState] = useState(null);   // { testing } | { ok, ms, address } | { error | invalid, tried }
  useEffect(() => {
    setKind(saved ? saved.kind : 'auto');
    setText(saved ? saved.server : '');
    setStrict(!!(saved && saved.strict));
    setProxy((saved && saved.proxy) || '');
  }, [saved && saved.kind, saved && saved.server, saved && saved.strict, saved && saved.proxy]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (k) => {
    setKind(k); setState(null);
    if (k === 'auto') { if (saved) onSave(null); return; }
    if (saved && saved.kind === k) setText(saved.server);
    else if (!saved || saved.kind !== k) setText('');
  };
  const use = async () => {
    const v = { kind, server: text.trim(), strict, proxy: proxyFor(kind) ? proxy.trim() : '' };
    // Asked before and it did not answer: the user says use it anyway.
    if (state && state.tried === `${v.kind} ${v.server} ${v.proxy}` && !state.invalid) { onSave(v); setState(null); return; }
    setState({ testing: true });
    let r;
    try { r = await window.electron.testDns(v); } catch { r = { ok: false, error: 'no answer' }; }
    if (r && r.ok) { onSave(v); setState({ ok: true, ms: r.ms, address: r.address }); return; }
    setState({ ...(r || {}), tried: `${v.kind} ${v.server} ${v.proxy}` });
  };
  const current = DNS_KINDS.find((k) => k.value === kind);
  const proxyNow = proxyFor(kind) ? proxy.trim() : '';
  const dirty = !saved || saved.kind !== kind || saved.server !== text.trim() || (saved.proxy || '') !== proxyNow;
  const anyway = state && state.tried === `${kind} ${text.trim()} ${proxyNow}` && !state.invalid;

  return (
    <div className="py-2.5">
      <p id={labelId} className="mb-1.5 text-[14px] font-medium leading-snug" style={{ color: 'var(--text)' }}>{t('dnsServer')}</p>
      <Select
        value={kind}
        ariaLabelledBy={labelId}
        options={[{ value: 'auto', label: t('dnsServerAuto') }, ...DNS_KINDS.map((k) => ({ value: k.value, label: t(k.labelKey) }))]}
        onChange={pick}
      />
      {kind !== 'auto' && (
        <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim() && !(state && state.testing)) use(); }}>
          <input
            value={text}
            onChange={(e) => { setText(e.target.value); if (state && !state.testing) setState(null); }}
            placeholder={current ? current.example : ''}
            aria-label={t('dnsServer')}
            dir="ltr"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            className="field mono min-w-[150px] flex-[1_1_180px] px-3 py-2 text-[13px]"
            style={{ textAlign: 'start' }}
          />
          <button
            type="submit"
            disabled={!text.trim() || !!(state && state.testing) || (!dirty && !anyway)}
            className="btn btn-primary flex-[0_0_auto] rounded-[var(--radius-sm)] px-4 py-2 text-[13px] font-semibold"
          >
            {state && state.testing && <SpinnerIcon className="spin h-4 w-4" />}
            <span>{state && state.testing ? t('testing') : anyway ? t('dnsServerUseAnyway') : t('dnsServerUse')}</span>
          </button>
          {proxyFor(kind) && (
            <label className="block basis-full">
              <span className="mb-1 block text-[12.5px] font-medium" style={{ color: 'var(--text)' }}>{t('dnsServerProxy')}</span>
              <input
                value={proxy}
                onChange={(e) => { setProxy(e.target.value); if (state && !state.testing) setState(null); }}
                placeholder="socks5://127.0.0.1:1080"
                dir="ltr"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="url"
                className="field mono w-full px-3 py-2 text-[13px]"
                style={{ textAlign: 'start' }}
              />
              <span className="mt-1 block text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('dnsServerProxyDesc')}</span>
            </label>
          )}
        </form>
      )}
      <div aria-live="polite">
        {state && state.ok && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug" style={{ color: 'var(--ok)' }}>
            <CheckCircleIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{t('dnsServerOk', { ms: state.ms, address: state.address })}</span>
          </p>
        )}
        {state && (state.invalid || state.error) && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug" style={{ color: 'var(--warn)' }}>
            <AlertTriangleIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{state.invalid ? t(DNS_ERRORS[state.invalid] || 'dnsErrorHost', { example: current ? current.example : '' }) : t('dnsServerFails', { error: state.error })}</span>
          </p>
        )}
      </div>
      {kind !== 'auto' && (
        <p className="mt-2 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('dnsServerDesc')}</p>
      )}
      {/* The exception to the line above. */}
      {kind !== 'auto' && (
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-[12.5px] leading-snug" style={{ color: 'var(--text-dim)' }}>
          <input
            type="checkbox"
            className="mt-[2px]"
            checked={strict}
            onChange={(e) => {
              const v = e.target.checked;
              setStrict(v);
              // The server in use already: the choice applies at once.
              if (saved && saved.kind === kind && saved.server === text.trim()) onSave({ ...saved, strict: v });
            }}
          />
          <span className="min-w-0">
            <span className="block font-medium" style={{ color: 'var(--text)' }}>{t('dnsServerStrict')}</span>
            <span className="block" style={{ color: 'var(--text-faint)' }}>{t('dnsServerStrictDesc')}</span>
          </span>
        </label>
      )}
    </div>
  );
}

/* "Your own server": every site through a server the user names, as one
 * link (SOCKS5, HTTP or Shadowsocks; electron/own-server.js). Tested
 * before it is used, as the DNS server is: a site's certificate has to
 * come through it. Saved: what it is (never the password), and the way to
 * stop using it. */
function OwnServer({ value, onSave }) {
  const { t } = useLanguage();
  const descId = useId();
  const saved = typeof value === 'string' ? value : '';
  const [text, setText] = useState(saved);
  const [state, setState] = useState(null);   // { testing } | { ok, ms } | { why | invalid, method, tried }
  useEffect(() => { setText(saved); }, [saved]);

  const use = async () => {
    const v = text.trim();
    // Tested before and it did not work: the user says use it anyway.
    if (state && state.tried === v && !state.invalid) { if (await onSave(v)) setState(null); return; }
    setState({ testing: true });
    let r;
    try { r = await window.electron.testOwnServer(v); } catch { r = { ok: false, why: 'noAnswer' }; }
    if (r && r.ok) { setState((await onSave(v)) ? { ok: true, ms: r.ms } : { invalid: 'format', tried: v }); return; }
    setState({ ...(r || {}), tried: v });
  };
  const off = async () => { if (await onSave(null)) { setText(''); setState(null); } };
  const dirty = text.trim() !== saved;
  const anyway = state && state.tried === text.trim() && !state.invalid;
  const shown = serverShown(saved);

  return (
    <div>
      <p id={descId} className="text-[12.5px] leading-snug" style={{ color: 'var(--text-dim)' }}>{t('ownServerDesc')}</p>
      <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim() && !(state && state.testing)) use(); }}>
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); if (state && !state.testing) setState(null); }}
          placeholder="socks5://1.2.3.4:1080 · ss://…"
          aria-label={t('ownServer')}
          aria-describedby={descId}
          dir="ltr"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="url"
          className="field mono min-w-[150px] flex-[1_1_180px] px-3 py-2 text-[13px]"
          style={{ textAlign: 'start' }}
        />
        <button
          type="submit"
          disabled={!text.trim() || !!(state && state.testing) || (!dirty && !anyway)}
          className="btn btn-primary flex-[0_0_auto] rounded-[var(--radius-sm)] px-4 py-2 text-[13px] font-semibold"
        >
          {state && state.testing && <SpinnerIcon className="spin h-4 w-4" />}
          <span>{state && state.testing ? t('testing') : anyway ? t('dnsServerUseAnyway') : t('dnsServerUse')}</span>
        </button>
      </form>
      <div aria-live="polite">
        {state && state.ok && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug" style={{ color: 'var(--ok)' }}>
            <CheckCircleIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{t('ownServerOk', { ms: state.ms })}</span>
          </p>
        )}
        {state && (state.invalid || state.why) && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug" style={{ color: 'var(--warn)' }}>
            <AlertTriangleIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{state.invalid
              ? t(OWN_SERVER_ERRORS[state.invalid] || 'ownServerErrFormat', { method: state.method || '' })
              : t('ownServerFails', { why: t(OWN_SERVER_WHY[state.why] || 'ownServerWhyNoAnswer') })}</span>
          </p>
        )}
      </div>
      {saved && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>
            {t('ownServerInUse', { server: shown || '…' })}
          </p>
          <button type="button" onClick={off} className="btn btn-ghost flex-[0_0_auto] rounded-[var(--radius-sm)] px-3 py-1.5 text-[12.5px] font-semibold">
            {t('ownServerOff')}
          </button>
        </div>
      )}
    </div>
  );
}

/* "Share my connection" (electron/share.js): off until turned on, with
 * what it means said first. On: a link per way in (the internet's, where
 * the router opened one; this network's), each to copy; what the router
 * said; who is connected now; and a new link, which ends the old one. */
function ShareConnection({ onChange }) {
  const { t } = useLanguage();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => window.electron?.getShareStatus?.().then((s) => { if (alive && s) setSt((p) => (p && p.error && !s.on ? { ...s, error: p.error } : s)); }).catch(() => {});
    load();
    const iv = setInterval(load, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  const set = async (on) => {
    setBusy(true);
    try { const s = await window.electron.setShare(on); setSt(s); onChange(!!(s && s.on)); } catch {}
    setBusy(false);
  };
  const renew = async () => {
    setBusy(true);
    try { setSt(await window.electron.newShareLink()); } catch {}
    setBusy(false);
  };
  const copy = async (link) => {
    let ok = false;
    try { ok = !!(await window.electron?.copyText?.(link)); } catch {}
    if (!ok) { try { await navigator.clipboard.writeText(link); ok = true; } catch {} }
    if (ok) { setCopied(link); setTimeout(() => setCopied(null), 2000); }
  };
  const on = !!(st && st.on);
  const upnp = on && (st.upnp === 'trying' ? t('shareUpnpTrying') : st.upnp === 'private' ? t('shareUpnpPrivate')
    : st.upnp === 'none' ? t('shareUpnpNone', { port: st.port }) : null);

  return (
    <div>
      <p className="mb-1 text-[12.5px] leading-snug" style={{ color: 'var(--text-dim)' }}>{t('shareDesc')}</p>
      <Toggle label={t('shareOn')} checked={on} disabled={busy || !st} onChange={set} />
      {st && st.error && !on && (
        <p className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug wrap-anywhere" style={{ color: 'var(--warn)' }}>
          <AlertTriangleIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{t('shareFailed', { error: st.error })}</span>
        </p>
      )}
      {on && (
        <div className="mt-1 flex flex-col gap-3" aria-live="polite">
          {st.links.map((l) => (
            <div key={l.link}>
              <p className="text-[12.5px] font-medium leading-snug" style={{ color: 'var(--text)' }}>
                {t(l.where === 'internet' ? 'shareLinkInternet' : 'shareLinkNetwork', { address: l.address })}
              </p>
              <div className="mt-1 flex gap-2">
                <input readOnly value={l.link} dir="ltr" aria-label={t(l.where === 'internet' ? 'shareLinkInternet' : 'shareLinkNetwork', { address: l.address })}
                       onFocus={(e) => e.target.select()} className="field mono min-w-0 flex-1 px-3 py-2 text-[12px]" style={{ textAlign: 'start' }} />
                <button type="button" onClick={() => copy(l.link)} className="btn btn-ghost flex-[0_0_auto] rounded-[var(--radius-sm)] px-3 py-1.5 text-[12.5px] font-semibold">
                  {copied === l.link ? t('supportCopied') : t('supportCopy')}
                </button>
              </div>
            </div>
          ))}
          {upnp && <p className="text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{upnp}</p>}
          {!st.protected && (
            <p className="flex items-start gap-1.5 text-[12px] leading-snug" style={{ color: 'var(--warn)' }}>
              <AlertTriangleIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">{t('shareUnprotected')}</span>
            </p>
          )}
          <p className="text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('sharePeople', { people: st.people, open: st.open, total: st.total })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={renew} disabled={busy} className="btn btn-ghost flex-[0_0_auto] rounded-[var(--radius-sm)] px-3 py-1.5 text-[12.5px] font-semibold">
              {t('shareNewLink')}
            </button>
            <span className="min-w-0 flex-1 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('shareNewLinkDesc')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettingsPanel({ active = false }) {
  const { language, setLanguage, t, availableLanguages, locale } = useLanguage();
  const strategyLabelId = useId();
  const languageLabelId = useId();
  const [testHost, setTestHost] = useState('');
  // macOS has a menu bar where the others have a tray: said so (ML-13).
  const [isMac, setIsMac] = useState(false);
  useEffect(() => { setIsMac(window.electron?.platform === 'darwin'); }, []);
  const [testing, setTesting] = useState(null);       // host being tested
  const [testNote, setTestNote] = useState(null);     // 'needsProtection' | 'noAnswer'
  const [startingTest, setStartingTest] = useState(false);
  const [probeResult, setProbeResult] = useState(null);
  const [advInfo, setAdvInfo] = useState({ available: false, active: false, reason: null, reasonCode: null });
  const [repairState, setRepairState] = useState(null);   // 'busy' | { missing, flushed, restarted }
  const [advBusy, setAdvBusy] = useState(false);
  const [advError, setAdvError] = useState(null);
  const testingRef = useRef(null);
  const timeoutRef = useRef(null);
  const [settings, setSettings] = useState({
    strategyId: 'auto', autoMode: true, dnsProtection: true, preferIpv6: false, routeMode: 'all',
    autoStart: false, minimizeToTray: true, showNotifications: true, askByItself: true,
  });
  // null while unknown; false greys out "Prefer IPv6" on IPv4-only networks
  const [ipv6Ok, setIpv6Ok] = useState(null);
  // Discord app mode: shown only where the Discord app has been used
  const [discord, setDiscord] = useState({ installed: false, on: false });
  // Games and apps mode: shown on the systems where it works (Windows, macOS)
  const [apps, setApps] = useState({ available: false, on: false, store: false });
  // Microsoft Store apps: shown on Windows only
  const [storeApps, setStoreApps] = useState({ available: false, on: false });
  const [defaultList, setDefaultList] = useState([]);
  const [siteText, setSiteText] = useState(null);   // textarea draft (null until loaded)
  const [badEntries, setBadEntries] = useState([]); // lines dropped as unusable
  const [allowText, setAllowText] = useState(null);  // ad blocking exceptions draft
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
    const load = () => window.electron?.discordStatus?.()
      .then((d) => setDiscord({ installed: !!d?.installed, on: d?.mode === true }))
      .catch(() => {});
    load();
    // The autopilot may turn the mode on by itself: the switch follows.
    const off = window.electron?.onDiscordState?.(load);
    return () => { if (typeof off === 'function') off(); };
  }, []);

  async function setDiscordMode(on) {
    setDiscord((d) => ({ ...d, on }));
    try {
      const r = await window.electron.discordSet(on);
      if (!r?.success) setDiscord((d) => ({ ...d, on: !on }));
    } catch { setDiscord((d) => ({ ...d, on: !on })); }
  }

  const loadApps = (running) => window.electron?.appsStatus?.({ running: running === true })
    .then((a) => setApps({ available: !!a?.available, on: a?.mode === true, store: !!a?.storeEdition }))
    .catch(() => {});
  useEffect(() => {
    loadApps(true);
    const off = window.electron?.onAppsState?.(() => loadApps());
    return () => { if (typeof off === 'function') off(); };
  }, []);
  async function setAppMode(on) {
    setApps((a) => ({ ...a, on }));
    try {
      const r = await window.electron.appsSet(on);
      if (!r?.success) setApps((a) => ({ ...a, on: !on }));
    } catch { setApps((a) => ({ ...a, on: !on })); }
  }

  useEffect(() => {
    const load = () => window.electron?.storeAppsStatus?.()
      .then((s) => setStoreApps({ available: !!s?.available, on: s?.on === true }))
      .catch(() => {});
    load();
    // The autopilot turns it on by itself: the switch follows.
    const off = window.electron?.onStoreAppsState?.(load);
    return () => { if (typeof off === 'function') off(); };
  }, []);
  async function setStoreAppsMode(on) {
    setStoreApps((a) => ({ ...a, on }));
    try {
      const r = await window.electron.storeAppsSet(on);
      // Turning it on needs the system's permission; declined, it stays off.
      if (on && !r?.success) setStoreApps((a) => ({ ...a, on: false }));
    } catch { setStoreApps((a) => ({ ...a, on: !on })); }
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

  // Whatever the autopilot turns on by itself shows here as it happens.
  useEffect(() => {
    const offAdv = window.electron?.onAdvancedState?.(() => {
      window.electron.advancedAvailable?.().then((i) => i && setAdvInfo(i)).catch(() => {});
    });
    const off = window.electron?.onAutoNotice?.(() => {
      window.electron.advancedAvailable?.().then((i) => i && setAdvInfo(i)).catch(() => {});
      window.electron.getAllSettings?.().then((all) => all && setSettings((p) => ({ ...p, ...all }))).catch(() => {});
    });
    return () => { if (typeof off === 'function') off(); if (typeof offAdv === 'function') offAdv(); };
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

  // Resolves false when the change was refused (and put back).
  async function save(key, value) {
    const before = settings[key];
    setSettings((p) => ({ ...p, [key]: value }));
    if (typeof window !== 'undefined' && window.electron?.setSetting) {
      try {
        const r = await window.electron.setSetting(key, value);
        if (r && r.success === false) { setSettings((p) => ({ ...p, [key]: before })); return false; }
      } catch { setSettings((p) => ({ ...p, [key]: before })); return false; }
    }
    return true;
  }
  // Start at sign-in that the system would not take (a folder that cannot
  // be written, a policy): said under the switch, which went back off with
  // nothing said.
  const [autoStartRefused, setAutoStartRefused] = useState(false);
  const setAutoStartSetting = async (v) => {
    setAutoStartRefused(false);
    if (!(await save('autoStart', v)) && v) setAutoStartRefused(true);
  };

  async function onStrategyChange(id) {
    const s = STRATEGIES.find((x) => x.id === id) || STRATEGIES[0];
    setSettings((p) => ({ ...p, strategyId: s.id, autoMode: s.auto }));
    if (typeof window !== 'undefined' && window.electron?.setSetting) {
      try {
        await window.electron.setSetting('strategyId', s.id);
        await window.electron.setSetting('strategy', s.spec);
        await window.electron.setSetting('autoMode', s.auto);
      } catch {}
    }
  }
  /* What the list shows. Auto mode on is "Auto", whatever technique an
   * earlier version kept beside it (it is only where the search starts);
   * off with "Auto" picked is the technique Auto starts from, alone. */
  const shownStrategy = settings.autoMode !== false ? 'auto'
    : settings.strategyId === 'auto' || !STRATEGIES.some((x) => x.id === settings.strategyId) ? 'split-sni' : settings.strategyId;

  /* "More settings" open by itself when something in it is not as a new
   * install has it: the user, or someone helping them, set it and should
   * find it. */
  const moreId = useId();
  const [more, setMore] = useState(null);
  const moreSet = shownStrategy !== 'auto' || settings.dnsProtection === false || !!settings.customDns || !!settings.ownServer || settings.shareOn === true
    || settings.preferIpv6 === true || settings.routeMode === 'listed' || settings.showTrayIcon === false
    || (!isMac && settings.askByItself === false);
  const moreOpen = more ?? moreSet;

  // started: protection was just started for this test (the window's own
  // status may not have caught up yet).
  async function runTest(started = false) {
    const host = normalizeHost(testHost);
    if (!host || testing) return;
    setProbeResult(null);
    setAdvError(null);
    setTestNote(null);
    if (!active && !started) { setTestNote('needsProtection'); return; }
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

  // Protection off: started from here, and the test then runs by itself.
  async function startAndTest() {
    if (!window.electron?.startDPI) return;
    setStartingTest(true);
    let ok = false;
    try { ok = !!(await window.electron.startDPI())?.success; } catch {}
    setStartingTest(false);
    if (ok) runTest(true);
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

  const strategyOptions = STRATEGIES.map((s) => ({ value: s.id, label: t(s.labelKey) }));

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

      {/* Test a site */}
      <Section title={t('testSite')} Icon={SearchIcon}>
        <p className="mb-3 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('testSiteDesc')}</p>
        {/* The tour points at the field itself: the whole section, with a
            result in it, could be taller than the room its card has. */}
        <form
          data-tour="sitetest"
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
          <div className="mt-3">
            <Notice tone="info" Icon={InfoIcon}>
              <p style={{ color: 'var(--text-dim)' }}>{t('testNeedsProtection')}</p>
              <button type="button" onClick={startAndTest} disabled={startingTest}
                      className="btn btn-primary mt-2.5 rounded-[9px] px-3.5 py-2 text-[13px] font-semibold">
                {startingTest && <SpinnerIcon className="spin h-4 w-4" />}
                <span>{startingTest ? t('starting') : t('start')}</span>
              </button>
            </Notice>
          </div>
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
                  {t('probeWorks', { host: probeResult.host })}
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
                ) : !NO_ADVANCED_HERE.includes(advInfo.reasonCode) && (
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
            networks that let the handshake through and cut the rest,
            the test says the site works, and the one mode that helps would
            otherwise never be shown. Not where this system has no Advanced
            mode at all (macOS): a row to say it cannot be had is only one
            more thing to read (ML-9). Not while a result above offers it
            already (two of the same button) or says the site itself refuses
            (no mode changes that), nor with protection off: it is part of
            protection, and the screen would say "Not protected" while it
            ran. */}
        {active && !advInfo.active && !probeBlocked && !probeShown.refused && !NO_ADVANCED_HERE.includes(advInfo.reasonCode) && (
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

      {/* The modes for apps that ignore the system proxy: in sight, as the
          notices that say "turn it on in Settings" expect. Shown where at
          least one of them exists on this system. */}
      {(discord.installed || apps.available || storeApps.available) && (
        <Section title={t('androidAppsSection')}>
          <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
            {discord.installed && (
              <Toggle label={t('discordModeLabel')} desc={t('discordModeDesc')}
                      checked={discord.on} onChange={setDiscordMode} />
            )}
            {/* Shroudly turns this on by itself when Roblox is blocked
                (autopilot.js); the switch is for whoever wants it either way. */}
            {apps.available && (
              <div>
              <Toggle label={t('appModeLabel')} desc={t('appModeDesc')}
                      checked={apps.on} onChange={setAppMode} />
              {apps.on && apps.store && (
                <p className="pb-3 text-[12px] leading-snug" style={{ color: 'var(--warn)' }}>{t('appStoreEdition')}</p>
              )}
              </div>
            )}
            {/* Windows: Shroudly lets Store apps reach it by itself
                (store-apps.js); off takes its exemptions out again. */}
            {storeApps.available && (
              <Toggle label={t('storeAppsLabel')} desc={t('storeAppsDesc')}
                      checked={storeApps.on} onChange={setStoreAppsMode} />
            )}
          </div>
        </Section>
      )}

      {/* App */}
      <Section title={t('appSection')}>
        <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
          <div>
            <Toggle label={t('startOnBoot')} desc={t('startOnBootDesc')} checked={settings.autoStart} onChange={setAutoStartSetting} />
            {autoStartRefused && (
              <p role="status" className="pb-3 text-[12px] leading-snug" style={{ color: 'var(--warn)' }}>{t('startOnBootRefused', { logs: t('navLogs') })}</p>
            )}
          </div>
          <Toggle label={t(isMac ? 'minimizeToTrayMac' : 'minimizeToTray')} desc={t(isMac ? 'minimizeToTrayDescMac' : 'minimizeToTrayDesc')} checked={settings.minimizeToTray} onChange={(v) => save('minimizeToTray', v)} />
          <Toggle label={t('adBlock')} desc={t('adBlockDesc')} checked={settings.adBlock === true} onChange={(v) => save('adBlock', v)} />
          {settings.adBlock === true && (
            <div className="py-2.5">
              <p className="mb-1.5 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('adBlockAllowDesc')}</p>
              <textarea
                aria-label={t('adBlockAllow')}
                value={allowText == null ? (Array.isArray(settings.adBlockAllow) ? settings.adBlockAllow : []).join('\n') : allowText}
                onChange={(e) => setAllowText(e.target.value)}
                onBlur={() => {
                  if (allowText == null) return;
                  const list = [...new Set(allowText
                    .split(/[\s,]+/)
                    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*?\./, '').replace(/\/.*$/, ''))
                    .filter(isHostname))];
                  setAllowText(null);
                  save('adBlockAllow', list);
                }}
                rows={3}
                spellCheck={false}
                placeholder="example.com"
                className="mono w-full resize-y rounded-[var(--radius-sm)] p-2.5 text-[12.5px] leading-relaxed outline-none"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
              />
            </div>
          )}
          <Toggle
            label={t('shareOnlineCount')}
            desc={t('shareOnlineCountDesc')}
            checked={settings.shareOnlineCount !== false}
            onChange={(v) => save('shareOnlineCount', v)}
          />
          <Toggle label={t('showNotifications')} desc={t('showNotificationsDesc')} checked={settings.showNotifications} onChange={(v) => save('showNotifications', v)} />
          <Toggle label={t('autoUpdate')} desc={t('autoUpdateDesc')} checked={settings.autoUpdate !== false} onChange={(v) => save('autoUpdate', v)} />
        </div>
        {/* Repair: Shroudly's files checked, what it learned forgotten, its
            network settings set again (issue #46). */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="m-0 min-w-0 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('repairAppDesc')}</p>
          <button type="button" disabled={repairState === 'busy'}
                  onClick={async () => {
                    setRepairState('busy');
                    try { setRepairState(await window.electron?.repairApp?.() || null); } catch { setRepairState(null); }
                  }}
                  className="btn btn-ghost inline-flex shrink-0 items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">
            {repairState === 'busy' && <SpinnerIcon className="spin h-3.5 w-3.5" />}
            <span>{t('repairApp')}</span>
          </button>
        </div>
        {repairState && repairState !== 'busy' && (
          <p className="m-0 mt-2 text-[12px] leading-snug" role="status"
             style={{ color: repairState.missing && repairState.missing.length ? 'var(--warn)' : 'var(--text-dim)' }}>
            {repairState.missing && repairState.missing.length
              ? (<>{t('repairFilesMissing', { files: repairState.missing.join(', ') })}{' '}
                  <a href="https://github.com/umutxyp/Shroudly/releases/latest" target="_blank" rel="noreferrer"
                     className="font-semibold underline">{t('repairDownload')}</a></>)
              : t('repairDone')}
          </p>
        )}
        {/* Every setting back to how a new install has it; the modes turned
            off properly first, then the app starts again. */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="m-0 min-w-0 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('resetSettingsDesc')}</p>
          <button type="button"
                  onClick={() => {
                    if (!window.confirm(t('resetSettingsConfirm'))) return;
                    // The colours and Liquid glass live in the window, not in
                    // the settings file: back to a new install's too.
                    setAppearance({ accent: 'sky', surface: 'solid' });
                    window.electron?.resetSettings?.();
                  }}
                  className="btn btn-ghost shrink-0 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('resetSettings')}</button>
        </div>
        {/* Quitting is otherwise only in the tray menu, which some desktops
            (stock GNOME) never show. Quitting restores every setting. */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="m-0 min-w-0 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('quitAppDesc')}</p>
          <button type="button" onClick={() => window.electron?.quitApp?.()}
                  className="btn btn-ghost shrink-0 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('quitApp')}</button>
        </div>
      </Section>
      {/* Appearance: after what Shroudly does, not before it */}
      <Section title={t('appearance')} Icon={PaletteIcon}>
        <p className="mb-3 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('accentColour')}</p>
        {/* A nine-column grid rather than a wrapping row: the swatches scale
            with the window instead of spilling into a stray second line at
            narrow widths, which read as a layout accident. */}
        <div className="grid grid-cols-9 gap-1.5 sm:gap-2.5">
          {ACCENTS.map((a, i) => {
            const on = look.accent === a.id;
            return (
              <button
                key={a.id}
                type="button"
                aria-label={t('accentSwatch', { n: i + 1, total: ACCENTS.length })}
                aria-pressed={on}
                onClick={() => setAppearance({ accent: a.id })}
                className="swatch relative aspect-square w-full rounded-full transition-transform duration-150 hover:scale-110"
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

      {/* "More settings": what only someone helping the user should
          change, folded away as on Android ("Advanced", a name the desktop
          keeps for its packet-level mode). Open from the start when
          something in it is set otherwise than a new install has it. */}
      <section className="card">
        <button
          type="button"
          onClick={() => setMore(!moreOpen)}
          aria-expanded={moreOpen}
          aria-controls={moreId}
          className="row-hover flex w-full items-center gap-3 rounded-[var(--radius)] p-4 text-start"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold leading-snug" style={{ color: 'var(--text-dim)' }}>{t('moreSettings')}</span>
            <span className="mt-0.5 block text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('androidAdvancedDesc')}</span>
          </span>
          <ChevronDownIcon className="h-4 w-4 shrink-0 transition-transform duration-150"
                           style={{ color: 'var(--text-faint)', transform: moreOpen ? 'rotate(180deg)' : 'none' }} />
        </button>
      </section>
      {moreOpen && (
        <div id={moreId} className="flex flex-col gap-3">
          <Section title={t('dpiBypassTechniques')}>
            <p id={strategyLabelId} className="mb-1.5 text-[12px] font-medium" style={{ color: 'var(--text-faint)' }}>{t('strategy')}</p>
            <div className="mb-2">
              <Select
                value={shownStrategy}
                options={strategyOptions}
                onChange={onStrategyChange}
                ariaLabelledBy={strategyLabelId}
              />
            </div>

            <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
              <Toggle label={t('dnsProtection')} desc={t('dnsProtectionDesc')} checked={settings.dnsProtection !== false} onChange={(v) => save('dnsProtection', v)} />
              {settings.dnsProtection !== false && (
                <DnsServer value={settings.customDns} onSave={(v) => save('customDns', v)} />
              )}
              <Toggle label={t('preferIpv6')}
                      desc={ipv6Ok === false ? t('ipv6Unavailable') : t('preferIpv6Desc')}
                      checked={settings.preferIpv6}
                      disabled={ipv6Ok === false && !settings.preferIpv6}
                      onChange={(v) => save('preferIpv6', v)} />
            </div>

            {active && (
              <p className="mt-2 flex items-start gap-2 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>
                <InfoIcon className="mt-[1px] h-3.5 w-3.5" />
                <span className="min-w-0">{t('restartToApply')}</span>
              </p>
            )}
          </Section>
          <Section title={t('ownServer')}>
            <OwnServer value={settings.ownServer} onSave={(v) => save('ownServer', v)} />
          </Section>
          <Section title={t('share')}>
            <ShareConnection onChange={(on) => setSettings((p) => ({ ...p, shareOn: on }))} />
          </Section>
          {/* Routing: which sites go through Shroudly */}
          <Section title={t('routing')} Icon={GlobeIcon}>
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
          <Section>
            <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
              <Toggle label={t(isMac ? 'showTrayIconMac' : 'showTrayIcon')} desc={t('showTrayIconDesc')} checked={settings.showTrayIcon !== false} onChange={(v) => save('showTrayIcon', v)} />
              {/* Off: no permission prompt is ever brought up by Shroudly on its
                  own (Advanced mode, Microsoft Store apps); it says what needs
                  which mode instead (issue #55). */}
              {/* macOS has neither Advanced mode nor Microsoft Store apps: nothing
                  there to ask about. */}
              {!isMac && <Toggle label={t('askByItself')} desc={t('askByItselfDesc')} checked={settings.askByItself !== false} onChange={(v) => save('askByItself', v)} />}
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}
