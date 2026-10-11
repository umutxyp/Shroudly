#!/usr/bin/env node
/*
 * Builds the native shroudly-core engine for the current platform.
 *
 * Prefers a system C compiler (cc/clang/gcc on Unix, cl/clang on Windows).
 * If `zig` is available it can also cross-compile every target from one host:
 *     node scripts/build-core.js --cross
 *
 * Output: electron/tools/core/<platform>/shroudly-core[.exe]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'core', 'src');
const sources = fs.readdirSync(srcDir).filter(f => f.endsWith('.c')).map(f => path.join(srcDir, f));
const outRoot = path.join(root, 'electron', 'tools', 'core');

const TARGETS = {
  'win32-x64':  { zig: 'x86_64-windows-gnu',   bin: 'shroudly-core.exe', libs: ['-lws2_32', '-liphlpapi'] },
  'win32-arm64':{ zig: 'aarch64-windows-gnu',  bin: 'shroudly-core.exe', libs: ['-lws2_32', '-liphlpapi'] },
  'linux-x64':  { zig: 'x86_64-linux-gnu',     bin: 'shroudly-core',     libs: ['-lpthread'] },
  'linux-arm64':{ zig: 'aarch64-linux-gnu',    bin: 'shroudly-core',     libs: ['-lpthread'] },
  'darwin-x64': { zig: 'x86_64-macos-none',    bin: 'shroudly-core',     libs: [] },
  'darwin-arm64':{ zig: 'aarch64-macos-none',  bin: 'shroudly-core',     libs: [] },
};

function have(cmd, args) {
  try { const r = spawnSync(cmd, args || ['--version'], { stdio: 'ignore' }); return r.status === 0 || r.status === null ? r.error == null : false; }
  catch { return false; }
}

function zigPath() {
  if (have('zig', ['version'])) return 'zig';
  // python -m ziglang (pip install ziglang)
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const r = spawnSync(py, ['-m', 'ziglang', 'version'], { stdio: 'ignore' });
  if (r.status === 0) return `${py} -m ziglang`;
  return null;
}

function platformKey() {
  const a = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${process.platform}-${a}`;
}

function buildWithZig(zig, targetKey) {
  const t = TARGETS[targetKey];
  const outDir = path.join(outRoot, targetKey);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, t.bin);
  const parts = zig.split(' ');
  const feat = t.zig.includes('windows') ? [] : ['-D_GNU_SOURCE', '-D_DARWIN_C_SOURCE'];
  const args = [...parts.slice(1), 'cc', '-target', t.zig, '-std=c11', '-O2', ...feat, '-o', out, ...sources, ...t.libs];
  console.log(`[core] zig -> ${targetKey}`);
  execFileSync(parts[0], args, { stdio: 'inherit' });
  return out;
}

function buildNative() {
  const key = platformKey();
  const t = TARGETS[key];
  const outDir = path.join(outRoot, key);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, t ? t.bin : (process.platform === 'win32' ? 'shroudly-core.exe' : 'shroudly-core'));

  if (process.platform === 'win32') {
    // Try MSVC cl, then clang
    const libs = ['ws2_32.lib', 'iphlpapi.lib'];
    try {
      execFileSync('cl', ['/nologo', '/O2', '/std:c11', ...sources, `/Fe:${out}`, '/link', ...libs], { stdio: 'inherit' });
      return out;
    } catch { /* fall through */ }
    execFileSync('clang', ['-std=c11', '-O2', '-o', out, ...sources, '-lws2_32', '-liphlpapi'], { stdio: 'inherit' });
    return out;
  }

  const cc = process.env.CC || (have('cc') ? 'cc' : 'gcc');
  const libs = process.platform === 'darwin' ? [] : ['-lpthread'];
  execFileSync(cc, ['-std=c11', '-O2', '-pthread', '-o', out, ...sources, ...libs], { stdio: 'inherit' });
  return out;
}

function main() {
  const cross = process.argv.includes('--cross');
  if (cross) {
    const zig = zigPath();
    if (!zig) { console.error('[core] --cross needs zig (npm i -g zig OR pip install ziglang)'); process.exit(1); }
    for (const k of Object.keys(TARGETS)) {
      try { buildWithZig(zig, k); } catch (e) { console.error(`[core] ${k} failed: ${e.message}`); }
    }
    return;
  }

  // Single-platform build. Prefer native toolchain; fall back to zig.
  try {
    const out = buildNative();
    console.log(`[core] built ${out}`);
  } catch (e) {
    const zig = zigPath();
    if (!zig) {
      console.error('[core] no C compiler found and zig unavailable.');
      console.error('[core] install a compiler, or: pip install ziglang');
      process.exit(1);
    }
    const out = buildWithZig(zig, platformKey());
    console.log(`[core] built ${out} (via zig)`);
  }
}

main();
