'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { AlertTriangleIcon, HandHeartIcon } from './icons';
import { accept, begin, isDue, refuse } from './helpNudge';

/* Whether the card below is due (helpNudge.js), and what its buttons do.
 * Nothing to ask while the help is on already, nor until the settings and
 * the home country are read. */
export function useHelpNudge() {
  const [state, setState] = useState(null);
  const [country, setCountry] = useState(undefined);
  const [on, setOn] = useState(true);
  // After "Turn on": thanks, or why it could not start, until closed.
  const [after, setAfter] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const e = typeof window !== 'undefined' ? window.electron : null;
      if (!e?.getSetting || !e?.setSnowflake) return;
      let kept = null;
      let home = '';
      let st = null;
      try { kept = await e.getSetting('helpNudge'); } catch {}
      try { home = (await e.getAppInfo())?.homeCountry || ''; } catch {}
      try { st = await e.getSnowflakeStatus(); } catch {}
      const started = begin(kept, Date.now());
      if (started !== kept) { try { await e.setSetting('helpNudge', started); } catch {} }
      if (!live) return;
      setState(started);
      setCountry(home);
      setOn(!!(st && st.on));
    })();
    return () => { live = false; };
  }, []);

  const keep = (next) => {
    setState(next);
    try { window.electron?.setSetting?.('helpNudge', next); } catch {}
  };
  const due = !!state && country !== undefined && !on && isDue(state, Date.now(), country);
  return {
    due,
    after,
    no: () => keep(refuse(state, Date.now())),
    yes: async () => {
      let s = null;
      try { s = await window.electron.setSnowflake(true); } catch {}
      if (s && s.on) {
        setOn(true);
        keep(accept(state, Date.now()));
        setAfter({ thanks: true });
      } else {
        setAfter({ error: (s && s.error) || '' });
      }
    },
    close: () => setAfter(null),
  };
}

/* A quiet card on the Protection panel while protection works: whether the
 * user would like to help people in censored countries ("Help people in
 * censored countries", electron/snowflake.js), said plainly, with the one
 * switch as its button. Never in a window of its own. */
export function HelpBanner({ show, help }) {
  const { t, isRTL } = useLanguage();
  const [busy, setBusy] = useState(false);
  if (!show || !(help.due || help.after)) return null;
  const path = [t('navSettings'), t('tabSharing'), t('snowflake')].join(isRTL ? ' ← ' : ' → ');
  return (
    <div role="note" data-testid="help-banner" className="no-drag mx-4 mb-3 rounded-[var(--radius-sm)] border py-2.5 pe-2 ps-3 sm:mx-5"
         style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
      {help.after ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          {help.after.thanks
            ? <HandHeartIcon className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
            : <AlertTriangleIcon className="h-4 w-4 shrink-0" style={{ color: 'var(--warn)' }} />}
          <span role="status" className="min-w-[14rem] flex-1 text-[12.5px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>
            {help.after.thanks ? t('helpNudgeThanks', { path }) : t('snowflakeFailed', { error: help.after.error || '?' })}
          </span>
          <button type="button" onClick={help.close}
                  className="btn btn-ghost ms-auto shrink-0 rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium">{t('whatsNewOk')}</button>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2.5">
            <HandHeartIcon className="mt-[1px] h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>{t('helpNudgeTitle')}</p>
              <p className="mt-0.5 text-[12.5px] leading-snug wrap-anywhere" style={{ color: 'var(--text-dim)' }}>{t('helpNudgeBody')}</p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
            <button type="button" disabled={busy}
                    onClick={async () => { setBusy(true); await help.yes(); setBusy(false); }}
                    className="btn btn-primary rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold">{t('helpNudgeYes')}</button>
            <button type="button" disabled={busy} onClick={help.no}
                    className="btn btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium">{t('supportBannerLater')}</button>
          </div>
        </>
      )}
    </div>
  );
}
