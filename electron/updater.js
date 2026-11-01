'use strict';

/*
 * Auto-update from GitHub releases (umutxyp/Shroudly).
 *
 * Checks shortly after launch and then every 30 minutes, so a closed app
 * updates on its next start and a running one soon after a release. With
 * "Install updates automatically" on (default), the update downloads in the
 * background, and Shroudly restarts to install it while nobody is using the
 * computer (after a short countdown that can still be postponed), when it
 * quits, or at its next start before protection: never in the middle of what
 * someone is doing through it (see restartPlan).
 *
 * What downloads by itself is held back where it costs (_downloadsByItself):
 * a release only a few hours old waits, once one was downloaded that day (on
 * the busiest days there were eleven releases, about 100 MB each); nothing
 * downloads by itself on a metered connection (metered.js); and a download
 * that keeps failing is tried less and less often. The user's own buttons
 * always go ahead.
 *
 * Windows / Linux: electron-updater (NSIS installer, AppImage, .deb, .rpm,
 *   .pacman), fed by the latest*.yml files electron-builder writes next to
 *   the installers.
 * macOS: electron-updater relies on Squirrel.Mac, which only accepts apps
 *   signed with an Apple Developer ID. Shroudly is ad-hoc signed, so macOS gets
 *   its own path: read latest-mac.yml, download the zip for this CPU into
 *   Shroudly's own folder, verify the SHA-512 of the file on disk, then a small
 *   script swaps the .app bundle after Shroudly quits and relaunches it.
 *
 * An install that asks for permission (a Linux package's password, the
 * administrator's for a Windows copy installed for everyone) never starts by
 * itself: only from the button that says so (permission).
 *
 * An install that does not happen (a password prompt dismissed, a folder that
 * cannot be written to, a download that is no longer intact, an installer
 * that would not start) never leaves Shroudly closed or half-quit: it carries
 * on as it was, protection back on, and says so in one line (_installFailed).
 * One that fails after Shroudly has quit (the macOS swap, a Windows permission
 * prompt refused) starts the old Shroudly again with a note of why
 * (_readFailedNote). Either way that version is not installed by itself again.
 *
 * Connections go direct first, so updates never depend on Shroudly's own
 * engine (a broken engine must still be able to fetch its fix), then through
 * the engine for networks where GitHub itself is blocked, then from a mirror
 * on Shroudly's own host, through the engine only (routesNow).
 */

const { app, net, session } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Metered = require('./metered');

const OWNER = 'umutxyp';
const REPO = 'Shroudly';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;
// A mirror of the release files on Shroudly's own host, for networks that
// block GitHub's addresses outright (whole-IP blackhole, as in Iran — then
// GitHub cannot be reached by any technique, so the app cannot even fetch its
// own fix). It is tried only after GitHub (direct and through the engine) has
// failed. The host must SERVE the files and the electron-updater feeds
// (latest.yml / latest-linux.yml / latest-mac.yml) at this path, not redirect
// to GitHub. A less-known host than github.com is a smaller target to block.
const MIRROR_URL = 'https://shroudly.codeshare.me/dl';
/* The mirror's copy of a github.com/<owner>/<repo>/releases/... URL. Both
 * .../releases/download/<tag>/<file> and .../releases/latest/download/<file>
 * map to a flat <MIRROR>/<file> — the layout electron-updater's generic
 * provider expects (feed and assets side by side). */
function mirrorOf(url) {
  return url.replace(
    new RegExp(`^https://github\\.com/${OWNER}/${REPO}/releases/(?:download/[^/]+|latest/download)/`),
    `${MIRROR_URL}/`);
}
const FIRST_CHECK_MS = 8000;
const FIRST_CHECK_SPREAD_MS = 10 * 60 * 1000;
const CHECK_EVERY_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESTART_COUNTDOWN_S = 60;
const WAIT_CHECK_MS = 60000;
/* How long an update waits for Roblox, Discord or a full-screen game or film
 * while nobody is at the computer: after that it installs then as well.
 * Counted from when it first had to wait, across restarts of Shroudly
 * (WAIT_KEY), so a game or a call that is open every day cannot hold it back
 * for good. */
const WAIT_LIMIT_MS = 3 * 60 * 60 * 1000;
// Nobody at the computer: no keyboard or mouse for this long, or locked.
const AWAY_S = 10 * 60;
// After a wake, how long nobody counts as away (the idle time includes the
// sleep), and how late a countdown may end before it is taken for one that
// ran out while the computer slept.
const AWAKE_GRACE_MS = 2 * 60 * 1000;
const LATE_MS = 5000;
const WAIT_KEY = 'updateWaiting';
/* After "Later", the update does not come back for this long, even while
 * nobody is at the computer. */
const LATER_MS = 60 * 60 * 1000;
/* At launch, the most protection is held back for an update that is due. */
const LAUNCH_INSTALL_MS = 10000;
/* Installing quits Shroudly within a moment. Still running this long after:
 * it did not install (_installFailed). */
const INSTALL_QUIT_MS = 10000;
/* Windows: an installer that could only be started through elevate.exe asks
 * for permission first and, once given, closes Shroudly itself. Not closed
 * this long after: it did not install. */
const ELEVATED_QUIT_MS = 2 * 60 * 1000;
/* A release this new does not download by itself once one was downloaded by
 * itself within a day: releases come in bursts, and one that follows within
 * hours replaces it. */
const SETTLE_MS = 6 * 60 * 60 * 1000;
const FETCHED_KEY = 'updateFetchedAt';
/* A download or a check from which nothing has arrived for this long is
 * given up, and tried on the next route; without it a connection that went
 * silent kept the update "downloading" or "checking" for the rest of the
 * session, and the button with it. */
const STALL_MS = 60000;
/* Free disk space a macOS update needs, as a multiple of its zip: the zip,
 * and the app it unpacks to beside it before the swap (2.6.43: a 112 MB zip,
 * a 262 MB app), with room to spare. */
const SPACE_FACTOR = 4;
/* An update whose install failed: { version }. That version is not installed
 * by itself again, at no later start either; the user's button still can. */
const FAILED_KEY = 'updateFailed';
/* Downloads left by a run that never finished with them are cleared at the
 * next start; one touched this recently may still be in use by the install
 * script of the run that has just quit. */
const LEFTOVER_MS = 60 * 60 * 1000;
/* How the old Shroudly is opened again when its update failed after it had
 * quit (main.js: the same window as before, as after an update). */
const UPDATE_FAILED_ARG = '--update-failed';
/* What failed after Shroudly had quit, for the log: the macOS install script,
 * and the Windows installer of a copy installed for everyone
 * (scripts/installer.nsh). */
const INSTALL_STEPS = {
  unpack: 'the download could not be unpacked',
  signature: 'its signature did not check out',
  replace: 'the app could not be replaced',
  permission: 'administrator permission was not given',
  elevation: 'Windows could not ask for administrator permission',
};
/* Where an AppImage update waits, beside the file it replaces
 * (_keepAppImagePath). */
const APPIMAGE_STAGE = '.shroudly-update';

/* Windows: the folder the update is installed into (/D=), the one this copy
 * of Shroudly runs from. Without it the installer goes by its own records,
 * which can point elsewhere: a copy put on another disk beside an older one,
 * or one installed for everyone beside one for "only me", left it picking the
 * default folder, and the update became a second copy while the one the user
 * runs stayed old (#57). Only a folder this user can write to: one under
 * Program Files is left to the installer's records and its own permission
 * prompt. null: no folder to give (another system, a development run). */
function canWriteDir(dir) {
  const probe = path.join(dir, `.shroudly-write-${process.pid}`);
  try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); return true; } catch { return false; }
}
const isWindowsApp = (execPath) => /[\\/]Shroudly\.exe$/i.test(String(execPath || ''));
function installDirFor(execPath, { platform = process.platform, canWrite = canWriteDir } = {}) {
  if (platform !== 'win32' || !isWindowsApp(execPath)) return null;
  const dir = path.win32.dirname(execPath);
  return canWrite(dir) ? dir : null;
}

/* The file someone would download by hand for this copy: the release's own
 * names, as server/stats/server.js knows them, so the mirror serves it where
 * GitHub is blocked. */
function downloadName(version, { platform = process.platform, arch = process.arch, packageType = null } = {}) {
  if (!version) return null;
  const arm = arch === 'arm64';
  if (platform === 'win32') return `Shroudly-${version}-Windows-${arm ? 'arm64' : 'x64'}-Setup.exe`;
  if (platform === 'darwin') return `Shroudly-${version}-macOS-${arm ? 'arm64' : 'x64'}.dmg`;
  if (platform !== 'linux') return null;
  if (packageType === 'deb') return `Shroudly-${version}-Linux-amd64.deb`;
  if (packageType === 'rpm') return `Shroudly-${version}-Linux-x86_64.rpm`;
  if (packageType === 'pacman') return `Shroudly-${version}-Linux-x64.pacman`;
  return `Shroudly-${version}-Linux-${arm ? 'arm64' : 'x86_64'}.AppImage`;
}

function newer(a, b) { // is version a newer than b
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

/* The subset of electron-builder's latest-mac.yml we need. */
function parseMacFeed(text) {
  const version = (text.match(/^version:\s*['"]?([^'"\s]+)/m) || [])[1];
  const releaseDate = (text.match(/^releaseDate:\s*['"]?([^'"\s]+)/m) || [])[1] || null;
  const files = [];
  const re = /^\s*-\s*url:\s*['"]?([^'"\s]+)['"]?\s*\n\s*sha512:\s*['"]?([^'"\s]+)['"]?\s*\n\s*size:\s*(\d+)/gm;
  let m;
  while ((m = re.exec(text))) files.push({ url: m[1], sha512: m[2], size: Number(m[3]) });
  return { version, releaseDate, files };
}

// GitHub first, direct then through the engine; the own-host mirror last.
const ROUTES = ['direct', 'system', 'mirror'];
const routeSessions = {};
// Through Shroudly's engine while protection is on (its own SOCKS rule), else
// the OS proxy; main.js keeps it current through setSystemRoute.
let systemRoute = { mode: 'system' };
const throughEngine = () => !!(systemRoute && systemRoute.proxyRules);
/* The mirror is Shroudly's own host, and a request to it, seen by whoever
 * filters the connection, says that this computer runs circumvention
 * software: the live counter is not sent in the clear for that reason
 * (main.js), nor is this. So the mirror is asked only through the engine,
 * while protection is on, and not at all otherwise. */
function routesNow() { return ROUTES.filter((r) => r !== 'mirror' || throughEngine()); }
const routeProxy = (route) => (route === 'direct' ? { mode: 'direct' } : systemRoute);
async function routeSession(route) {
  if (!routeSessions[route]) {
    const s = session.fromPartition(`shroudly-updater-${route}`, { cache: false });
    await s.setProxy(routeProxy(route));
    routeSessions[route] = s;
  }
  return routeSessions[route];
}
function setSystemRoute(cfg) {
  systemRoute = cfg;
  for (const r of ['system', 'mirror']) if (routeSessions[r]) routeSessions[r].setProxy(cfg).catch(() => {});
}

/* Run fn(route) for each route until one succeeds. A disk that is full
 * would refuse the file the same on every route. */
async function viaRoutes(fn) {
  let last;
  for (const route of routesNow()) {
    try { return await fn(route); } catch (e) { last = e; if (e && e.local) break; }
  }
  throw last;
}

/* The disk is full: for the user to fix, and said so (not "could not check
 * for updates"). */
function noSpace(e) {
  return !!e && (e.code === 'ENOSPC' || /\bENOSPC\b|no space left/i.test(String(e.message || e)));
}

/* SHA-512 (base64, as in latest-mac.yml) of a file as it is on disk. */
function fileSha512(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file).on('error', reject).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('base64')));
  });
}

/* Is the file on disk the one the feed describes, every byte of it? */
async function fileMatches(file, { size, sha512 }) {
  try { return fs.statSync(file).size === size && (await fileSha512(file)) === sha512; } catch { return false; }
}

/* The text at url, given up when nothing arrives for stallMs. */
async function fetchText(url, route, { stallMs = STALL_MS } = {}) {
  const ses = await routeSession(route);
  if (route === 'mirror') url = mirrorOf(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stall = null;
    let body = '';
    const req = net.request({ url, redirect: 'follow', session: ses });
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      if (!err) { resolve(body); return; }
      try { req.abort(); } catch {}
      reject(err);
    };
    const alive = () => { clearTimeout(stall); stall = setTimeout(() => settle(new Error('the connection stalled')), stallMs); };
    alive();
    req.on('response', (res) => {
      if (res.statusCode !== 200) { settle(new Error(`HTTP ${res.statusCode}`)); res.resume?.(); return; }
      res.on('data', (d) => { body += d; alive(); });
      res.on('end', () => settle(null));
      res.on('aborted', () => settle(new Error('the connection was closed')));
      res.on('error', settle);
    });
    req.on('error', settle);
    req.end();
  });
}

/* Download url to dest. Resolves once the file is written and closed;
 * rejects, exactly once, on anything else: an HTTP error, a broken
 * connection, nothing arriving for stallMs, or the disk refusing the file
 * (full, not writable). That last one comes as the file stream's 'error'
 * event, which with no listener is an uncaught exception, and main.js quits
 * Shroudly on one: a nearly full disk closed Shroudly at every update check.
 * Whether the right file arrived is judged from the file on disk
 * (fileMatches), never from the bytes that came in, which a write that failed
 * partway does not show. */
async function download(url, dest, onProgress, route, { stallMs = STALL_MS } = {}) {
  const ses = await routeSession(route);
  if (route === 'mirror') url = mirrorOf(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = null;
    let stall = null;
    const req = net.request({ url, redirect: 'follow', session: ses });
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      if (!err) { resolve(); return; }
      try { req.abort(); } catch {}
      if (out) out.destroy();
      reject(err);
    };
    const alive = () => { clearTimeout(stall); stall = setTimeout(() => settle(new Error('the download stalled')), stallMs); };
    alive();
    req.on('response', (res) => {
      if (res.statusCode !== 200) { settle(new Error(`HTTP ${res.statusCode}`)); res.resume?.(); return; }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      out = fs.createWriteStream(dest);
      out.on('error', (e) => { e.local = true; settle(e); });
      out.on('close', () => settle(out.writableFinished ? null : new Error('the download was cut short')));
      res.on('data', (d) => { got += d.length; alive(); if (total) onProgress(got / total); });
      res.on('aborted', () => settle(new Error('the connection was closed')));
      res.on('error', settle);
      res.pipe(out);
    });
    req.on('error', settle);
    req.end();
  });
}

/* electron-updater's way to call off a download (builder-util-runtime, which
 * it brings along); null where it is not there. */
function cancelToken() {
  try { const { CancellationToken } = require('builder-util-runtime'); return new CancellationToken(); } catch { return null; }
}

/* What a downloaded update does now (automatic installs on, the update
 * ready): 'install' at once, a 'countdown' the user can still postpone, or
 * 'wait' and look again in a minute. A restart cuts off for a few seconds
 * whatever goes through Shroudly, so it happens only while nobody is at the
 * computer (away: no keyboard or mouse for AWAY_S, or the screen locked);
 * never while someone is browsing, downloading or in a call through it.
 * busy: even then, a Roblox game or Discord goes through Shroudly, or a
 * full-screen game or film is on: that holds it back for WAIT_LIMIT_MS at
 * most. atLaunch: Shroudly has just started and protection has not yet
 * (nothing goes through it to be interrupted). */
function restartPlan({ busy, waitedMs, away, atLaunch }) {
  if (atLaunch) return 'install';
  if (!away) return 'wait';
  if (!busy || waitedMs >= WAIT_LIMIT_MS) return 'countdown';
  return 'wait';
}

/* Nobody at the computer: idle for AWAY_S, or the screen locked. Unknown
 * (some Linux sessions cannot tell) counts as somebody being there. */
function awayFromComputer() {
  try {
    const { powerMonitor } = require('electron');
    const st = powerMonitor.getSystemIdleState(AWAY_S);
    return st === 'idle' || st === 'locked';
  } catch { return false; }
}

/* Does a restart now interrupt something? Only while protection is on, and
 * only the programs whose mode sends them through Shroudly: the Roblox player
 * with Games and apps mode, Discord with Discord app mode. Each check lists
 * the running programs, so it is not even run otherwise. */
async function inUse({ protection, appMode, discordMode, robloxPlaying, discordOpen }) {
  if (!protection) return false;
  if (appMode && robloxPlaying && await robloxPlaying()) return true;
  if (discordMode && discordOpen && await discordOpen()) return true;
  return false;
}

/* Where downloads and the note of a failed install are kept: Shroudly's own
 * folder, not the system's temporary one, which macOS empties of anything
 * three days old, while an update may wait longer than that (for a game, a
 * call, or the user). */
function updateDir() {
  try { return path.join(app.getPath('userData'), 'update'); } catch { return path.join(os.tmpdir(), 'shroudly-updates'); }
}

class Updater {
  /* onInstallFailed: undo beforeInstall (protection back on, no longer
   * quitting). onAppImageMoved(file): the AppImage now lives at file.
   * metered(): whether the connection is paid for by the byte.
   * adminPrompt(version): the sentence macOS's password dialog shows. */
  constructor({ log, store, notify, beforeInstall, onInstallFailed, onAppImageMoved, busy, fullScreen, away, metered, adminPrompt, dir }) {
    this.log = log || (() => {});
    this.store = store;
    this.notify = notify || (() => {});
    this.beforeInstall = beforeInstall || (async () => {});
    this.onInstallFailed = onInstallFailed || (() => {});
    this.onAppImageMoved = onAppImageMoved || (() => {});
    this.metered = metered || (() => Metered.metered());
    this.adminPrompt = adminPrompt || (() => '');
    // osascript, for the macOS install that needs an administrator (tests: a stand-in).
    this.osascript = (args) => new Promise((resolve, reject) => {
      execFile('/usr/bin/osascript', args, { timeout: 10 * 60 * 1000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().split('\n')[0])) : resolve(String(out || ''))));
    });
    this.dir = dir || updateDir();
    this.tmp = os.tmpdir();   // where versions before this one kept downloads
    // Is something running that a restart would cut off (a game, a call)?
    this.busy = busy || (async () => false);
    // A full-screen game or video in front (user-busy.js): the restart would
    // cut it off too.
    this.fullScreen = fullScreen || (async () => false);
    this.busyApps = false;
    this.toldWaiting = false;
    this.away = away || awayFromComputer;
    this.waitTimer = null;
    this.listeners = new Set();
    this.mac = process.platform === 'darwin';
    // 'password' (a Linux package) or 'admin' (a Windows copy installed for
    // everyone): the install asks for it, see _initElectronUpdater.
    this.permission = null;
    this.appImage = null;
    this.packageType = null;
    // access() is exact on Linux (permissions, ACLs, a read-only disk), and
    // leaves nothing behind in the user's folder.
    this.canWrite = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
    this.told = {};
    this.state = { status: 'idle', current: app.getVersion(), version: null, percent: 0, restartAt: null, error: null, permission: null, downloadUrl: null };
    this.timer = null;
    this.restartTimer = null;
    this.installWatch = null;
    this.installQuitMs = INSTALL_QUIT_MS;
    this.elevatedQuitMs = ELEVATED_QUIT_MS;
    this.stallMs = STALL_MS;
    this.macDownload = null; // { zip, dir, version, size, sha512 }
    this.eu = null;
    this.atLaunch = false;
    this.onInstall = null;
    this.heldUntil = 0;       // "Later": not before then
    this.failedDownload = null;   // { version, count, next }
    this.quiet = false;       // a check in the background: what is shown stays
    this.manualCheck = false;
    this.rebinding = false;
    this.started = null;      // the installer electron-updater last started
    // A wait for an update this version already has is over, and so is a
    // failed install of one.
    for (const key of [WAIT_KEY, FAILED_KEY]) {
      try { const w = store.get(key); if (w && !newer(w.version, app.getVersion())) store.delete(key); } catch {}
    }
  }

  get auto() { return this.store.get('autoUpdate', true) !== false; }

  onState(fn) { this.listeners.add(fn); }
  _set(patch) {
    this.state = { ...this.state, ...patch };
    // Nothing newer out there (a release that was withdrawn): nothing to wait for.
    if (patch.status === 'up-to-date') { try { this.store.delete(WAIT_KEY); } catch {} }
    for (const fn of [...this.listeners]) { try { fn(this.state); } catch {} }
  }

  start() {
    if (!app.isPackaged) { this._set({ status: 'unsupported' }); return; }
    this._readFailedNote();
    if (!this.mac) this._initElectronUpdater();
    this._clearLeftovers();
    // Spread over the first minutes: computers started together (a classroom,
    // an internet cafe, an office after a power cut) do not all ask and
    // download at the same moment.
    setTimeout(() => this.check(false), FIRST_CHECK_MS + Math.floor(Math.random() * FIRST_CHECK_SPREAD_MS));
    this.timer = setInterval(() => this.check(false), CHECK_EVERY_MS);
  }

  _initElectronUpdater() {
    // deb, rpm and pacman installs go through the system's package manager,
    // which asks for an administrator's password (pkexec). Such an update is
    // never installed by itself: not after a countdown, nor at a quit or a
    // logout, where the prompt comes up with nobody expecting it, or cannot
    // come up at all (no polkit agent on Sway, i3 or Hyprland). The user
    // installs it with the button that says it asks for a password.
    // Windows: the same for a copy installed for everyone, in a folder this
    // user cannot write to (Program Files). Its installer asks for an
    // administrator's permission, which a standard account cannot give, and
    // which came up by itself after the countdown or at a quit.
    if (process.platform === 'linux' && !process.env.APPIMAGE) this.permission = 'password';
    else if (process.platform === 'win32' && isWindowsApp(process.execPath) && !installDirFor(process.execPath)) this.permission = 'admin';
    // An AppImage is replaced where it is: only in a folder this user can
    // write to.
    this.appImage = process.platform === 'linux' ? process.env.APPIMAGE || null : null;
    // deb, rpm or pacman (electron-builder writes it into those packages).
    try { this.packageType = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim() || null; } catch {}
    this._set({ permission: this.permission });
    this._wire(require('electron-updater').autoUpdater);
  }

  _wire(autoUpdater) {
    this.eu = autoUpdater;
    autoUpdater.autoDownload = false;          // we decide, based on the setting
    // A downloaded update installs on quit, except where that asks for
    // permission.
    autoUpdater.autoInstallOnAppQuit = !this.permission;
    autoUpdater.logger = null;
    // A check made only to move the download to the mirror (download) says
    // nothing of its own; one in the background leaves what is shown.
    autoUpdater.on('checking-for-update', () => { if (!this.quiet && !this.rebinding) this._set({ status: 'checking', error: null }); });
    autoUpdater.on('update-not-available', () => { if (!this.rebinding) this._set({ status: 'up-to-date' }); });
    autoUpdater.on('update-available', (info) => { if (!this.rebinding) this._found(info.version, info.releaseDate).catch(() => {}); });
    autoUpdater.on('download-progress', (p) => {
      if (this.onProgress) this.onProgress();
      this._set({ status: 'downloading', percent: Math.round(p.percent || 0) });
    });
    autoUpdater.on('update-downloaded', (info) => this._downloaded(info.version));
    // A failed check or download comes back from the call itself (check,
    // download), where only the last route's failure reaches the window.
    // While installing: the install's own failure, which install() and
    // _awaitQuit report (_installFailed).
    autoUpdater.on('error', (e) => { if (this.installing) this.installError = e; });
    // An AppImage that electron-updater did put under a new name (see
    // _keepAppImagePath): "Start at login" must follow it (main.js), or the
    // next login starts a file that is gone and protection stays off.
    autoUpdater.on('appimage-filename-updated', (file) => { try { this.onAppImageMoved(file); } catch {} });
    this._onePrompt(autoUpdater);
    this._keepAppImagePath(autoUpdater);
    this._watchStarts(autoUpdater);
  }

  /* One password prompt per install. After a failed `dpkg -i`,
   * electron-updater runs `apt-get install -f` (pacman: a refresh, then the
   * install again), each through pkexec, so a dismissed prompt came straight
   * back. Once the user has dismissed or refused it, or no prompt could come
   * up (pkexec exits 126 or 127), the rest is not asked: the same failure
   * stands for them (reset at each install). And pacman's database is never
   * refreshed on its own (`pacman -Sy` without the upgrade that goes with it
   * is the partial upgrade Arch warns can break the system): the failed
   * install is reported as it is. */
  _onePrompt(eu) {
    if (typeof eu.runCommandWithSudoIfNeeded !== 'function') return;
    const run = eu.runCommandWithSudoIfNeeded.bind(eu);
    eu.runCommandWithSudoIfNeeded = (cmd) => {
      if (this.promptRefused) throw this.promptRefused;
      if (Array.isArray(cmd) && cmd[0] === 'pacman' && cmd.includes('-Sy')) throw this.commandError || new Error('pacman could not install the update');
      try { return run(cmd); } catch (e) {
        this.commandError = e;
        if (/exited with code 12[67]\b/.test(String(e && e.message))) this.promptRefused = e;
        throw e;
      }
    };
  }

  /* An AppImage update takes the place of the file the user runs, under the
   * same name. electron-updater put it beside it under its own name
   * (Shroudly-2.6.45-Linux-x86_64.AppImage) and deleted the old file, so every
   * desktop shortcut, menu entry, launcher and script that started Shroudly
   * broke at each update; it keeps the name only when the download has the
   * same one. So the download is first put in a folder beside the file, under
   * the file's own name: electron-updater then keeps the name, and putting it
   * in place is a rename on the same disk, which cannot stop halfway. (It
   * deleted the old file first and then copied the new one over from the
   * cache, often on another disk: a disk that filled up meanwhile left no
   * Shroudly at all.) If that folder or the copy into it fails, nothing has
   * been touched yet, and the install fails as any other would. Should a
   * later electron-updater keep its download elsewhere, it is left to do
   * things its own way (and "Start at login" follows the new name). */
  _keepAppImagePath(eu) {
    if (typeof eu.doInstall !== 'function') return;
    const doInstall = eu.doInstall.bind(eu);
    eu.doInstall = (options) => {
      const current = process.env.APPIMAGE;
      const helper = eu.downloadedUpdateHelper;
      const file = eu.installerPath;
      if (!current || !file || !helper || helper._file !== file || path.basename(file) === path.basename(current)) return doInstall(options);
      const stage = path.join(path.dirname(current), APPIMAGE_STAGE);
      const staged = path.join(stage, path.basename(current));
      fs.mkdirSync(stage, { recursive: true });
      try { fs.renameSync(file, staged); } catch (e) {
        if (e.code !== 'EXDEV') { try { fs.rmdirSync(stage); } catch {} throw e; }
        try { fs.copyFileSync(file, staged); } catch (err) { fs.rmSync(stage, { recursive: true, force: true }); throw err; }
        fs.rmSync(file, { force: true });
      }
      fs.chmodSync(staged, 0o755);
      helper._file = staged;
      // Once in place, the folder is empty and goes; after a failure the
      // download stays there for "Restart now", and the next start clears it.
      try { return doInstall(options); } finally { try { fs.rmdirSync(stage); } catch {} }
    };
  }

  /* electron-updater starts the installer and quits at once, without looking
   * whether it started: an installer an antivirus had taken away, or one
   * Windows would not start, left Shroudly closed with nothing installed.
   * Each start is kept here for install() to wait on (_installerStarted). */
  _watchStarts(eu) {
    if (typeof eu.spawnLog !== 'function') return;
    const spawnLog = eu.spawnLog.bind(eu);
    eu.spawnLog = (cmd, ...rest) => {
      const promise = spawnLog(cmd, ...rest);
      this.started = { promise, elevated: /(^|[\\/])elevate\.exe$/i.test(String(cmd)) };
      return promise;
    };
  }

  /* 'started'; 'elevated' (started through elevate.exe after a normal start
   * was refused: it asks for permission first, and the installer closes
   * Shroudly itself); or 'none' (nothing to start: a Linux package is in
   * already, and Shroudly starts again as it quits). Rejects when nothing
   * could be started. */
  async _installerStarted() {
    for (;;) {
      const s = this.started;
      if (!s) return 'none';
      try { await s.promise; return s.elevated ? 'elevated' : 'started'; } catch (e) {
        // electron-updater answers some failures by trying once more through
        // elevate.exe, in its own handler of this one, which runs first.
        await new Promise((r) => setImmediate(r));
        if (this.started === s) throw e;
      }
    }
  }

  _logFail(msg) {
    if (msg !== this.lastLoggedError) { this.lastLoggedError = msg; this.log('warning', `Update failed: ${msg}`); }
  }

  /* stage: 'check' or 'download', for the window's sentence. */
  _fail(e, stage = 'check') {
    const msg = (e && e.message ? e.message : String(e)).split('\n')[0];
    this._logFail(msg);
    this._set({ status: noSpace(e) ? 'no-space' : 'error', error: msg, stage });
  }

  /* The install failed after Shroudly had quit, and the macOS install script
   * or the Windows installer left a note ("<version> <step>"): said once, and
   * that version is not installed by itself again. */
  _readFailedNote() {
    const file = path.join(this.dir, 'failed');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    try { fs.rmSync(file, { force: true }); } catch {}
    const [version, step] = text.trim().split(/\s+/);
    if (!version || !newer(version, app.getVersion())) return;
    this.log('warning', `Update ${version} could not be installed (${INSTALL_STEPS[step] || step || 'unknown'}); Shroudly carries on with version ${app.getVersion()}`);
    this._noteFailed(version);
  }

  /* The first time for this version: a line said once, not at every check. */
  _first(kind, version) {
    if (this.told[kind] === version) return false;
    this.told[kind] = version;
    return true;
  }

  _noteFailed(version) { try { this.store.set(FAILED_KEY, { version, at: Date.now() }); } catch {} }

  _failedBefore(version) {
    try { const f = this.store.get(FAILED_KEY); return !!(f && version && f.version === version); } catch { return false; }
  }

  /* Downloads left by a run that never finished with them (Shroudly closed
   * mid-download, an install script that failed), in our folder and in the
   * system's temporary one, where earlier versions kept them: on a nearly
   * full disk each left another 100 MB behind. And an AppImage update that
   * never got into place. */
  _clearLeftovers() {
    for (const base of [this.dir, this.tmp]) {
      let names = [];
      try { names = fs.readdirSync(base); } catch { continue; }
      for (const name of names.filter((n) => n.startsWith('shroudly-update-'))) {
        const p = path.join(base, name);
        try { if (Date.now() - fs.statSync(p).mtimeMs > LEFTOVER_MS) fs.rmSync(p, { recursive: true, force: true }); } catch {}
      }
    }
    if (this.appImage) { try { fs.rmSync(path.join(path.dirname(this.appImage), APPIMAGE_STAGE), { recursive: true, force: true }); } catch {} }
  }

  /* electron-updater has one network session: point it at a route. */
  async _euRoute(route) {
    await this.eu.netSession.setProxy(routeProxy(route));
    // Direct and through-the-engine read the GitHub release feed; the mirror
    // reads the same feed files served on our own host (generic provider).
    try {
      if (route === 'mirror') this.eu.setFeedURL({ provider: 'generic', url: MIRROR_URL, channel: 'latest' });
      else this.eu.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO });
    } catch {}
  }

  /* A request electron-updater will never see the end of: its connections
   * are closed (so the request fails), and its own record of a check or a
   * download under way is dropped, or every later one would wait on it. */
  _dropConnections() {
    try { this.eu.checkForUpdatesPromise = null; this.eu.downloadPromise = null; } catch {}
    try { Promise.resolve(this.eu.netSession.closeAllConnections()).catch(() => {}); } catch {}
  }

  /* electron-updater's check, given up after stallMs. Its own timeout waits
   * for a 'socket' event that Electron's network never sends, so a request
   * that stalled kept it "checking" for the rest of the session. */
  async _euCheck() {
    let timer = null;
    const stalled = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('the connection stalled')), this.stallMs); });
    try { return await Promise.race([this.eu.checkForUpdates(), stalled]); } catch (e) {
      if (e && e.message === 'the connection stalled') this._dropConnections();
      throw e;
    } finally { clearTimeout(timer); }
  }

  /* electron-updater's download, called off once nothing has arrived for
   * stallMs (download-progress comes about every second while it does). */
  async _euDownload() {
    const token = cancelToken();
    let timer = null;
    let stalled = false;
    let giveUp = null;
    const gaveUp = new Promise((resolve, reject) => { giveUp = reject; });
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        if (token) { try { token.cancel(); } catch {} }
        this._dropConnections();
        giveUp(new Error('the download stalled'));
      }, this.stallMs);
    };
    this.onProgress = alive;
    alive();
    try {
      await Promise.race([token ? this.eu.downloadUpdate(token) : this.eu.downloadUpdate(), gaveUp]);
    } catch (e) {
      throw stalled ? new Error('the download stalled') : e;
    } finally { clearTimeout(timer); this.onProgress = null; }
  }

  async check(manual) {
    const st = this.state.status;
    if (['checking', 'downloading', 'unsupported'].includes(st) || this.installing) return this.state;
    // A countdown under way stays as it is.
    if (st === 'ready' && (this.restartTimer || manual)) return this.state;
    // In the background, what is shown stays while the check runs, and stays
    // when it fails: an update ready or available, or one that needs the
    // user, is not taken away by a network that is down for a moment. The
    // check still runs, for a newer version (one ready is replaced by it).
    const keep = !manual && ['ready', 'available', 'manual', 'no-space'].includes(st) ? { ...this.state } : null;
    this.quiet = !!keep;
    this.manualCheck = !!manual;
    try {
      if (!this.mac) {
        await viaRoutes(async (route) => { this.euRoute = route; await this._euRoute(route); await this._euCheck(); });
        return this.state;
      }
      if (!keep) this._set({ status: 'checking', error: null });
      const feed = parseMacFeed(await viaRoutes((route) => fetchText(`${RELEASES_URL}/download/latest-mac.yml`, route, { stallMs: this.stallMs })));
      if (!feed.version || !newer(feed.version, app.getVersion())) { this._dropMacDownload(); this._set({ status: 'up-to-date' }); return this.state; }
      this.macFeed = feed;
      await this._found(feed.version, feed.releaseDate);
    } catch (e) {
      if (keep) { this._logFail((e && e.message ? e.message : String(e)).split('\n')[0]); this._set({ status: keep.status }); } else this._fail(e);
    } finally { this.quiet = false; this.manualCheck = false; }
    return this.state;
  }

  /* A check found version, newer than this one. */
  async _found(version, releaseDate) {
    // The one already downloaded: nothing new.
    if (this.state.status === 'ready' && this.state.version === version) return;
    // A newer one than the download kept: that goes.
    if (this.mac && this.macDownload && this.macDownload.version !== version) this._dropMacDownload();
    const same = this.state.version === version && ['available', 'manual', 'no-space', 'error'].includes(this.state.status);
    if (!(same && this.quiet)) this._set({ status: 'available', version, error: null, downloadUrl: this._downloadUrl(version) });
    if (this._first('available', version)) this.log('info', `Update available: version ${version}`);
    if (!this.auto) return;
    if (!this.manualCheck && !(await this._downloadsByItself(version, releaseDate))) return;
    await this.download({ byItself: !this.manualCheck });
  }

  /* Whether an update downloads without anyone asking (see the top). */
  async _downloadsByItself(version, releaseDate) {
    const now = Date.now();
    const out = Date.parse(releaseDate || '') || 0;
    let last = 0;
    try { last = Number(this.store.get(FETCHED_KEY)) || 0; } catch {}
    if (out && now - out < SETTLE_MS && now - last < DAY_MS) return false;
    const f = this.failedDownload;
    if (f && f.version === version && now < f.next) return false;
    let metered = false;
    try { metered = !!(await this.metered()); } catch {}
    if (metered) {
      if (this._first('metered', version)) this.log('info', `Update ${version} is not downloaded by itself on a metered connection`);
      return false;
    }
    return true;
  }

  /* The download page's link for this copy: the file itself, from the
   * mirror (the release page has every file, and GitHub may be blocked). */
  _downloadUrl(version) {
    let arch = process.arch;
    if (this.mac) { try { if (app.runningUnderARM64Translation === true) arch = 'arm64'; } catch {} }
    const name = downloadName(version, { arch, packageType: this.packageType });
    return name ? `${MIRROR_URL}/${name}` : null;
  }

  async download({ byItself = false } = {}) {
    if (byItself) { try { this.store.set(FETCHED_KEY, Date.now()); } catch {} }
    if (!this.mac) {
      // An AppImage in a folder this user cannot write to (/opt, a system
      // folder): the install would fail after protection had been stopped
      // for it, again at every start. Said at once instead, with the
      // download page.
      if (this.appImage && !this.canWrite(path.dirname(this.appImage))) {
        if (this._first('manual', this.state.version)) this.log('warning', `Update ${this.state.version}: Shroudly cannot replace itself in ${path.dirname(this.appImage)}; download it from the download page`);
        this._set({ status: 'manual', reason: 'folder' });
        return;
      }
      const version = this.state.version;
      this._set({ status: 'downloading', percent: 0 });
      try {
        // Keep the route the check succeeded on; fall back to the others.
        const routes = routesNow();
        const first = routes.includes(this.euRoute) ? this.euRoute : routes[0];
        let last;
        for (const route of [first, ...routes.filter((r) => r !== first)]) {
          try {
            await this._euRoute(route);
            // electron-updater downloads from where its last check read the
            // feed: for the mirror's turn that check is made there first, or
            // it fetched from GitHub once more.
            if ((route === 'mirror') !== (this.euRoute === 'mirror')) await this._rebind(route, version);
            await this._euDownload();
            this.failedDownload = null;
            return;
          } catch (e) { last = e; if (noSpace(e)) break; }
        }
        throw last;
      } catch (e) { this._downloadFailed(e); }
      return;
    }
    const feed = this.macFeed;
    if (!feed) return;
    // The Intel build on an Apple Silicon Mac runs under Rosetta: update it to
    // the native build, which Rosetta will not always be there for.
    let arm = process.arch === 'arm64';
    try { arm = arm || app.runningUnderARM64Translation === true; } catch {}
    const zips = feed.files.filter((f) => f.url.endsWith('.zip'));
    const file = zips.find((f) => /arm64/i.test(f.url) === arm) || zips[0];
    if (!file) { this._fail(new Error('no macOS zip in latest-mac.yml')); return; }
    if (!this._macCanReplace()) {
      // In Applications, which this account cannot change (a standard
      // account; the app put there by an administrator): downloaded all the
      // same, and installed from the button with one administrator's
      // password, never by itself. Anywhere else: moved to Applications first.
      if (this._macWhy() !== 'folder') { this._set({ status: 'manual', reason: 'location' }); return; }
      if (this.permission !== 'admin') { this.permission = 'admin'; this._set({ permission: 'admin' }); }
    }
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    // Not enough room for the zip and the app it unpacks to: nothing is
    // downloaded, and the next check (every half hour) tries again.
    if (!this._roomFor(file.size)) {
      if (this._first('space', feed.version)) this.log('warning', `Update ${feed.version} needs ${Math.ceil((file.size * SPACE_FACTOR) / 1048576)} MB of free disk space; Shroudly tries again at the next check`);
      this._set({ status: 'no-space', error: null });
      return;
    }
    let dir;
    try { dir = fs.mkdtempSync(path.join(this.dir, 'shroudly-update-')); } catch (e) { this._fail(e); return; }
    const zip = path.join(dir, path.basename(file.url));
    this._set({ status: 'downloading', percent: 0 });
    try {
      await viaRoutes(async (route) => {
        await download(`https://github.com/${OWNER}/${REPO}/releases/download/v${feed.version}/${file.url}`, zip,
          (f) => this._set({ percent: Math.round(f * 100) }), route, { stallMs: this.stallMs });
        // What is on disk, every byte of it, not what came in.
        if (!(await fileMatches(zip, file))) throw new Error('checksum mismatch');
      });
      this.macDownload = { zip, dir, version: feed.version, size: file.size, sha512: file.sha512 };
      this.failedDownload = null;
      this._downloaded(feed.version);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      this._downloadFailed(e);
    }
  }

  /* electron-updater's check made on route, so that its download goes there
   * too; it must find the version being downloaded. */
  async _rebind(route, version) {
    this.rebinding = true;
    try {
      const r = await this._euCheck();
      if (!r || !r.isUpdateAvailable || !r.updateInfo || r.updateInfo.version !== version) throw new Error(`version ${version} is not there`);
      this.euRoute = route;
    } finally { this.rebinding = false; }
  }

  /* A failed download: said, and tried by itself less and less often (half an
   * hour, an hour, two... a day at most): each try is the whole file. */
  _downloadFailed(e) {
    const version = this.state.version;
    const f = this.failedDownload && this.failedDownload.version === version ? this.failedDownload : { version, count: 0 };
    f.count += 1;
    f.next = Date.now() + Math.min(DAY_MS, CHECK_EVERY_MS * 2 ** (f.count - 1));
    this.failedDownload = f;
    this._fail(e, 'download');
  }

  /* Room on the disk for a macOS update whose zip is `bytes`. Unknown
   * counts as room. */
  _roomFor(bytes) {
    try { const s = fs.statfsSync(this.dir); return Number(s.bavail) * Number(s.bsize) >= bytes * SPACE_FACTOR; } catch { return true; }
  }

  /* The downloaded zip, gone (and its folder with it). */
  _dropMacDownload() {
    if (this.macDownload) { try { fs.rmSync(this.macDownload.dir, { recursive: true, force: true }); } catch {} }
    this.macDownload = null;
  }

  _macBundle() { return path.resolve(process.execPath, '..', '..', '..'); }

  /* We can only swap the bundle if it sits in a writable folder (not on the
   * read-only disk image it was opened from). */
  _macCanReplace() {
    const bundle = this._macBundle();
    if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/')) return false;
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); return true; }
    catch { return false; }
  }

  /* Why the bundle cannot be swapped: 'location' (opened from its disk image,
   * from Downloads, where macOS runs it from a hidden copy, or any folder but
   * Applications: moving it there is the fix, and the window offers it), or
   * 'folder' (in Applications, which this account cannot change: a standard
   * account; only the download page helps). */
  _macWhy() {
    let inApps = false;
    try { inApps = app.isInApplicationsFolder(); } catch {}
    return inApps && !this._macBundle().startsWith('/Volumes/') ? 'folder' : 'location';
  }

  /* macOS: the window's "Move to Applications". Electron moves the app there
   * (asking for an administrator's password when it must) and starts it from
   * there; it can then update itself. */
  moveToApplications() {
    if (!this.mac) return false;
    try { return app.moveToApplicationsFolder(); } catch (e) {
      this.log('warning', `Shroudly could not be moved to the Applications folder (${(e && e.message ? e.message : String(e)).split('\n')[0]})`);
      return false;
    }
  }

  _downloaded(version) {
    if (this._first('downloaded', version)) this.log('success', `Update downloaded: version ${version}`);
    // failed: its install failed before; the window says so beside the button.
    const failed = this._failedBefore(version);
    if (!this.mac && this.eu) {
      // electron-updater installs it at a quit too: not a version whose
      // install failed, nor one that asks for permission; and into the folder
      // this copy runs from (#57), which before was given only to "Restart
      // now", so an update postponed to the quit could become a second copy.
      this.eu.autoInstallOnAppQuit = !this.permission && !failed;
      const dir = installDirFor(process.execPath);
      if (dir) this.eu.installDirectory = dir;
    }
    this._set({ status: 'ready', version, percent: 100, restartAt: null, failed, byItself: this._autoInstalls() && !failed, downloadUrl: this._downloadUrl(version) });
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.auto) this._armRestart();
    // Installed only with the button (permission): said once, or it would
    // wait unseen while Shroudly sits in the tray.
    if (this.auto && this.permission && !failed && this._first('ready', version)) this.notify(version, this.permission);
  }

  /* Never by itself: an install that asks for permission, or a version whose
   * install failed before (it would fail again, and each time stop
   * protection for it). */
  _autoInstalls() { return this.auto && !this.permission; }
  _mayInstall() { return this._autoInstalls() && this.state.status === 'ready' && !this.state.failed && !this.installing; }

  _waitedMs() {
    let w = null;
    try { w = this.store.get(WAIT_KEY); } catch {}
    if (!w || !newer(w.version, app.getVersion())) return 0;
    return Math.max(0, Date.now() - (Number(w.since) || Date.now()));
  }

  /* Remembered across restarts of Shroudly: written when it begins (or the
   * route changes), not at every look. */
  _noteWaiting() {
    try {
      const w = this.store.get(WAIT_KEY);
      const route = this.euRoute || null;
      if (w && w.version === this.state.version && Number(w.since) && (w.route || null) === route) return;
      const since = w && newer(w.version, app.getVersion()) && Number(w.since) ? Number(w.since) : Date.now();
      this.store.set(WAIT_KEY, { version: this.state.version, since, route });
    } catch {}
  }

  async _plan() {
    const waitedMs = this._waitedMs();
    if (this.atLaunch) return restartPlan({ atLaunch: true, waitedMs });
    // Just woken up: the idle time counts the sleep, but someone has just
    // opened the lid.
    const woke = this.wokeAt && Date.now() - this.wokeAt >= 0 && Date.now() - this.wokeAt < AWAKE_GRACE_MS;
    let away = false;
    if (!woke) { try { away = !!this.away(); } catch {} }
    // What is running is looked at only once nobody is at the computer: the
    // program list is not read every minute of a working day.
    let busy = false;
    this.busyApps = false;
    if (away) {
      try { busy = !!(await this.busy()); } catch {}
      // Said in the log only for Roblox and Discord (its line names them).
      this.busyApps = busy;
      if (!busy) { try { busy = !!(await this.fullScreen()); } catch {} }
    }
    return restartPlan({ busy, waitedMs, away, atLaunch: false });
  }

  _stopTimers() {
    clearTimeout(this.restartTimer);
    clearTimeout(this.waitTimer);
    this.restartTimer = null;
    this.waitTimer = null;
  }

  _later(fn, ms) {
    this.waitTimer = setTimeout(fn, ms);
    if (this.waitTimer.unref) this.waitTimer.unref();
  }

  async _armRestart() {
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
    if (!this._mayInstall() || this.restartTimer) return;
    // "Later": not before the time it asked for.
    const held = this.heldUntil - Date.now();
    if (held > 0) { this._later(() => this._armRestart(), held); return; }
    const plan = await this._plan();
    if (!this._mayInstall() || this.restartTimer || this.waitTimer) return;
    if (plan === 'install') { this.install(); return; }
    if (plan === 'wait') {
      this._noteWaiting();
      this.waiting = true;
      if (this.busyApps && !this.toldWaiting) { this.toldWaiting = true; this.log('info', 'Update ready: it waits while Roblox or Discord goes through Shroudly, and installs once they are closed or the computer has not been used for a while'); }
      this._later(() => this._armRestart(), WAIT_CHECK_MS);
      return;
    }
    this.waiting = false;
    this.toldWaiting = false;
    const restartAt = Date.now() + RESTART_COUNTDOWN_S * 1000;
    this._set({ restartAt });
    this.notify(this.state.version); // "will restart to install it"
    const timer = setTimeout(() => this._restartDue(timer), RESTART_COUNTDOWN_S * 1000);
    this.restartTimer = timer;
  }

  /* The computer woke up. A countdown that ran out while it slept (or whose
   * end the window shows as past) is over: someone has just woken it, so it
   * waits again until nobody is at the computer; and for a moment nobody
   * counts as away. */
  resumed() {
    this.wokeAt = Date.now();
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this._set({ restartAt: null });
    this._armRestart().catch(() => {});
  }

  /* The countdown is over: install, unless the setting was switched off, or
   * someone came back to the computer or a game or call has started
   * meanwhile (then back to waiting). */
  async _restartDue(timer) {
    if (this.restartTimer !== timer) return;
    // Ended long after it should have: the computer slept through it (the
    // window showed it as over). Nobody saw it run out: it starts again.
    if (this.state.restartAt && Date.now() - this.state.restartAt > LATE_MS) { this.resumed(); return; }
    const plan = this._mayInstall() ? await this._plan() : null;
    if (this.restartTimer !== timer) return;   // postponed meanwhile
    this.restartTimer = null;
    if (!plan || !this._mayInstall()) { this._set({ restartAt: null }); return; }
    if (plan === 'wait') { this._set({ restartAt: null }); await this._armRestart(); return; }
    await this.install();
  }

  /* "Install updates automatically" was switched: a countdown stops at once
   * when it goes off; when it comes on, an update found or downloaded
   * meanwhile goes ahead. */
  autoChanged() {
    const failed = !!this.state.failed;
    if (this.state.status === 'ready') this._set({ byItself: this._autoInstalls() && !failed });
    if (!this.auto) { this._stopTimers(); this._set({ restartAt: null }); return; }
    if (this.state.status === 'available') this.download();
    else if (this.state.status === 'ready') this._armRestart();
  }

  /* At launch, before protection starts. An update that was waiting for the
   * computer not to be in use installs now, while nothing goes through
   * Shroudly to be interrupted. Only where the download is kept from run to
   * run (electron-updater; macOS fetches it afresh and installs on quit
   * anyway) and was fetched directly (through Shroudly it cannot be fetched
   * before protection is on), and for at most `ms`: after that protection
   * starts and the update waits as before. Resolves true once it is
   * installing. */
  installBeforeProtection(ms = LAUNCH_INSTALL_MS) {
    let w = null;
    try { w = this.store.get(WAIT_KEY); } catch {}
    if (this.mac || !this.eu || !this._autoInstalls() || this.installing || !w || !newer(w.version, app.getVersion())
      || (w.route && w.route !== 'direct') || this._failedBefore(w.version)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer = null;
      // The check found nothing, or failed: protection starts at once.
      const ended = (st) => { if (st.status === 'up-to-date' || st.status === 'error') done(false); };
      const done = (v) => { clearTimeout(timer); this.listeners.delete(ended); this.atLaunch = false; this.onInstall = null; resolve(v); };
      this.atLaunch = true;
      this.onInstall = () => done(true);
      this.listeners.add(ended);
      timer = setTimeout(() => done(false), ms);
      if (this.state.status === 'ready') this._armRestart();
      else this.check(false);
    });
  }

  /* "Later": no restart now. The update stays downloaded; it installs at the
   * next quit or start, or once LATER_MS have passed while nobody is at the
   * computer. */
  postpone() {
    this._stopTimers();
    this.heldUntil = Date.now() + LATER_MS;
    this._set({ restartAt: null });
    if (this._mayInstall()) this._later(() => this._armRestart(), LATER_MS);
  }

  async install() {
    if (this.state.status !== 'ready' || this.installing) return;
    this._stopTimers();
    this.installing = true;
    // macOS: the zip may have gone or changed since it was verified (a disk
    // tidied up, a file damaged): checked again before anything is stopped,
    // and downloaded again if it is not the one verified. Swapping in a
    // damaged one would leave Shroudly closed.
    if (this.mac && !(this.macDownload && await fileMatches(this.macDownload.zip, this.macDownload))) {
      this.installing = false;
      this.log('warning', `The downloaded update ${this.state.version} is missing or damaged; downloading it again`);
      this._dropMacDownload();
      this._set({ status: 'available', restartAt: null });
      this.download();
      return;
    }
    this.log('info', `Installing update ${this.state.version}`);
    if (this.onInstall) { try { this.onInstall(); } catch {} }
    this.installError = null;
    this.promptRefused = null;
    this.commandError = null;
    this.started = null;
    this.stopped = false;
    if (this.mac) {
      // Applications not this account's to change: the administrator's
      // password is asked first, while protection is still on; refused,
      // nothing has been stopped.
      if (this.permission === 'admin') {
        try { await this._macSwapAsAdmin(); } catch (e) { this._installFailed(e); return; }
        await this.beforeInstall();
        this.stopped = true;
        app.exit(0);
        return;
      }
      await this.beforeInstall(); // stop the engine: puts the system proxy back first
      this.stopped = true;
      try { this._macSwapOnExit(); } catch (e) { this._installFailed(e); return; }
      app.exit(0);
      return;
    }
    // A Linux package: its password is asked first, while protection is
    // still on, and Shroudly stops only once the new version is in (it is
    // started again as this one quits). A prompt refused then changes
    // nothing at all.
    const packageFirst = this.permission === 'password';
    if (!packageFirst) {
      await this.beforeInstall();
      this.stopped = true;
      // Into the folder this copy runs from (#57).
      const dir = installDirFor(process.execPath);
      if (dir) this.eu.installDirectory = dir;
    }
    // A failure comes as electron-updater's 'error' event during this call
    // (a refused password, a folder it cannot write to), or from the start
    // of the installer (_installerStarted).
    let ok = false;
    try { ok = this.eu.install(true, true) !== false; } catch (e) { this.installError = e; }
    if (!ok || this.installError) { this._installFailed(this.installError || new Error('the install did not start')); return; }
    let how;
    try { how = await this._installerStarted(); } catch (e) { this._installFailed(e); return; }
    if (packageFirst) { await this.beforeInstall(); this.stopped = true; }
    if (how === 'elevated') { this._awaitQuit(this.elevatedQuitMs); return; }
    this._awaitQuit(this.installQuitMs);
    setImmediate(() => app.quit());
  }

  /* Installing quits Shroudly. Still running ms later: it did not install. */
  _awaitQuit(ms) {
    clearTimeout(this.installWatch);
    this.installWatch = setTimeout(() => this._installFailed(this.installError || new Error('Shroudly was not closed to install it')), ms);
    try { app.once('will-quit', () => clearTimeout(this.installWatch)); } catch {}
  }

  /* The install did not happen: a password prompt dismissed or refused, no
   * prompt possible (no polkit agent), a folder it cannot write to, an
   * installer that would not start. beforeInstall had already stopped
   * protection and readied Shroudly to quit, and without this it stayed so:
   * protection off, the window's close button quitting for real, "Restart
   * now" doing nothing for the rest of the session. main.js undoes it
   * (onInstallFailed). The update stays downloaded for the button, which now
   * says it failed and offers the download page; this version is not
   * installed by itself again, here, at a quit or at a later start. */
  _installFailed(e) {
    clearTimeout(this.installWatch);
    this.installWatch = null;
    if (!this.installing) return;
    this.installing = false;
    const msg = (e && e.message ? e.message : String(e)).split('\n')[0];
    const version = this.state.version;
    this.log('warning', `Update ${version} could not be installed (${msg}); Shroudly carries on with version ${app.getVersion()}`);
    this._noteFailed(version);
    // electron-updater keeps its own "install under way", which only its
    // quitAndInstall cleared: the button could not try again.
    if (this.eu) { try { this.eu.quitAndInstallCalled = false; this.eu.autoInstallOnAppQuit = false; } catch {} }
    this._set({ status: 'ready', restartAt: null, failed: true, byItself: false, error: msg });
    // Only what was stopped for it is started again (a Linux package's
    // refused password stopped nothing).
    if (this.stopped) { this.stopped = false; try { this.onInstallFailed(); } catch {} }
  }

  /* Called on a normal quit: a downloaded macOS update installs then. On the
   * way out there is no time to hash it again: only that the zip is all
   * there. The script verifies the rest, and keeps the app as it was if the
   * update does not unpack or its signature does not check out. Not a
   * version whose install failed before. */
  installOnQuit() {
    if (!this.mac || !this.macDownload || this.installing || this.permission || this._failedBefore(this.macDownload.version)) return;
    try { if (fs.statSync(this.macDownload.zip).size !== this.macDownload.size) return; } catch { return; }
    this.installing = true;
    this._macSwapOnExit(false);
  }

  /* The swap script and what it is given (see macSwapScript). */
  _macSwapArgs(relaunch) {
    const { zip, dir, version } = this.macDownload;
    const script = path.join(dir, 'install.sh');
    fs.writeFileSync(script, macSwapScript());
    let uid = '';
    try { uid = String(process.getuid()); } catch {}
    return [script, String(process.pid), zip, dir, this._macBundle(), relaunch ? '1' : '0', path.join(this.dir, 'failed'), version, uid];
  }

  _macSwapOnExit(relaunch = true) {
    const p = spawn('/bin/sh', this._macSwapArgs(relaunch), { detached: true, stdio: 'ignore' });
    p.unref();
  }

  /* The same script, run as root once an administrator's password is given
   * (one macOS dialog, saying what it is for). It waits in the background
   * for Shroudly to quit; osascript returns as soon as it is on its way, and
   * fails when the password is refused or the dialog dismissed. */
  async _macSwapAsAdmin() {
    const q = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
    const shell = `/bin/sh ${this._macSwapArgs(true).map(q).join(' ')} </dev/null >/dev/null 2>&1 &`;
    const SystemProxy = require('./system-proxy');
    await this.osascript(['-e', SystemProxy._appleScriptAdmin(shell, true, this.adminPrompt(this.state.version))]);
  }
}

/* The script that swaps the app bundle once Shroudly has quit:
 *   $1 Shroudly's pid  $2 the zip  $3 its folder  $4 the .app  $5 1: open it afterwards
 *   $6 where to note a failure  $7 the version  $8 the user's uid
 * Whatever fails, the app that was there stays, and is opened again when the
 * update was to open it: before, a zip that would not unpack or a signature
 * that did not check out ended the script with Shroudly closed for good, and
 * protection off. The failure is noted for the next start (_readFailedNote).
 * The app is opened in the background (open -g), never over a full-screen
 * game or film, and as the user even when the script runs as root (the
 * administrator's install, _macSwapAsAdmin). The tools are passed in for the
 * tests. */
function macSwapScript({ ditto = '/usr/bin/ditto', codesign = '/usr/bin/codesign', xattr = '/usr/bin/xattr', open = '/usr/bin/open' } = {}) {
  return `#!/bin/sh
# Wait for Shroudly to exit, then replace the app bundle with the verified update.
PID="$1"; ZIP="$2"; DIR="$3"; APP="$4"; REOPEN="$5"; NOTE="$6"; VERSION="$7"; OWNER="$8"
X="$DIR/x"
as_user() {
  if [ -n "$OWNER" ] && [ "$(id -u)" = 0 ] && [ "$OWNER" != 0 ]; then /bin/launchctl asuser "$OWNER" /usr/bin/sudo -u "#$OWNER" "$@"; else "$@"; fi
}
fail() {
  echo "$VERSION $1" > "$NOTE"
  [ -n "$OWNER" ] && chown "$OWNER" "$NOTE" 2>/dev/null
  rm -rf "$DIR"
  [ "$REOPEN" = 1 ] && as_user ${open} -g "$APP" --args ${UPDATE_FAILED_ARG}
  exit 1
}
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
rm -rf "$X"; mkdir -p "$X" || fail unpack
${ditto} -x -k "$ZIP" "$X" || fail unpack
NEW=$(ls -d "$X"/*.app 2>/dev/null | head -n 1)
[ -d "$NEW" ] || fail unpack
${codesign} --verify --deep --strict "$NEW" || fail signature
rm -rf "$APP.old"
mv "$APP" "$APP.old" || fail replace
if ! mv "$NEW" "$APP"; then mv "$APP.old" "$APP"; fail replace; fi
rm -rf "$APP.old"
${xattr} -dr com.apple.quarantine "$APP" 2>/dev/null
[ "$REOPEN" = 1 ] && as_user ${open} -g "$APP" --args --updated
rm -rf "$DIR"
`;
}

module.exports = Updater;
module.exports.RELEASES_URL = RELEASES_URL;
module.exports.MIRROR_URL = MIRROR_URL;
module.exports.mirrorOf = mirrorOf;
module.exports.installDirFor = installDirFor;
module.exports.downloadName = downloadName;
module.exports.ROUTES = ROUTES;
module.exports.routesNow = routesNow;
module.exports.setSystemRoute = setSystemRoute;
module.exports.restartPlan = restartPlan;
module.exports.inUse = inUse;
module.exports.WAIT_LIMIT_MS = WAIT_LIMIT_MS;
module.exports.WAIT_KEY = WAIT_KEY;
module.exports.FAILED_KEY = FAILED_KEY;
module.exports.FETCHED_KEY = FETCHED_KEY;
module.exports.SETTLE_MS = SETTLE_MS;
module.exports.LATER_MS = LATER_MS;
module.exports.APPIMAGE_STAGE = APPIMAGE_STAGE;
module.exports.UPDATE_FAILED_ARG = UPDATE_FAILED_ARG;
module.exports.download = download;
module.exports.macSwapScript = macSwapScript;
