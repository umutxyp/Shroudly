#!/usr/bin/env node
/*
 * Downloads the official WinDivert 2.2.2 release, verifies it, and places
 * WinDivert.dll + WinDivert64.sys (+ its LGPL license) next to the x64
 * advanced Windows engine, where electron-builder picks them up.
 *
 * WinDivert is a SIGNED kernel driver (required for the Windows advanced mode).
 * It is NOT committed to the repo; it is fetched from the official GitHub release
 * and checked against a pinned SHA-256 so a tampered download is rejected.
 * WinDivert ships no ARM64 driver, so Windows on ARM has no advanced mode.
 *
 * Only needed if you build/package the Windows ADVANCED engine. The default
 * driver-free engine never uses it.
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VERSION = '2.2.2';
const URL = `https://github.com/basil00/WinDivert/releases/download/v${VERSION}/WinDivert-${VERSION}-A.zip`;
// Upstream publishes no checksum: this is the hash of the zip served by the
// official release above, pinned so any later change to it is rejected.
const SHA256 = '63cb41763bb4b20f600b6de04e991a9c2be73279e317d4d82f237b150c5f3f15';

const outDir = path.join(__dirname, '..', 'electron', 'tools', 'core', 'win32-x64');
const FILES = { 'x64/WinDivert.dll': 'WinDivert.dll', 'x64/WinDivert64.sys': 'WinDivert64.sys', 'LICENSE': 'WinDivert-LICENSE.txt' };

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    const go = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location); }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      res.pipe(f); f.on('finish', () => f.close(resolve));
    }).on('error', reject);
    go(url);
  });
}

function unzip(zip, dest) {
  // bsdtar reads zip on Windows 10+ and macOS; GNU tar on Linux does not.
  if (process.platform === 'linux') execFileSync('unzip', ['-q', '-o', zip, '-d', dest], { stdio: 'inherit' });
  // On Windows, Windows' own bsdtar by its full path: from a Git Bash shell a
  // bare "tar" is GNU tar, which reads "C:" as a remote host.
  else if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest], { stdio: 'inherit' });
  else execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'inherit' });
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'windivert-'));
  try {
    const zip = path.join(work, `WinDivert-${VERSION}-A.zip`);
    console.log(`[windivert] downloading ${URL}`);
    await download(URL, zip);
    const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    if (got !== SHA256) {
      console.error(`[windivert] SHA-256 mismatch!\n  expected ${SHA256}\n  got      ${got}`);
      process.exit(1);
    }
    console.log('[windivert] SHA-256 verified');

    unzip(zip, work);
    fs.mkdirSync(outDir, { recursive: true });
    for (const [from, to] of Object.entries(FILES)) {
      fs.copyFileSync(path.join(work, `WinDivert-${VERSION}-A`, from), path.join(outDir, to));
      console.log(`[windivert] ${to} -> ${path.relative(process.cwd(), outDir)}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error('[windivert]', e.message); process.exit(1); });
