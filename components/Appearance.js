'use client';

/*
 * Accent colour and surface style.
 *
 * Both are applied as attributes on <html>, which the stylesheet keys off, so
 * changing one is a single attribute write and never a re-render of the app.
 * Only the accent family moves; the greys, the status colours and every
 * contrast ratio stay as designed, so no choice available here can make text
 * hard to read.
 */

import { useEffect } from 'react';

export const ACCENTS = [
  { id: 'sky',     swatch: '#38bdf8' },
  { id: 'teal',    swatch: '#2dd4bf' },
  { id: 'emerald', swatch: '#34d399' },
  { id: 'lime',    swatch: '#a3e635' },
  { id: 'amber',   swatch: '#fbbf24' },
  { id: 'rose',    swatch: '#fb7185' },
  { id: 'pink',    swatch: '#f472b6' },
  { id: 'violet',  swatch: '#a78bfa' },
  { id: 'indigo',  swatch: '#818cf8' },
];

const ACCENT_KEY = 'shroudly_accent';
const SURFACE_KEY = 'shroudly_surface';

export function readAppearance() {
  let accent = 'sky';
  let surface = 'solid';
  try {
    accent = localStorage.getItem(ACCENT_KEY) || 'sky';
    surface = localStorage.getItem(SURFACE_KEY) || 'solid';
  } catch {}
  if (!ACCENTS.some((a) => a.id === accent)) accent = 'sky';
  if (surface !== 'glass') surface = 'solid';
  return { accent, surface };
}

export function applyAppearance({ accent, surface }) {
  const el = document.documentElement;
  // The default needs no attribute at all, so the base tokens apply untouched.
  if (accent && accent !== 'sky') el.setAttribute('data-accent', accent);
  else el.removeAttribute('data-accent');
  if (surface === 'glass') el.setAttribute('data-surface', 'glass');
  else el.removeAttribute('data-surface');
  try {
    localStorage.setItem(ACCENT_KEY, accent || 'sky');
    localStorage.setItem(SURFACE_KEY, surface || 'solid');
  } catch {}

  /* On Windows and Linux the caption buttons sit on a strip the operating
   * system paints, which would otherwise keep its original colour while the
   * rest of the window changed around it. macOS draws its buttons straight
   * over ours, so it needs nothing. */
  try {
    const color = cssColorToHex('var(--titlebar)');
    const symbolColor = cssColorToHex('var(--text-dim)');
    if (color && symbolColor) window.electron?.setTitleBarColors?.({ color, symbolColor });
  } catch {}
}

/* The colour a CSS value actually paints, as #rrggbb. Tokens can be written
 * as color-mix() or oklab(), which Electron's caption strip does not accept;
 * reading back one painted pixel resolves any of them. */
export function cssColorToHex(value) {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;width:1px;height:1px;left:-9px;top:-9px;background:${value}`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || !resolved) return null;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/* Applies the saved choice as early as the app can run script, so the window
 * never shows the default colours for a frame before switching. */
export default function Appearance() {
  useEffect(() => { applyAppearance(readAppearance()); }, []);
  return null;
}
