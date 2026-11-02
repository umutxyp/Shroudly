'use strict';

/* Windows' registry where Windows will not start reg.exe (issue #64:
 * "spawnSync reg.exe EPERM", even for an administrator, and protection did
 * not start). electron/win-reg.js and the engine's --reg (core/src/winreg.c):
 *   - reg.exe that starts is used as before; its own errors (a value not
 *     there) are its answer, the engine is not asked
 *   - reg.exe that cannot start: the same arguments to the engine, said once
 *     in the log, and reg.exe not tried again; with no engine, the error
 *   - every module that runs reg.exe goes through it
 *   - on Windows, the engine's answers read as reg.exe's: a value written by
 *     one is read the same by the other, letters outside English included;
 *     DWORD, a list, a key with subkeys (/s), a value and a key deleted, and
 *     "not there" as reg.exe says it (exit 1). And WinINET told of a change. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, suite, enginePath } = require('./helpers');
const WinReg = require(path.join(ROOT, 'electron', 'win-reg.js'));

const t = suite('win-reg');

const QUERY_OUT = '\r\nHKEY_CURRENT_USER\\Software\\X\r\n    A    REG_SZ    one\r\n\r\n';
const spawnErr = (code) => Object.assign(new Error(`spawnSync reg.exe ${code}`), { code, errno: -1, syscall: 'spawnSync reg.exe' });
const exitErr = (status) => Object.assign(new Error('Command failed'), { status });

(async () => {
  const core = enginePath();
  const calls = [];
  const logs = [];
  let regBehaviour = 'ok';
  const hooks = {
    core,
    execFileSync(file, args) {
      calls.push([path.basename(file), ...args]);
      if (WinReg.isReg(file)) {
        if (regBehaviour === 'refused') throw spawnErr('EPERM');
        if (regBehaviour === 'missing') throw exitErr(1);
        return QUERY_OUT;
      }
      if (args[0] === '--reg') return QUERY_OUT.replace('one', 'from the engine');
      throw new Error('unexpected');
    },
    execFile(file, args, opts, cb) {
      calls.push([path.basename(file), ...args]);
      if (WinReg.isReg(file) && regBehaviour === 'refused') { setImmediate(() => cb(spawnErr('EPERM'), '', '')); return; }
      if (WinReg.isReg(file)) { setImmediate(() => cb(null, QUERY_OUT, '')); return; }
      setImmediate(() => cb(null, QUERY_OUT.replace('one', 'from the engine'), ''));
    },
  };
  WinReg.setLog((level, msg) => logs.push(`${level}: ${msg}`));

  WinReg._setHooks(hooks);
  t.ok(WinReg.runSync(['query', 'HKCU\\Software\\X', '/v', 'A']) === QUERY_OUT && calls.length === 1 && calls[0][0] === 'reg.exe',
    'reg.exe that starts: its answer, the engine not asked');
  regBehaviour = 'missing';
  let status = null;
  try { WinReg.runSync(['query', 'HKCU\\Software\\X', '/v', 'B']); } catch (e) { status = e.status; }
  t.ok(status === 1 && calls.length === 2 && !calls.some((c) => c[1] === '--reg') && !WinReg.refused(),
    'reg.exe that ran and said "not there" (exit 1): that is the answer, not a refusal');

  regBehaviour = 'refused';
  calls.length = 0;
  const out = WinReg.runSync(['add', 'HKCU\\Software\\X', '/v', 'A', '/t', 'REG_SZ', '/d', 'Ümit', '/f']);
  t.ok(/from the engine/.test(out) && calls.length === 2 && calls[1][1] === '--reg'
    && JSON.stringify(calls[1].slice(2)) === JSON.stringify(['add', 'HKCU\\Software\\X', '/v', 'A', '/t', 'REG_SZ', '/d', 'Ümit', '/f']),
  'reg.exe refused (EPERM): the same arguments to the engine');
  calls.length = 0;
  WinReg.runSync(['query', 'HKCU\\Software\\X']);
  await WinReg.run(['query', 'HKCU\\Software\\X']);
  t.ok(calls.length === 2 && calls.every((c) => c[1] === '--reg') && WinReg.refused(), 'once refused, reg.exe is not tried again in this run');
  t.ok(logs.length === 1 && /Windows does not let Shroudly start reg\.exe \(EPERM\); Shroudly reads and writes these settings itself/.test(logs[0]),
    'said once in the log');

  WinReg._setHooks({ ...hooks });
  calls.length = 0;
  t.ok(/from the engine/.test(await WinReg.run(['query', 'HKCU\\Software\\X'])) && calls.length === 2 && calls[0][0] === 'reg.exe' && calls[1][1] === '--reg',
    'the same without blocking');
  WinReg._setHooks({ ...hooks, core: path.join(path.dirname(core), 'not-there.exe') });
  let err = null;
  try { WinReg.runSync(['query', 'HKCU\\Software\\X']); } catch (e) { err = e; }
  t.ok(err && err.code === 'EPERM', 'no engine either: reg.exe\'s own error');
  WinReg._setHooks(null);

  // Every module that runs reg.exe goes through it.
  const src = (f) => fs.readFileSync(path.join(ROOT, 'electron', f), 'utf8').replace(/\r\n/g, '\n');
  const wired = {
    'system-proxy.js': /function run\(cmd[^)]*\) \{\n[^\n]*\n\s*if \(process\.platform === 'win32' && WinReg\.isReg\(cmd\)\) return WinReg\.run\(/,
    'app-env.js': /WinReg\.isReg\(cmd\)\) return WinReg\.runSync\(/,
    'boot.js': /WinReg\.runSync\(\['query'/,
    'winhttp.js': /WinReg\.run\(\['query', KEY/,
    'link-open.js': /WinReg\.runSync\(\['query', 'HKCU\\\\Volatile Environment'\]/,
    'store-apps.js': /WinReg\.isReg\(cmd\)\) \{\n\s*return WinReg\.run\(/,
  };
  const missing = Object.entries(wired).filter(([f, re]) => !re.test(src(f))).map(([f]) => f);
  t.ok(!missing.length && /WinReg\.isReg\(cmd\)\) return WinReg\.runSync\(/.test(src('system-proxy.js')) && /WinReg\.setLog\(addLog\)/.test(src('main.js')),
    missing.length ? `not wired: ${missing.join(', ')}` : 'every reg.exe call goes through it (system proxy, Games and apps, boot, WinHTTP, links, Store apps); the log is told');

  // On Windows: the engine reads and writes what reg.exe reads and writes.
  if (process.platform === 'win32') {
    const key = `HKCU\\Software\\ShroudlyTest-${process.pid}`;
    const reg = (args) => execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const eng = (args) => execFileSync(core, ['--reg', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const status1 = (fn) => { try { fn(); return 0; } catch (e) { return e.status; } };
    const line = (out, name) => (out.match(new RegExp(`^\\s+${name}\\s+(REG_\\w+)\\s+(.*)$`, 'm')) || []).slice(1).join(' ').trim();
    try {
      const odd = 'http://127.0.0.1:61000/proxy.pac?ç=Ümit Çağrı';
      eng(['add', key, '/v', 'AutoConfigURL', '/t', 'REG_SZ', '/d', odd, '/f']);
      reg(['add', key, '/v', 'ByReg', '/t', 'REG_DWORD', '/d', '1', '/f']);
      eng(['add', `${key}\\Sub`, '/v', 'List', '/t', 'REG_MULTI_SZ', '/d', 'a\\0b', '/f']);
      t.ok(line(eng(['query', key, '/v', 'AutoConfigURL']), 'AutoConfigURL') === `REG_SZ ${odd}`
        && line(reg(['query', key, '/v', 'AutoConfigURL']), 'AutoConfigURL').startsWith('REG_SZ http://127.0.0.1:61000/proxy.pac?'),
      'a value the engine wrote reads back the same from it, and reg.exe finds it (letters outside English in UTF-8 from the engine)');
      t.ok(line(eng(['query', key, '/v', 'ByReg']), 'ByReg') === line(reg(['query', key, '/v', 'ByReg']), 'ByReg') && line(eng(['query', key, '/v', 'ByReg']), 'ByReg') === 'REG_DWORD 0x1',
        'a DWORD reg.exe wrote reads the same through the engine (REG_DWORD 0x1)');
      const all = eng(['query', key, '/s']);
      t.ok(/\\Sub\r?\n\s+List\s+REG_MULTI_SZ\s+a\\0b/.test(all) && /AutoConfigURL\s+REG_SZ/.test(all) && line(reg(['query', `${key}\\Sub`, '/v', 'List']), 'List') === 'REG_MULTI_SZ a\\0b',
        'a key with its subkeys (/s), a list as reg.exe shows one');
      // Every line ends in "\r\n", as from reg.exe (a text-mode stdout gave
      // "\r\r\n", which the app's line readers do not match), and a key
      // reads as the same lines from both.
      const crlf = (s) => s.length > 0 && !/\r\r|[^\r]\n|^\n|\r(?!\n)/.test(s);
      const rows = (s) => s.split('\r\n').filter((l) => l.trim());
      const added = eng(['add', `${key}\\Sub`, '/v', 'Two', '/t', 'REG_SZ', '/d', 'x', '/f']);
      t.ok(crlf(all) && crlf(eng(['query', key, '/v', 'ByReg'])) && crlf(added)
        && JSON.stringify(rows(eng(['query', `${key}\\Sub`, '/s']))) === JSON.stringify(rows(reg(['query', `${key}\\Sub`, '/s']))),
      'lines end in "\\r\\n" as reg.exe\'s do, and a key reads as the same lines from both');
      eng(['delete', key, '/v', 'ByReg', '/f']);
      t.ok(status1(() => eng(['query', key, '/v', 'ByReg'])) === 1 && status1(() => reg(['query', key, '/v', 'ByReg'])) === 1,
        'a value deleted; "not there" is exit 1, as from reg.exe');
      t.ok(status1(() => eng(['refresh'])) === 0, 'WinINET told of a change (no PowerShell)');
    } finally {
      try { eng(['delete', key, '/f']); } catch {}
    }
    t.ok(status1(() => reg(['query', key])) === 1, 'a key and everything under it deleted');
  } else {
    console.log('  --  the engine against reg.exe itself: on Windows');
  }

  console.log(`win-reg: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
