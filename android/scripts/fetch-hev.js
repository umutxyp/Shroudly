#!/usr/bin/env node
'use strict';

/*
 * Fetches hev-socks5-tunnel (MIT, github.com/heiher/hev-socks5-tunnel), the
 * tun2socks the Android app builds into libhev-socks5-tunnel.so, together with
 * its submodules, at one pinned release.
 *
 * The release is pinned twice: by its commit (git checks every submodule
 * against the commits that commit records), and by a SHA-256 over every file
 * of the checked-out tree, computed here and compared with TREE_SHA256. A
 * moved tag or a rewritten submodule stops the fetch; the Gradle build runs
 * --verify before every build, so a changed file there stops the build too.
 *
 * Output: android/third_party/hev-socks5-tunnel (not committed). Run again
 * any time; it does nothing when the pinned tree is already there, and
 * fetches it again when what is there differs.
 *
 *   node android/scripts/fetch-hev.js           fetch (or confirm) the pinned tree
 *   node android/scripts/fetch-hev.js --verify  exit 1 unless what is there is the pinned tree
 *   node android/scripts/fetch-hev.js --print   print the tree hash of what is there
 *
 * To move to a newer release: change TAG and COMMIT, run with --print after a
 * fetch with SHROUDLY_HEV_TRUST=1, read the changes, then record the new hash.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = 'https://github.com/heiher/hev-socks5-tunnel';
const TAG = '2.18.0';
const COMMIT = 'd9dca26c7ad0e494492244f0309e80ee583e739e';
// Submodules at this commit, for the record (git enforces them):
//   src/core                     162dd996299fc2d2bff2dd63728f8a2cd71ed31a (hev-socks5-core 1.6.4)
//   third-part/hev-task-system   328f35d903221b51811b3d02b277d665dfbdc75f (5.10.3)
//   third-part/lwip              e22c9d2873cd5a8aade9deb2e518b75dab05170e (2.2.1.8)
//   third-part/yaml              efa36117a8646d26d12b58e05bac472d7854a70d (0.2.5.2)
//   third-part/wintun            (Windows only, not built)
const TREE_SHA256 = '39010fa8d3ea1bced85ba57075328669da220854416b58300a32d98e7af4d220';

const root = path.join(__dirname, '..');
const dest = path.join(root, 'third_party', 'hev-socks5-tunnel');
const stamp = path.join(dest, '.shroudly-pin');

function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', ...args], {
    cwd, stdio: ['ignore', 'pipe', 'inherit'],
  }).toString().trim();
}

/* SHA-256 over "<sha256 of file>  <path>\n" for every file, sorted by path,
 * .git directories left out. The same on every OS and git version. */
function treeHash(dir) {
  const files = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || (rel === '' && e.name === '.shroudly-pin')) continue;
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) files.push([r, Buffer.from(`link:${fs.readlinkSync(full)}`)]);
      else if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) files.push([r, fs.readFileSync(full)]);
    }
  })(dir, '');
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const all = crypto.createHash('sha256');
  for (const [r, data] of files) {
    all.update(`${crypto.createHash('sha256').update(data).digest('hex')}  ${r}\n`);
  }
  return all.digest('hex');
}

function fetch() {
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`[hev] fetching ${REPO} ${TAG}`);
  git(['clone', '--quiet', '--depth', '1', '--branch', TAG, REPO, tmp]);
  const head = git(['rev-parse', 'HEAD'], tmp);
  if (head !== COMMIT) throw new Error(`tag ${TAG} is at ${head}, expected ${COMMIT}`);
  try {
    git(['submodule', 'update', '--quiet', '--init', '--recursive', '--depth', '1'], tmp);
  } catch {
    // A server that will not hand out a single commit: take the whole history.
    git(['submodule', 'update', '--quiet', '--init', '--recursive'], tmp);
  }
  return tmp;
}

function main() {
  if (process.argv.includes('--print')) {
    if (!fs.existsSync(dest)) { console.error('[hev] nothing fetched yet'); process.exit(1); }
    console.log(treeHash(dest));
    return;
  }
  const pinned = () => fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === `${COMMIT} ${TREE_SHA256}`
    && treeHash(dest) === TREE_SHA256;
  if (process.argv.includes('--verify')) {
    if (!fs.existsSync(dest)) throw new Error('hev-socks5-tunnel is missing: run `node android/scripts/fetch-hev.js`');
    const got = treeHash(dest);
    if (got !== TREE_SHA256) {
      throw new Error(`third_party/hev-socks5-tunnel is not the pinned ${TAG} (tree ${got}, pinned ${TREE_SHA256}); `
        + 'delete it and run `node android/scripts/fetch-hev.js`');
    }
    console.log(`[hev] ${TAG} verified`);
    return;
  }
  if (pinned()) {
    console.log(`[hev] ${TAG} already in place`);
    return;
  }
  const tmp = fetch();
  const got = treeHash(tmp);
  if (got !== TREE_SHA256 && process.env.SHROUDLY_HEV_TRUST !== '1') {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`tree hash ${got} does not match the recorded ${TREE_SHA256}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  // A tree taken on trust is marked so; the build refuses it until its hash is recorded.
  fs.writeFileSync(stamp, `${COMMIT} ${got}${got === TREE_SHA256 ? '' : ' untrusted'}\n`);
  console.log(`[hev] ${TAG} ready (tree ${got})`);
}

try {
  main();
} catch (e) {
  console.error(`[hev] ${e.message}`);
  process.exit(1);
}
