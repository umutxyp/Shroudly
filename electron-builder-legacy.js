'use strict';

/*
 * The Windows 7, 8 and 8.1 build (electron-builder -c electron-builder-legacy.js).
 *
 * Electron 23 and later run on Windows 10 and later only. This build is the
 * same app on Electron 22, the last that runs on Windows 7, 8 and 8.1: the
 * same window, engine and settings. One installer carries both 64-bit and
 * 32-bit Windows and puts on the one that fits. It updates from its own
 * channel (legacy.yml), so it is never offered the Windows 10 build, which
 * would not start there. What does not run on these systems is left out by
 * the app itself: the last way out (Tor 16 needs Windows 10, main.js
 * torOldWindows) and Advanced mode on 32-bit Windows (WinDivert's 64-bit
 * driver only). Windows' Universal C runtime, which the engine uses and
 * Windows 7 and 8 may lack, comes beside it (scripts/fetch-ucrt.js).
 */

const base = require('./package.json').build;

module.exports = {
  ...base,
  electronVersion: '22.3.27',
  // Beside the Windows 10 build's dist/, not over it (release.yml copies the
  // installer and legacy.yml across).
  directories: { ...base.directories, output: 'dist-legacy' },
  // electron-builder 26 sets fuses Electron 22 also has (package.json).
  electronFuses: base.electronFuses,
  win: {
    ...base.win,
    // The one installer for both is "...-Windows7-8-Setup.exe" (electron-builder
    // drops "-${arch}" there); the per-architecture ones are not published.
    artifactName: '${productName}-${version}-Windows7-8-${arch}-Setup.${ext}',
    target: [{ target: 'nsis', arch: ['x64', 'ia32'] }],
    files: ['electron/tools/core/win32-${arch}/**'],
  },
  nsis: { ...base.nsis, include: 'scripts/installer-legacy.nsh' },
  publish: base.publish.map((p) => ({ ...p, channel: 'legacy' })),
};
