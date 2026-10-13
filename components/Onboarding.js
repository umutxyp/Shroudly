'use client';

/*
 * First-run tour.
 *
 * Not a stack of paragraphs: each step dims the window, lights up the control
 * it is talking about, and switches to the tab that control lives on, so the
 * explanation and the thing being explained are never in different places.
 * Someone who has never heard of DPI should be able to follow it without
 * reading a word twice.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { PowerIcon, GlobeIcon, SearchIcon, ShieldCheckIcon, LogsIcon, CloseIcon } from './icons';

const SEEN_KEY = 'shroudly_onboarded';
const PAD = 10;         // breathing room around the highlighted control
const GAP = 22;         // between the highlight and the card, arrow included
const ARROW = 9;        // half-width of the pointer

const STEPS = [
  { tab: 'control',  target: null,              icon: ShieldCheckIcon, title: 'obTitle1', body: 'obBody1' },
  { tab: 'control',  target: '[data-tour="power"]',    icon: PowerIcon,  title: 'obTitle2', body: 'obBody2' },
  { tab: 'settings', target: '[data-tour="routing"]',  icon: GlobeIcon,  title: 'obTitle3', body: 'obBody3' },
  { tab: 'settings', target: '[data-tour="sitetest"]', icon: SearchIcon, title: 'obTitle4', body: 'obBody4' },
  { tab: 'logs',     target: '[data-tour="nav-logs"]', icon: LogsIcon,   title: 'obTitle5', body: 'obBody5' },
];

export default function Onboarding({ onNavigate }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const cardRef = useRef(null);
  const [cardH, setCardH] = useState(180);

  useEffect(() => {
    try { if (!localStorage.getItem(SEEN_KEY)) setOpen(true); } catch {}
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    try { localStorage.setItem(SEEN_KEY, '1'); } catch {}
  }, []);

  const step = STEPS[i];

  // Move to the tab this step lives on before trying to find its control.
  useEffect(() => {
    if (!open || !step) return;
    if (typeof onNavigate === 'function') onNavigate(step.tab);
  }, [open, i, step, onNavigate]);

  // The control may still be mounting after a tab switch, so keep looking for
  // a short while, and follow it if the window is resized.
  useLayoutEffect(() => {
    if (!open || !step) return undefined;
    if (!step.target) { setRect(null); return undefined; }
    let tries = 0;
    let scrolled = false;
    const find = () => {
      const el = document.querySelector(step.target);
      if (!el) return false;
      // Bring it into view before pointing at it, or the highlight lands on
      // something the person cannot see.
      if (!scrolled) {
        scrolled = true;
        try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {}
        return false;                       // measure on the next tick, after the scroll
      }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      return true;
    };
    if (!find()) setRect(null);
    const id = setInterval(() => { if (find() || ++tries > 25) clearInterval(id); }, 40);
    const onResize = () => find();
    window.addEventListener('resize', onResize);
    return () => { clearInterval(id); window.removeEventListener('resize', onResize); };
  }, [open, i, step]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [i, open, rect]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') setI((n) => Math.min(STEPS.length - 1, n + 1));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open || !step) return null;

  const Icon = step.icon;
  const last = i === STEPS.length - 1;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

  // Keep the ring inside the window, so a full-width control still reads as
  // highlighted rather than as two stripes running off both edges.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 460;
  const hole = rect && (() => {
    const l = Math.max(6, rect.left - PAD);
    const r = Math.min(vw - 6, rect.left + rect.width + PAD);
    const tp = Math.max(6, rect.top - PAD);
    const bt = Math.min(vh - 6, rect.top + rect.height + PAD);
    return { top: tp, left: l, width: Math.max(0, r - l), height: Math.max(0, bt - tp) };
  })();

  // Sit clear of the highlight, on whichever side has room, and point at it.
  let cardTop = 0;
  let centred = false;
  let arrowUp = false;          // the pointer sits on the card's top edge
  let arrowX = null;            // where along that edge, in px from the card's left
  if (hole) {
    const cardW = Math.min(352, vw - 32);
    const below = hole.top + hole.height + GAP;
    if (below + cardH + 16 <= vh) { cardTop = below; arrowUp = true; }
    else { cardTop = Math.max(16, hole.top - GAP - cardH); arrowUp = false; }
    const cardLeft = (vw - cardW) / 2;
    const targetCx = hole.left + hole.width / 2;
    arrowX = Math.max(18, Math.min(cardW - 18, targetCx - cardLeft));
  } else {
    centred = true;
  }

  return (
    <div className="no-drag fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={t(step.title)}>
      {/* Dim everything except the control being described. Four panels rather
          than an SVG mask, so the lit area stays perfectly crisp. */}
      {hole ? (
        <>
          <div className="tour-dim absolute inset-x-0" style={{ top: 0, height: Math.max(0, hole.top) }} />
          <div className="tour-dim absolute" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
          <div className="tour-dim absolute" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
          <div className="tour-dim absolute inset-x-0" style={{ top: hole.top + hole.height, bottom: 0 }} />
          <div
            className="pointer-events-none absolute rounded-[12px]"
            style={{
              top: hole.top, left: hole.left, width: hole.width, height: hole.height,
              border: '2px solid var(--accent)',
              boxShadow: '0 0 0 4px color-mix(in srgb, var(--accent) 28%, transparent)',
            }}
          />
        </>
      ) : (
        <div className="tour-dim absolute inset-0" />
      )}

      <div
        ref={cardRef}
        className="absolute left-1/2 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-[var(--radius)] border p-4"
        style={{
          top: centred ? '50%' : cardTop,
          transform: centred ? 'translate(-50%, -50%)' : 'translateX(-50%)',
          background: 'var(--surface-pop)',
          borderColor: 'var(--line-strong)',
          boxShadow: '0 18px 50px rgba(0,0,0,.5)',
        }}
      >
        {arrowX != null && (
          <span
            aria-hidden
            className="absolute h-[14px] w-[14px] rotate-45"
            style={{
              left: arrowX - ARROW + 2,
              [arrowUp ? 'top' : 'bottom']: -8,
              background: 'var(--surface-pop)',
              borderTop: arrowUp ? '1px solid var(--line-strong)' : 'none',
              borderLeft: arrowUp ? '1px solid var(--line-strong)' : 'none',
              borderBottom: arrowUp ? 'none' : '1px solid var(--line-strong)',
              borderRight: arrowUp ? 'none' : '1px solid var(--line-strong)',
              borderRadius: 2,
            }}
          />
        )}

        <div className="flex items-start justify-between gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--accent-soft)' }}>
            <Icon className="h-[18px] w-[18px]" style={{ color: 'var(--accent)' }} />
          </div>
          <button
            type="button" onClick={close} aria-label={t('obSkip')}
            className="shrink-0 rounded-md p-1 transition-opacity hover:opacity-70"
            style={{ color: 'var(--text-faint)' }}
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <h2 className="mt-2.5 text-[16px] font-semibold leading-snug wrap-anywhere" style={{ color: 'var(--text)' }}>
          {t(step.title)}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed wrap-anywhere" style={{ color: 'var(--text-dim)' }}>
          {t(step.body)}
        </p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5" aria-hidden>
            {STEPS.map((_, n) => (
              <span
                key={n}
                className="h-1.5 rounded-full transition-all duration-300"
                style={{ width: n === i ? 16 : 6, background: n === i ? 'var(--accent)' : 'var(--line-strong)' }}
              />
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {i > 0 && (
              <button
                type="button" onClick={() => setI(i - 1)}
                className="btn rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium"
                style={{ color: 'var(--text-dim)' }}
              >
                {t('obBack')}
              </button>
            )}
            <button
              type="button" onClick={() => (last ? close() : setI(i + 1))}
              className="btn btn-primary rounded-[var(--radius-sm)] px-4 py-2 text-[13px] font-semibold"
            >
              {last ? t('obDone') : t('obNext')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
