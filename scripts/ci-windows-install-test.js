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

  const r = spawnSync(path.join(dist, setup), ['/S'], { stdio: 'inherit' });
  if (r.status !== 0) fail(`installer exited ${r.status}`);
  const roots = [path.join(process.env.LOCALAPPDATA, 'Programs', 'Shroudly'), path.join(process.env.LOCALAPPDATA, 'Programs', 'shroudly')];
  let dir = null;
  for (let i = 0; i < 60 && !dir; i++) { dir = roots.find((d) => fs.existsSync(path.join(d, 'Shroudly.exe'))); if (!dir) await sleep(1000); }
  if (!dir) fail('Shroudly.exe not found after install');
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

  const raw = fs.readFileSync(settings);
  if (raw[0] === 0xef && raw[1] === 0xbb) fail("Discord's settings.json now starts with a byte-order mark");
  const obj = JSON.parse(raw.toString('utf8'));
  if ('NEW_UPDATE_ENDPOINT' in obj) fail("our line is still in Discord's settings.json");
  if (obj.IS_MAXIMIZED !== true || obj.WINDOW_BOUNDS.width !== 1200) fail("Discord's other settings changed");
  ok("uninstaller removed the Discord app mode line and kept everything else");
  fs.rmSync(discordDir, { recursive: true, force: true });
  console.log(`== Windows ${arch} installer passed`);
})().catch((e) => fail(e.message));
