#!/usr/bin/env node
/*
 * Publish dist/ to a GitHub release with readable asset labels.
 *
 *   GITHUB_TOKEN=... node scripts/publish-release.js [notes.md]
 *
 * Creates release v<version> (from package.json) on the current commit, then
 * uploads only what users and the auto-updater need: the per-arch installers
 * and the latest*.yml update feeds. The universal Windows installer that
 * electron-builder also produces is left out (and dropped from latest.yml):
 * the updater picks the x64 / arm64 installer, and two Windows choices are
 * enough for people downloading by hand.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OWNER = 'umutxyp';
const REPO = 'Shroudly';
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const { version } = require('../package.json');
const token = process.env.GITHUB_TOKEN;
if (!token) { console.error('Set GITHUB_TOKEN'); process.exit(1); }

const FEED = '(for automatic updates, no need to download)';
const ASSETS = [
  [`Shroudly-${version}-Windows-x64-Setup.exe`, 'Windows · Intel/AMD 64-bit (most PCs) · Installer'],
  [`Shroudly-${version}-Windows-arm64-Setup.exe`, 'Windows · ARM (Snapdragon / Copilot+ PCs) · Installer'],
  [`Shroudly-${version}-macOS-arm64.dmg`, 'macOS · Apple Silicon (M1/M2/M3/M4) · Disk image (recommended)'],
  [`Shroudly-${version}-macOS-x64.dmg`, 'macOS · Intel Macs · Disk image (recommended)'],
  [`Shroudly-${version}-macOS-arm64.zip`, 'macOS · Apple Silicon (M1/M2/M3/M4) · Zip'],
  [`Shroudly-${version}-macOS-x64.zip`, 'macOS · Intel Macs · Zip'],
  [`Shroudly-${version}-Linux-x86_64.AppImage`, 'Linux · Intel/AMD 64-bit · AppImage (any distro)'],
  [`Shroudly-${version}-Linux-amd64.deb`, 'Linux · Intel/AMD 64-bit · Debian / Ubuntu package (.deb)'],
  [`Shroudly-${version}-Linux-arm64.AppImage`, 'Linux · ARM 64-bit (e.g. Raspberry Pi 4/5) · AppImage'],
  [`Shroudly-${version}-Linux-x64.pacman`, 'Linux · Intel/AMD 64-bit · Arch / Manjaro package (.pacman)'],
  [`Shroudly-${version}-Linux-x86_64.rpm`, 'Linux · Intel/AMD 64-bit · Fedora / openSUSE package (.rpm)'],
  [`Shroudly-${version}-Android.apk`, 'Android 8+ · Phones and tablets · APK', { optional: true }],
  ['latest.yml', `Update data · Windows ${FEED}`],
  ['latest-mac.yml', `Update data · macOS ${FEED}`],
  ['latest-linux.yml', `Update data · Linux x64 ${FEED}`],
  ['latest-linux-arm64.yml', `Update data · Linux ARM ${FEED}`],
];

/* electron-builder lists the AppImage, .deb and .rpm in latest-linux.yml but
 * not the .pacman, and electron-updater's pacman updater finds its file by
 * looking for that extension in the feed — so without this an Arch install
 * would never update. Add the entry with the same fields the others carry. */
function addPacmanToLinuxFeed() {
  const crypto = require('crypto');
  const yml = path.join(dist, 'latest-linux.yml');
  const pkg = `Shroudly-${version}-Linux-x64.pacman`;
  const file = path.join(dist, pkg);
  if (!fs.existsSync(yml) || !fs.existsSync(file)) return;
  let text = fs.readFileSync(yml, 'utf8');
  if (text.includes(pkg)) return;
  const data = fs.readFileSync(file);
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  const entry = `  - url: ${pkg}\n    sha512: ${sha512}\n    size: ${data.length}\n`;
  // Append to the end of the files: list, just before the top-level path:.
  text = text.replace(/\npath: /, `\n${entry}path: `);
  fs.writeFileSync(yml, text);
  console.log(`  feed      added ${pkg} to latest-linux.yml`);
}

/* Drop the universal installer from latest.yml and point the legacy
 * top-level path at the x64 installer. Works line by line, so extra fields,
 * their order and Windows line endings make no difference. */
function cleanWindowsFeed() {
  const file = path.join(dist, 'latest.yml');
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (/^\s*- url: /.test(line)) skip = /-Windows-Setup\.exe\s*$/.test(line);
    else if (!/^\s{4,}\S/.test(line)) skip = false;
    if (!skip) out.push(line);
  }
  let s = out.join('\n');
  const x64 = s.match(/- url: (\S+-Windows-x64-Setup\.exe)\n\s+sha512: (\S+)/);
  if (!x64) throw new Error('latest.yml has no x64 installer');
  s = s.replace(/^path: .*$/m, `path: ${x64[1]}`).replace(/^sha512: .*$/m, `sha512: ${x64[2]}`);
  if (/-Windows-Setup\.exe/.test(s)) throw new Error('latest.yml still lists the universal installer, which is not published');
  fs.writeFileSync(file, s);
}

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.message || url}`);
  return body;
}

(async () => {
  const absent = ASSETS.filter(([, , o]) => !(o && o.optional)).map(([n]) => n).filter((n) => !fs.existsSync(path.join(dist, n)));
  if (absent.length) {
    // Print what is actually there: every time this has fired it was a name
    // that did not match, and guessing from the missing one alone is slow.
    const have = fs.existsSync(dist) ? fs.readdirSync(dist).filter((f) => !f.startsWith('.')).sort() : [];
    throw new Error(`missing from dist:\n  ${absent.join('\n  ')}\n\ndist contains:\n  ${have.join('\n  ')}`);
  }
  cleanWindowsFeed();
  addPacmanToLinuxFeed();
  // Notes: an explicit file argument, else release-notes/v<version>.md if the
  // repo has one (that is what the CI release job uses).
  const repoNotes = path.join(root, 'release-notes', `v${version}.md`);
  const notesFile = process.argv[2] || (fs.existsSync(repoNotes) ? repoNotes : null);

  // Idempotent: if this version is already released (published locally, or a
  // re-run), reuse it and upload only the files it is missing.
  let release = await api(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/v${version}`).catch(() => null);
  if (release) {
    console.log(`release exists ${release.html_url}`);
  } else {
    release = await api(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: `v${version}`,
        target_commitish: execSync('git rev-parse HEAD', { cwd: root }).toString().trim(),
        name: `Shroudly v${version}`,
        body: notesFile ? fs.readFileSync(notesFile, 'utf8') : '',
        make_latest: 'true',
      }),
    });
    console.log(`release ${release.html_url}`);
  }
  const have = new Set((release.assets || []).map((a) => a.name));
  for (const [name, label, o] of ASSETS) {
    if (have.has(name)) { console.log(`  exists    ${name}`); continue; }
    if (o && o.optional && !fs.existsSync(path.join(dist, name))) { console.log(`  skipped   ${name} (not built)`); continue; }
    const data = fs.readFileSync(path.join(dist, name));
    const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}&label=${encodeURIComponent(label)}`;
    const a = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
    console.log(`  ${a.state}  ${name}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
