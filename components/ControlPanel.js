'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { HeartIcon, PowerIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldIcon, SpinnerIcon } from './icons';
import Toast from './Toast';
import ClampedText from './ClampedText';
import { proxyNotice, PROXY_ACTIONS } from './proxyNotice';
import { pickRoom } from './panelRoom';

export default function ControlPanel({ dpiStatus, onStatusChange, onSupport }) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [room, setRoom] = useState('full');
  const panelRef = useRef(null);
  const statusRef = useRef(null);
  const buttonsRef = useRef(null);
  const active = !!dpiStatus.active;
  const closeToast = useCallback(() => setToast(null), []);

  /* On, but browsers and most programs are not going through Shroudly (the
   * system proxy could not be set, needs an administrator's password, or
   * another program took it over): not "Protected". What happened and the
   * one button that fixes it are here, under the status, where the user
   * looks; the banner that used to say it could be closed and was easy to
   * read past. */
  const notRouting = active && !!dpiStatus.notRouting;
  // On, but the network itself has no internet: said so, instead of a
  // "Protected" that made the browser's proxy error look like Shroudly's.
  const offline = active && !notRouting && !!dpiStatus.offline;
  const ownProxy = offline && !!dpiStatus.ownProxy;
  const pn = notRouting ? proxyNotice(dpiStatus.proxy, { active, advanced: dpiStatus.advanced }) : null;
  const fix = pn && pn.action ? PROXY_ACTIONS[pn.action] : null;
  const runFix = async () => {
    setFixing(true);
    try { await fix.run(pn); } catch {}
    setFixing(false);
    onStatusChange();
  };
  /* On its way up (at launch, after an update): "Starting…", not a red
   * "Not protected" inviting a press on Start. Meant to be on and the last
   * start failed: said under the status, with Repair, for as long as it
   * lasts; the system's error is in the log. */
  const starting = !active && !!dpiStatus.starting;
  const failed = !active && !starting && !!dpiStatus.failed;
  const [repair, setRepair] = useState(null);   // 'busy' | { missing }
  const runRepair = async () => {
    setRepair('busy');
    let r = null;
    try { r = await window.electron.repairApp(); } catch {}
    // Files missing: nothing starts until Shroudly is installed again.
    if (r && Array.isArray(r.missing) && r.missing.length) { setRepair({ missing: r.missing }); return; }
    try { await window.electron.startDPI(); } catch {}
    setRepair(null);
    onStatusChange();
  };
  // What Repair found stays said until protection runs.
  useEffect(() => { if (active) setRepair(null); }, [active]);
  const support = !!onSupport && !notRouting;

  /* The room the content area has, worked out again whenever it or the
   * status and buttons change size (a notice coming or going, the window
   * resized, the language changed, "More" opened). */
  useEffect(() => {
    const panel = panelRef.current;
    const area = panel && panel.parentElement;
    if (!area || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      if (!statusRef.current || !buttonsRef.current) return;
      const cs = getComputedStyle(area);
      const inside = area.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
      setRoom(pickRoom(inside, statusRef.current.offsetHeight, buttonsRef.current.offsetHeight, support));
    };
    measure();
    const ro = new ResizeObserver(measure);
    [area, statusRef.current, buttonsRef.current].forEach((el) => el && ro.observe(el));
    return () => ro.disconnect();
  }, [support]);

  const act = async (fn, okKey, failKey) => {
    if (typeof window === 'undefined' || !window.electron?.[fn]) {
      setToast({ message: t('desktopOnly'), type: 'warning' });
      return;
    }
    setLoading(true);
    try {
      const r = await window.electron[fn]();
      if (r?.success) {
        onStatusChange();
        // Started, but not working yet: the status says why, in amber, with
        // its button; a green "Protection started" would say the opposite.
        if (r.routed !== false) setToast({ message: t(okKey), type: 'success' });
      } else if (r?.code === 'security_blocked') {
        // An antivirus took or refused the engine: said plainly; the banner
        // above says what to do, never the engine's technical words.
        onStatusChange();
        setToast({ message: t('startBlockedBySecurity'), type: 'error' });
      } else {
        onStatusChange();
        // A failed start stays said under the status (failed, above); the
        // system's own words ("listen EADDRINUSE") are in the log.
        if (fn !== 'startDPI') setToast({ message: t(failKey), type: 'error' });
      }
    } catch {
      onStatusChange();
      if (fn !== 'startDPI') setToast({ message: t(failKey), type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const onClick = () => (active
    ? act('stopDPI', 'protectionStopped', 'stopFailed')
    : act('startDPI', 'protectionStarted', 'startFailed'));

  const ShieldGlyph = notRouting ? ShieldAlertIcon : active ? ShieldCheckIcon : ShieldIcon;
  const label = loading ? (active ? t('stopping') : t('starting')) : starting ? t('starting') : (active ? t('stop') : t('start'));
  // The shield and the title: the accent colour when it works, amber when it
  // is on and does not yet.
  // --state: the accent, except where the accent is a warning or danger
  // colour (globals.css).
  const ring = notRouting ? 'var(--warn-line)' : active ? 'var(--state-line)' : 'var(--line-strong)';
  const disc = notRouting ? 'var(--warn-soft)' : active ? 'var(--state-soft)' : 'var(--surface)';
  const glyph = notRouting ? 'var(--warn)' : active ? 'var(--state)' : 'var(--text-faint)';

  return (
    <>
      {toast && <Toast message={toast.message} detail={toast.detail} type={toast.type} onClose={closeToast} />}

      {/* data-room: the shield gives up its room first in a short window
          (panelRoom.js, globals.css). */}
      <div ref={panelRef} data-room={room} className="power-panel flex min-h-full flex-col items-center justify-center">
        {/* The shield — the one bold moment */}
        <div className="power-shield relative flex shrink-0 items-center justify-center" aria-hidden>
          {active && !notRouting && (
            <span
              className="power-halo halo absolute rounded-full"
              style={{ background: 'radial-gradient(circle, var(--state-soft) 0%, transparent 70%)' }}
            />
          )}
          <div
            className="power-disc relative flex items-center justify-center rounded-full border transition-all duration-500"
            style={{ borderColor: ring, background: disc }}
          >
            <ShieldGlyph
              className="power-glyph transition-colors duration-500"
              strokeWidth={1.5}
              style={{ color: glyph }}
            />
          </div>
        </div>

        {/* Status text */}
        <div ref={statusRef} className="w-full max-w-sm text-center" aria-live="polite">
          <h2 className="text-2xl font-semibold leading-tight tracking-tight wrap-anywhere"
              style={{ color: notRouting ? 'var(--warn)' : offline ? 'var(--text)' : active ? 'var(--state)' : 'var(--text)' }}>
            {notRouting ? t('notWorkingYet') : ownProxy ? t('ownProxyTitle') : offline ? t('noInternet') : active ? t('protected') : starting ? t('starting') : t('notProtected')}
          </h2>
          {notRouting ? (
            <ClampedText text={t(pn ? pn.body : 'proxyFailedBody', pn ? pn.params : undefined)} lines={5}
                         className="mt-1.5 text-[13px] leading-snug" style={{ color: 'var(--text-dim)' }} />
          ) : starting ? null : repair && repair.missing ? (
            <p className="mt-1.5 text-[13px] leading-snug wrap-anywhere" style={{ color: 'var(--warn)' }}>
              {t('repairFilesMissing', { files: repair.missing.join(', ') })}{' '}
              <a href="https://github.com/umutxyp/Shroudly/releases/latest" target="_blank" rel="noreferrer"
                 className="font-semibold underline">{t('repairDownload')}</a>
            </p>
          ) : failed ? (
            <p className="mt-1.5 text-[13px] leading-snug wrap-anywhere" style={{ color: 'var(--warn)' }}>{t('startFailedBody', { repair: t('repairApp') })}</p>
          ) : (
            <p className="mt-1.5 text-[13px] leading-snug" style={{ color: !active && dpiStatus.blocked ? 'var(--warn)' : 'var(--text-dim)' }}>
              {ownProxy ? t('ownProxyBody') : offline ? t('noInternetBody') : active ? t('dpiBypassRunning') : dpiStatus.blocked ? t('securityStatus') : t('dpiBypassStopped')}
            </p>
          )}
        </div>

        {/* Primary action, and under it, quietly, the way to support
            Shroudly (About → Support Shroudly), always there as on Android's
            main screen. Not working yet: the button that fixes it first. */}
        <div className="flex w-full flex-col items-center gap-3">
          <div ref={buttonsRef} className="flex w-full flex-col items-center gap-3">
            {failed && !(repair && repair.missing) && (
              <button
                type="button"
                onClick={runRepair}
                disabled={repair === 'busy'}
                aria-busy={repair === 'busy'}
                className="btn btn-warn w-full max-w-xs rounded-[var(--radius)] px-5 py-3 text-[14px] font-semibold"
              >
                {repair === 'busy' && <SpinnerIcon className="spin h-[16px] w-[16px]" />}
                <span className="min-w-0 wrap-anywhere">{t('repairApp')}</span>
              </button>
            )}
            {fix && (
              <button
                type="button"
                onClick={runFix}
                disabled={fixing}
                aria-busy={fixing}
                data-proxy-action={pn.action}
                className="btn btn-primary w-full max-w-xs rounded-[var(--radius)] px-5 py-3 text-[14px] font-semibold"
              >
                {fixing && <SpinnerIcon className="spin h-[16px] w-[16px]" />}
                <span className="min-w-0 wrap-anywhere">{t(fix.label)}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClick}
              disabled={loading || starting || repair === 'busy'}
              aria-busy={loading || starting}
              data-tour="power"
              // Stop is an everyday choice, not an alarm: a red button while
              // everything worked read as an error.
              className={`btn w-full max-w-xs rounded-[var(--radius)] px-5 py-3.5 text-[15px] font-semibold ${active ? 'btn-ghost' : 'btn-state'}`}
            >
              {loading || starting
                ? <SpinnerIcon className="spin h-[18px] w-[18px]" />
                : <PowerIcon className="h-[18px] w-[18px]" />}
              <span className="min-w-0 wrap-anywhere">{label}</span>
            </button>
          </div>
          {support && (
            <button
              type="button"
              onClick={onSupport}
              className="power-support row-hover inline-flex max-w-xs items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium"
              style={{ color: 'var(--text-dim)' }}
            >
              <HeartIcon className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
              <span className="min-w-0 wrap-anywhere">{t('supportTitle')}</span>
            </button>
          )}
        </div>
      </div>
    </>
  );
}
