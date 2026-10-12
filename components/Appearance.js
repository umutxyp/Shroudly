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
}

/* Applies the saved choice as early as the app can run script, so the window
 * never shows the default colours for a frame before switching. */
export default function Appearance() {
  useEffect(() => { applyAppearance(readAppearance()); }, []);
  return null;
}
