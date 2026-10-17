'use strict';

/*
 * Points the Discord app's updater at Shroudly's relay (discord-relay.js), and
 * takes it away again.
 *
 * Discord reads its update server from NEW_UPDATE_ENDPOINT in its own
 * settings.json, once, when it starts. Two facts about that file make editing
 * it safe:
 *  - Discord only writes it back if the file is unchanged since Discord read
 *    it (it compares the modification time), so an edit made while Discord is
 *    running is never overwritten. Discord just has to be restarted to use it.
 *  - Only our own value is ever removed: an endpoint the user set themselves
 *    is left alone, and never replaced.
 *
 * The line is there only while Shroudly can answer it: it is taken out when
 * the user quits Shroudly or turns the mode off (and by the Windows
 * uninstaller), so a Discord started without Shroudly goes straight to
 * Discord, exactly as before. It stays across logout and shutdown, so a
 * Discord that starts at login does not race Shroudly for it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const KEY = 'NEW_UPDATE_ENDPOINT';
const OURS = /^http:\/\/127\.0\.0\.1:\d+\/$/;

function endpointUrl(port) { return `http://127.0.0.1:${port}/`; }

// A name safe to put in a pattern (every character with a meaning escaped).
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Every place a Discord build keeps its settings on this OS. */
function variants(platform = process.platform) {
  const home = os.homedir();
  const builds = [
    { id: 'stable', dir: 'discord', app: 'Discord', exe: 'Discord.exe', local: 'Discord', bin: 'discord' },
    { id: 'ptb', dir: 'discordptb', app: 'Discord PTB', exe: 'DiscordPTB.exe', local: 'DiscordPTB', bin: 'discord-ptb' },
    { id: 'canary', dir: 'discordcanary', app: 'Discord Canary', exe: 'DiscordCanary.exe', local: 'DiscordCanary', bin: 'discord-canary' },
    { id: 'development', dir: 'discorddevelopment', app: 'Discord Development', exe: 'DiscordDevelopment.exe', local: 'DiscordDevelopment', bin: 'discord-development' },
  ];
  if (platform === 'darwin') {
    return builds.map((b) => ({ ...b, proc: b.app, settingsDir: path.join(home, 'Library', 'Application Support', b.dir) }));
  }
  if (platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return builds.map((b) => ({ ...b, settingsDir: path.join(roaming, b.dir), updateExe: path.join(local, b.local, 'Update.exe') }));
  }
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    // Linux reports process names cut to 15 characters (DiscordDevelopm).
    ...builds.map((b) => ({ ...b, proc: b.exe.replace(/\.exe$/, '').slice(0, 15), settingsDir: path.join(cfg, b.dir) })),
    { id: 'flatpak', dir: 'discord', app: 'Discord', bin: 'flatpak', binArgs: ['run', 'com.discordapp.Discord'],
      settingsDir: path.join(home, '.var', 'app', 'com.discordapp.Discord', 'config', 'discord') },
    { id: 'snap', dir: 'discord', app: 'Discord', proc: 'Discord', bin: 'snap', binArgs: ['run', 'discord'],
      settingsDir: path.join(home, 'snap', 'discord', 'current', '.config', 'discord') },
  ];
}

function settingsFile(v) { return path.join(v.settingsDir, 'settings.json'); }

/* Discord builds that have run on this machine (each creates its folder on
 * first launch), on the systems where the mode works. On macOS the folder may be unreadable until the user allows
 * it, but its existence is still visible. */
function installed() {
  // Discord's Linux builds still use the older updater, which never reads
  // NEW_UPDATE_ENDPOINT: the mode would change a file to no effect there.
  if (process.platform !== 'darwin' && process.platform !== 'win32') return [];
  return variants().filter((v) => { try { return fs.statSync(v.settingsDir).isDirectory(); } catch { return false; } });
}

function readJson(text, file) {
  if (!text.trim()) return {};
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch {}
  throw Object.assign(new Error(`${file} is not valid JSON`), { code: 'EBADJSON' });
}

/* Set our endpoint (url) or remove it (null). Returns 'changed', 'unchanged'
 * or 'foreign' (the user has their own endpoint there; left alone). Throws on
 * access errors (EPERM / EACCES). Written to a temporary file and renamed, so
 * a crash halfway through cannot leave Discord with half a settings file. */
function patchSync(file, url) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const obj = readJson(text, file);
  const cur = obj[KEY];
  if (cur !== undefined && !OURS.test(String(cur))) return 'foreign';
  if (url ? cur === url : cur === undefined) return 'unchanged';
  if (url) obj[KEY] = url; else delete obj[KEY];
  // Discord writes this file with two-space indentation and no trailing newline.
  const tmp = `${file}.shroudly-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  return 'changed';
}

/* Is our line in this build's settings right now? */
function hasOurs(v) {
  try { return OURS.test(String(readJson(fs.readFileSync(settingsFile(v), 'utf8'), '')[KEY] || '')); } catch { return false; }
}

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? '' : String(out))));
}

async function isRunning(v) {
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', `IMAGENAME eq ${v.exe}`, '/NH', '/FO', 'CSV']);
    return out.toLowerCase().includes(`"${v.exe.toLowerCase()}"`);
  }
  if (v.id === 'flatpak') return (await run('flatpak', ['ps', '--columns=application'])).includes('com.discordapp.Discord');
  return (await run('pgrep', ['-x', v.proc])).trim().length > 0;
}

/* Process ids of this build, helpers included: what the autopilot asks
 * about, to tell a Discord that works through Shroudly from one stuck before
 * its window. Chromium makes every connection from a helper process (its
 * network service): on Windows the helpers share Discord.exe's name; on macOS
 * they are "Discord Helper" processes inside the app bundle, so every process
 * running from the bundle counts. */
async function pids(v) {
  const list = (out) => String(out || '').split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number);
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', `IMAGENAME eq ${v.exe}`, '/NH', '/FO', 'CSV']);
    return [...out.matchAll(new RegExp(`^"${reEscape(v.exe)}","(\\d+)"`, 'gmi'))].map((m) => Number(m[1]));
  }
  if (process.platform === 'darwin') return list(await run('pgrep', ['-f', `/${reEscape(v.app)}\\.app/Contents/`]));
  if (v.id === 'flatpak' || !v.proc) return [];
  return list(await run('pgrep', ['-x', v.proc]));
}

async function waitGone(v, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await isRunning(v))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function detached(cmd, args) {
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch { return false; }
}

/* Quit this Discord build and start it again, so it reads its settings anew. */
async function restart(v) {
  if (process.platform === 'darwin') {
    // SIGTERM is a normal quit for Electron apps. (Asking through AppleScript
    // would need a separate "control Discord" permission.)
    await run('pkill', ['-x', v.proc]);
    if (!(await waitGone(v, 8000))) { await run('pkill', ['-9', '-x', v.proc]); await waitGone(v, 3000); }
    return detached('open', ['-a', v.app]);
  }
  if (process.platform === 'win32') {
    await run('taskkill', ['/IM', v.exe, '/T', '/F']);
    await waitGone(v, 5000);
    return fs.existsSync(v.updateExe) ? detached(v.updateExe, ['--processStart', v.exe]) : false;
  }
  if (v.id === 'flatpak') await run('flatpak', ['kill', 'com.discordapp.Discord']);
  else await run('pkill', ['-x', v.proc]);
  await waitGone(v, 5000);
  return detached(v.bin, v.binArgs || []);
}

module.exports = { KEY, endpointUrl, variants, installed, settingsFile, patchSync, hasOurs, isRunning, pids, restart };
