'use strict';

/* Runs every network test in its own process and prints one summary.
 *   node tests/net/run.js            all of them
 *   node tests/net/run.js doh cut    only those whose file name matches */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const only = process.argv.slice(2);
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'))
  .filter((f) => !only.length || only.some((o) => f.includes(o))).sort();
const results = [];
for (const f of files) {
  console.log(`\n── ${f}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', timeout: 300000 });
  results.push({ f, ok: r.status === 0, s: ((Date.now() - t0) / 1000).toFixed(1) });
}
console.log('\n── summary');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.f}  (${r.s}s)`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
