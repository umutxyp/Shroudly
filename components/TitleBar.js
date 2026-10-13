'use client';

import { useEffect, useState } from 'react';

/* Draggable title bar. The window buttons are the OS's own (see the
 * BrowserWindow options in electron/main.js): macOS draws its traffic lights
 * at the top left, Windows and Linux their caption buttons at the top right,
 * so we only leave room for them. Kept left-to-right in every language, like
 * the buttons themselves. */
export default function TitleBar() {
  const [platform, setPlatform] = useState(null);
  useEffect(() => { setPlatform(window.electron?.platform || 'web'); }, []);
  const mac = platform === 'darwin';

  return (
    <div
      dir="ltr"
      className={`drag flex h-9 shrink-0 items-center ${mac ? 'justify-center' : 'ps-3'}`}
      style={{
        // Opaque, and the very colour the OS paints behind its caption buttons
        // (Appearance sends it), so the strip reads as one piece in every
        // accent and surface. The glass gradient starts below it.
        background: 'var(--titlebar)',
        borderBottom: '1px solid var(--line)',
        // Room for the caption buttons drawn by Windows/Linux (3 × 46 px).
        paddingRight: platform && !mac && platform !== 'web' ? 138 : undefined,
      }}
    >
      <span className="select-none text-[12px] font-semibold tracking-wide" style={{ color: 'var(--text-dim)' }}>
        Shroudly
      </span>
    </div>
  );
}
