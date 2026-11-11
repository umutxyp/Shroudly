#!/usr/bin/env node
/*
 * Downloads the Tor Project's own Tor Expert Bundle for each target, checks
 * it against a pinned SHA-256, and places what the last way out needs
 * (electron/tor-route.js; Android: TorRoute.kt) where the builds pick it up:
 *
 *   electron/tools/tor/<os>-<arch>/   (a run from source only: installers do
 *                                     not ship Tor, the app fetches it when
 *                                     needed, electron/tor-download.js)
 *                                     tor, lyrebird (Snowflake, meek, obfs4,
 *                                     webtunnel), pt_config.json (the bundle's
 *                                     bridges), Tor's own libraries, licenses
 *   android/app/src/main/jniLibs/<abi>/  libtor.so, liblyrebird.so: Android
 *                                     runs programs only from the app's
 *                                     native library folder, so they go there
 *                                     under library names
 *
 * The hashes are those of the Tor Project's list for this version
 * (sha256sums-signed-build.txt), whose signature was checked against the
 * Tor Browser Developers' key (EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87 9329
 * 8290) when they were pinned here. A download that differs is refused.
 *
 *   node scripts/fetch-tor.js                 this computer's desktop target
 *   node scripts/fetch-tor.js darwin-arm64 …  the targets named
 *   node scripts/fetch-tor.js --desktop       every desktop target
 *   node scripts/fetch-tor.js --android       every Android ABI
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// The table is shared with the app, which fetches Tor itself on computers
// (electron/tor-files.js, electron/tor-download.js).
const T = require('../electron/tor-files.js');
const { VERSION, SHA256, PT, DESKTOP, ANDROID, COMMON } = T;
const ROOT = path.join(__dirname, '..');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    const go = (u, n) => https.get(u, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 5) { res.resume(); return go(new URL(res.headers.location, u).href, n + 1); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${u}`)); }
      res.pipe(f); f.on('finish', () => f.close(resolve));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error(`timed out: ${u}`)); });
    go(url, 0);
  });
}

function untar(file, dest) {
  // Windows' own bsdtar by its full path (a Git Bash "tar" reads "C:" as a host).
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', file, '-C', dest], { stdio: 'inherit' });
}

const cache = new Map();
async function bundle(name, work) {
  if (cache.has(name)) return cache.get(name);
  const file = `tor-expert-bundle-${name}-${VERSION}.tar.gz`;
  const tgz = path.join(work, file);
  let last = null;
  // Every source in turn (the Tor Project's, then its mirrors).
  for (const base of T.SOURCES) {
    try {
      console.log(`[tor] downloading ${base}${file}`);
      await download(base + file, tgz);
      const got = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
      if (got !== SHA256[name]) throw new Error(`SHA-256 mismatch for ${file}\n  expected ${SHA256[name]}\n  got      ${got}`);
      last = null;
      break;
    } catch (e) { last = e; console.error(`[tor] ${e.message}`); }
  }
  if (last) throw last;
  console.log(`[tor] ${file}: SHA-256 verified`);
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  untar(tgz, dir);
  cache.set(name, dir);
  return dir;
}

function place(from, to, mode) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, mode);
}

async function desktop(target, work) {
  const t = DESKTOP[target];
  if (!t) throw new Error(`unknown target ${target}`);
  const src = await bundle(t.bundle, work);
  const out = path.join(ROOT, 'electron', 'tools', 'tor', target);
  fs.rmSync(out, { recursive: true, force: true });
  for (const [from, to] of Object.entries(t.files)) place(path.join(src, from), path.join(out, to), 0o755);
  for (const [from, to] of Object.entries(COMMON)) place(path.join(src, from), path.join(out, to), 0o644);
  // macOS: the bundle's signatures do not hold on Apple silicon once copied
  // out of it (the program is killed at start). Signed again here, ad hoc,
  // for a run from source; a release build signs them with the app's own
  // identity (electron-builder signs every program in the app).
  if (target.startsWith('darwin') && process.platform === 'darwin') {
    for (const f of Object.values(t.files)) execFileSync('codesign', ['--force', '-s', '-', path.join(out, f)], { stdio: 'ignore' });
  }
  console.log(`[tor] ${target} -> ${path.relative(ROOT, out)}`);
}

async function android(abi, work) {
  const src = await bundle(ANDROID[abi], work);
  const out = path.join(ROOT, 'android', 'app', 'src', 'main', 'jniLibs', abi);
  place(path.join(src, 'tor', 'libTor.so'), path.join(out, 'libtor.so'), 0o755);
  place(path.join(src, PT, 'lyrebird'), path.join(out, 'liblyrebird.so'), 0o755);
  const assets = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'tor');
  for (const [from, to] of Object.entries(COMMON)) place(path.join(src, from), path.join(assets, to), 0o644);
  console.log(`[tor] android ${abi} -> ${path.relative(ROOT, out)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const here = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  let desk = args.filter((a) => DESKTOP[a]);
  let abis = args.filter((a) => ANDROID[a]);
  if (args.includes('--desktop')) desk = Object.keys(DESKTOP);
  if (args.includes('--android')) abis = Object.keys(ANDROID);
  if (!args.length) desk = [here];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-tor-'));
  try {
    for (const t of desk) await desktop(t, work);
    for (const a of abis) await android(a, work);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((e) => { console.error('[tor]', e.message); process.exit(1); });

// For apple/scripts/fetch-tor.js: the bundle's bridge list, checked the same way.
module.exports = { SHA256, DESKTOP, ANDROID, VERSION, bundle, download, PT };
