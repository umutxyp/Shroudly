'use strict';

/* The Windows 7 and 8 build runs the same electron/ code on Electron 22
 * (electron-builder-legacy.js). An API that came later is undefined there,
 * and calling it throws: app.setProxy (Electron 28) failed every Start and
 * Stop on Windows 7 in 2.6.70 ("Start failed: app.setProxy is not a
 * function", a Russian report). So each such API is used only behind a
 * check that it is there, and net.fetch (25) not at all: net.request is in
 * both. Read from the source, so every system runs it. */

const path = require('path');
const fs = require('fs');
const { ROOT, suite } = require('./helpers');

const t = suite('legacy-electron');
const dir = path.join(ROOT, 'electron');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

// Electron APIs newer than 22, as the code would call them.
const NEWER = [
  { re: /\bapp\.setProxy\(/g, name: 'app.setProxy (Electron 28)', guard: /typeof app\.setProxy === 'function'/ },
  { re: /\bapp\.resolveProxy\(/g, name: 'app.resolveProxy (Electron 28)', guard: /typeof app\.resolveProxy === 'function'/ },
  { re: /\bnet\.fetch\(/g, name: 'net.fetch (Electron 25)', guard: null },
  { re: /\bnet\.resolveHost\(/g, name: 'net.resolveHost (Electron 33)', guard: null },
  { re: /\bwebUtils\b/g, name: 'webUtils (Electron 29)', guard: null },
];

let checked = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  // Comments say these names too; only code counts.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const n of NEWER) {
    const uses = code.match(n.re) || [];
    if (!uses.length) continue;
    checked += uses.length;
    t.ok(n.guard && n.guard.test(code), `${f}: ${n.name} is used only where it is there (Windows 7 and 8 run Electron 22)`);
  }
}
t.ok(checked > 0, 'the newer APIs are looked for (app.setProxy is in main.js, guarded)');

console.log(`legacy-electron: ${t.count} passed`);
process.exit(0);
