#!/usr/bin/env node
/*
 * Builds the OPTIONAL advanced (packet-layer) engine, shroudly-core-adv, which
 * can defeat stateful DPI (Iran/China) via low-TTL fake packets.
 *
 * This build is platform-specific and privileged by nature:
 *   Linux  : NFQUEUE + raw sockets (libnetfilter_queue, libmnl). Needs
 *            CAP_NET_ADMIN + CAP_NET_RAW at runtime.
 *   Windows: (planned) WinDivert backend — not built here yet.
 *   macOS  : (planned) pf/divert backend — not built here yet.
 *
 * It is intentionally separate from the default driver-free build. The app ships
 * the default engine always, and this advanced engine only where available, used
 * only when the user opts in after a probe reports a site can't be unblocked.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'core', 'src');
const sources = fs.readdirSync(srcDir).filter(f => f.endsWith('.c')).map(f => path.join(srcDir, f));
const outRoot = path.join(root, 'electron', 'tools', 'core');

if (process.platform !== 'linux') {
  console.log(`[core-adv] advanced backend currently builds on Linux only (this is ${process.platform}). Skipping.`);
  process.exit(0);
}

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const outDir = path.join(outRoot, `linux-${arch}`);
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'shroudly-core-adv');

const cc = process.env.CC || 'cc';
try {
  execFileSync(cc, ['-std=c11', '-O2', '-pthread', '-DSHROUDLY_RAW',
    '-o', out, ...sources, '-lnetfilter_queue', '-lmnl'], { stdio: 'inherit' });
  console.log(`[core-adv] built ${out}`);
} catch (e) {
  console.error('[core-adv] build failed. Install: libnetfilter-queue-dev libmnl-dev');
  console.error('[core-adv] ' + e.message);
  process.exit(1);
}
