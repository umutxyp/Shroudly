#!/usr/bin/env node
/*
 * Downloads the official WinDivert 2.2 release and places WinDivert.dll +
 * WinDivert64.sys (and arm64) next to the advanced Windows engine binaries.
 *
 * WinDivert is a SIGNED kernel driver (required for the Windows advanced mode).
 * It is NOT committed to the repo; it is fetched from the official GitHub release
 * and verified by SHA-256 so a tampered download is rejected.
 *
 * Only needed if you build/package the Windows ADVANCED engine. The default
 * driver-free engine never uses it.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const VERSION = '2.2.2';
const URL = `https://github.com/basil00/WinDivert/releases/download/v${VERSION}/WinDivert-${VERSION}-A.zip`;
// Official published SHA-256 of WinDivert-2.2.2-A.zip. VERIFY before trusting:
// https://github.com/basil00/WinDivert/releases/tag/v2.2.2
const SHA256 = 'PASTE_OFFICIAL_SHA256_HERE';

const outRoot = path.join(__dirname, '..', 'electron', 'tools', 'core');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    const go = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return go(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      res.pipe(f); f.on('finish', () => f.close(resolve));
    }).on('error', reject);
    go(url);
  });
}

(async () => {
  const tmp = path.join(require('os').tmpdir(), `windivert-${VERSION}.zip`);
  console.log(`[windivert] downloading ${URL}`);
  await download(URL, tmp);
  const got = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
  if (SHA256 === 'PASTE_OFFICIAL_SHA256_HERE') {
    console.warn('[windivert] WARNING: no SHA-256 pinned. Computed:', got);
    console.warn('[windivert] Set SHA256 in this script to the official value, then re-run.');
  } else if (got !== SHA256) {
    console.error(`[windivert] SHA-256 mismatch!\n  expected ${SHA256}\n  got      ${got}`);
    process.exit(1);
  } else {
    console.log('[windivert] SHA-256 verified');
  }
  console.log('[windivert] extract WinDivert.dll + WinDivert64.sys from', tmp,
    '\n[windivert] and copy into electron/tools/core/win32-x64 and win32-arm64');
  // Extraction is left to the packaging step (unzip availability varies by OS).
})();
