'use strict';

/*
 * Where Roblox is on this machine, whether it is running, and how to start,
 * restart or install it so that it goes through Shroudly. Roblox makes two
 * programs, each with its own installer: the player games run in, and Studio,
 * the editor games are made in. Both read the setting the same way.
 *
 * Roblox ignores the system proxy and reads HTTPS_PROXY (app-env.js) once,
 * when it starts, from whoever started it. On Windows that is the catch: the
 * website's Play button and a download opened from the browser's download bar
 * are started by the browser, with the environment the browser itself got
 * when it started, which is usually before Shroudly set anything. So Shroudly
 * also starts Roblox, and its installer, itself, with the setting in place.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { envFor } = require('./win-powershell');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 10000, ...opts, env: envFor(cmd, opts.env) }, (err, out) => resolve(err ? '' : String(out))));
}

const exists = (p) => { try { return fs.statSync(p); } catch { return null; } };
// A program's name as it appears in tasklist's CSV, safe to put in a pattern.
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const csvPids = (out, exe) => [...String(out || '').matchAll(new RegExp(`^"${reEscape(exe)}","(\\d+)"`, 'gmi'))].map((m) => Number(m[1]));
const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/* Bootstrappers people use instead of Roblox's own launcher (Bloxstrap and
 * its many forks): each keeps its own copy of the player in a Versions folder
 * of its own and starts it itself, so it is them that have to be started with
 * the setting. They are recognised by that layout, not by name, so a new fork
 * needs nothing here. These two are only the names known so far. */
const BOOTSTRAPPERS = ['Bloxstrap', 'Fishstrap'];

/* The two programs: what each is called on disk and in the process list,
 * the version Roblox's servers name as current for its installer, and the
 * link the website starts it with. */
const KINDS = {
  player: { exe: 'RobloxPlayerBeta.exe', apps: ['Roblox.app', 'RobloxPlayer.app'], mac: 'RobloxPlayer', channel: 'WindowsPlayer', installer: 'RobloxPlayerInstaller.exe', link: 'roblox-player' },
  studio: { exe: 'RobloxStudioBeta.exe', apps: ['RobloxStudio.app'], mac: 'RobloxStudio', channel: 'WindowsStudio64', installer: 'RobloxStudioInstaller.exe', link: 'roblox-studio' },
};
const kindOf = (k) => KINDS[k] || KINDS.player;

/* Installed copies, newest first. macOS: the app bundle. Windows: the
 * program in each version folder, Roblox's own and the bootstrappers'
 * (Roblox keeps the current one, and sometimes an older one it has not
 * cleaned up yet). */
function installs(platform = process.platform, kind = 'player') {
  const k = kindOf(kind);
  if (platform === 'darwin') {
    return ['/Applications', path.join(os.homedir(), 'Applications')]
      .flatMap((d) => k.apps.map((a) => path.join(d, a)))
      .filter((p) => exists(p));
  }
  if (platform === 'win32') {
    const local = localAppData();
    // Roblox's own folder, and every other folder of LOCALAPPDATA with a
    // Versions folder inside: a bootstrapper's (whatever its name).
    let others = [];
    try { others = fs.readdirSync(local).filter((d) => d.toLowerCase() !== 'roblox'); } catch {}
    const roots = [local, process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
      .filter(Boolean).map((r) => path.join(r, 'Roblox', 'Versions'))
      .concat(others.map((b) => path.join(local, b, 'Versions')));
    const found = [];
    for (const root of roots) {
      let dirs = [];
      try { dirs = fs.readdirSync(root); } catch { continue; }
      for (const d of dirs) {
        const exe = path.join(root, d, k.exe);
        const st = exists(exe);
        if (st) found.push({ exe, t: st.mtimeMs });
      }
    }
    return found.sort((a, b) => b.t - a.t).map((f) => f.exe);
  }
  return [];
}

function installed(kind = 'player') { return installs(process.platform, kind).length > 0; }

/* The program Windows runs for the website's link (Play, or Edit for
 * Studio): Roblox's own, or a bootstrapper that took the link over. Asked of
 * the merged view (HKCR): the user's own entry first, else the machine's
 * (Roblox installed for every user of the computer). */
async function handler(kind = 'player') {
  if (process.platform !== 'win32') return null;
  const out = await run('reg', ['query', `HKCR\\${kindOf(kind).link}\\shell\\open\\command`, '/ve']);
  const m = /REG_(?:EXPAND_)?SZ\s+(?:"([^"]+\.exe)"|(\S+\.exe))/i.exec(out);
  const exe = m ? (m[1] || m[2]) : null;
  return exe && exists(exe) ? exe : null;
}

/* A program that handles Roblox's links in place of Roblox's own: a
 * bootstrapper, known by name or by the Versions folder beside it. */
function isBootstrapper(exe) {
  if (!exe) return false;
  // A Windows path, whichever system reads it (the tests).
  const base = path.win32.basename(exe).toLowerCase();
  if (Object.values(KINDS).some((k) => k.exe.toLowerCase() === base)) return false;
  return BOOTSTRAPPERS.some((b) => base === `${b.toLowerCase()}.exe`) || !!exists(path.join(path.win32.dirname(exe), 'Versions'));
}

/* What to start to open Roblox: the bootstrapper if one handles Roblox's
 * links (it starts the player itself), else the newest player. For Studio,
 * the newest Studio itself (it updates itself when it starts). */
async function launcher(kind = 'player') {
  const k = kindOf(kind);
  if (process.platform === 'darwin') { const app = installs('darwin', kind)[0]; return app ? { exe: 'open', args: ['-a', app] } : null; }
  if (process.platform !== 'win32') return null;
  const h = await handler(kind);
  if (kind === 'player' && isBootstrapper(h)) return { exe: h, args: ['-player'] };
  const own = installs('win32', kind)[0] || (h && path.basename(h).toLowerCase() === k.exe.toLowerCase() ? h : null);
  return own ? { exe: own, args: [] } : null;
}

/* The Microsoft Store edition runs inside an app container, which cannot
 * reach Shroudly on this computer at all. Asked only when the window shows
 * the Games and apps section: it starts PowerShell. */
async function storeEdition() {
  if (process.platform !== 'win32') return false;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'if (Get-AppxPackage -Name ROBLOXCORPORATION.ROBLOX -ErrorAction SilentlyContinue) { "yes" }'], { timeout: 15000 });
  return /yes/.test(out);
}

/* Process ids of Roblox's player (the program a game runs in) or of Studio:
 * the programs whose route is watched and the ones an update waits for. The
 * player's name is the same for Roblox's own copy and the bootstrappers'
 * (they start the same RobloxPlayerBeta.exe). Nothing else whose name starts
 * with "Roblox" counts: not the crash handler that runs beside them, not the
 * installers, not other people's tools (account managers, FPS unlockers). */
function parsePids(out, platform = process.platform, kind = 'player') {
  if (platform === 'win32') return csvPids(out, kindOf(kind).exe);
  return String(out || '').split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number);
}

/* null when the process list could not be read (tasklist always prints
 * something, even "no tasks"): the caller then changes nothing, rather than
 * taking every process for gone. */
async function pids(kind = 'player') {
  const k = kindOf(kind);
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', `IMAGENAME eq ${k.exe}`, '/NH', '/FO', 'CSV']);
    return out ? parsePids(out, 'win32', kind) : null;
  }
  if (process.platform === 'darwin') return parsePids(await run('pgrep', ['-x', k.mac]), 'darwin', kind);
  return [];
}

/* Windows: process ids of Roblox's installers (the player's and Studio's),
 * by kind. An installer started from the browser's download bar gets the
 * browser's older environment and goes around Shroudly; it is safe to start
 * again, since it keeps nothing of its own. */
function parseInstallerPids(out) {
  const found = { player: [], studio: [] };
  for (const [kind, k] of Object.entries(KINDS)) found[kind] = csvPids(out, k.installer);
  return found;
}
async function installerPids() {
  if (process.platform !== 'win32') return { player: [], studio: [] };
  const out = await run('tasklist', ['/FI', 'IMAGENAME eq Roblox*', '/NH', '/FO', 'CSV']);
  return out ? parseInstallerPids(out) : null;
}

/* All of Roblox's programs on one look: players, Studios and both
 * installers. Windows asks the process list once for every name that starts
 * with "Roblox" (one tasklist, however often it is looked at); macOS has no
 * installers to look for. null when the list could not be read. */
function parseProcesses(out, platform = process.platform) {
  if (platform !== 'win32') return { players: [], studios: [], installers: { player: [], studio: [] } };
  return { players: parsePids(out, 'win32', 'player'), studios: parsePids(out, 'win32', 'studio'), installers: parseInstallerPids(out) };
}
async function processes() {
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', 'IMAGENAME eq Roblox*', '/NH', '/FO', 'CSV']);
    return out ? parseProcesses(out, 'win32') : null;
  }
  if (process.platform === 'darwin') {
    const [players, studios] = await Promise.all([pids('player'), pids('studio')]);
    return { players: players || [], studios: studios || [], installers: { player: [], studio: [] } };
  }
  return { players: [], studios: [], installers: { player: [], studio: [] } };
}

/* Windows: when each of these processes started (ms since 1970, by the
 * system's clock) and the program file it runs, both asked in one
 * PowerShell call for every new process at once. Its start time tells
 * whether it can have the setting at all; its file is what an installer is
 * started again from (it goes with the process, so it is read as soon as
 * the process is seen). Resolves pid -> { startedAt, path }, each null when
 * it could not be read (a process of another user, one already gone). */
const FILETIME_EPOCH_MS = 11644473600000;
function parseProcessInfo(out) {
  const found = new Map();
  for (const line of String(out || '').split(/\r?\n/)) {
    const [id, t, ...rest] = line.trim().split('|');
    if (!/^\d+$/.test(id || '')) continue;
    const startedAt = /^\d{15,19}$/.test(t || '') ? Math.round(Number(t) / 1e4 - FILETIME_EPOCH_MS) : null;
    const file = rest.join('|').trim();
    found.set(Number(id), { startedAt, path: /^[a-z]:\\|^\\\\/i.test(file) ? file : null });
  }
  return found;
}
function processInfo(list) {
  const ids = (list || []).filter((p) => Number.isInteger(p) && p > 0);
  if (process.platform !== 'win32' || !ids.length) return Promise.resolve(new Map());
  const env = { ...process.env, SHROUDLY_PIDS: ids.join(',') };
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "foreach ($id in ($env:SHROUDLY_PIDS -split ',')) { $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue; if (-not $p) { continue }; " +
    "$t = ''; try { $t = $p.StartTime.ToFileTime() } catch {}; $f = ''; try { $f = $p.Path } catch {}; \"$id|$t|$f\" }"],
  { windowsHide: true, timeout: 20000, env: envFor('powershell.exe', env) }, (err, out) => resolve(parseProcessInfo(out))));
}

/* What to do about Roblox's programs on one look (roblox-watch.js), as a
 * pure decision. A process counts as going around Shroudly when it is quiet
 * (roblox-watch.js judge) or was open before the mode came on, and has not
 * been dealt with yet. Installers and players are started again through
 * Shroudly (only those, never the others: another player may be in a game
 * through Shroudly); Studio is only ever told about. A player is restarted at
 * most twice in ten minutes, then left to Advanced mode. */
function decide({ players, studios, installers, quiet, before, handled, restarts, now }) {
  const around = (list) => list.filter((pid) => (quiet.includes(pid) || before.includes(pid)) && !handled.includes(pid));
  const recent = (restarts || []).filter((t) => now - t <= 10 * 60 * 1000);
  const p = around(players);
  return {
    installers: { player: around(installers.player), studio: around(installers.studio) },
    restartPlayers: recent.length < 2 ? p : [],
    stuckPlayers: recent.length < 2 ? [] : p,
    tellStudios: around(studios),
  };
}

/* Stop these processes outright (an installer, a player that never got
 * through): nothing in them is the user's. */
async function kill(list) {
  const live = alive(list);
  if (!live.length) return true;
  if (process.platform === 'win32') await run('taskkill', [...live.flatMap((p) => ['/PID', String(p)]), '/T', '/F']);
  else for (const p of live) { try { process.kill(p, 'SIGKILL'); } catch {} }
  return waitGone(live, 5000);
}

/* A player going around Shroudly is only possible on Windows, where a
 * browser that was open before the setting hands what it starts its own
 * older environment. macOS gives every app the session's setting, browsers
 * included. */
function routeWatched(platform = process.platform) { return platform === 'win32'; }

/* Which of these processes still run: asked of the system directly, without
 * starting a program to list them. */
function alive(list) {
  return (list || []).filter((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
}

async function waitGone(list, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(list).length) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/* Start a program on its own. Its process id (what Shroudly started itself
 * is never taken for something going around it), true if the system gave
 * none, false if it could not be started. */
function detached(cmd, args, env) {
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env: env || process.env });
    c.on('error', () => {});
    c.unref();
    return c.pid || true;
  } catch { return false; }
}

/* Start Roblox (or Studio). `env` is what it should get on Windows; on
 * macOS it is started by the system, whose environment already has the
 * setting. */
async function open(env, kind = 'player') {
  const l = await launcher(kind);
  if (!l) return false;
  return detached(l.exe, l.args, process.platform === 'win32' ? { ...process.env, ...env } : process.env);
}

/* Quit these players and open Roblox again, through Shroudly. Only the
 * ones given: another player may be in a game through Shroudly. Never
 * Studio: it may hold work that is not saved, so it is only ever closed by
 * the user. */
async function restart(env, list) {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
  // Asked again right before: a pid seen a while ago may have ended and been
  // given to another program since.
  const now = await pids();
  if (!now) return false;
  const these = alive((list || []).filter((p) => now.includes(p)));
  if (!these.length) return false;
  if (process.platform === 'darwin') {
    for (const p of these) { try { process.kill(p, 'SIGTERM'); } catch {} }
    if (!(await waitGone(these, 8000))) { for (const p of alive(these)) { try { process.kill(p, 'SIGKILL'); } catch {} } await waitGone(these, 3000); }
  } else {
    if (these.length) await run('taskkill', [...these.flatMap((p) => ['/PID', String(p)]), '/T', '/F']);
    await waitGone(these, 5000);
  }
  return open(env);
}

/* ── installing (Windows) ────────────────────────────────────────────────── */
/* The same two requests Roblox's own website makes: which version is current,
 * then that version's installer. Fetched through the engine (Roblox's servers
 * are what is filtered), checked to be signed by Roblox, then started with the
 * setting, so the installer and the program it installs go through Shroudly. */
const versionUrl = (kind) => `https://clientsettingscdn.roblox.com/v2/client-version/${kindOf(kind).channel}`;
const ALLOWED_HOSTS = /(^|\.)(roblox\.com|rbxcdn\.com)$/i;
const MAX_BYTES = 128 * 1024 * 1024;

/* GET url, through the engine at socksPort when given. Follows a few
 * redirects within Roblox's own hosts. Resolves { status, body } or, with
 * toFile, writes the body there; resolved once the file is closed (Windows
 * will not check or rename a file that is still open). A download that fails
 * (cut off, too large, too slow) closes its file and removes it before the
 * error comes back, so nothing is left open or half-written. */
function get(url, { socksPort, connect, toFile, timeoutMs = 60000, redirects = 3, tlsOptions, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname)) { reject(new Error(`refused ${u.hostname}`)); return; }
    const timer = setTimeout(() => fail(new Error('timed out')), timeoutMs);
    let req = null;
    let out = null;
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { req && req.destroy(); } catch {}
      if (!out) { reject(e); return; }
      const gone = () => fs.rm(toFile, { force: true }, () => reject(e));
      if (out.closed) gone(); else { out.once('close', gone); out.destroy(); }
    };
    const ok = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const start = (sock) => {
      req = https.request({
        host: u.hostname, path: `${u.pathname}${u.search}`, method: 'GET',
        port: 443,
        // Spelled out: with a connection of our own Node would otherwise
        // write "host:80" into the request.
        headers: { host: u.hostname, 'user-agent': 'Shroudly', accept: '*/*' },
        // createConnection is only used when no agent is: the request then
        // runs on the engine's connection rather than a direct one.
        ...(sock ? { createConnection: () => tls.connect({ socket: sock, servername: u.hostname, ...(tlsOptions || {}) }) } : {}),
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          clearTimeout(timer); done = true;
          get(new URL(res.headers.location, u).toString(), { socksPort, connect, toFile, timeoutMs, redirects: redirects - 1, tlsOptions, maxBytes }).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); fail(new Error(`HTTP ${res.statusCode}`)); return; }
        let got = 0;
        if (toFile) {
          out = fs.createWriteStream(toFile, { mode: 0o600 });
          res.on('data', (d) => { got += d.length; if (got > maxBytes) fail(new Error('too large')); });
          res.on('error', fail);
          res.on('close', () => { if (!res.complete) fail(new Error('cut off')); });
          out.on('error', fail);
          out.on('finish', () => out.once('close', () => ok({ status: 200, bytes: got })));
          res.pipe(out);
          return;
        }
        const parts = [];
        res.on('data', (d) => { got += d.length; if (got > 1024 * 1024) fail(new Error('too large')); else parts.push(d); });
        res.on('end', () => ok({ status: 200, body: Buffer.concat(parts).toString('utf8') }));
        res.on('error', fail);
      });
      req.on('error', fail);
      req.end();
    };
    if (socksPort && connect) connect(socksPort, u.hostname, 443).then(start, fail);
    else start(null);
  });
}

/* The file's signature as Windows judges it: "Status|signer|message", or
 * what went wrong asking. Checking the certificate's revocation online can
 * take a while on a slow machine or network: up to two minutes. That is why
 * a file found signed is remembered by its content (signedInstaller), and
 * why the check starts as soon as an installer is seen, long before it is
 * known whether it has to be started again. */
function signatureOf(file) {
  if (process.platform !== 'win32') return Promise.resolve('');
  const env = { ...process.env, SHROUDLY_FILE: file };
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$s = Get-AuthenticodeSignature -LiteralPath $env:SHROUDLY_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)|$($s.StatusMessage)"'],
  { windowsHide: true, timeout: 120000, env: envFor('powershell.exe', env) }, (err, out, errOut) => {
    const text = String(out || '').trim();
    resolve(text || (err ? `no answer: ${err.killed ? 'timed out' : String(errOut || err.message).trim().split(/\r?\n/)[0]}` : ''));
  }));
}
const byRoblox = (sig) => {
  const [status, subject] = String(sig || '').split('|');
  return status === 'Valid' && /(^|,\s*)O="?Roblox Corporation"?(,|$)/i.test(subject || '');
};

/* Is the file signed, validly, by Roblox Corporation? Never start a
 * downloaded program on anything less. */
async function signedByRoblox(file) { return byRoblox(await signatureOf(file)); }

/* The SHA-256 of a file's whole content, or null when it cannot be read. */
function fileHash(file) {
  return new Promise((resolve) => {
    let s;
    try { s = fs.createReadStream(file); } catch { resolve(null); return; }
    const h = crypto.createHash('sha256');
    s.on('error', () => resolve(null));
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/* Installers already found signed by Roblox, by the SHA-256 of their whole
 * content: the same file again (a shared machine's script starts the same
 * copy from its game disk every time) needs no second check, which may have
 * to ask about revocation online. `keep` saves the list (Shroudly's
 * settings), so it outlives a restart. A file with any other content is
 * checked again, whatever its name, size or date. */
const HASH = /^[0-9a-f]{64}$/;
function signedCache(saved = [], keep = () => {}) {
  let list = (Array.isArray(saved) ? saved : []).filter((h) => HASH.test(h)).slice(0, 16);
  return {
    has: (h) => list.includes(h),
    add: (h) => {
      if (!HASH.test(h)) return;
      list = [h, ...list.filter((x) => x !== h)].slice(0, 16);
      try { keep(list); } catch {}
    },
  };
}

/* Is `file` Roblox's installer of this kind, validly signed by Roblox? Its
 * content's SHA-256 when it is (sameFile checks that again right before it is
 * started), else null: not found, renamed, not Roblox's, not signed, or
 * changed while it was being checked. Started again from that file, an
 * installer caught going around Shroudly needs no download: the common case
 * on shared machines, where a script or a launcher starts it from a game disk
 * before Shroudly has set anything. Nothing is ever started on less. */
async function signedInstaller(file, kind = 'player', { cache = null, signature = signatureOf } = {}) {
  if (!file || path.win32.basename(file).toLowerCase() !== kindOf(kind).installer.toLowerCase()) return null;
  const before = await fileHash(file);
  if (!before) return null;
  if (cache && cache.has(before)) return before;
  if (!byRoblox(await signature(file))) return null;
  // What was checked is what is remembered.
  const after = await fileHash(file);
  if (after !== before) return null;
  if (cache) cache.add(after);
  return after;
}

/* Still the very content that was found signed? */
async function sameFile(file, hash) { return !!hash && (await fileHash(file)) === hash; }

/* Start an installer file again, with `env`: its process id (detached). */
function startInstaller(file, env) {
  if (process.platform !== 'win32' || !file) return false;
  return detached(file, [], { ...process.env, ...env });
}

/* Each download gets a folder of its own, so a second one never has to
 * replace an installer that is still running (Windows refuses). What earlier
 * ones left (an installer that has done its work, a download cut short) is
 * removed at the next download and when Shroudly starts; anything still in
 * use is left for the next time. */
function cleanDownloads(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch {} }
}

function newDownload(dir, kind = 'player') {
  fs.mkdirSync(dir, { recursive: true });
  cleanDownloads(dir);
  const own = fs.mkdtempSync(path.join(dir, 'dl-'));
  const file = path.join(own, kindOf(kind).installer);
  return { dir: own, file, part: `${file}.part` };
}

/* Download the current installer of the player (opts.kind 'player', the
 * default) or of Studio ('studio') and start it with `env`.
 * opts: { kind, socksPort, connect, env, dir, cache (signedCache) }.
 * Resolves { success, version, pid, file } or { success: false, code }. */
async function install(opts) {
  if (process.platform !== 'win32') return { success: false, code: 'unsupported' };
  const kind = KINDS[opts.kind] ? opts.kind : 'player';
  let version;
  try {
    const r = await get(versionUrl(kind), { socksPort: opts.socksPort, connect: opts.connect, timeoutMs: 20000 });
    version = JSON.parse(r.body).clientVersionUpload;
  } catch (e) { return { success: false, code: 'unreachable', detail: e.message }; }
  if (!/^version-[0-9a-f]{8,32}$/i.test(String(version || ''))) return { success: false, code: 'unreachable', detail: 'unexpected version' };
  let dl;
  try { dl = newDownload(opts.dir, kind); } catch (e) { return { success: false, code: 'failed', detail: e.message }; }
  const drop = () => { try { fs.rmSync(dl.dir, { recursive: true, force: true }); } catch {} };
  try {
    await get(`https://setup.rbxcdn.com/${version}-${kindOf(kind).installer}`, { socksPort: opts.socksPort, connect: opts.connect, toFile: dl.part, timeoutMs: 180000 });
  } catch (e) { drop(); return { success: false, code: 'unreachable', detail: e.message }; }
  // Checked under its own name, in its own folder: Windows tells what kind
  // of file it is judging partly by the extension, and nothing starts it
  // until the signature has been checked.
  try { fs.renameSync(dl.part, dl.file); } catch (e) { drop(); return { success: false, code: 'failed', detail: e.message }; }
  let sig = '';
  const hash = await signedInstaller(dl.file, kind, { cache: opts.cache, signature: async (f) => { sig = await signatureOf(f); return sig; } });
  if (!hash) { drop(); return { success: false, code: 'unsigned', detail: sig || 'no answer' }; }
  const pid = detached(dl.file, [], { ...process.env, ...opts.env });
  return pid ? { success: true, version, pid, file: dl.file } : { success: false, code: 'failed' };
}

/* Hosts Roblox's programs talk to: how a request is recognised as Roblox's,
 * which is what shows a program of Roblox's uses Shroudly. Every name of
 * Roblox's own counts: one left out would make a program that goes through
 * Shroudly look silent. */
const ROBLOX_HOST = /(^|\.)(roblox\.com|rbxcdn\.com|rbxcdn\.net|robloxcdn\.com|rbxinfra\.net|rbx\.com|robloxlabs\.com|rbxtrk\.com|rblx\.org)$/i;
function isRobloxHost(h) { return ROBLOX_HOST.test(String(h || '')); }

module.exports = {
  installs, installed, handler, launcher, isBootstrapper, storeEdition, pids, parsePids, installerPids, parseInstallerPids,
  processes, parseProcesses, processInfo, parseProcessInfo, decide, kill, routeWatched, alive, open, restart, install,
  startInstaller, signedInstaller, signedCache, sameFile, fileHash, cleanDownloads, newDownload, isRobloxHost, get, signedByRoblox,
  BOOTSTRAPPERS, KINDS,
};
