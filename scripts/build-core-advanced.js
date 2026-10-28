#!/usr/bin/env node
/*
 * Builds the OPTIONAL advanced (packet-layer) engine, shroudly-core-adv, which
 * defeats stateful DPI (Iran/China) via low-TTL fake packets.
 *
 * Backends (one per OS, all privileged by nature):
 *   Linux  : NFQUEUE (spoken over netlink, core/src/nfq.c: no library) + raw sockets
 *   Windows: WinDivert (loads WinDivert.dll/.sys at runtime; Administrator; x64 only)
 * macOS has none: its pf has no divert-to rule and the kernel no divert
 * sockets, so packet interception needs a signed Network Extension.
 *
 * Native build for the current OS by default; `--cross` builds all via zig,
 * whose own headers (the kernel's included) are all Linux needs.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'core', 'src');
const sources = fs.readdirSync(srcDir).filter(f => f.endsWith('.c')).map(f => path.join(srcDir, f));
const outRoot = path.join(root, 'electron', 'tools', 'core');

const TARGETS = {
  'linux-x64':   { zig: 'x86_64-linux-gnu.2.28',  bin: 'shroudly-core-adv', libs: ['-lpthread'], feat: ['-D_GNU_SOURCE'] },
  'linux-arm64': { zig: 'aarch64-linux-gnu.2.28', bin: 'shroudly-core-adv', libs: ['-lpthread'], feat: ['-D_GNU_SOURCE'] },
  // advapi32: the service manager, to unload the WinDivert driver at stop
  'win32-x64':   { zig: 'x86_64-windows-gnu', bin: 'shroudly-core-adv.exe', libs: ['-lws2_32', '-ladvapi32'], feat: [] },
  // no win32-arm64: WinDivert ships no ARM64 driver
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
    console.error('[core-adv] build failed (a C compiler, or zig, is needed)');
    process.exit(1);
  }
}

// --target <key>: build just that one with zig.
// Used by CI so the Linux engines link against an old glibc, not the runner's.
const ti = process.argv.indexOf('--target');
if (ti > 0) {
  const zig = zigPath();
  const key = process.argv[ti + 1];
  if (!zig) { console.error('[core-adv] --target needs zig'); process.exit(1); }
  if (!TARGETS[key]) { console.error(`[core-adv] unknown target ${key}`); process.exit(1); }
  buildZig(zig, key);
  if (!fs.existsSync(path.join(outRoot, key, TARGETS[key].bin))) process.exit(1);
  process.exit(0);
}

if (process.argv.includes('--cross')) {
  const zig = zigPath();
  if (!zig) { console.error('[core-adv] --cross needs zig'); process.exit(1); }
  const self = platKey();
  for (const k of Object.keys(TARGETS)) {
    if (k === self && process.platform === 'linux') continue; // built natively below
    buildZig(zig, k);
  }
  if (process.platform === 'linux') buildNative();
} else {
  buildNative();
}
