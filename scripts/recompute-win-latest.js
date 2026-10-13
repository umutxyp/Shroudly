#!/usr/bin/env node
/*
 * After the Windows installers are code-signed (which changes their bytes),
 * electron-updater's latest.yml still holds the pre-signing SHA-512 and size.
 * This recomputes them from the signed files in dist/ so auto-update keeps
 * verifying correctly. Run after signing, before publishing.
 *
 * Works line by line: electron-builder writes the file with Windows line
 * endings on Windows, and the fields of an entry can come in any order.
 * Every installer the feed lists must be found and rewritten, or this fails:
 * a stale hash would only show up later, as every user's update refusing to
 * install.
 *
 *   node scripts/recompute-win-latest.js [dist-dir]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
const ymlPath = path.join(dist, 'latest.yml');
if (!fs.existsSync(ymlPath)) { console.log('[win-latest] no latest.yml; nothing to do'); process.exit(0); }

const facts = new Map();
const factsOf = (file) => {
  if (!facts.has(file)) {
    const f = path.join(dist, file);
    if (!fs.existsSync(f)) throw new Error(`latest.yml lists ${file}, which is not in ${dist}`);
    const buf = fs.readFileSync(f);
    facts.set(file, { sha512: crypto.createHash('sha512').update(buf).digest('base64'), size: buf.length });
  }
  return facts.get(file);
};

const lines = fs.readFileSync(ymlPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
let entry = null;            // the file of the "- url:" entry being read
let top = null;              // the top-level "path:"
for (const line of lines) { const m = line.match(/^path:\s*(\S+)/); if (m) top = m[1]; }

const out = lines.map((line) => {
  let m;
  if ((m = line.match(/^(\s*- url:\s*)(\S+)\s*$/))) { entry = m[2]; return line; }
  if (entry && /^\s{4,}\S/.test(line)) {
    if ((m = line.match(/^(\s+sha512:\s*)\S+/))) return m[1] + factsOf(entry).sha512;
    if ((m = line.match(/^(\s+size:\s*)\d+/))) return m[1] + factsOf(entry).size;
    return line;
  }
  entry = null;
  if (top && (m = line.match(/^(sha512:\s*)\S+/))) return m[1] + factsOf(top).sha512;
  if (top && (m = line.match(/^(size:\s*)\d+/))) return m[1] + factsOf(top).size;
  return line;
});

if (!facts.size) throw new Error('latest.yml lists no installers');
fs.writeFileSync(ymlPath, out.join('\n'));
for (const [file, f] of facts) console.log(`[win-latest] ${file}: size ${f.size}, sha512 ${f.sha512.slice(0, 12)}…`);
console.log('[win-latest] latest.yml recomputed from signed files');
