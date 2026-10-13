'use strict';

/*
 * Where Roblox is on this machine, whether it is running, and how to start it
 * again so that it picks up the session's HTTPS_PROXY (app-env.js).
 *
 * Roblox reads the proxy once, when it starts. A copy that was already open
 * when the mode came on keeps going straight to Roblox until it is restarted.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? '' : String(out))));
}

/* Installed copies, newest first. macOS: the app bundle. Windows: the player
 * in each version folder (Roblox keeps the current one, and sometimes an
 * older one it has not cleaned up yet). */
function installs(platform = process.platform) {
  const exists = (p) => { try { return fs.statSync(p); } catch { return null; } };
  if (platform === 'darwin') {
    return ['/Applications', path.join(os.homedir(), 'Applications')]
      .flatMap((d) => ['Roblox.app', 'RobloxPlayer.app'].map((a) => path.join(d, a)))
      .filter((p) => exists(p));
  }
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const roots = [local, process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
      .filter(Boolean).map((r) => path.join(r, 'Roblox', 'Versions'));
    const found = [];
    for (const root of roots) {
      let dirs = [];
      try { dirs = fs.readdirSync(root); } catch { continue; }
      for (const d of dirs) {
        const exe = path.join(root, d, 'RobloxPlayerBeta.exe');
        const st = exists(exe);
        if (st) found.push({ exe, t: st.mtimeMs });
      }
    }
    return found.sort((a, b) => b.t - a.t).map((f) => f.exe);
  }
  return [];
}

function installed() { return installs().length > 0; }

/* Process ids of the running Roblox player, and of its installer: the
 * installer is the first thing to fail ("Continue installation without flag
 * settings from clientsettingscdn.roblox.com") and is just as deaf to the
 * system proxy. */
async function pids() {
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', 'IMAGENAME eq Roblox*', '/NH', '/FO', 'CSV']);
    return [...out.matchAll(/^"RobloxPlayer(?:Beta|Installer)\.exe","(\d+)"/gmi)].map((m) => Number(m[1]));
  }
  if (process.platform === 'darwin') {
    return (await run('pgrep', ['^(RobloxPlayer|RobloxPlayerInstaller)$'])).split(/\s+/).filter(Boolean).map(Number);
  }
  return [];
}

async function waitGone(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await pids()).length) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function detached(cmd, args, env) {
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env: env || process.env }).unref();
    return true;
  } catch { return false; }
}

/* Quit Roblox and open it again. `env` is what the new copy should get on
 * Windows; on macOS it is started by the system, which already has it. */
async function restart(env) {
  const app = installs()[0];
  if (!app) return false;
  if (process.platform === 'darwin') {
    const re = '^(RobloxPlayer|RobloxPlayerInstaller)$';
    await run('pkill', [re]);
    if (!(await waitGone(8000))) { await run('pkill', ['-9', re]); await waitGone(3000); }
    return detached('open', ['-a', app]);
  }
  if (process.platform === 'win32') {
    await run('taskkill', ['/IM', 'RobloxPlayerBeta.exe', '/IM', 'RobloxPlayerInstaller.exe', '/T', '/F']);
    await waitGone(5000);
    return detached(app, [], { ...process.env, ...env });
  }
  return false;
}

module.exports = { installs, installed, pids, restart };
