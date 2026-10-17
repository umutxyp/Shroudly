'use strict';

/* Roblox Studio for real, on Windows x64 CI machines only (it is several
 * hundred MB, and the test changes the machine): Studio's own installer is
 * downloaded through the engine and started with the setting Games and apps
 * mode puts in place, then Studio itself runs for a minute. Everything
 * Roblox's programs connect to must go through Shroudly, Studio's own
 * connections included: the proof that Studio honours the setting, which
 * the autopilot relies on (electron/autopilot.js, main.js watchRoblox). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const { ROOT, startEngine, freePort, sleep, suite } = require('./helpers');

const AppProxy = require(path.join(ROOT, 'electron', 'app-proxy.js'));
const AppEnv = require(path.join(ROOT, 'electron', 'app-env.js'));
const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));
const t = suite('studio');

/* Roblox's web connections (80/443) that do not go to this machine, i.e.
 * that bypass the proxy. */
function robloxDirect() {
  const ps = "$ids = @(Get-Process -Name 'Roblox*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }); " +
    "if ($ids.Count) { Get-NetTCPConnection -OwningProcess $ids -ErrorAction SilentlyContinue | " +
    "Where-Object { ($_.RemotePort -eq 443 -or $_.RemotePort -eq 80) -and $_.RemoteAddress -notmatch '^(127\\.|::1)' } | " +
    "ForEach-Object { \"$($_.OwningProcess) $($_.RemoteAddress):$($_.RemotePort)\" } }";
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000, env: powershellEnv() },
    (err, out) => resolve(String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))));
}

/* The same for Roblox Studio, the editor: its own installer ("Install
 * Roblox Studio") downloaded through the engine and started with the
 * setting, then Studio itself, started by its installer or else as "Open
 * Roblox Studio" starts it. Watched from the download until Studio has run
 * for a minute: everything Roblox's programs connect to must go through
 * Shroudly, Studio's own connections included. */
async function robloxStudio(proxy, socksPort) {
  const RobloxApp = require(path.join(ROOT, 'electron', 'roblox-app.js'));
  const { socksConnect } = require(path.join(ROOT, 'electron', 'discord-relay.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-studio-'));
  const env = { HTTPS_PROXY: proxy.url, NO_PROXY: AppEnv.NO_PROXY_VALUE };
  let studioSince = 0;
  const all = new Set();
  const studioHosts = new Set();
  let studioTunnels = 0;
  proxy.onTunnel = (host) => {
    all.add(host);
    if (studioSince) { studioTunnels++; studioHosts.add(host); }
  };
  const r = await RobloxApp.install({ kind: 'studio', socksPort, connect: socksConnect, dir, env });
  if (!r.success && r.code === 'unreachable') {
    console.log(`  --  Roblox Studio installer not downloadable here (${r.detail}); skipped`);
    proxy.onTunnel = null;
    return;
  }
  t.ok(r.success, `Install Roblox Studio: current installer (${r.version}) downloaded through the engine, signed by Roblox, started (${r.code || 'ok'}${r.detail ? `: ${r.detail}` : ''})`);
  if (!r.success) { proxy.onTunnel = null; return; }
  const direct = new Set();
  const watch = async () => { for (const c of await robloxDirect()) direct.add(c); };
  // The installer fetches Studio (several hundred MB) and normally starts it.
  let until = Date.now() + 8 * 60000;
  let startedBy = 'its installer';
  let installedAt = 0;
  while (Date.now() < until) {
    await sleep(3000);
    await watch();
    if ((await RobloxApp.pids('studio')).length) { studioSince = Date.now(); break; }
    if (RobloxApp.installed('studio') && !installedAt) installedAt = Date.now();
    // Installed, and the installer has ended without starting it.
    const installerRunning = /RobloxStudioInstaller/i.test(String(spawnSync('tasklist', ['/FI', 'IMAGENAME eq RobloxStudioInstaller.exe', '/NH']).stdout || ''));
    if (installedAt && !installerRunning && Date.now() - installedAt > 10000) {
      startedBy = 'Open Roblox Studio';
      t.ok(await RobloxApp.open(env, 'studio'), `Open Roblox Studio starts it (${(await RobloxApp.launcher('studio') || {}).exe})`);
      studioSince = Date.now();
      break;
    }
  }
  console.log(`  ..  Studio installed at ${RobloxApp.installs('win32', 'studio').join(', ') || '(not found)'}; link handled by ${await RobloxApp.handler('studio')}`);
  t.ok(studioSince > 0, `Roblox Studio installed and started (by ${startedBy})`);
  if (studioSince) {
    until = Date.now() + 60000;
    while (Date.now() < until) { await sleep(3000); await watch(); }
  }
  for (const im of ['RobloxStudioBeta.exe', 'RobloxStudioInstaller.exe', 'RobloxCrashHandler.exe']) spawnSync('taskkill', ['/F', '/T', '/IM', im]);
  proxy.onTunnel = null;
  if (direct.size) console.log(`  !!  direct: ${[...direct].slice(0, 12).join(', ')}`);
  console.log(`  ..  through Shroudly: ${[...all].slice(0, 30).join(', ')}`);
  t.ok(direct.size === 0, `Roblox Studio and its installer: nothing around Shroudly (${direct.size})`);
  if (studioSince) t.ok(studioTunnels > 0 && [...studioHosts].some(RobloxApp.isRobloxHost), `Roblox Studio itself connects through Shroudly (${studioTunnels}: ${[...studioHosts].slice(0, 8).join(', ')})`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {
  if (!(process.platform === 'win32' && process.env.CI && process.arch === 'x64')) {
    console.log('studio: Windows x64 CI machines only; skipped');
    return;
  }
  const P = await freePort();
  const eng = await startEngine(P, ['--strategy', 'tlsrec(sni+1)', '--auto', '--doh']);
  const proxy = new AppProxy(() => {}, () => P);
  await proxy.start(await freePort());
  try { await robloxStudio(proxy, P); } finally { proxy.stop(); eng.stop(); }
  console.log(`studio: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
