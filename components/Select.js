'use client';

/*
 * Themed, keyboard-accessible replacement for native <select>.
 *  - click / Enter / Space / ArrowUp / ArrowDown on the trigger opens it
 *  - ArrowUp/Down, Home/End, PageUp/PageDown move, Enter/Space pick,
 *    Esc / Tab / click-outside close, typing jumps to the first match
 *  - the popup is portalled to <body> with fixed positioning, so scroll
 *    containers never clip it; it opens upward when there is no room below
 *    and its height is capped to the visible window
 *  - role=combobox/listbox/option + aria-activedescendant; RTL follows <html dir>
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, ChevronDownIcon } from './icons';

const GAP = 6;        // px between trigger and popup
const EDGE = 8;       // keep this far from the window edge
const MAX_H = 300;

export default function Select({
  value,
  options,            // [{ value, label, hint?, leading?: ReactNode, lang? }]
  onChange,
  ariaLabel,
  ariaLabelledBy,
  leadingIcon,        // optional ReactNode shown before the selected label
  className = '',
  disabled = false,
}) {
  const id = useId();
  const listId = `${id}-list`;
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const typeahead = useRef({ text: '', at: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState(null);

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const wanted = Math.min(MAX_H, options.length * 44 + 10);
    const up = below < Math.min(wanted, 180) && above > below;
    const maxHeight = Math.max(120, Math.min(MAX_H, up ? above : below));
    setPos({
      left: Math.max(EDGE, r.left),
      width: Math.min(r.width, window.innerWidth - 2 * EDGE),
      top: up ? undefined : r.bottom + GAP,
      bottom: up ? vh - r.top + GAP : undefined,
      maxHeight,
      up,
    });
  }, [options.length]);

  const openList = useCallback((index) => {
    if (disabled) return;
    place();
    setActiveIndex(index ?? selectedIndex);
    setOpen(true);
  }, [disabled, place, selectedIndex]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const choose = useCallback((index) => {
    const opt = options[index];
    if (opt && opt.value !== value) onChange(opt.value);
    close(true);
  }, [options, value, onChange, close]);

  // Focus the list when it opens; keep the active option visible.
  useLayoutEffect(() => {
    if (open) listRef.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = document.getElementById(`${id}-opt-${activeIndex}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, id]);

  // Close on outside press; follow the trigger on scroll / resize.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      close(false);
    };
    const onMove = (e) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      place();
    };
    const onBlur = () => close(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close, place]);

  const onTypeahead = (key) => {
    const now = Date.now();
    const ta = typeahead.current;
    ta.text = (now - ta.at > 700 ? '' : ta.text) + key.toLowerCase();
    ta.at = now;
    const start = activeIndex < 0 ? 0 : activeIndex;
    for (let i = 0; i < options.length; i++) {
      const idx = (start + (ta.text.length === 1 ? 1 : 0) + i) % options.length;
      if (String(options[idx].label).toLowerCase().startsWith(ta.text)) { setActiveIndex(idx); return true; }
    }
    return false;
  };

  const onTriggerKey = (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openList(e.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1)
             : e.key === 'ArrowDown' && open ? Math.min(options.length - 1, selectedIndex + 1)
             : selectedIndex);
    }
  };

  const onListKey = (e) => {
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActiveIndex((i) => Math.min(last, i + 1)); break;
      case 'ArrowUp': e.preventDefault(); setActiveIndex((i) => Math.max(0, i - 1)); break;
      case 'Home': e.preventDefault(); setActiveIndex(0); break;
      case 'End': e.preventDefault(); setActiveIndex(last); break;
      case 'PageDown': e.preventDefault(); setActiveIndex((i) => Math.min(last, i + 5)); break;
      case 'PageUp': e.preventDefault(); setActiveIndex((i) => Math.max(0, i - 5)); break;
      case 'Enter':
      case ' ': e.preventDefault(); choose(activeIndex); break;
      case 'Escape': e.preventDefault(); close(true); break;
      case 'Tab': close(false); break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && onTypeahead(e.key)) e.preventDefault();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onTriggerKey}
        className={`field flex w-full min-w-0 items-center gap-2.5 px-3.5 py-2.5 text-start text-[14px] disabled:opacity-55 ${className}`}
        style={{ color: 'var(--text)' }}
      >
        {leadingIcon}
        {selected?.leading}
        <span className="min-w-0 flex-1 truncate" lang={selected?.lang} title={String(selected?.label ?? '')}>
          {selected?.label}
        </span>
        <ChevronDownIcon
          className="h-4 w-4 transition-transform duration-150"
          style={{ color: 'var(--text-faint)', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-activedescendant={activeIndex >= 0 ? `${id}-opt-${activeIndex}` : undefined}
          onKeyDown={onListKey}
          className="listbox pop scroll fixed z-[100] overflow-y-auto p-1 outline-none"
          style={{
            left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight,
            transformOrigin: pos.up ? 'bottom' : 'top',
          }}
        >
          {options.map((opt, i) => {
            const isSel = i === selectedIndex;
            return (
              <li
                key={opt.value}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={isSel}
                data-active={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className="option flex min-h-[40px] items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[14px]"
              >
                {opt.leading}
                <span className="min-w-0 flex-1">
                  <span className="block wrap-anywhere leading-snug" lang={opt.lang}>{opt.label}</span>
                  {opt.hint && (
                    <span className="mono block truncate text-[11.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>
                      <bdi dir="ltr">{opt.hint}</bdi>
                    </span>
                  )}
                </span>
                <CheckIcon className="h-4 w-4" style={{ color: 'var(--accent)', visibility: isSel ? 'visible' : 'hidden' }} />
              </li>
            );
          })}
        </ul>,
        document.body
      )}
    </>
  );
}
