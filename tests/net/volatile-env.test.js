'use strict';

/* Games and apps mode on Windows writes HTTPS_PROXY to HKCU\Volatile
 * Environment, which Windows empties at logoff and never saves, instead of
 * HKCU\Environment, which survives a kill, a restart and a disk image. What
 * this proves:
 *   - everywhere: with the real Windows code over a registry in memory
 *     (reg.exe and PowerShell stood in for), every write goes to Volatile
 *     Environment, nothing is ever written to HKCU\Environment, an older
 *     version's marked values there are removed (apply, clear, the restore at
 *     login, the installer), the user's own are never touched or replaced,
 *     and the change is announced without storing anything
 *   - on Windows CI, for real: a program started by the running Explorer,
 *     with the environment Explorer rebuilt on our announcement, has our
 *     HTTPS_PROXY after the mode is turned on and no longer has it after it
 *     is turned off, and HKCU\Environment never holds any of it. Skipped,
 *     saying why, where there is no Explorer in this session. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { ROOT, sleep, suite } = require('./helpers');

const t = suite('volatile-env');
const APP_ENV = path.join(ROOT, 'electron', 'app-env.js');
const AppEnv = require(APP_ENV);
const { MARK, NO_PROXY_VALUE, BROADCAST_NAME } = AppEnv;
const VOL = 'HKCU\\Volatile Environment';
const USR = 'HKCU\\Environment';
const MACH = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

/* ── a registry in memory, behind stand-ins for reg.exe and PowerShell ── */
function fakeWindows() {
  const keys = new Map([[VOL, new Map()], [USR, new Map([['Path', '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;']])], [MACH, new Map()]]);
  const log = []; const spawned = [];
  const find = (m, name) => [...m.keys()].find((n) => n.toUpperCase() === name.toUpperCase());
  const exec = (cmd, args) => {
    if (!/^reg(\.exe)?$/i.test(cmd)) throw new Error(`unexpected program ${cmd}`);
    const [op, key] = args;
    log.push([op, key, ...args.slice(2)]);
    const name = args[args.indexOf('/v') + 1];
    if (op === 'query') {
      if (!keys.has(key)) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      const lines = [...keys.get(key)].map(([n, v]) => `    ${n}    REG_SZ    ${v}`);
      return Buffer.from(`\r\n${key.replace(/^HKCU/, 'HKEY_CURRENT_USER')}\r\n${lines.join('\r\n')}\r\n\r\n`);
    }
    if (op === 'add') {
      if (!keys.has(key)) keys.set(key, new Map());  // as reg.exe does: a kept key
      const m = keys.get(key); const old = find(m, name);
      if (old) m.delete(old);
      m.set(name, args[args.indexOf('/d') + 1]);
      return Buffer.from('The operation completed successfully.\r\n');
    }
    if (op === 'delete') {
      const m = keys.get(key); const old = m && find(m, name);
      if (!old) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      m.delete(old);
      return Buffer.from('The operation completed successfully.\r\n');
    }
    throw new Error(`unexpected reg ${op}`);
  };
  const spawn = (cmd, args) => { spawned.push([cmd, ...args]); return { pid: 1, on() {}, once() {}, unref() {} }; };
  return { keys, log, spawned, exec, spawn, val: (key, name) => { const m = keys.get(key); const n = m && find(m, name); return n ? m.get(n) : null; } };
}

/* app-env.js loaded afresh with reg.exe and PowerShell replaced by `w`. */
function loadWith(w) {
  const real = { execFileSync: cp.execFileSync, spawn: cp.spawn };
  cp.execFileSync = (cmd, args) => w.exec(cmd, args);
  cp.spawn = (cmd, args) => w.spawn(cmd, args);
  delete require.cache[APP_ENV];
  try { return require(APP_ENV); } finally {
    Object.assign(cp, real);
    delete require.cache[APP_ENV];   // the next require gets the real one
  }
}

/* ── the NSIS cleanup macro, interpreted over a registry in memory ── */
function runInstallerCleanup(keys) {
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'installer.nsh'), 'utf8').replace(/\r\n/g, '\n');
  const macros = {};
  for (const m of nsh.matchAll(/!macro (\w+)([^\n]*)\n([\s\S]*?)!macroend/g)) macros[m[1]] = { params: m[2].trim().split(/\s+/).filter(Boolean), body: m[3] };
  const v = {}; let broadcasts = 0;
  const run = (name, args = []) => {
    const mac = macros[name];
    let body = mac.body;
    mac.params.forEach((p, i) => { body = body.split(`\${${p}}`).join(args[i]); });
    const stack = [];
    const active = () => stack.every(Boolean);
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith(';')) continue;
      const tok = line.match(/"[^"]*"|\S+/g);
      const val = (x) => (x.startsWith('$') ? (v[x] ?? '') : x.replace(/^"(.*)"$/, '$1'));
      if (tok[0] === '${If}') { stack.push(active() && (tok[2] === '==' ? val(tok[1]) === val(tok[3]) : val(tok[1]) !== val(tok[3]))); continue; }
      if (tok[0] === '${EndIf}') { stack.pop(); continue; }
      if (!active()) continue;
      const key = (x) => `HKCU\\${val(x)}`;
      if (tok[0] === '!insertmacro') run(tok[1], tok.slice(2).map(val));
      else if (tok[0] === 'ReadRegStr' && tok[2] === 'HKCU') v[tok[1]] = (keys.get(key(tok[3])) || new Map()).get(val(tok[4])) || '';
      else if (tok[0] === 'DeleteRegValue' && tok[1] === 'HKCU') { const m = keys.get(key(tok[2])); if (m) m.delete(val(tok[3])); }
      else if (tok[0] === 'StrCpy') v[tok[1]] = val(tok[2]);
      else if (tok[0] === 'SendMessage') broadcasts++;
      else throw new Error(`installer.nsh: not understood here: ${line}`);
    }
  };
  run('shroudlyAppEnvCleanup');
  return broadcasts;
}

/* ── for real: programs started by Explorer ── */
const csv = (line) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
function sessionOf(pid) {
  const out = String(cp.execFileSync('tasklist.exe', ['/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`], { windowsHide: true, timeout: 10000 }));
  const row = out.split(/\r?\n/).map(csv).find((r) => r[1] === String(pid));
  return row ? row[3] : null;
}
function explorersIn(session) {
  const out = String(cp.execFileSync('tasklist.exe', ['/fo', 'csv', '/nh', '/fi', 'IMAGENAME eq explorer.exe'], { windowsHide: true, timeout: 10000 }));
  return out.split(/\r?\n/).map(csv).filter((r) => r.length >= 4 && /^explorer\.exe$/i.test(r[0]) && r[3] === session).map((r) => Number(r[1]));
}
function regRead(key) {
  try { return AppEnv.parseRegQuery(cp.execFileSync('reg.exe', ['query', key], { windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return null; }
}
function regDel(key, name) {
  try { cp.execFileSync('reg.exe', ['delete', key, '/v', name, '/f'], { windowsHide: true, timeout: 10000, stdio: 'ignore' }); } catch {}
}
function regAdd(key, name, data) {
  cp.execFileSync('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
}
/* The announcement's PowerShell, given time to finish (at most 30 s). */
function waitBroadcast(p) {
  return new Promise((resolve) => {
    if (!p || p.exitCode !== null || p.signalCode) { resolve(); return; }
    const timer = setTimeout(resolve, 30000);
    p.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

const PROBE = 'SHROUDLY_VOLENV_LAUNCHER';
async function realWindows() {
  if (process.platform !== 'win32') { console.log('  --  real Windows part skipped: not Windows'); return; }
  if (!process.env.CI) { console.log('  --  real Windows part skipped outside CI (it changes this session and opens console windows)'); return; }
  const session = sessionOf(process.pid);
  const shells = session === null ? [] : explorersIn(session);
  if (!shells.length) {
    console.log(`  --  SKIPPED: explorer.exe is not running in this test's session (session ${session}); nothing here can show what Explorer hands the programs it starts`);
    return;
  }
  if (!regRead(VOL)) { console.log('  --  SKIPPED: this session has no HKCU\\Volatile Environment key (not an interactive logon)'); return; }
  const be = AppEnv.backend('win32');
  if (be.get('HTTPS_PROXY') || be.persistent.get('HTTPS_PROXY') || be.machine('HTTPS_PROXY')) {
    console.log('  --  SKIPPED: this machine already has an HTTPS_PROXY of its own');
    return;
  }
  console.log(`  --  session ${session}, Explorer ${shells.join(', ')}`);

  const url = 'http://127.0.0.1:59321';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-volenv-'));
  const EXPLORER = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  // What explorer.exe is started with: none of the variables under test, and
  // one that only a program started by this explorer.exe itself could have.
  const launchEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(https?_proxy|no_proxy|shroudly_app_proxy)$/i.test(k)) launchEnv[k] = v;
  launchEnv[PROBE] = '1';
  let seq = 0;
  /* "explorer.exe <file>" hands the file to the Explorer already running in
   * this session and exits: that Explorer opens it (cmd.exe for a .cmd) with
   * its own environment. The script writes that environment out. */
  const viaExplorer = async () => {
    const n = ++seq;
    const out = path.join(dir, `env-${n}.txt`);
    const script = path.join(dir, `dump-${n}.cmd`);
    fs.writeFileSync(script, `@echo off\r\nset > "${out}.tmp"\r\nmove /y "${out}.tmp" "${out}" > nul\r\n`);
    const p = cp.spawn(EXPLORER, [script], { env: launchEnv, stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if (fs.existsSync(out)) {
        const env = new Map();
        for (const line of fs.readFileSync(out, 'latin1').split(/\r?\n/)) {
          const i = line.indexOf('=');
          if (i > 0) env.set(line.slice(0, i).toUpperCase(), line.slice(i + 1));
        }
        return env;
      }
      await sleep(150);
    }
    return null;
  };
  /* Programs started through Explorer until one matches (or `ms` is up). */
  const explorerGives = async (pred, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const env = await viaExplorer();
      if (!env) throw new Error('volatile-env: no program started through Explorer within 20 s');
      if (env.has(PROBE)) throw new Error('volatile-env: the program was started by our own explorer.exe, not by the running Explorer, so this cannot show what Explorer hands out');
      if (pred(env) || Date.now() > end) return { env, ok: pred(env) };
      await sleep(1000);
    }
  };
  const keptIsClean = () => {
    const m = regRead(USR) || new Map();
    return !m.has(MARK) && !m.has(BROADCAST_NAME) && m.get('HTTPS_PROXY') !== url && m.get('NO_PROXY') !== NO_PROXY_VALUE;
  };

  let e = null;
  try {
    const before = await explorerGives((env) => !env.has('HTTPS_PROXY') && !env.has(MARK), 30000);
    t.ok(true, 'a program started through Explorer is Explorer\'s child (it does not have the launcher\'s own variable)');
    t.ok(before.ok, 'before: a program Explorer starts has no HTTPS_PROXY');
    t.ok(keptIsClean(), 'before: HKCU\\Environment holds nothing of ours');

    e = new AppEnv({});
    t.ok(e.applySync(url) === 'changed', 'mode on: applied');
    const vol = regRead(VOL) || new Map();
    t.ok(vol.get('HTTPS_PROXY') === url && vol.get(MARK) === url && vol.get('NO_PROXY') === NO_PROXY_VALUE,
      'HTTPS_PROXY, NO_PROXY and the mark are in HKCU\\Volatile Environment');
    const t0 = Date.now();
    await waitBroadcast(e.broadcast);
    console.log(`  --  the announcement took ${Date.now() - t0} ms`);
    t.ok(keptIsClean(), 'HKCU\\Environment never got our values, and the announcement stored nothing there either');
    const on = await explorerGives((env) => env.get('HTTPS_PROXY') === url, 30000);
    t.ok(on.ok, `a program Explorer starts after the change has HTTPS_PROXY=${url} (it had ${on.env.get('HTTPS_PROXY') || 'none'})`);
    t.ok(on.env.get('NO_PROXY') === NO_PROXY_VALUE, '…and our NO_PROXY');

    t.ok(e.clearSync() === 'changed', 'mode off: removed');
    const vol2 = regRead(VOL) || new Map();
    t.ok(!vol2.has('HTTPS_PROXY') && !vol2.has(MARK) && !vol2.has('NO_PROXY'), 'nothing of ours left in HKCU\\Volatile Environment');
    await waitBroadcast(e.broadcast);
    t.ok(keptIsClean(), 'HKCU\\Environment still holds nothing of ours');
    const off = await explorerGives((env) => !env.has('HTTPS_PROXY') && !env.has(MARK), 30000);
    t.ok(off.ok, `a program Explorer starts after the mode is off has no HTTPS_PROXY (it had ${off.env.get('HTTPS_PROXY') || 'none'})`);

    // What 2.5.12 and earlier left in HKCU\Environment, for real.
    const legacy = () => { regAdd(USR, MARK, url); regAdd(USR, 'HTTPS_PROXY', url); regAdd(USR, 'NO_PROXY', NO_PROXY_VALUE); };
    legacy();
    t.ok(AppEnv.recoverSync({}) === true && keptIsClean(), 'an older version\'s values in HKCU\\Environment are removed by the restore');
    legacy();
    e = new AppEnv({});
    t.ok(e.applySync(url) === 'changed' && keptIsClean() && (regRead(VOL) || new Map()).get('HTTPS_PROXY') === url,
      'turning the mode on moves them: gone from HKCU\\Environment, set in Volatile Environment');
    t.ok(e.clearSync() === 'changed', '…and off again');
    await waitBroadcast(e.broadcast);
  } finally {
    // Whatever happened: nothing of ours stays in this session.
    try { new AppEnv({}).clearSync(); } catch {}
    for (const key of [VOL, USR]) {
      const m = regRead(key) || new Map();
      if (m.get(MARK) === url) regDel(key, MARK);
      if (m.get('HTTPS_PROXY') === url) regDel(key, 'HTTPS_PROXY');
      if (m.get('NO_PROXY') === NO_PROXY_VALUE && m.get('HTTPS_PROXY') === url) regDel(key, 'NO_PROXY');
    }
    try { await waitBroadcast(AppEnv.backend('win32').commit(null)); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  const url = 'http://127.0.0.1:10810';
  const writes = (w) => w.log.filter(([op]) => op === 'add');
  const ourUserWrites = (w) => w.log.filter(([op, key]) => key === USR && op !== 'query');
  const broadcasts = (w) => w.spawned.filter((a) => /powershell/i.test(a[0]));
  const legacy = (w) => { const m = w.keys.get(USR); m.set(MARK, url); m.set('HTTPS_PROXY', url); m.set('NO_PROXY', NO_PROXY_VALUE); };

  // ── the Windows code, over a registry in memory ──
  {
    const w = fakeWindows();
    const A = loadWith(w);
    const e = new A({ platform: 'win32' });
    t.ok(e.applySync(url) === 'changed', 'win32: applied');
    t.ok(w.val(VOL, 'HTTPS_PROXY') === url && w.val(VOL, MARK) === url && w.val(VOL, 'NO_PROXY') === NO_PROXY_VALUE,
      'win32: HTTPS_PROXY, NO_PROXY and the mark written to HKCU\\Volatile Environment');
    t.ok(w.val(VOL, 'NODE_USE_ENV_PROXY') === '1' && w.val(VOL, 'SHROUDLY_NODE_PROXY') === '1', 'win32: NODE_USE_ENV_PROXY for Node.js, and its own mark, there too');
    t.ok(writes(w).length === 5 && writes(w).every(([, key]) => key === VOL), `win32: every write goes there, the key passed as one argument (${writes(w).map((x) => x[1]).join(', ')})`);
    t.ok(w.keys.get(USR).size === 1 && !ourUserWrites(w).length, 'win32: HKCU\\Environment is not written');
    t.ok(!w.log.some(([op, key]) => op === 'add' && /RunOnce/.test(key)), 'win32: no login entry (the value cannot outlive the session)');
    const ps = broadcasts(w);
    t.ok(ps.length === 1 && ps[0].join(' ').includes(`[Environment]::SetEnvironmentVariable('${BROADCAST_NAME}', $null, 'User')`),
      'win32: announced by removing a name that is never set (nothing stored), which still broadcasts WM_SETTINGCHANGE');
    t.ok(!ps[0].join(' ').includes(MARK), 'win32: the announcement does not touch the mark');
    t.ok(e.applySync(url) === 'unchanged' && broadcasts(w).length === 1, 'win32: applying again changes nothing');
    t.ok(e.clearSync() === 'changed' && w.keys.get(VOL).size === 0 && broadcasts(w).length === 2, 'win32: cleared, and announced');
    t.ok(w.keys.get(USR).size === 1 && !ourUserWrites(w).length, 'win32: HKCU\\Environment still untouched');
  }
  {
    const w = fakeWindows();
    legacy(w);
    const A = loadWith(w);
    t.ok(new A({ platform: 'win32' }).applySync(url) === 'changed', 'win32 migration: applied over a 2.5.12 leftover');
    t.ok(!w.val(USR, MARK) && !w.val(USR, 'HTTPS_PROXY') && !w.val(USR, 'NO_PROXY') && w.val(USR, 'Path'),
      'win32 migration: our old values gone from HKCU\\Environment, the user\'s Path kept');
    t.ok(w.val(VOL, 'HTTPS_PROXY') === url && w.val(VOL, 'NO_PROXY') === NO_PROXY_VALUE, 'win32 migration: the new ones in Volatile Environment');
  }
  {
    const w = fakeWindows();
    legacy(w);
    const A = loadWith(w);
    t.ok(A.recoverSync({ platform: 'win32' }) === true && w.keys.get(USR).size === 1 && broadcasts(w).length === 1,
      'win32 migration: the restore (at login, at start, by the watchdog) removes a 2.5.12 leftover and announces it');
    t.ok(A.recoverSync({ platform: 'win32' }) === false && broadcasts(w).length === 1, 'win32 migration: nothing left, nothing announced');
  }
  {
    const w = fakeWindows();
    w.keys.get(USR).set('HTTPS_PROXY', 'http://proxy.corp:8080');
    const A = loadWith(w);
    t.ok(new A({ platform: 'win32' }).applySync(url) === 'foreign' && !writes(w).length && w.val(USR, 'HTTPS_PROXY') === 'http://proxy.corp:8080',
      'win32: the user\'s own HTTPS_PROXY in HKCU\\Environment is never replaced, nothing written');
  }
  {
    const w = fakeWindows();
    w.keys.get(MACH).set('HTTPS_PROXY', 'http://proxy.corp:8080');
    const A = loadWith(w);
    t.ok(new A({ platform: 'win32' }).applySync(url) === 'foreign' && !writes(w).length, 'win32: a machine-wide HTTPS_PROXY is never replaced');
  }
  {
    const w = fakeWindows();
    w.keys.get(VOL).set('HTTPS_PROXY', 'http://127.0.0.1:7890');
    const A = loadWith(w);
    t.ok(new A({ platform: 'win32', listening: () => true }).applySync(url) === 'foreign' && !writes(w).length,
      'win32: another local proxy in Volatile Environment, running, is never replaced');
  }
  {
    // One left by a program that has gone (nothing listens there): every
    // program would reach nothing; ours is used while the mode is on, and
    // the user's comes back when it goes off.
    const w = fakeWindows();
    w.keys.get(VOL).set('HTTPS_PROXY', 'http://127.0.0.1:7890');
    const A = loadWith(w);
    const a = new A({ platform: 'win32', listening: (port) => (port === 7890 ? false : null) });
    t.ok(a.applySync(url) === 'changed' && w.val(VOL, 'HTTPS_PROXY') === url,
      'win32: another local proxy in Volatile Environment where nothing runs: ours in its place');
    a.clearSync();
    t.ok(w.val(VOL, 'HTTPS_PROXY') === 'http://127.0.0.1:7890', 'win32: off again, the one that was there is put back');
  }
  {
    const w = fakeWindows();
    w.keys.delete(VOL);
    const A = loadWith(w);
    let err = null;
    try { new A({ platform: 'win32' }).applySync(url); } catch (x) { err = x; }
    t.ok(err && err.code === 'ENOTSUP' && !w.keys.has(VOL) && !writes(w).length,
      'win32: a session without Volatile Environment is refused; the key is not created (reg.exe would make a kept one)');
  }
  {
    // A user who set HTTPS_PROXY after an older Shroudly did: its mark goes, their value stays.
    const w = fakeWindows();
    legacy(w);
    w.keys.get(USR).set('HTTPS_PROXY', 'http://user.choice:3128');
    const A = loadWith(w);
    t.ok(new A({ platform: 'win32' }).applySync(url) === 'foreign' && w.val(USR, 'HTTPS_PROXY') === 'http://user.choice:3128' && !w.val(USR, MARK) && !writes(w).length,
      'win32 migration: an old mark beside the user\'s own proxy: only the mark removed, theirs kept and not replaced');
    t.ok(broadcasts(w).length === 1, 'win32 migration: …and the removal announced');
  }
  {
    const w = fakeWindows();
    w.keys.get(USR).set('NO_PROXY', 'intranet.corp');
    const A = loadWith(w);
    const e = new A({ platform: 'win32' });
    t.ok(e.applySync(url) === 'changed' && !w.val(VOL, 'NO_PROXY') && w.val(USR, 'NO_PROXY') === 'intranet.corp',
      'win32: the user\'s own NO_PROXY in HKCU\\Environment is kept, and not shadowed by ours');
    e.clearSync();
    t.ok(w.val(USR, 'NO_PROXY') === 'intranet.corp', 'win32: …and still there after removal');
  }

  // ── the same rules over any backend (opts.backend) ──
  {
    const store = (o = {}) => { const m = new Map(Object.entries(o)); return { m, get: (k) => m.get(k) || null, del: (k) => { m.delete(k); } }; };
    const fake = (persistent) => {
      const env = new Map(); let commits = 0;
      return { env, get commits() { return commits; }, persistent,
        names: { proxy: ['HTTPS_PROXY'], noProxy: ['NO_PROXY'] },
        get: (k) => env.get(k) || null, set: (k, v) => { env.set(k, v); }, del: (k) => { env.delete(k); },
        machine: () => null, commit: () => { commits++; } };
    };
    let p = store({ [MARK]: url, HTTPS_PROXY: url, NO_PROXY: NO_PROXY_VALUE, PATH: 'x' });
    let b = fake(p);
    t.ok(new AppEnv({ backend: b }).clearSync() === 'changed' && p.m.size === 1 && b.commits === 1, 'backend: clear removes leftovers from the kept environment');
    p = store({ [MARK]: url, HTTPS_PROXY: url });
    b = fake(p);
    b.set(MARK, url); b.set('HTTPS_PROXY', url);
    t.ok(new AppEnv({ backend: b }).applySync(url) === 'unchanged' && p.m.size === 0 && b.commits === 1, 'backend: already on, the leftover still goes, and the change is announced');
    p = store({ HTTPS_PROXY: url });   // no mark: not provably ours
    b = fake(p);
    t.ok(new AppEnv({ backend: b }).applySync(url) === 'foreign' && p.m.get('HTTPS_PROXY') === url && b.commits === 0, 'backend: an unmarked value is the user\'s, even if it looks like ours');
  }

  // ── the installer (scripts/installer.nsh) ──
  {
    const keys = new Map([['HKCU\\Environment', new Map([[MARK, url], ['HTTPS_PROXY', url], ['NO_PROXY', NO_PROXY_VALUE], ['Path', 'x']])],
      ['HKCU\\Volatile Environment', new Map([[MARK, url], ['HTTPS_PROXY', url], ['NO_PROXY', NO_PROXY_VALUE], ['USERNAME', 'u']])]]);
    const n = runInstallerCleanup(keys);
    t.ok(keys.get('HKCU\\Environment').size === 1 && keys.get('HKCU\\Volatile Environment').size === 1 && n === 1,
      'installer: ours removed from both HKCU\\Environment and Volatile Environment, one announcement');
    const own = new Map([['HKCU\\Environment', new Map([['HTTPS_PROXY', 'http://proxy.corp:8080']])], ['HKCU\\Volatile Environment', new Map()]]);
    t.ok(runInstallerCleanup(own) === 0 && own.get('HKCU\\Environment').get('HTTPS_PROXY') === 'http://proxy.corp:8080', 'installer: the user\'s own proxy left alone, nothing announced');
    const mixed = new Map([['HKCU\\Environment', new Map()], ['HKCU\\Volatile Environment', new Map([[MARK, url], ['HTTPS_PROXY', 'http://user.choice:3128'], ['NO_PROXY', NO_PROXY_VALUE]])]]);
    runInstallerCleanup(mixed);
    const mv = mixed.get('HKCU\\Volatile Environment');
    t.ok(!mv.has(MARK) && mv.get('HTTPS_PROXY') === 'http://user.choice:3128' && mv.get('NO_PROXY') === NO_PROXY_VALUE, 'installer: a proxy the user put in after us stays');
  }

  await realWindows();
  console.log(`volatile-env: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
