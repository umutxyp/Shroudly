'use strict';

/* Runs every network test in its own process and prints one summary.
 *   node tests/net/run.js            all of them
 *   node tests/net/run.js doh cut    only those whose file name matches
 *
 * NET_SHARD=2/3: only this machine's part of them, so CI runs the network
 * tests on several machines at once (one test after another on each, as
 * before: timing-sensitive tests never share a machine). The parts are
 * balanced by durations.json (each file's longest run on any system; a file
 * not in it counts 15 s), so every machine finishes about together.
 *
 * NET_RETRY=1: a file that fails is run once more, alone; it passes only
 * if the second run passes, and the summary says it needed one. A real
 * fault fails twice; a network moment on a CI machine (a relay that did not
 * answer, a resolver's slow minute) does not turn the run red. */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const only = process.argv.slice(2);
let files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'))
  .filter((f) => !only.length || only.some((o) => f.includes(o))).sort();

/* The files of part k of n: the longest first, each to the part with the
 * least time so far. Pure, for the tests. */
function shard(list, k, n, weights, head = 0) {
  const parts = Array.from({ length: n }, (_, i) => ({ t: i === 0 ? head : 0, files: [] }));
  const w = (f) => (Number.isFinite(weights[f]) ? weights[f] : 15);
  for (const f of [...list].sort((a, b) => w(b) - w(a) || a.localeCompare(b))) {
    const p = parts.reduce((a, b) => (b.t < a.t ? b : a));
    p.files.push(f); p.t += Math.max(w(f), 1);
  }
  return parts[k - 1].files.sort();
}
module.exports = { shard };
if (require.main !== module) return;

const sh = /^(\d+)\/(\d+)$/.exec(process.env.NET_SHARD || '');
if (sh && +sh[1] >= 1 && +sh[1] <= +sh[2]) {
  let weights = {};
  try { weights = JSON.parse(fs.readFileSync(path.join(__dirname, 'durations.json'), 'utf8')); } catch {}
  // NET_SHARD_HEAD: seconds the first part's machine spends on other work
  // first (the labs and unit tests in CI), so it takes fewer of these.
  files = shard(files, +sh[1], +sh[2], weights, Number(process.env.NET_SHARD_HEAD) || 0);
  console.log(`part ${sh[1]} of ${sh[2]}: ${files.length} files`);
}
const retry = process.env.NET_RETRY === '1';
// Roblox Studio is installed for real on Windows CI: several hundred MB.
// The last way out's tests wait out ladders and re-checks, one after another.
const LIMIT_MS = { 'studio.test.js': 30 * 60 * 1000, 'engine-fallback.test.js': 10 * 60 * 1000, 'engine-search.test.js': 10 * 60 * 1000 };
const results = [];
for (const f of files) {
  console.log(`\n── ${f}`);
  const t0 = Date.now();
  const run = () => spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', timeout: LIMIT_MS[f] || 300000 });
  let r = run();
  let again = false;
  if (r.status !== 0 && retry) {
    console.log(`\n── ${f}: failed; once more, alone`);
    again = true;
    r = run();
  }
  results.push({ f, ok: r.status === 0, again, s: ((Date.now() - t0) / 1000).toFixed(1) });
}
console.log('\n── summary');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.f}  (${r.s}s)${r.again ? (r.ok ? '  passed on its second run' : '  failed twice') : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
