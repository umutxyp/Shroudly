'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { CheckIcon, CopyIcon, HeartIcon } from './icons';
import Select from './Select';
import { ACCOUNTS, PAYPAL_QR, PAYPAL_URL, RECIPIENT, accountFor, canPayFrom, fieldLabel } from './donate';

const DAY = 24 * 60 * 60 * 1000;
const FIRST_KEY = 'shroudly_support_first';
const LATER_KEY = 'shroudly_support_later';
// The card on the Protection panel: first after a few days of use, and after
// "Not now" (or a look at the section) not again for two months.
const WAIT_DAYS = 3;
const AGAIN_DAYS = 60;

/* The system's region ("TR", "DE"...), from the main process; null until known. */
function useCountry() {
  const [country, setCountry] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      let c = '';
      try { c = (await window.electron?.getAppInfo?.())?.country || ''; } catch {}
      if (live) setCountry(c);
    })();
    return () => { live = false; };
  }, []);
  return country;
}

/* What a bank's form takes: an IBAN without its spaces, a sort code or BSB
 * as digits. */
function copyForm(key, value) {
  if (key === 'iban') return value.replace(/\s+/g, '');
  if (key === 'sortCode' || key === 'bsb') return value.replace(/\D+/g, '');
  return value;
}

function Field({ label, value, copy, t }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const id = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(id);
  }, [done]);
  const onCopy = async () => {
    let ok = false;
    try { ok = !!(await window.electron?.copyText?.(copy ?? value)); } catch {}
    if (!ok) { try { await navigator.clipboard.writeText(copy ?? value); ok = true; } catch {} }
    if (ok) setDone(true);
  };
  return (
    <div className="-mx-2 flex items-center gap-2 border-t px-2 py-1.5 first:border-t-0" style={{ borderColor: 'var(--line)' }}>
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>{label}</p>
        <p className="num select-text text-[13px] font-medium leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>
          <span dir="ltr">{value}</span>
        </p>
      </div>
      <button type="button" onClick={onCopy} title={done ? t('supportCopied') : t('supportCopy')}
              aria-label={`${done ? t('supportCopied') : t('supportCopy')}: ${label}`}
              className="btn btn-ghost inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px]">
        {done ? <CheckIcon className="h-3.5 w-3.5" style={{ color: 'var(--ok)' }} /> : <CopyIcon className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/* About → "Support Shroudly": PayPal, and the bank account for where the
 * user sends from (their system's region; another can be picked). */
export function SupportSection({ focus = 0 }) {
  const { t, locale } = useLanguage();
  const country = useCountry();
  const [picked, setPicked] = useState(null);
  const ref = useRef(null);
  const labelId = useId();

  // Opened from the card or the tray: the section in view, and the card
  // rests as after "Not now".
  useEffect(() => {
    if (!focus) return;
    ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    try { localStorage.setItem(LATER_KEY, String(Date.now())); } catch {}
  }, [focus]);

  const regions = useMemo(() => {
    try { return new Intl.DisplayNames([locale || 'en'], { type: 'region' }); } catch { return null; }
  }, [locale]);
  const place = (a) => {
    if (a.id === 'eur') return t('supportSepa');
    if (a.id === 'swift') return t('supportElsewhere');
    try { return regions?.of(a.countries[0]) || a.countries[0]; } catch { return a.countries[0]; }
  };
  const account = (picked && ACCOUNTS.find((a) => a.id === picked)) || accountFor(country);
  const options = ACCOUNTS.map((a) => ({ value: a.id, label: place(a), hint: a.currency }));

  return (
    <section ref={ref} id="support" className="card scroll-mt-4 p-4">
      <h2 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold leading-snug" style={{ color: 'var(--text-dim)' }}>
        <HeartIcon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
        <span className="min-w-0">{t('supportTitle')}</span>
      </h2>
      <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{t('supportDesc')}</p>

      {/* PayPal: the button, and the code for paying from a phone. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
        <a href={PAYPAL_URL} target="_blank" rel="noreferrer"
           className="btn btn-primary inline-flex items-center gap-2 rounded-[8px] px-4 py-2 text-[13px] font-semibold">
          <HeartIcon className="h-4 w-4" />{t('supportPaypal')}
        </a>
        <div className="flex min-w-0 items-center gap-2.5">
          <img src={PAYPAL_QR} alt="" draggable={false} width={72} height={72}
               className="h-[72px] w-[72px] shrink-0 select-none rounded-[6px] bg-white p-1" />
          <span className="min-w-0 max-w-[12rem] text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('supportScan')}</span>
        </div>
      </div>

      {/* A bank transfer. */}
      <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
        <p className="text-[13px] font-semibold leading-snug" style={{ color: 'var(--text)' }}>{t('supportBank')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span id={labelId} className="text-[12.5px]" style={{ color: 'var(--text-dim)' }}>{t('supportBankFrom')}</span>
          <div className="min-w-[12rem] flex-1">
            <Select value={account.id} options={options} onChange={setPicked} ariaLabelledBy={labelId} />
          </div>
        </div>
        {account.id === 'swift' && (
          <p className="mt-2 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('supportSwiftDesc')}</p>
        )}
        <div className="mt-2 flex flex-col">
          <Field label={t('supportRecipient')} value={RECIPIENT} t={t} />
          {account.fields.map(([k, v]) => <Field key={`${account.id}-${k}`} label={fieldLabel(k, t)} value={v} copy={copyForm(k, v)} t={t} />)}
          <Field label={t('supportBankName')} value={account.bank} t={t} />
        </div>
        {account.qr && (
          <div className="mt-3 flex items-center gap-3">
            <img src={`./${account.qr}`} alt="QR Ph" draggable={false} width={120} height={120}
                 className="h-[120px] w-[120px] shrink-0 select-none rounded-[6px] bg-white p-1" />
            <span className="min-w-0 text-[12px] leading-snug" style={{ color: 'var(--text-faint)' }}>{t('supportQrPh')}</span>
          </div>
        )}
      </div>
    </section>
  );
}

/* A quiet card on the Protection panel while protection is on: never in a
 * window of its own, never as a notification, and not from countries where
 * no way of giving works. */
export function SupportBanner({ show, onOpen }) {
  const { t } = useLanguage();
  const country = useCountry();
  const [due, setDue] = useState(false);

  useEffect(() => {
    try {
      const now = Date.now();
      let first = Number(localStorage.getItem(FIRST_KEY)) || 0;
      if (!first) { first = now; localStorage.setItem(FIRST_KEY, String(now)); }
      const later = Number(localStorage.getItem(LATER_KEY)) || 0;
      setDue(now - first >= WAIT_DAYS * DAY && now - later >= AGAIN_DAYS * DAY);
    } catch {}
  }, []);

  if (!show || !due || country == null || !canPayFrom(country)) return null;
  const rest = () => {
    try { localStorage.setItem(LATER_KEY, String(Date.now())); } catch {}
    setDue(false);
  };
  return (
    <div role="note" className="no-drag mx-4 mb-3 rounded-[var(--radius-sm)] border py-2 pl-3 pr-2 sm:mx-5"
         style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <HeartIcon className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
        <span className="min-w-[14rem] flex-1 text-[12.5px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>
          {t('supportBanner')}
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-1.5">
          <button type="button" onClick={() => { rest(); onOpen?.(); }}
                  className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('supportBannerOpen')}</button>
          <button type="button" onClick={rest}
                  className="btn btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium">{t('supportBannerLater')}</button>
        </span>
      </div>
    </div>
  );
}
