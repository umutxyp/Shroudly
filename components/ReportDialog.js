'use client';

/*
 * "Something not working?": from the link under the main button
 * (ControlPanel). The user says what went wrong (50 to 1000 characters) and
 * it goes to the developer with the app's log in one go (electron/report.js),
 * which gives a reference number. What is sent, where it goes and that
 * nothing of it is kept on our server are said before the Send button, and
 * Send waits for the user to tick that they agree to send it, log included.
 * One report an hour, three a day. The same in the Android and Apple apps.
 */

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { CheckIcon, CloseIcon, CopyIcon, SpinnerIcon } from './icons';

const WHAT_MIN = 50;
const WHAT_MAX = 1000;
const chars = (s) => [...String(s || '').trim()].length;
const PRIVACY_URL = 'https://codeshare.me/projects/shroudly/privacy';

function Field({ label, value, onChange, max, multiline = false, required = false, id, hint = null }) {
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <label className="flex flex-col gap-1" htmlFor={id}>
      <span className="text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>{label}</span>
      {hint}
      <Tag
        id={id}
        value={value}
        maxLength={max}
        required={required}
        rows={multiline ? 5 : undefined}
        onChange={(e) => onChange(multiline ? [...e.target.value].slice(0, max).join('') : e.target.value)}
        className="field w-full px-3 py-2 text-[13px]"
        style={multiline ? { resize: 'vertical', minHeight: 84 } : undefined}
      />
    </label>
  );
}

export default function ReportDialog({ onClose }) {
  const { t, language } = useLanguage();
  const [fields, setFields] = useState({ what: '', site: '', isp: '', country: '', contact: '' });
  const [agree, setAgree] = useState(false);
  const [state, setState] = useState('idle');   // idle | sending | sent | error
  const [result, setResult] = useState(null);
  const [info, setInfo] = useState({ past: [], wait: { ms: 0 } });
  const [copied, setCopied] = useState(null);
  const boxRef = useRef(null);
  const set = (k) => (v) => setFields((f) => ({ ...f, [k]: v }));

  const load = () => {
    window.electron?.reportInfo?.().then((i) => { if (i) setInfo(i); }).catch(() => {});
  };
  useEffect(() => {
    load();
    const onKey = (e) => { if (e.key === 'Escape' && state !== 'sending') onClose(); };
    window.addEventListener('keydown', onKey);
    boxRef.current?.querySelector('textarea')?.focus();
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const limited = info.wait && info.wait.ms > 0;
  const n = chars(fields.what);
  const enough = n >= WHAT_MIN && n <= WHAT_MAX;
  const canSend = agree && enough && state !== 'sending' && !limited;

  const send = async () => {
    if (!canSend) return;
    setState('sending');
    let r = null;
    try { r = await window.electron.sendReport(fields); } catch {}
    setResult(r);
    setState(r && r.ok ? 'sent' : 'error');
    load();
  };

  const copy = async (ref) => {
    try { await window.electron?.writeClipboard?.(ref); } catch {}
    try { await navigator.clipboard?.writeText(ref); } catch {}
    setCopied(ref);
    setTimeout(() => setCopied(null), 1500);
  };

  const dateOf = (at) => {
    try { return new Date(at).toLocaleDateString(language, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; }
  };
  const rateText = (limit) => t(limit === 'day' ? 'reportRateDay' : 'reportRateHour');

  return (
    <div className="no-drag fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="report-title">
      <div className="tour-dim absolute inset-0" onClick={() => state !== 'sending' && onClose()} />
      <div
        ref={boxRef}
        className="scroll relative flex max-h-[calc(100vh-2rem)] w-[min(30rem,100%)] flex-col gap-3 overflow-y-auto rounded-[var(--radius)] border p-4"
        style={{ background: 'var(--surface-pop)', borderColor: 'var(--line-strong)', boxShadow: '0 18px 50px rgba(0,0,0,.5)' }}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="report-title" className="text-[16px] font-semibold leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>{t('reportTitle')}</h2>
          <button type="button" onClick={onClose} disabled={state === 'sending'} aria-label={t('close')}
                  className="shrink-0 rounded-md p-1 transition-opacity hover:opacity-70" style={{ color: 'var(--text-faint)' }}>
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <p className="text-[12.5px] leading-relaxed wrap-anywhere" style={{ color: 'var(--text-dim)' }}>{t('reportIntro')}</p>

        <p className="text-[12.5px] leading-relaxed wrap-anywhere" style={{ color: 'var(--text-dim)' }}>{t('reportSendDesc')}</p>

        {state === 'sent' && result?.ok ? (
          <div className="rounded-[var(--radius)] p-3" role="status" style={{ background: 'var(--ok-soft)' }}>
            <p className="text-[13px] font-medium" style={{ color: 'var(--ok)' }}>{t('reportSent')}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="mono select-all text-[15px] font-semibold" dir="ltr" style={{ color: 'var(--text)' }}>{result.ref}</code>
              <button type="button" onClick={() => copy(result.ref)} className="btn btn-ghost rounded-full px-2.5 py-1 text-[12px]">
                {copied === result.ref ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                <span>{copied === result.ref ? t('reportCopied') : t('reportCopy')}</span>
              </button>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{t('reportSentHint')}</p>
          </div>
        ) : (
          <>
            <Field id="report-what" label={t('reportWhat')} value={fields.what} onChange={set('what')} max={WHAT_MAX} multiline required
                   hint={<span className="text-[11.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('reportWhatHint')}</span>} />
            <p className="-mt-2 text-end text-[11px]" dir="ltr" aria-live="polite"
               style={{ color: n > 0 && n < WHAT_MIN ? 'var(--warn)' : 'var(--text-faint)' }}>{n} / {WHAT_MAX}</p>
            <Field id="report-site" label={t('reportSite')} value={fields.site} onChange={set('site')} max={300} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="report-isp" label={t('reportIsp')} value={fields.isp} onChange={set('isp')} max={120} />
              <Field id="report-country" label={t('reportCountry')} value={fields.country} onChange={set('country')} max={80} />
            </div>
            <Field id="report-contact" label={t('reportContact')} value={fields.contact} onChange={set('contact')} max={200} />

            <div className="rounded-[var(--radius)] border p-3 text-[12px] leading-relaxed wrap-anywhere"
                 style={{ borderColor: 'var(--line)', color: 'var(--text-dim)', background: 'var(--bg-sunk)' }}>
              {t('reportPrivacy')} {t('reportPrivacyProvider')}{' '}
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--accent)' }}>{t('androidPrivacyPolicy')}</a>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-[12.5px]" style={{ color: 'var(--text)' }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5" />
              <span>{t('reportAgree')}</span>
            </label>

            {limited && <p className="text-[12.5px]" role="status" style={{ color: 'var(--warn)' }}>{rateText(info.wait.limit)}</p>}
            {state === 'error' && result && !limited && (
              <p className="text-[12.5px]" role="alert" style={{ color: 'var(--danger)' }}>
                {result.error === 'rate' ? rateText(result.limit) : t('reportFailed')}
              </p>
            )}
            <button type="button" onClick={send} disabled={!canSend} aria-busy={state === 'sending'}
                    className="btn btn-primary w-full rounded-[var(--radius)] px-5 py-2.5 text-[14px] font-semibold">
              {state === 'sending' && <SpinnerIcon className="spin h-[16px] w-[16px]" />}
              <span>{state === 'sending' ? t('reportSending') : t('reportSend')}</span>
            </button>
          </>
        )}

        {info.past && info.past.length > 0 && (
          <div className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
            <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>{t('reportPast')}</h3>
            <p className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>{t('reportPastHint')}</p>
            <ul className="mt-2 flex flex-col gap-1">
              {info.past.map((r) => (
                <li key={r.ref} className="flex items-center justify-between gap-2 text-[12.5px]">
                  <code className="mono select-all" dir="ltr" style={{ color: 'var(--text)' }}>{r.ref}</code>
                  <span className="flex items-center gap-2">
                    <span style={{ color: 'var(--text-faint)' }}>{dateOf(r.at)}</span>
                    <button type="button" onClick={() => copy(r.ref)} aria-label={t('reportCopy')} className="rounded-md p-1 hover:opacity-70" style={{ color: 'var(--text-dim)' }}>
                      {copied === r.ref ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
