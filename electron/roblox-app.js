'use strict';

/*
 * Where Roblox is on this machine, whether it is running, and how to start,
 * restart or install it so that it goes through Shroudly.
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
const { execFile, spawn } = require('child_process');
const { envFor } = require('./win-powershell');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 10000, ...opts, env: envFor(cmd, opts.env) }, (err, out) => resolve(err ? '' : String(out))));
}

const exists = (p) => { try { return fs.statSync(p); } catch { return null; } };
const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/* Bootstrappers people use instead of Roblox's own launcher: they keep their
 * own copy of the player and start it themselves, so it is them that have to
 * be started with the setting. */
const BOOTSTRAPPERS = ['Bloxstrap', 'Fishstrap'];

/* Installed copies of the player, newest first. macOS: the app bundle.
 * Windows: the player in each version folder, Roblox's own and the
 * bootstrappers' (Roblox keeps the current one, and sometimes an older one it
 * has not cleaned up yet). */
function installs(platform = process.platform) {
  if (platform === 'darwin') {
    return ['/Applications', path.join(os.homedir(), 'Applications')]
      .flatMap((d) => ['Roblox.app', 'RobloxPlayer.app'].map((a) => path.join(d, a)))
      .filter((p) => exists(p));
  }
  if (platform === 'win32') {
    const local = localAppData();
    const roots = [local, process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
      .filter(Boolean).map((r) => path.join(r, 'Roblox', 'Versions'))
      .concat(BOOTSTRAPPERS.map((b) => path.join(local, b, 'Versions')));
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

/* The program Windows runs for the website's Play button: Roblox's player, or
 * a bootstrapper that took the link over. */
async function handler() {
  if (process.platform !== 'win32') return null;
  const out = await run('reg', ['query', 'HKCU\\Software\\Classes\\roblox-player\\shell\\open\\command', '/ve']);
  const m = /REG_(?:EXPAND_)?SZ\s+(?:"([^"]+\.exe)"|(\S+\.exe))/i.exec(out);
  const exe = m ? (m[1] || m[2]) : null;
  return exe && exists(exe) ? exe : null;
}

/* What to start for "Open Roblox": the bootstrapper if one handles Roblox's
 * links (it starts the player itself), else the newest player. */
async function launcher() {
  if (process.platform === 'darwin') { const app = installs()[0]; return app ? { exe: 'open', args: ['-a', app] } : null; }
  if (process.platform !== 'win32') return null;
  const h = await handler();
  if (h && BOOTSTRAPPERS.some((b) => path.basename(h).toLowerCase() === `${b.toLowerCase()}.exe`)) return { exe: h, args: ['-player'] };
  const player = installs()[0] || (h && /robloxplayerbeta\.exe$/i.test(h) ? h : null);
  return player ? { exe: player, args: [] } : null;
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

/* Process ids of Roblox's player: the program a game runs in, the one that
 * is restarted through Shroudly and the one an update waits for. Its name is
 * the same for Roblox's own copy and the bootstrappers' (they start the same
 * RobloxPlayerBeta.exe). Nothing else whose name starts with "Roblox" counts:
 * not Studio, not the crash handler that runs beside the player, not the
 * installer, not other people's tools (account managers, FPS unlockers). */
const PLAYER = { win32: 'RobloxPlayerBeta.exe', darwin: 'RobloxPlayer' };
function parsePids(out, platform = process.platform) {
  if (platform === 'win32') return [...String(out || '').matchAll(/^"RobloxPlayerBeta\.exe","(\d+)"/gmi)].map((m) => Number(m[1]));
  return String(out || '').split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number);
}

async function pids() {
  if (process.platform === 'win32') return parsePids(await run('tasklist', ['/FI', `IMAGENAME eq ${PLAYER.win32}`, '/NH', '/FO', 'CSV']), 'win32');
  if (process.platform === 'darwin') return parsePids(await run('pgrep', ['-x', PLAYER.darwin]), 'darwin');
  return [];
}

/* A player going around Shroudly is only possible on Windows, where a
 * browser that was open before the setting hands what it starts its own
 * older environment. macOS gives every app the session's setting, browsers
 * included. */
function routeWatched(platform = process.platform) { return platform === 'win32'; }

/* Players that have run for BYPASS_GRACE_MS without a single request from
 * Roblox reaching Shroudly since just before each was first seen. Roblox makes
 * its requests in its first seconds and then keeps its connections open, so
 * each player is judged from when it was first seen, never from when the
 * others came or went. seen (pid -> first seen) is kept up to date here:
 * players that ended are dropped, new ones added. The slack covers requests
 * made in the seconds before a player was first seen (it is looked for every
 * 20 seconds). */
const BYPASS_GRACE_MS = 30000;
const BYPASS_SLACK_MS = 25000;
function silentPlayers(seen, list, lastRequestAt, now = Date.now()) {
  for (const pid of [...seen.keys()]) if (!list.includes(pid)) seen.delete(pid);
  for (const pid of list) if (!seen.has(pid)) seen.set(pid, now);
  return list.filter((pid) => now - seen.get(pid) >= BYPASS_GRACE_MS && (lastRequestAt || 0) < seen.get(pid) - BYPASS_SLACK_MS);
}

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

function detached(cmd, args, env) {
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env: env || process.env });
    c.on('error', () => {});
    c.unref();
    return true;
  } catch { return false; }
}

/* Start Roblox. `env` is what it should get on Windows; on macOS it is
 * started by the system, whose environment already has the setting. */
async function open(env) {
  const l = await launcher();
  if (!l) return false;
  return detached(l.exe, l.args, process.platform === 'win32' ? { ...process.env, ...env } : process.env);
}

/* Quit Roblox and open it again, through Shroudly. */
async function restart(env) {
  const before = await pids();
  if (process.platform === 'darwin') {
    await run('pkill', ['-x', PLAYER.darwin]);
    if (!(await waitGone(before, 8000))) { await run('pkill', ['-9', '-x', PLAYER.darwin]); await waitGone(before, 3000); }
  } else if (process.platform === 'win32') {
    if (before.length) await run('taskkill', [...before.flatMap((p) => ['/PID', String(p)]), '/T', '/F']);
    await waitGone(before, 5000);
  } else return false;
  return open(env);
}

/* ── installing (Windows) ────────────────────────────────────────────────── */
/* The same two requests Roblox's own website makes: which version is current,
 * then that version's installer. Fetched through the engine (Roblox's servers
 * are what is filtered), checked to be signed by Roblox, then started with the
 * setting, so the installer and the player it installs go through Shroudly. */
const VERSION_URL = 'https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer';
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

/* The file's signature as Windows judges it: "Status|signer", '' when
 * nothing answered. */
async function signatureOf(file) {
  if (process.platform !== 'win32') return '';
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$s = Get-AuthenticodeSignature -LiteralPath $env:SHROUDLY_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)|$($s.StatusMessage)"'],
  { timeout: 30000, env: { ...process.env, SHROUDLY_FILE: file } });
  return out.trim();
}
const byRoblox = (sig) => {
  const [status, subject] = String(sig || '').split('|');
  return status === 'Valid' && /(^|,\s*)O="?Roblox Corporation"?(,|$)/i.test(subject || '');
};

/* Is the file signed, validly, by Roblox Corporation? Never start a
 * downloaded program on anything less. */
async function signedByRoblox(file) { return byRoblox(await signatureOf(file)); }

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

function newDownload(dir) {
  fs.mkdirSync(dir, { recursive: true });
  cleanDownloads(dir);
  const own = fs.mkdtempSync(path.join(dir, 'dl-'));
  const file = path.join(own, 'RobloxPlayerInstaller.exe');
  return { dir: own, file, part: `${file}.part` };
}

/* Download Roblox's current installer and start it with `env`.
 * opts: { socksPort, connect, env, dir }. Resolves { success, code }. */
async function install(opts) {
  if (process.platform !== 'win32') return { success: false, code: 'unsupported' };
  let version;
  try {
    const r = await get(VERSION_URL, { socksPort: opts.socksPort, connect: opts.connect, timeoutMs: 20000 });
    version = JSON.parse(r.body).clientVersionUpload;
  } catch (e) { return { success: false, code: 'unreachable', detail: e.message }; }
  if (!/^version-[0-9a-f]{8,32}$/i.test(String(version || ''))) return { success: false, code: 'unreachable', detail: 'unexpected version' };
  let dl;
  try { dl = newDownload(opts.dir); } catch (e) { return { success: false, code: 'failed', detail: e.message }; }
  const drop = () => { try { fs.rmSync(dl.dir, { recursive: true, force: true }); } catch {} };
  try {
    await get(`https://setup.rbxcdn.com/${version}-RobloxPlayerInstaller.exe`, { socksPort: opts.socksPort, connect: opts.connect, toFile: dl.part, timeoutMs: 180000 });
  } catch (e) { drop(); return { success: false, code: 'unreachable', detail: e.message }; }
  // Checked under its own name, in its own folder: Windows tells what kind
  // of file it is judging partly by the extension, and nothing starts it
  // until the signature has been checked.
  try { fs.renameSync(dl.part, dl.file); } catch (e) { drop(); return { success: false, code: 'failed', detail: e.message }; }
  const sig = await signatureOf(dl.file);
  if (!byRoblox(sig)) { drop(); return { success: false, code: 'unsigned', detail: sig || 'no answer' }; }
  return detached(dl.file, [], { ...process.env, ...opts.env }) ? { success: true, version } : { success: false, code: 'failed' };
}

/* Hosts Roblox's programs talk to: how a tunnel is recognised as Roblox's. */
const ROBLOX_HOST = /(^|\.)(roblox\.com|rbxcdn\.com|rbxinfra\.net|rbx\.com|robloxlabs\.com)$/i;
function isRobloxHost(h) { return ROBLOX_HOST.test(String(h || '')); }

module.exports = { installs, installed, handler, launcher, storeEdition, pids, parsePids, routeWatched, silentPlayers, alive, open, restart, install, cleanDownloads, newDownload, isRobloxHost, get, signedByRoblox, BOOTSTRAPPERS, BYPASS_GRACE_MS };
