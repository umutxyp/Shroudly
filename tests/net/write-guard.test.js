'use strict';

/* A computer that does not let Shroudly create files (electron/write-guard.js):
 * a deleted temporary folder is made again; folders that refuse new files are
 * found with a probe and said once; other errors change nothing. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, suite } = require('./helpers');
const { WriteGuard, ensureTmp, canCreate } = require(path.join(ROOT, 'electron', 'write-guard.js'));

const t = suite('write-guard');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-wg-'));
try {
  // The temporary folder gone (a cleaning program): made again.
  const tmp = path.join(base, 'Temp');
  t.ok(!fs.existsSync(tmp) && ensureTmp(tmp) && fs.statSync(tmp).isDirectory(), 'a deleted temporary folder is made again');
  t.ok(canCreate(tmp), 'and new files can be made in it');

  // A write failed, but the folders take new files: nothing to say.
  const logs = [];
  const data = path.join(base, 'data');
  const ok = new WriteGuard({ dirs: [data], log: (l, m) => logs.push(m), tmp: () => tmp });
  t.ok(ok.note(Object.assign(new Error('x'), { code: 'ENOENT' })) === false && logs.length === 0, 'a failed write where the folders take new files: nothing said, nothing blocked');

  // The temporary folder deleted again before the failed write: made again by note().
  fs.rmSync(tmp, { recursive: true, force: true });
  t.ok(ok.note(Object.assign(new Error('x'), { code: 'ENOENT' })) === false && fs.existsSync(tmp), 'a write failing because the temporary folder is gone: the folder is made again, nothing blocked');

  // Other errors: nothing looked at.
  t.ok(ok.note(Object.assign(new Error('x'), { code: 'ENOSPC' })) === false && ok.note(null) === false, 'another error (a full disk) or none: nothing');

  // A folder that refuses new files (read-only here): found and said once.
  if (process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)) {
    const locked = path.join(base, 'locked');
    fs.mkdirSync(locked); fs.chmodSync(locked, 0o500);
    const said = [];
    const g = new WriteGuard({ dirs: [locked], log: (l, m) => said.push(`${l}: ${m}`), tmp: () => tmp });
    const e = Object.assign(new Error('x'), { code: 'EACCES' });
    t.ok(g.note(e) === true && g.refused.includes(locked), 'a folder that refuses new files: found');
    t.ok(g.note(e) === true && said.length === 1 && /does not let Shroudly create files/.test(said[0]) && said[0].includes(locked) && /Controlled folder access/.test(said[0]),
      `said once, in plain words, naming the folder (${said.length})`);
    fs.chmodSync(locked, 0o700);
  } else {
    t.ok(true, 'read-only folder check skipped here (Windows or root)');
  }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
console.log(`write-guard: ${t.count} passed`);
