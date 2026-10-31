'use strict';

/* Windows' own folders first on Shroudly's PATH (electron/win-path.js, issue
 * #61): missing ones added, ones elsewhere moved first, each once, the user's
 * own folders kept in their order; nothing done off Windows; and on Windows,
 * reg.exe and powershell.exe start with a PATH that has none of them. */

const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, suite } = require('./helpers');
const W = require(path.join(ROOT, 'electron', 'win-path.js'));

const t = suite('win-path');
const there = (d) => /^c:\\windows(\\system32)?$/i.test(d);
const STD = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0';

(async () => {
  t.ok(W.windowsDir({ SystemRoot: 'C:\\Windows' }, there) === 'C:\\Windows', 'the Windows folder the environment names');
  t.ok(W.windowsDir({ SystemRoot: 'D:\\Gone' }, there) === 'C:\\Windows', 'one that is not there: the usual one');
  t.ok(W.windowsDir({}, () => false) === null, 'none found: nothing to put on PATH');

  t.ok(W.withSystemDirs('', 'C:\\Windows') === STD, 'an empty PATH gets the standard four');
  t.ok(W.withSystemDirs('C:\\Tools;C:\\Program Files\\Git\\cmd', 'C:\\Windows') === `${STD};C:\\Tools;C:\\Program Files\\Git\\cmd`,
    'a PATH without them: they come first, the rest kept in order');
  t.ok(W.withSystemDirs('C:\\Tools;c:\\windows\\system32\\;C:\\WINDOWS', 'C:\\Windows') === `${STD};C:\\Tools`,
    'ones already there in another case or with a trailing backslash are not doubled');
  t.ok(W.withSystemDirs(`${STD};C:\\Tools;;`, 'C:\\Windows') === `${STD};C:\\Tools`, 'empty entries dropped');

  const env1 = { PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows' };
  t.ok(W.ensureWindowsPath(env1, 'win32', there) === true && env1.PATH === `${STD};C:\\Tools`, 'fixed on Windows, and said so');
  t.ok(env1.ComSpec === 'C:\\Windows\\System32\\cmd.exe' && env1.windir === 'C:\\Windows', 'cmd.exe and windir named when missing');
  const env2 = { PATH: `${STD};C:\\Tools`, SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'X' };
  t.ok(W.ensureWindowsPath(env2, 'win32', there) === false && env2.PATH === `${STD};C:\\Tools` && env2.ComSpec === 'X',
    'a standard PATH is left exactly as it is');
  const env3 = { PATH: '/usr/bin' };
  t.ok(W.ensureWindowsPath(env3, 'darwin', there) === false && env3.PATH === '/usr/bin', 'nothing done off Windows');

  if (process.platform === 'win32') {
    const env = { ...process.env, PATH: 'C:\\Nowhere' };
    delete env.Path;
    W.ensureWindowsPath(env);
    let ok = false;
    try { ok = /ShutdownTime/.test(execFileSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Windows', '/v', 'ShutdownTime'], { env, encoding: 'utf8', windowsHide: true })); } catch {}
    t.ok(ok, 'reg.exe starts by name with a PATH that had no Windows folder');
    let ps = '';
    try { ps = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output ok'], { env, encoding: 'utf8', windowsHide: true }); } catch {}
    t.ok(ps.trim() === 'ok', 'powershell.exe too');
  }
  console.log(`win-path: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
