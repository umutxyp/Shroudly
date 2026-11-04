#!/usr/bin/env node
/*
 * Downloads the Tor Project's own Tor Expert Bundle for each target, checks
 * it against a pinned SHA-256, and places what the last way out needs
 * (electron/tor-route.js; Android: TorRoute.kt) where the builds pick it up:
 *
 *   electron/tools/tor/<os>-<arch>/   tor, lyrebird (Snowflake, meek, obfs4,
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

const VERSION = '16.0';
const BASE = `https://dist.torproject.org/torbrowser/${VERSION}/`;
// Mirror of the same files, for a network that will not reach the first.
const MIRROR = `https://archive.torproject.org/tor-package-archive/torbrowser/${VERSION}/`;
const SHA256 = {
  'macos-aarch64': 'b8da251eccbe9e82f3681ee3af3c97fb4291c4a4e153e5b824bde48a1117cd6a',
  'macos-x86_64': '5b1860215c26f2d408392d1d79e798a2f81d65eb939510bb94c11f237bd0bfc3',
  'linux-x86_64': 'cc950ebe9acb80188325c3a2cd8817def7dd7237d6fdcd861bb87b234a0cb2fd',
  'linux-aarch64': 'bed98744e093a0dc3a22be0eecfdce7a33cb36866d3f15fcf011a35bf3513d0d',
  'windows-x86_64': '2ee123e9167318a3742778ff704e75f01d4780f05a14522d451fe011011077c4',
  'android-aarch64': 'bf8f4c63652fd7daa62288713c7fa512f244a5b972808f6251450e5fdfca9120',
  'android-armv7': '13befa352b64c32ba460b63066179bb1c9eaf6c3ea7057ae860dcdd22b8acf7b',
  'android-x86_64': 'ab3152ba164bcd49e50175086c62e40ffa2bf9002a4f6473f77111bd88b0462b',
};

const ROOT = path.join(__dirname, '..');
const PT = 'tor/pluggable_transports';
// Windows on ARM runs the x64 build (Tor ships no ARM64 one for Windows).
const DESKTOP = {
  'darwin-arm64': { bundle: 'macos-aarch64', files: { 'tor/tor': 'tor', 'tor/libevent-2.1.7.dylib': 'libevent-2.1.7.dylib', [`${PT}/lyrebird`]: 'lyrebird' } },
  'darwin-x64': { bundle: 'macos-x86_64', files: { 'tor/tor': 'tor', 'tor/libevent-2.1.7.dylib': 'libevent-2.1.7.dylib', [`${PT}/lyrebird`]: 'lyrebird' } },
  'linux-x64': { bundle: 'linux-x86_64', files: { 'tor/tor': 'tor', 'tor/libcrypto.so.3': 'libcrypto.so.3', 'tor/libssl.so.3': 'libssl.so.3', 'tor/libevent-2.1.so.7': 'libevent-2.1.so.7', [`${PT}/lyrebird`]: 'lyrebird' } },
  'linux-arm64': { bundle: 'linux-aarch64', files: { 'tor/tor': 'tor', 'tor/libcrypto.so.3': 'libcrypto.so.3', 'tor/libssl.so.3': 'libssl.so.3', 'tor/libevent-2.1.so.7': 'libevent-2.1.so.7', [`${PT}/lyrebird`]: 'lyrebird' } },
  'win32-x64': { bundle: 'windows-x86_64', files: { 'tor/tor.exe': 'tor.exe', [`${PT}/lyrebird.exe`]: 'lyrebird.exe' } },
  'win32-arm64': { bundle: 'windows-x86_64', files: { 'tor/tor.exe': 'tor.exe', [`${PT}/lyrebird.exe`]: 'lyrebird.exe' } },
};
const ANDROID = {
  'arm64-v8a': 'android-aarch64',
  'armeabi-v7a': 'android-armv7',
  'x86_64': 'android-x86_64',
};
const COMMON = { [`${PT}/pt_config.json`]: 'pt_config.json', 'docs/tor.txt': 'LICENSE-tor.txt', 'docs/lyrebird.txt': 'LICENSE-lyrebird.txt' };

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
  for (const base of [BASE, MIRROR]) {
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
