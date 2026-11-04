#!/usr/bin/env node
/*
 * The last way out on iPhone, iPad and the Mac (Tunnel/TorRoute.swift):
 * Tor and the pluggable transports as libraries, since the packet tunnel
 * can run no program of its own. Each download is checked against a pinned
 * SHA-256, and nothing is unpacked from one that differs.
 *
 *   third_party/Tor.xcframework       Tor 0.4.9.15 with OpenSSL and libevent,
 *                                     static (iCepa/Tor.framework 409.15.3,
 *                                     the build Orbot and Onion Browser use)
 *   third_party/IPtProxy.xcframework  Snowflake 2.15.1, lyrebird 0.9.0 (obfs4,
 *                                     meek, webtunnel) as one library
 *                                     (IPtProxy 5.7.0, Guardian Project)
 *   Tunnel/tor-bridges.json           the bridges of the Tor Project's own
 *                                     bundle (scripts/fetch-tor.js), as the
 *                                     desktop and Android use them
 *
 * Linked into the Mac's tunnel only: on an iPhone or iPad, Tor and Snowflake
 * would take the tunnel past what iOS lets it use (TorRoute.swift), and
 * neither library has a tvOS build.
 *
 *   node apple/scripts/fetch-tor.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const desk = require('../../scripts/fetch-tor.js');

const APPLE = path.join(__dirname, '..');
const THIRD = path.join(APPLE, 'third_party');
const PARTS = [
  {
    name: 'Tor.xcframework',
    url: 'https://github.com/iCepa/Tor.framework/releases/download/409.15.3/tor-nolzma.xcframework.zip',
    sha256: '0c3921c9fc58631428904f77d9c4afd49fa4c77ad608abf547bf7c409bb33b70',
    // The zip holds tor-nolzma.xcframework.
    unpack: (file, work) => { execFileSync('unzip', ['-q', '-o', file, '-d', work]); return path.join(work, 'tor-nolzma.xcframework'); },
  },
  {
    name: 'IPtProxy.xcframework',
    url: 'https://codeload.github.com/tladesignz/IPtProxy/tar.gz/refs/tags/5.7.0',
    sha256: '00faadf0540b15be2ee2bacc46da9f0f64417dccaa8ce54731c392d62c52835c',
    unpack: (file, work) => { execFileSync('tar', ['-xzf', file, '-C', work]); return path.join(work, 'IPtProxy-5.7.0', 'IPtProxy.xcframework'); },
  },
];

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-apple-tor-'));
  try {
    fs.mkdirSync(THIRD, { recursive: true });
    for (const p of PARTS) {
      const out = path.join(THIRD, p.name);
      const stamp = path.join(out, '.shroudly-sha256');
      if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === p.sha256) { console.log(`[apple-tor] ${p.name}: up to date`); continue; }
      const file = path.join(work, path.basename(p.name) + '.download');
      console.log(`[apple-tor] downloading ${p.url}`);
      await desk.download(p.url, file);
      const got = sha(file);
      if (got !== p.sha256) throw new Error(`SHA-256 mismatch for ${p.name}\n  expected ${p.sha256}\n  got      ${got}`);
      const dir = p.unpack(file, work);
      fs.rmSync(out, { recursive: true, force: true });
      // Symbolic links kept (a macOS framework is made of them).
      execFileSync('cp', ['-R', dir, out]);
      fs.writeFileSync(stamp, `${p.sha256}\n`);
      console.log(`[apple-tor] ${p.name}: SHA-256 verified -> ${path.relative(process.cwd(), out)}`);
    }
    const src = await desk.bundle('macos-aarch64', work);
    fs.copyFileSync(path.join(src, desk.PT, 'pt_config.json'), path.join(APPLE, 'Tunnel', 'tor-bridges.json'));
    console.log('[apple-tor] Tunnel/tor-bridges.json from the Tor Expert Bundle');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error('[apple-tor]', e.message); process.exit(1); });
