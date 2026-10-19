#!/usr/bin/env node
/*
 * Builds shroudly-core for the Android app, one binary per ABI, with the
 * Android NDK's clang:
 *
 *     node scripts/build-core-android.js                 arm64-v8a, armeabi-v7a, x86_64
 *     node scripts/build-core-android.js --x86           ... and x86 (32-bit emulators)
 *     node scripts/build-core-android.js --abi arm64-v8a only the ABIs named (comma-separated)
 *     node scripts/build-core-android.js --ndk <dir>     a particular NDK
 *
 * The NDK is found through --ndk, ANDROID_NDK_HOME, ANDROID_NDK_ROOT, else the
 * newest one under $ANDROID_HOME/ndk/ (or $ANDROID_SDK_ROOT/ndk/). Minimum API
 * level 26 (--api to change it).
 *
 * Output: android/app/src/main/jniLibs/<abi>/libshroudlycore.so. It is an
 * EXECUTABLE (a position-independent one, as Android requires), not a library:
 * only files named lib*.so in jniLibs are installed into the app's
 * nativeLibraryDir, the one place an app may run a binary from, so it is named
 * like one. The app starts it with ProcessBuilder from
 * applicationInfo.nativeLibraryDir; the manifest needs
 * android:extractNativeLibs="true" (or packaging.jniLibs.useLegacyPackaging)
 * so it is unpacked there. Build outputs are not committed (.gitignore).
 *
 * Only the userspace engine: no Advanced (packet-layer) backends, so no
 * -DSHROUDLY_RAW, and nothing to link besides bionic.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'core', 'src');
const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith('.c')).sort().map((f) => path.join(srcDir, f));
const outRoot = path.join(root, 'android', 'app', 'src', 'main', 'jniLibs');
const BIN = 'libshroudlycore.so';

// ABI -> clang target triple (the API level is appended) and the ELF machine
// the result must be for.
const ABIS = {
  'arm64-v8a':   { triple: 'aarch64-linux-android',     machine: 183, name: 'AArch64' },
  'armeabi-v7a': { triple: 'armv7a-linux-androideabi',  machine: 40,  name: 'ARM' },
  'x86_64':      { triple: 'x86_64-linux-android',      machine: 62,  name: 'x86-64' },
  'x86':         { triple: 'i686-linux-android',        machine: 3,   name: 'i386' },
};
const DEFAULT_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

/* "28.2.13676358" > "27.0.12077973" */
function cmpVersion(a, b) {
  const x = a.split('.').map((n) => parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

function findNdk() {
  const direct = [arg('--ndk'), process.env.ANDROID_NDK_HOME, process.env.ANDROID_NDK_ROOT, process.env.ANDROID_NDK];
  for (const d of direct) if (d && fs.existsSync(path.join(d, 'toolchains', 'llvm'))) return d;
  for (const sdk of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (!sdk) continue;
    const dir = path.join(sdk, 'ndk');
    let versions = [];
    try { versions = fs.readdirSync(dir).filter((v) => fs.existsSync(path.join(dir, v, 'toolchains', 'llvm'))); } catch {}
    versions.sort(cmpVersion);
    if (versions.length) return path.join(dir, versions[versions.length - 1]);
    const bundle = path.join(sdk, 'ndk-bundle');
    if (fs.existsSync(path.join(bundle, 'toolchains', 'llvm'))) return bundle;
  }
  return null;
}

/* The NDK's own clang, for whichever host this runs on. */
function findClang(ndk) {
  const pre = path.join(ndk, 'toolchains', 'llvm', 'prebuilt');
  const exe = process.platform === 'win32' ? 'clang.exe' : 'clang';
  const hosts = { darwin: ['darwin-x86_64', 'darwin-arm64'], linux: ['linux-x86_64', 'linux-aarch64'], win32: ['windows-x86_64'] }[process.platform] || [];
  let dirs = [];
  try { dirs = fs.readdirSync(pre); } catch {}
  for (const h of [...hosts, ...dirs]) {
    const c = path.join(pre, h, 'bin', exe);
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/* The ELF header says what it is: { elf, machine, exec } */
function elfInfo(file) {
  const b = Buffer.alloc(20);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, b, 0, 20, 0); } finally { fs.closeSync(fd); }
  const elf = b[0] === 0x7f && b.toString('latin1', 1, 4) === 'ELF';
  // e_type 2 = EXEC, 3 = DYN (a PIE is DYN with an interpreter); both little-endian here.
  return { elf, machine: b.readUInt16LE(18), type: b.readUInt16LE(16) };
}

function main() {
  const ndk = findNdk();
  if (!ndk) {
    console.error('[core-android] no Android NDK found: set ANDROID_NDK_HOME (or ANDROID_HOME with an ndk/<version> inside), or pass --ndk <dir>');
    process.exit(1);
  }
  const clang = findClang(ndk);
  if (!clang) { console.error(`[core-android] no clang under ${ndk}/toolchains/llvm/prebuilt`); process.exit(1); }
  const api = parseInt(arg('--api') || '26', 10);
  let abis = arg('--abi') ? arg('--abi').split(',').map((s) => s.trim()).filter(Boolean) : [...DEFAULT_ABIS];
  if (process.argv.includes('--x86') && !abis.includes('x86')) abis.push('x86');
  const unknown = abis.filter((a) => !ABIS[a]);
  if (unknown.length) { console.error(`[core-android] unknown ABI: ${unknown.join(', ')} (known: ${Object.keys(ABIS).join(', ')})`); process.exit(1); }
  console.log(`[core-android] NDK ${ndk}, API ${api}`);

  let failed = 0;
  for (const abi of abis) {
    const t = ABIS[abi];
    const outDir = path.join(outRoot, abi);
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, BIN);
    const args = [
      `--target=${t.triple}${api}`,
      '-std=c11', '-O2', '-Wall', '-Wextra',
      '-D_GNU_SOURCE',
      '-fPIE', '-pie',
      '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2',
      // 16 KB pages (Android 15+ devices) as well as 4 KB ones.
      '-Wl,-z,max-page-size=16384',
      '-Wl,-z,relro', '-Wl,-z,now',
      '-s',
      '-o', out, ...sources,
    ];
    console.log(`[core-android] ${abi} (${t.triple}${api})`);
    const r = spawnSync(clang, args, { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`[core-android] ${abi} failed`); failed++; continue; }
    const e = elfInfo(out);
    if (!e.elf || e.machine !== t.machine || (e.type !== 2 && e.type !== 3)) {
      console.error(`[core-android] ${abi}: ${out} is not an ELF executable for ${t.name} (machine ${e.machine}, type ${e.type})`);
      failed++; continue;
    }
    fs.chmodSync(out, 0o755);
    console.log(`[core-android] built ${path.relative(root, out)} (${t.name}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  }
  if (failed) { console.error(`[core-android] ${failed} of ${abis.length} ABIs failed`); process.exit(1); }
}

main();
