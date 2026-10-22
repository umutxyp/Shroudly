'use strict';

/* Roblox Studio for real, on Windows x64 CI machines only (it is several
 * hundred MB, and the test changes the machine): Studio's own installer is
 * downloaded through the engine and started with the setting Games and apps
 * mode puts in place, then Studio itself runs for a minute. Everything
 * Roblox's programs connect to must go through Shroudly, Studio's own
 * connections included: the proof that Studio honours the setting, which
 * the autopilot relies on (electron/autopilot.js, main.js watchRoblox).
 *
 * Then issue #30: Studio opened as the website's Edit button opens it, by
 * its roblox-studio: link, from a program that does not have the setting
 * (a browser started before Shroudly), while the session has it. Before the
 * mode takes the link over it goes around Shroudly (the cause, however often
 * it is reopened); after, through it (the fix: electron/link-handlers.js,
 * link-open.js, Shroudly's own program standing in, here Electron from this
 * checkout). Opened from the Start menu (Explorer) it goes through too. The
 * link is exactly as Roblox left it afterwards. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn, execFile } = require('child_process');
const { ROOT, startEngine, freePort, sleep, suite } = require('./helpers');

const AppProxy = require(path.join(ROOT, 'electron', 'app-proxy.js'));
const AppEnv = require(path.join(ROOT, 'electron', 'app-env.js'));
const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));
const t = suite('studio');
const LinkHandlers = require(path.join(ROOT, 'electron', 'link-handlers.js'));

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
    if (((await RobloxApp.pids('studio')) || []).length) { studioSince = Date.now(); break; }
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

/* Issue #30, for real (see the top). Studio is closed between the runs:
 * this is a test machine (Shroudly itself never closes Studio). */
async function studioLinks(proxy) {
  const RobloxApp = require(path.join(ROOT, 'electron', 'roblox-app.js'));
  const studioExe = RobloxApp.installs('win32', 'studio')[0];
  if (!studioExe) { console.log('  --  Roblox Studio is not installed here; its link is not tried'); return; }
  const regExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  if (spawnSync(regExe, ['query', 'HKCU\\Volatile Environment'], { windowsHide: true }).status !== 0) { console.log('  --  SKIPPED: no HKCU\\Volatile Environment in this session'); return; }
  const be = AppEnv.backend('win32');
  if (be.get('HTTPS_PROXY') || be.machine('HTTPS_PROXY') || be.persistent.get('HTTPS_PROXY')) { console.log('  --  SKIPPED: this machine has an HTTPS_PROXY of its own'); return; }
  let electronExe = null;
  try { electronExe = require(path.join(ROOT, 'node_modules', 'electron')); } catch {}
  if (!electronExe || !fs.existsSync(electronExe)) { console.log('  --  SKIPPED: Electron is not installed here'); return; }
  const handler = () => String(spawnSync(regExe, ['query', 'HKCR\\roblox-studio\\shell\\open\\command', '/ve'], { windowsHide: true, encoding: 'utf8' }).stdout || '').trim();
  const handlerBefore = handler();
  console.log(`  ..  roblox-studio: link, before: ${handlerBefore.split(/\r?\n/).pop()}`);
  // A parent without the setting, as a browser that was open before Shroudly.
  const parentEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(https?_proxy|no_proxy|shroudly_app_proxy)$/i.test(k)) parentEnv[k] = v;
  const kill = () => { for (const im of ['RobloxStudioBeta.exe', 'RobloxStudioInstaller.exe', 'RobloxCrashHandler.exe']) spawnSync('taskkill', ['/F', '/T', '/IM', im], { windowsHide: true }); };
  /* Studio started by `how`, watched for a minute once it runs. */
  const run = async (how) => {
    kill();
    await sleep(3000);
    let tunnels = 0; const hosts = new Set(); const direct = new Set();
    proxy.onTunnel = (host) => { tunnels++; hosts.add(host); };
    const t0 = Date.now();
    how();
    let up = 0;
    while (Date.now() - t0 < 90000) {
      await sleep(2000);
      for (const c of await robloxDirect()) direct.add(c);
      if (((await RobloxApp.pids('studio')) || []).length) { up = Date.now() - t0; break; }
    }
    const end = Date.now() + 60000;
    while (Date.now() < end) { await sleep(3000); for (const c of await robloxDirect()) direct.add(c); }
    proxy.onTunnel = null;
    kill();
    return { up, direct, tunnels, hosts };
  };
  const viaLink = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Start-Process 'roblox-studio:1+launchmode:edit'"],
    { windowsHide: true, timeout: 60000, env: powershellEnv(parentEnv) });
  const say = (r) => `${r.up ? `running ${(r.up / 1000).toFixed(0)} s after the click` : 'not seen running'}; through Shroudly ${r.tunnels} (${[...r.hosts].slice(0, 6).join(', ')}), around it ${r.direct.size}${r.direct.size ? ` (${[...r.direct].slice(0, 4).join(', ')})` : ''}`;
  const env = new AppEnv({ links: new LinkHandlers() });
  try {
    t.ok(env.applySync(proxy.url) === 'changed', `Games and apps mode's setting is in this session (${proxy.url})`);
    await new Promise((resolve) => { const p = env.broadcast; if (!p || p.exitCode !== null) { resolve(); return; } const h = setTimeout(resolve, 30000); p.once('exit', () => { clearTimeout(h); resolve(); }); });
    const before = await run(viaLink);
    console.log(`  ..  link, not taken over: ${say(before)}`);
    t.ok(before.up && before.direct.size > 0 && before.tunnels === 0,
      'the cause, on real Windows: Studio opened by its roblox-studio: link from a program without the setting goes around Shroudly, although the session has it');
    const a = await env.links.apply(LinkHandlers.prefixFor(electronExe, ROOT));
    t.ok(a.links.includes('roblox-studio') && /--open-link=roblox-studio/.test(handler()), `the mode takes Roblox's links over (${a.links.join(', ')})`);
    const seen = await RobloxApp.handler('studio');
    t.ok(seen && /RobloxStudioBeta\.exe$/i.test(seen), `Shroudly still finds Studio behind its link (${seen})`);
    const after = await run(viaLink);
    console.log(`  ..  link, taken over: ${say(after)}`);
    t.ok(after.up && after.direct.size === 0 && after.tunnels > 0 && [...after.hosts].some(RobloxApp.isRobloxHost),
      'the fix: the same link from the same program opens Studio through Shroudly, nothing around it');
    console.log(`  ..  roblox-studio: link while taken over, after Studio ran: ${handler().split(/\r?\n/).pop()}`);
    const EXPLORER = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    const start = await run(() => { const p = spawn(EXPLORER, [studioExe], { env: parentEnv, stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); });
    console.log(`  ..  Start menu (Explorer): ${say(start)}`);
    t.ok(start.up && start.direct.size === 0 && start.tunnels > 0, 'opened from the Start menu (Explorer, which got the setting): through Shroudly too');
    env.clearSync();
    t.ok(handler() === handlerBefore, 'mode off: its link exactly as Roblox left it');
  } finally {
    try { env.clearSync(); } catch {}
    proxy.onTunnel = null;
    kill();
  }
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
  try { await robloxStudio(proxy, P); await studioLinks(proxy); } finally { proxy.stop(); eng.stop(); }
  console.log(`studio: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
