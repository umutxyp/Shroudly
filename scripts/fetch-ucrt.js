#!/usr/bin/env node
'use strict';

/*
 * Windows' Universal C runtime beside the engine, for the Windows 7 and 8
 * build (electron-builder-legacy.js).
 *
 * The engine (core/src, built with zig for Windows 7 and later) uses the
 * Universal C runtime (ucrtbase.dll and its api-ms-win-crt-*.dll names).
 * Windows 10 and 11 always have it; Windows 7, 8 and 8.1 have it only after
 * an update (KB2999226) many of them never got. Microsoft lets a program
 * carry these DLLs in its own folder ("app-local"); Windows 10 and 11 then
 * still use their own. They are copied from the Windows SDK's redistributable
 * folder (what GitHub's Windows machines have) into
 * electron/tools/core/win32-x64 and win32-ia32, next to shroudly-core.exe.
 *
 *   node scripts/fetch-ucrt.js            (on Windows, with the Windows SDK)
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'Redist');

function redist() {
  let versions = [];
  try { versions = fs.readdirSync(kits).filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d)); } catch {}
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const dirs = [...versions.map((v) => path.join(kits, v, 'ucrt', 'DLLs')), path.join(kits, 'ucrt', 'DLLs')];
  return dirs.find((d) => fs.existsSync(path.join(d, 'x64', 'ucrtbase.dll')) && fs.existsSync(path.join(d, 'x86', 'ucrtbase.dll')));
}

function main() {
  if (process.platform !== 'win32') { console.error('[ucrt] run this on Windows (the Windows SDK has the files)'); process.exit(1); }
  const from = redist();
  if (!from) { console.error(`[ucrt] no Universal CRT redistributable under ${kits}`); process.exit(1); }
  for (const [sdk, ours] of [['x64', 'win32-x64'], ['x86', 'win32-ia32']]) {
    const src = path.join(from, sdk);
    const dst = path.join(root, 'electron', 'tools', 'core', ours);
    fs.mkdirSync(dst, { recursive: true });
    const dlls = fs.readdirSync(src).filter((f) => /^(ucrtbase|api-ms-win-[a-z0-9-]+)\.dll$/i.test(f));
    if (!dlls.includes('ucrtbase.dll') || !dlls.some((f) => /^api-ms-win-crt-runtime/i.test(f))) {
      console.error(`[ucrt] ${src} is missing ucrtbase.dll or api-ms-win-crt-runtime`); process.exit(1);
    }
    for (const f of dlls) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    console.log(`[ucrt] ${dlls.length} files from ${src} -> ${path.relative(root, dst)}`);
  }
}

main();
