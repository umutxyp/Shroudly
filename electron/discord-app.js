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
 * (Discord 1.0.9265 on Windows, watched with file and registry auditing,
 * never wrote the file at all: not at its start, not when its window was
 * maximised, moved, minimised or closed, not when it was killed. Nothing in
 * it reads or writes the system's proxy setting either; its updater only
 * reads a manual ProxyServer.)
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

/* Discord builds that have run on this machine, on any system: each creates
 * its folder on first launch. On macOS the folder may be unreadable until the
 * user allows it, but its existence is still visible. */
function present() {
  return variants().filter((v) => { try { return fs.statSync(v.settingsDir).isDirectory(); } catch { return false; } });
}

/* The same, on the systems where the mode works. */
function installed() {
  // Discord's Linux builds still use the older updater, which never reads
  // NEW_UPDATE_ENDPOINT: the mode would change a file to no effect there.
  if (process.platform !== 'darwin' && process.platform !== 'win32') return [];
  return present();
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
  writeSettings(file, JSON.stringify(obj, null, 2));
  return 'changed';
}

/* Write the settings file as robustly as Windows allows, since several things
 * block the plain write-and-rename there:
 *   - the file carries the read-only attribute (cleared first, and put back if
 *     it was set and the write still fails);
 *   - renaming over a file another process holds open fails with EPERM, where
 *     writing the bytes in place can still go through (so that is the fallback,
 *     and it keeps Discord's own file rather than a new one);
 *   - a file Discord itself has open, or a security product guarding the folder
 *     (Windows' Controlled folder access), refuses every write — that error is
 *     passed up so the caller can say which it is.
 * Atomic where it can be (temp + rename); in place only when rename will not. */
function writeSettings(file, data) {
  let wasReadonly = false;
  try { wasReadonly = (fs.statSync(file).mode & 0o200) === 0; } catch {}
  if (wasReadonly) { try { fs.chmodSync(file, 0o644); } catch {} }
  const tmp = `${file}.shroudly-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data);
    try { fs.renameSync(tmp, file); return; }
    catch (renameErr) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      if (renameErr.code !== 'EPERM' && renameErr.code !== 'EACCES' && renameErr.code !== 'EEXIST') throw renameErr;
      // The target is held open or otherwise un-renamable: write in place.
      fs.writeFileSync(file, data);
    }
  } catch (e) {
    if (wasReadonly) { try { fs.chmodSync(file, 0o444); } catch {} }   // leave it as we found it
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
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

/* "[[dd-]hh:]mm:ss" (ps -o etime): seconds, or null. */
function etimeSeconds(text) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(String(text || ''));
  if (!m) return null;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/* When the oldest process of this build started (ms since 1970), or null
 * when that cannot be told. Windows: the times PowerShell prints, one ISO
 * time per process; macOS: how long each has run (ps -o etime). */
function oldestStart(out, { platform = process.platform, now = Date.now() } = {}) {
  const times = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    if (platform === 'win32') { const t = Date.parse(l); return Number.isNaN(t) ? null : t; }
    const s = etimeSeconds(l);
    return s === null ? null : now - s * 1000;
  }).filter((t) => t !== null);
  return times.length ? Math.min(...times) : null;
}

async function startedAt(v) {
  if (process.platform === 'win32') {
    const { envFor } = require('./win-powershell');
    const name = v.exe.replace(/\.exe$/i, '');
    const out = await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.StartTime.ToUniversalTime().ToString('o') } catch {} }`],
    { windowsHide: true, timeout: 15000, env: envFor('powershell.exe') }, (err, o) => resolve(err ? '' : String(o))));
    return oldestStart(out, { platform: 'win32' });
  }
  const list = await pids(v);
  if (!list.length) return null;
  return oldestStart(await run('ps', ['-o', 'etime=', '-p', list.join(',')]), { platform: process.platform });
}

/* Whether a running Discord has to be started again after its line was
 * put back: only one that may have read its settings while the line was
 * not there, i.e. one started since the line was last seen in place
 * (lineSeenAt; a little earlier, for the time between two looks). A Discord
 * that started before read the line, and goes on using it whatever is
 * written over the file later: restarting it for every rewrite would cut
 * its calls again and again for nothing. When its start cannot be told,
 * it is restarted, as before. */
function readWithoutLine({ startedAt: at, lineSeenAt }) {
  if (at == null || !lineSeenAt) return true;
  return at >= lineSeenAt - 2000;
}

/* A proxy written as a URL or host:port (http://127.0.0.1:1080,
 * socks5://user@[::1]:1080, 127.0.0.1:1080): { host, port }, or null. */
function proxyHostPort(s) {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/\s]+):(\d+)/i.exec(String(s || '').trim());
  return m ? { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) } : null;
}

/* app-1.0.9265 before app-1.0.10000: Discord's version folders, oldest
 * first. */
function byAppVersion(a, b) {
  const n = (d) => (String(d).match(/\d+/g) || []).map(Number);
  const x = n(a); const y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/* Windows: Discord Drover, a version.dll put beside Discord.exe that sends
 * every connection of Discord's to the proxy in its drover.ini, often left
 * from a setup with another tool (ByeDPI, which listens on 127.0.0.1:1080).
 * Read in the build's newest app-* folder only, the one Discord runs:
 * { file, url, host, port } (host and port null when it names none), or
 * null when there is none. */
function drover(v, { root = null, fsx = fs } = {}) {
  if (!v || !v.local) return null;
  const local = root || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base = path.join(local, v.local);
  let dirs = [];
  try { dirs = fsx.readdirSync(base).filter((d) => /^app-\d/i.test(d)); } catch { return null; }
  if (!dirs.length) return null;
  const file = path.join(base, dirs.sort(byAppVersion)[dirs.length - 1], 'drover.ini');
  let text;
  try { text = fsx.readFileSync(file, 'utf8'); } catch { return null; }
  const m = /^[ \t]*proxy[ \t]*=[ \t]*(\S+)/mi.exec(text);
  const p = m ? proxyHostPort(m[1]) : null;
  return { file, url: m ? m[1] : null, host: p ? p.host : null, port: p ? p.port : null };
}

/* Since when a running Discord has to have reached Shroudly for the watch
 * (main.js watchDiscord) to leave it alone, or null when there is nothing to
 * look at: its line was written while it ran (needsRestart, changedAt), or
 * it was open already when this run's relay came up (startCheckAt: at login
 * it often starts first, reads the line while nothing answers it, and sits
 * on "Starting" or "Update Failed" for good), looked at for START_CHECK_MS
 * only: by then it went through Shroudly, or the network does not block
 * Discord and it never had to. */
const START_CHECK_MS = 5 * 60 * 1000;
function watchSince({ needsRestart, changedAt, startCheckAt, now }) {
  if (needsRestart) return changedAt || 0;
  if (startCheckAt && now - startCheckAt <= START_CHECK_MS) return startCheckAt;
  return null;
}

/* Whether any Discord build here is running (Linux included). */
async function anyRunning() {
  for (const v of present()) if (await isRunning(v)) return true;
  return false;
}

/* The log lines for putting our line back into builds' settings (names: the
 * builds whose file had lost it), with counts, a Map the caller keeps for the
 * session. The first time for a build, that it was put back; the second, once,
 * that this build's file keeps losing it; after that nothing. A program that
 * changes Discord can write the file every few minutes; the line goes back
 * within seconds each time, and saying so each time only buries what matters
 * in the log. The line names no writer: in the 2.6.3 reports it was not
 * Discord (a real Discord on Windows, watched with the file and registry
 * audited, never wrote the file: at its start, its window maximised, moved,
 * minimised or closed, or killed), but a second copy of Shroudly opened from
 * its icon, which moved the line to a relay of its own (main.js, "single
 * instance"). */
function healNote(counts, names) {
  const fresh = [];
  const again = [];
  for (const n of names) {
    const c = (counts.get(n) || 0) + 1;
    counts.set(n, c);
    if (c === 1) fresh.push(n);
    else if (c === 2) again.push(n);
  }
  const lines = [];
  if (fresh.length) lines.push(`Discord app mode: ${fresh.join(', ')} added`);
  if (again.length) {
    lines.push(`Discord app mode: ${again.join(', ')} settings lost the line again; it is put back each time, and not logged again this session`);
  }
  return lines;
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
/* `between`: run once Discord is gone and before it starts again (its
 * files are free then). */
async function restart(v, between = null) {
  const gap = async () => { if (between) { try { await between(); } catch {} } };
  if (process.platform === 'darwin') {
    // SIGTERM is a normal quit for Electron apps. (Asking through AppleScript
    // would need a separate "control Discord" permission.)
    await run('pkill', ['-x', v.proc]);
    if (!(await waitGone(v, 8000))) { await run('pkill', ['-9', '-x', v.proc]); await waitGone(v, 3000); }
    await gap();
    return detached('open', ['-a', v.app]);
  }
  if (process.platform === 'win32') {
    await run('taskkill', ['/IM', v.exe, '/T', '/F']);
    await waitGone(v, 5000);
    await gap();
    return fs.existsSync(v.updateExe) ? detached(v.updateExe, ['--processStart', v.exe]) : false;
  }
  if (v.id === 'flatpak') await run('flatpak', ['kill', 'com.discordapp.Discord']);
  else await run('pkill', ['-x', v.proc]);
  await waitGone(v, 5000);
  await gap();
  return detached(v.bin, v.binArgs || []);
}

/* Discord Drover's files set aside: version.dll and drover.ini moved from
 * Discord's folder (beside drover.ini, `d.file`) into `backupDir`; nothing
 * is deleted, so the user can put them back. Discord must not be running
 * (it holds its version.dll). The names moved; throws when one cannot be
 * moved, with any moved before it put back where it was. */
function moveFile(from, to, fsx) {
  try { fsx.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fsx.copyFileSync(from, to);
    fsx.unlinkSync(from);
  }
}
function setDroverAside(d, backupDir, fsx = fs) {
  const dir = path.dirname(d.file);
  const names = ['version.dll', 'drover.ini'].filter((n) => fsx.existsSync(path.join(dir, n)));
  fsx.mkdirSync(backupDir, { recursive: true });
  const moved = [];
  try {
    for (const n of names) { moveFile(path.join(dir, n), path.join(backupDir, n), fsx); moved.push(n); }
  } catch (e) {
    for (const n of moved) { try { moveFile(path.join(backupDir, n), path.join(dir, n), fsx); } catch {} }
    throw e;
  }
  return moved;
}

module.exports = { KEY, endpointUrl, variants, present, installed, settingsFile, patchSync, writeSettings, hasOurs, isRunning, anyRunning, pids, restart, healNote,
  startedAt, oldestStart, etimeSeconds, readWithoutLine, watchSince, START_CHECK_MS, drover, proxyHostPort, byAppVersion, setDroverAside };
