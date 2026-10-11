#!/usr/bin/env node
/*
 * Builds the OPTIONAL advanced (packet-layer) engine, shroudly-core-adv, which
 * defeats stateful DPI (Iran/China) via low-TTL fake packets.
 *
 * Backends (one per OS, all privileged by nature):
 *   Linux  : NFQUEUE + raw sockets (needs libnetfilter-queue-dev, libmnl-dev)
 *   Windows: WinDivert (loads WinDivert.dll/.sys at runtime; Administrator)
 *   macOS  : pf divert sockets + raw sockets (root; no kext/SIP changes)
 *
 * Native build for the current OS by default; `--cross` builds all via zig.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'core', 'src');
const sources = fs.readdirSync(srcDir).filter(f => f.endsWith('.c')).map(f => path.join(srcDir, f));
const outRoot = path.join(root, 'electron', 'tools', 'core');

const TARGETS = {
  'linux-x64':   { zig: 'x86_64-linux-gnu',   bin: 'shroudly-core-adv',     libs: ['-lnetfilter_queue', '-lmnl', '-lpthread'], feat: ['-D_GNU_SOURCE'] },
  'linux-arm64': { zig: 'aarch64-linux-gnu',  bin: 'shroudly-core-adv',     libs: ['-lnetfilter_queue', '-lmnl', '-lpthread'], feat: ['-D_GNU_SOURCE'] },
  'win32-x64':   { zig: 'x86_64-windows-gnu', bin: 'shroudly-core-adv.exe', libs: ['-lws2_32'], feat: [] },
  'win32-arm64': { zig: 'aarch64-windows-gnu',bin: 'shroudly-core-adv.exe', libs: ['-lws2_32'], feat: [] },
  'darwin-x64':  { zig: 'x86_64-macos-none',  bin: 'shroudly-core-adv',     libs: [], feat: ['-D_DARWIN_C_SOURCE'] },
  'darwin-arm64':{ zig: 'aarch64-macos-none', bin: 'shroudly-core-adv',     libs: [], feat: ['-D_DARWIN_C_SOURCE'] },
};

function zigPath() {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  if (spawnSync('zig', ['version'], { stdio: 'ignore' }).status === 0) return 'zig';
  if (spawnSync(py, ['-m', 'ziglang', 'version'], { stdio: 'ignore' }).status === 0) return `${py} -m ziglang`;
  return null;
}
function platKey() { return `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`; }

function buildZig(zig, key) {
  const t = TARGETS[key];
  if (!t) { console.log(`[core-adv] no advanced backend target for ${key}`); return; }
  const outDir = path.join(outRoot, key); fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, t.bin);
  const parts = zig.split(' ');
  // Linux needs the system libnetfilter_queue headers/libs, which zig's
  // cross sysroot does not provide; skip cross Linux unless building natively.
  if (t.zig.includes('linux') && platKey() !== key) {
    console.log(`[core-adv] skip cross ${key} (needs libnetfilter_queue sysroot; build natively on Linux)`);
    return;
  }
  const args = [...parts.slice(1), 'cc', '-target', t.zig, '-std=c11', '-O2', '-DSHROUDLY_RAW',
    ...t.feat, '-o', out, ...sources, ...t.libs];
  try { execFileSync(parts[0], args, { stdio: 'inherit' }); console.log(`[core-adv] built ${key} -> ${out}`); }
  catch (e) { console.error(`[core-adv] ${key} failed: ${e.message}`); }
}

function buildNative() {
  const key = platKey();
  const t = TARGETS[key];
  if (!t) { console.log(`[core-adv] advanced backend not available for ${key}`); process.exit(0); }
  const outDir = path.join(outRoot, key); fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, t.bin);
  const cc = process.env.CC || 'cc';
  try {
    execFileSync(cc, ['-std=c11', '-O2', '-pthread', '-DSHROUDLY_RAW', ...t.feat, '-o', out, ...sources, ...t.libs], { stdio: 'inherit' });
    console.log(`[core-adv] built ${out}`);
  } catch (e) {
    const zig = zigPath();
    if (zig) return buildZig(zig, key);
    console.error('[core-adv] build failed. Linux needs: libnetfilter-queue-dev libmnl-dev');
    process.exit(1);
  }
}

if (process.argv.includes('--cross')) {
  const zig = zigPath();
  if (!zig) { console.error('[core-adv] --cross needs zig'); process.exit(1); }
  const self = platKey();
  for (const k of Object.keys(TARGETS)) {
    if (k === self && process.platform === 'linux') continue; // built natively below
    buildZig(zig, k);
  }
  // native build for the host (Linux needs its real libnetfilter_queue)
  if (process.platform === 'linux') buildNative();
} else {
  buildNative();
}
