'use strict';

/* Installs the built Windows installer the way a user would (silently, per
 * user), checks the app and its engine, then uninstalls it and checks that
 * the uninstaller cleaned up after Discord app mode: our line gone from
 * Discord's settings.json, everything else in it kept, no byte-order mark.
 *   node scripts/ci-windows-install-test.js x64|arm64 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const arch = process.argv[2] || 'x64';
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m) => console.log(`ok  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dist = path.resolve('dist');
  const setup = fs.readdirSync(dist).find((f) => f.endsWith(`-Windows-${arch}-Setup.exe`));
  if (!setup) fail(`no ${arch} installer in dist/ (${fs.readdirSync(dist).join(', ')})`);

  // Discord app mode was on before the user uninstalls.
  const discordDir = path.join(process.env.APPDATA, 'discord');
  fs.mkdirSync(discordDir, { recursive: true });
  const settings = path.join(discordDir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ NEW_UPDATE_ENDPOINT: 'http://127.0.0.1:10809/', IS_MAXIMIZED: true, WINDOW_BOUNDS: { x: 5, y: 6, width: 1200, height: 800 } }, null, 2));

  const t0 = Date.now();
  const r = spawnSync(path.join(dist, setup), ['/S'], { stdio: 'inherit' });
  if (r.status !== 0) fail(`installer exited ${r.status}`);
  ok(`installer returned after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const roots = [path.join(process.env.LOCALAPPDATA, 'Programs', 'Shroudly'), path.join(process.env.LOCALAPPDATA, 'Programs', 'shroudly')];
  let dir = null;
  for (let i = 0; i < 120 && !dir; i++) { dir = roots.find((d) => fs.existsSync(path.join(d, 'Shroudly.exe'))); if (!dir) await sleep(1000); }
  if (!dir) {
    // Where did it go, if anywhere: what the uninstall entries say, and what
    // is in the folders an installer may use.
    const reg = (k) => String(spawnSync('reg', ['query', k, '/s', '/f', 'Shroudly'], { encoding: 'utf8' }).stdout || '').trim();
    const ls = (d) => { try { return fs.readdirSync(d).join(', '); } catch (e) { return e.code; } };
    console.log(`HKCU uninstall:\n${reg('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')}`);
    console.log(`HKLM uninstall:\n${reg('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')}`);
    console.log(`LOCALAPPDATA\\Programs: ${ls(path.join(process.env.LOCALAPPDATA, 'Programs'))}`);
    console.log(`ProgramFiles: ${ls(process.env.ProgramFiles)}`);
    console.log(`Shroudly folders: ${['Shroudly', 'shroudly'].map((n) => [path.join(process.env.LOCALAPPDATA, 'Programs', n), path.join(process.env.ProgramFiles, n)]).flat().map((d) => `${d}=[${ls(d)}]`).join(' ')}`);
    console.log(`processes: ${String(spawnSync('tasklist', ['/FI', 'IMAGENAME eq Shroudly*'], { encoding: 'utf8' }).stdout || '').trim()}`);
    fail('Shroudly.exe not found after install');
  }
  ok(`installed to ${dir}`);

  const engine = path.join(dir, 'resources', 'app.asar.unpacked', 'electron', 'tools', 'core', `win32-${arch}`, 'shroudly-core.exe');
  if (!fs.existsSync(engine)) fail(`engine missing: ${engine}`);
  const ready = await new Promise((resolve) => {
    const p = spawn(engine, ['--listen', '127.0.0.1', '--port', '18765', '--strategy', 'split(sni)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('"ready"')) { p.stdin.end('STOP\n'); resolve(true); } });
    p.on('exit', () => resolve(out.includes('"ready"')));
    setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 10000);
  });
  if (!ready) fail('installed engine did not start');
  ok('installed engine starts');
  if (arch === 'x64') {
    const adv = path.join(path.dirname(engine), 'shroudly-core-adv.exe');
    if (!fs.existsSync(adv)) fail('Advanced mode engine missing');
    for (const f of ['WinDivert.dll', 'WinDivert64.sys']) if (!fs.existsSync(path.join(path.dirname(engine), f))) fail(`${f} missing`);
    ok('Advanced mode engine and WinDivert present');
  }

  const uninst = fs.readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f));
  if (!uninst) fail('no uninstaller');
  spawnSync(path.join(dir, uninst), ['/S'], { stdio: 'inherit' });
  // The uninstaller copies itself away and returns at once; wait for it.
  for (let i = 0; i < 90 && fs.existsSync(path.join(dir, 'Shroudly.exe')); i++) await sleep(1000);
  if (fs.existsSync(path.join(dir, 'Shroudly.exe'))) fail('app still there after uninstall');
  ok('uninstalled');

  // Our clean-up runs last in the uninstaller, after the program files are
  // gone, so give the uninstaller time to finish before judging it.
  for (let i = 0; i < 60; i++) {
    try { if (!('NEW_UPDATE_ENDPOINT' in JSON.parse(fs.readFileSync(settings, 'utf8').replace(/^\uFEFF/, '')))) break; } catch {}
    await sleep(1000);
  }
  const raw = fs.readFileSync(settings);
  if (raw[0] === 0xef && raw[1] === 0xbb) fail("Discord's settings.json now starts with a byte-order mark");
  const obj = JSON.parse(raw.toString('utf8'));
  if ('NEW_UPDATE_ENDPOINT' in obj) fail("our line is still in Discord's settings.json");
  if (obj.IS_MAXIMIZED !== true || obj.WINDOW_BOUNDS.width !== 1200) fail("Discord's other settings changed");
  ok("uninstaller removed the Discord app mode line and kept everything else");
  fs.rmSync(discordDir, { recursive: true, force: true });

  // #57: a copy on another disk while the installer's own records point at
  // the default folder. The update goes where that copy is (/D=, as the
  // updater passes it, electron/updater.js installDirFor), not to the default
  // folder as a second copy.
  {
    const other = fs.existsSync('D:\\') ? 'D:\\ShroudlyElsewhere' : path.join(process.env.SystemDrive || 'C:', 'ShroudlyElsewhere');
    const exe = (d) => fs.existsSync(path.join(d, 'Shroudly.exe'));
    const waitFor = async (cond, s) => { for (let i = 0; i < s && !cond(); i++) await sleep(1000); return cond(); };
    if (spawnSync(path.join(dist, setup), ['/S', `/D=${other}`], { stdio: 'inherit' }).status !== 0) fail(`installer to ${other} failed`);
    if (!(await waitFor(() => exe(other), 120))) fail(`not installed to ${other}`);
    ok(`installed to another folder: ${other}`);
    // The installer's record of where it is installed, pointed at the default folder.
    const q = String(spawnSync('reg', ['query', 'HKCU\\Software', '/s', '/v', 'InstallLocation'], { encoding: 'utf8' }).stdout || '');
    let key = null;
    let cur = null;
    for (const line of q.split(/\r?\n/)) {
      if (/^HKEY_/.test(line)) cur = line.trim();
      else if (/InstallLocation\s+REG_SZ\s+/.test(line) && line.split(/REG_SZ\s+/)[1].trim().toLowerCase() === other.toLowerCase()) key = cur;
    }
    if (!key) fail(`no InstallLocation record pointing at ${other}:\n${q.slice(0, 2000)}`);
    if (spawnSync('reg', ['add', key, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', dir, '/f'], { stdio: 'ignore' }).status !== 0) fail(`could not change ${key}`);
    ok(`the installer's record (${key}) now points at the default folder, not where the copy runs`);
    // The update the way the updater runs it now.
    if (spawnSync(path.join(dist, setup), ['--updated', '/S', `/D=${other}`], { stdio: 'inherit' }).status !== 0) fail('the update failed');
    await waitFor(() => exe(other) && !exe(dir), 60);
    if (exe(other) && !exe(dir)) ok(`the update went to ${other}, where the copy runs; nothing in the default folder`);
    else fail(`after the update: ${other} ${exe(other) ? 'has' : 'lacks'} Shroudly.exe, the default folder ${exe(dir) ? 'has a second copy' : 'is empty'}`);
    const un = fs.readdirSync(other).find((f) => /^Uninstall .*\.exe$/i.test(f));
    if (un) spawnSync(path.join(other, un), ['/S'], { stdio: 'inherit' });
    await waitFor(() => !exe(other), 90);
  }
  console.log(`== Windows ${arch} installer passed`);
})().catch((e) => fail(e.message));
