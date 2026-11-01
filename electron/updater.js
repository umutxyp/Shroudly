'use strict';

/*
 * Auto-update from GitHub releases (umutxyp/Shroudly).
 *
 * Checks shortly after launch and then every 30 minutes, so a closed app
 * updates on its next start and a running one within half an hour of a
 * release. With "Install updates automatically" on (default), the update
 * downloads in the background, then Shroudly restarts to install it after a
 * short countdown the user can postpone; a postponed update installs on quit.
 * While a Roblox game or Discord goes through Shroudly the restart waits for
 * them, for a few hours at most (see _armRestart).
 *
 * Windows / Linux: electron-updater (NSIS installer, AppImage, .deb), fed by
 *   the latest*.yml files electron-builder writes next to the installers.
 * macOS: electron-updater relies on Squirrel.Mac, which only accepts apps
 *   signed with an Apple Developer ID. Shroudly is ad-hoc signed, so macOS gets
 *   its own path: read latest-mac.yml, download the zip for this CPU into
 *   Shroudly's own folder, verify the SHA-512 of the file on disk, then a small
 *   script swaps the .app bundle after Shroudly quits and relaunches it.
 *
 * An install that does not happen (a password prompt dismissed, a folder that
 * cannot be written to, a download that is no longer intact) never leaves
 * Shroudly closed or half-quit: it carries on as it was, protection back on,
 * and says so in one line (_installFailed).
 *
 * Connections go direct first, so updates never depend on Shroudly's own
 * engine (a broken engine must still be able to fetch its fix), then through
 * the system proxy (= the engine) for networks where GitHub itself is blocked.
 */

const { app, net, session } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
const RESTART_COUNTDOWN_S = 60;
const WAIT_CHECK_MS = 60000;
/* How long an update waits for Roblox and Discord before it may also install
 * while the computer is not in use: nobody has touched it for AWAY_S, or the
 * screen is locked. Counted from when it first had to wait, across restarts
 * of Shroudly (WAIT_KEY), so a game or a call that is open every day cannot
 * hold it back for good. */
const WAIT_LIMIT_MS = 3 * 60 * 60 * 1000;
const AWAY_S = 10 * 60;
// After a wake, how long nobody counts as away (the idle time includes the
// sleep), and how late a countdown may end before it is taken for one that
// ran out while the computer slept.
const AWAKE_GRACE_MS = 2 * 60 * 1000;
const LATE_MS = 5000;
const WAIT_KEY = 'updateWaiting';
/* At launch, the most protection is held back for an update that is due. */
const LAUNCH_INSTALL_MS = 10000;
/* Installing quits Shroudly within a moment (electron-updater quits once the
 * installer is on its way). Still running this long after: it did not
 * install (_installFailed). */
const INSTALL_QUIT_MS = 10000;
/* A download from which nothing has arrived for this long is given up, and
 * tried on the next route; without it a connection that went silent kept the
 * update "downloading" for the rest of the session. */
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
/* How the macOS install script opens the old app again when the swap failed
 * (main.js: the same window as before, as after an update). */
const UPDATE_FAILED_ARG = '--update-failed';
/* What failed in the macOS install script, for the log. */
const MAC_STEPS = {
  unpack: 'the download could not be unpacked',
  signature: 'its signature did not check out',
  replace: 'the app could not be replaced',
};

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
function installDirFor(execPath, { platform = process.platform, canWrite = canWriteDir } = {}) {
  if (platform !== 'win32' || !/[\\/]Shroudly\.exe$/i.test(String(execPath || ''))) return null;
  const dir = path.win32.dirname(execPath);
  return canWrite(dir) ? dir : null;
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
  const files = [];
  const re = /^\s*-\s*url:\s*['"]?([^'"\s]+)['"]?\s*\n\s*sha512:\s*['"]?([^'"\s]+)['"]?\s*\n\s*size:\s*(\d+)/gm;
  let m;
  while ((m = re.exec(text))) files.push({ url: m[1], sha512: m[2], size: Number(m[3]) });
  return { version, files };
}

/* 'direct' or 'system' (through Shroudly's engine while protection is on,
 * else the OS proxy; main.js keeps it current through setSystemRoute). */
// GitHub first, direct then through the engine; the own-host mirror last.
const ROUTES = ['direct', 'system', 'mirror'];
// The mirror is a different host, reached directly (not through GitHub's
// blocked addresses); every other route is a proxy mode for GitHub.
const routeProxyMode = (route) => (route === 'system' ? 'system' : 'direct');
const routeSessions = {};
let systemRoute = { mode: 'system' };
async function routeSession(route) {
  if (!routeSessions[route]) {
    const s = session.fromPartition(`shroudly-updater-${route}`, { cache: false });
    await s.setProxy(route === 'system' ? systemRoute : { mode: routeProxyMode(route) });
    routeSessions[route] = s;
  }
  return routeSessions[route];
}
function setSystemRoute(cfg) {
  systemRoute = cfg;
  if (routeSessions.system) routeSessions.system.setProxy(cfg).catch(() => {});
}

/* Run fn(route) for each route until one succeeds. A failure on this
 * computer (e.local: the disk) would fail the same on every route. */
async function viaRoutes(fn) {
  let last;
  for (const route of ROUTES) {
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

async function fetchText(url, route) {
  const ses = await routeSession(route);
  if (route === 'mirror') url = mirrorOf(url);
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow', session: ses });
    let body = '';
    req.on('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume?.(); return; }
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
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

/* What a downloaded update does now (automatic installs on, the update
 * ready): 'install' at once, a 'countdown' the user can still postpone, or
 * 'wait' and look again. busy: Roblox or Discord goes through Shroudly.
 * atLaunch: Shroudly has just started and protection has not yet (nothing
 * goes through it to be interrupted). */
function restartPlan({ busy, waitedMs, away, atLaunch }) {
  const due = waitedMs >= WAIT_LIMIT_MS;
  if (atLaunch && due) return 'install';
  if (!busy || (due && away)) return 'countdown';
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
   * quitting). onAppImageMoved(file): the AppImage now lives at file. */
  constructor({ log, store, notify, beforeInstall, onInstallFailed, onAppImageMoved, busy, fullScreen, away, dir }) {
    this.log = log || (() => {});
    this.store = store;
    this.notify = notify || (() => {});
    this.beforeInstall = beforeInstall || (async () => {});
    this.onInstallFailed = onInstallFailed || (() => {});
    this.onAppImageMoved = onAppImageMoved || (() => {});
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
    this.asksPassword = false;   // see _initElectronUpdater
    this.appImage = null;
    // access() is exact on Linux (permissions, ACLs, a read-only disk), and
    // leaves nothing behind in the user's folder.
    this.canWrite = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
    this.told = {};
    this.state = { status: 'idle', current: app.getVersion(), version: null, percent: 0, restartAt: null, error: null, asksPassword: false };
    this.timer = null;
    this.restartTimer = null;
    this.installWatch = null;
    this.installQuitMs = INSTALL_QUIT_MS;
    this.stallMs = STALL_MS;
    this.macDownload = null; // { zip, dir, version, size, sha512 }
    this.eu = null;
    this.atLaunch = false;
    this.onInstall = null;
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
    this._clearLeftovers();
    if (!this.mac) this._initElectronUpdater();
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
    this.asksPassword = process.platform === 'linux' && !process.env.APPIMAGE;
    // An AppImage is replaced where it is (electron-updater deletes it and
    // puts the new one beside it): only in a folder this user can write to.
    this.appImage = process.platform === 'linux' ? process.env.APPIMAGE || null : null;
    this._set({ asksPassword: this.asksPassword });
    this._wire(require('electron-updater').autoUpdater);
  }

  _wire(autoUpdater) {
    this.eu = autoUpdater;
    autoUpdater.autoDownload = false;          // we decide, based on the setting
    // A downloaded update installs on quit, except where that asks for a
    // password (see asksPassword).
    autoUpdater.autoInstallOnAppQuit = !this.asksPassword;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this._set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this._set({ status: 'up-to-date' }));
    autoUpdater.on('update-available', (info) => {
      this._set({ status: 'available', version: info.version });
      this.log('info', `Update available: version ${info.version}`);
      if (this.auto) this.download();
    });
    autoUpdater.on('download-progress', (p) => this._set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => this._downloaded(info.version));
    autoUpdater.on('error', (e) => {
      // While installing: the install's own failure, which install() and
      // _awaitQuit report (_installFailed), not a failed check.
      if (this.installing) { this.installError = e; return; }
      if (!this.euQuiet) this._fail(e);
    });
    // An AppImage update installed at a quit leaves the new version under its
    // own name (Shroudly-<version>-Linux-x86_64.AppImage) and deletes the old
    // file: "Start at login" must follow it (main.js), or the next login
    // starts a file that is gone and protection stays off without a word.
    autoUpdater.on('appimage-filename-updated', (file) => { try { this.onAppImageMoved(file); } catch {} });
    this._onePrompt(autoUpdater);
  }

  /* One password prompt per install. After a failed `dpkg -i`,
   * electron-updater runs `apt-get install -f` (pacman: a refresh, then the
   * install again), each through pkexec, so a dismissed prompt came straight
   * back. Once the user has dismissed or refused it, or no prompt could come
   * up (pkexec exits 126 or 127), the rest is not asked: the same failure
   * stands for them (reset at each install). */
  _onePrompt(eu) {
    if (typeof eu.runCommandWithSudoIfNeeded !== 'function') return;
    const run = eu.runCommandWithSudoIfNeeded.bind(eu);
    eu.runCommandWithSudoIfNeeded = (cmd) => {
      if (this.promptRefused) throw this.promptRefused;
      try { return run(cmd); } catch (e) {
        if (/exited with code 12[67]\b/.test(String(e && e.message))) this.promptRefused = e;
        throw e;
      }
    };
  }

  _fail(e) {
    const msg = (e && e.message ? e.message : String(e)).split('\n')[0];
    if (msg !== this.lastLoggedError) { this.lastLoggedError = msg; this.log('warning', `Update failed: ${msg}`); }
    this._set({ status: noSpace(e) ? 'no-space' : 'error', error: msg });
  }

  /* The macOS install script failed after Shroudly had quit, and left a note
   * ("<version> <step>"): said once, and that version is not installed by
   * itself again. */
  _readFailedNote() {
    const file = path.join(this.dir, 'failed');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    try { fs.rmSync(file, { force: true }); } catch {}
    const [version, step] = text.trim().split(/\s+/);
    if (!version || !newer(version, app.getVersion())) return;
    this.log('warning', `Update ${version} could not be installed (${MAC_STEPS[step] || step || 'unknown'}); Shroudly carries on with version ${app.getVersion()}`);
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
   * full disk each left another 100 MB behind. */
  _clearLeftovers() {
    for (const base of [this.dir, this.tmp]) {
      let names = [];
      try { names = fs.readdirSync(base); } catch { continue; }
      for (const name of names.filter((n) => n.startsWith('shroudly-update-'))) {
        const p = path.join(base, name);
        try { if (Date.now() - fs.statSync(p).mtimeMs > LEFTOVER_MS) fs.rmSync(p, { recursive: true, force: true }); } catch {}
      }
    }
  }

  /* electron-updater has one network session: point it at a route. */
  async _euRoute(route) {
    await this.eu.netSession.setProxy({ mode: routeProxyMode(route) });
    // Direct and through-the-engine read the GitHub release feed; the mirror
    // reads the same feed files served on our own host (generic provider).
    try {
      if (route === 'mirror') this.eu.setFeedURL({ provider: 'generic', url: MIRROR_URL, channel: 'latest' });
      else this.eu.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO });
    } catch {}
  }

  async check(manual) {
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    if (this.state.status === 'unsupported') return this.state;
    try {
      if (!this.mac) {
        // electron-updater reports failures through its 'error' event too;
        // only the last route's failure should reach the UI.
        this.euQuiet = true;
        try {
          await viaRoutes(async (route) => { this.euRoute = route; await this._euRoute(route); await this.eu.checkForUpdates(); });
        } finally { this.euQuiet = false; }
        return this.state;
      }
      this._set({ status: 'checking', error: null });
      const feed = parseMacFeed(await viaRoutes((route) => fetchText(`${RELEASES_URL}/download/latest-mac.yml`, route)));
      if (!feed.version || !newer(feed.version, app.getVersion())) { this._set({ status: 'up-to-date' }); return this.state; }
      this._set({ status: 'available', version: feed.version });
      this.log('info', `Update available: version ${feed.version}`);
      this.macFeed = feed;
      if (this.auto || manual === 'download') await this.download();
    } catch (e) { this._fail(e); }
    return this.state;
  }

  async download() {
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
      this._set({ status: 'downloading', percent: 0 });
      try {
        // Keep the route the check succeeded on; fall back to the other one.
        const order = [this.euRoute || 'direct', ...ROUTES.filter((r) => r !== (this.euRoute || 'direct'))];
        let last;
        for (const route of order) {
          try { await this._euRoute(route); await this.eu.downloadUpdate(); return; } catch (e) { last = e; }
        }
        throw last;
      } catch (e) { this._fail(e); }
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
    if (!this._macCanReplace()) { this._set({ status: 'manual', reason: 'location' }); return; }
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
      this._downloaded(feed.version);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      this._fail(e);
    }
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

  _downloaded(version) {
    this.log('success', `Update downloaded: version ${version}`);
    // failed: its install failed before; the window says so beside the button.
    const failed = this._failedBefore(version);
    this._set({ status: 'ready', version, percent: 100, restartAt: null, failed });
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.auto) this._armRestart();
    // Installed only with the button (asksPassword): said once, or it would
    // wait unseen while Shroudly sits in the tray.
    if (this.auto && this.asksPassword && !failed && this._first('ready', version)) this.notify(version, 'password');
  }

  /* Restarting interrupts for a few seconds what goes through Shroudly: the
   * HTTPS of a Roblox game or of Discord (their game and voice traffic is not
   * proxied and carries on). So while one of them goes through Shroudly (busy)
   * the countdown does not start; it is looked at again every minute. The
   * wait has an end: after WAIT_LIMIT_MS the update also installs once nobody
   * is at the computer, and at the next launch before protection starts
   * (installBeforeProtection). Everything is looked at again when the
   * countdown ends, the setting included. Never by itself: an install that
   * asks for a password (asksPassword), or a version whose install failed
   * before (it would fail again, and each time stop protection for it). */
  _autoInstalls() { return this.auto && !this.asksPassword; }
  _mayInstall() { return this._autoInstalls() && this.state.status === 'ready' && !this.state.failed && !this.installing; }

  _waitedMs() {
    let w = null;
    try { w = this.store.get(WAIT_KEY); } catch {}
    if (!w || !newer(w.version, app.getVersion())) return 0;
    return Math.max(0, Date.now() - (Number(w.since) || Date.now()));
  }

  _noteWaiting() {
    try {
      const w = this.store.get(WAIT_KEY);
      const since = w && newer(w.version, app.getVersion()) && Number(w.since) ? Number(w.since) : Date.now();
      this.store.set(WAIT_KEY, { version: this.state.version, since, route: this.euRoute || null });
    } catch {}
  }

  async _plan() {
    let busy = false;
    try { busy = !!(await this.busy()); } catch {}
    // Said in the log only for Roblox and Discord (its line names them).
    this.busyApps = busy;
    if (!busy) { try { busy = !!(await this.fullScreen()); } catch {} }
    const waitedMs = this._waitedMs();
    let away = false;
    // Just woken up: the idle time counts the sleep, but someone has just
    // opened the lid.
    const woke = this.wokeAt && Date.now() - this.wokeAt >= 0 && Date.now() - this.wokeAt < AWAKE_GRACE_MS;
    if (busy && waitedMs >= WAIT_LIMIT_MS && !woke) { try { away = !!this.away(); } catch {} }
    return restartPlan({ busy, waitedMs, away, atLaunch: this.atLaunch });
  }

  async _armRestart() {
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
    if (!this._mayInstall() || this.restartTimer) return;
    const plan = await this._plan();
    if (!this._mayInstall() || this.restartTimer || this.waitTimer) return;
    if (plan === 'install') { this.install(); return; }
    if (plan === 'wait') {
      this._noteWaiting();
      this.waiting = true;
      if (this.busyApps && !this.toldWaiting) { this.toldWaiting = true; this.log('info', 'Update ready: it waits while Roblox or Discord goes through Shroudly, and installs once they are closed or the computer has not been used for a while'); }
      this.waitTimer = setTimeout(() => this._armRestart(), WAIT_CHECK_MS);
      if (this.waitTimer.unref) this.waitTimer.unref();
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
   * end the window shows as past) starts again from now, said again; and for
   * a moment nobody counts as away. */
  resumed() {
    this.wokeAt = Date.now();
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this._set({ restartAt: null });
    this._armRestart().catch(() => {});
  }

  /* The countdown is over: install, unless the setting was switched off or a
   * game or call has started meanwhile (then back to waiting). */
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
    if (!this.auto) { this.postpone(); return; }
    if (this.state.status === 'available') this.download();
    else if (this.state.status === 'ready') this._armRestart();
  }

  /* At launch, before protection starts. An update that has already waited
   * WAIT_LIMIT_MS (a game or a call kept it back, and nobody ever left the
   * computer alone) installs now, while nothing goes through Shroudly to be
   * interrupted. Only where the download is kept from run to run
   * (electron-updater; macOS fetches it afresh and installs on quit anyway)
   * and was fetched directly (through Shroudly it cannot be fetched before
   * protection is on), and for at most `ms`: after that protection starts
   * and the update waits as before. Resolves true once it is installing. */
  installBeforeProtection(ms = LAUNCH_INSTALL_MS) {
    let w = null;
    try { w = this.store.get(WAIT_KEY); } catch {}
    if (this.mac || !this.eu || !this._autoInstalls() || this.installing || this._waitedMs() < WAIT_LIMIT_MS || (w && w.route && w.route !== 'direct')
      || this._failedBefore(w && w.version)) return Promise.resolve(false);
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

  /* Keep the downloaded update for the next quit instead of restarting now. */
  postpone() {
    clearTimeout(this.restartTimer);
    clearTimeout(this.waitTimer);
    this.restartTimer = null;
    this.waitTimer = null;
    this._set({ restartAt: null });
  }

  async install() {
    if (this.state.status !== 'ready' || this.installing) return;
    clearTimeout(this.restartTimer);
    clearTimeout(this.waitTimer);
    this.restartTimer = null;
    this.waitTimer = null;
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
    await this.beforeInstall(); // stop the engine: puts the system proxy back first
    if (!this.mac) {
      // Into the folder this copy runs from (#57).
      const dir = installDirFor(process.execPath);
      if (dir) this.eu.installDirectory = dir;
      // A failure comes as electron-updater's 'error' event, during this
      // call (a refused password, a folder it cannot write to) or soon after
      // (an installer that would not start), and Shroudly is not quit.
      try { this.eu.quitAndInstall(true, true); } catch (e) { this.installError = e; }
      if (this.installError) { this._installFailed(this.installError); return; }
      this._awaitQuit();
      return;
    }
    try { this._macSwapOnExit(); } catch (e) { this._installFailed(e); return; }
    app.exit(0);
  }

  /* Installing quits Shroudly. Still running installQuitMs later: it did
   * not install. */
  _awaitQuit() {
    clearTimeout(this.installWatch);
    this.installWatch = setTimeout(() => this._installFailed(this.installError || new Error('Shroudly was not closed to install it')), this.installQuitMs);
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
   * installed by itself again, here or at a later start. */
  _installFailed(e) {
    clearTimeout(this.installWatch);
    this.installWatch = null;
    if (!this.installing) return;
    this.installing = false;
    const msg = (e && e.message ? e.message : String(e)).split('\n')[0];
    const version = this.state.version;
    this.log('warning', `Update ${version} could not be installed (${msg}); Shroudly carries on with version ${app.getVersion()}`);
    this._noteFailed(version);
    this._set({ status: 'ready', restartAt: null, failed: true, error: msg });
    try { this.onInstallFailed(); } catch {}
  }

  /* Called on a normal quit: a downloaded macOS update installs then. On the
   * way out there is no time to hash it again: only that the zip is all
   * there. The script verifies the rest, and keeps the app as it was if the
   * update does not unpack or its signature does not check out. */
  installOnQuit() {
    if (!this.mac || !this.macDownload || this.installing) return;
    try { if (fs.statSync(this.macDownload.zip).size !== this.macDownload.size) return; } catch { return; }
    this.installing = true;
    this._macSwapOnExit(false);
  }

  _macSwapOnExit(relaunch = true) {
    const { zip, dir, version } = this.macDownload;
    const bundle = this._macBundle();
    const script = path.join(dir, 'install.sh');
    fs.writeFileSync(script, macSwapScript());
    const p = spawn('/bin/sh', [script, String(process.pid), zip, dir, bundle, relaunch ? '1' : '0', path.join(this.dir, 'failed'), version],
      { detached: true, stdio: 'ignore' });
    p.unref();
  }
}

/* The script that swaps the app bundle once Shroudly has quit:
 *   $1 Shroudly's pid  $2 the zip  $3 its folder  $4 the .app  $5 1: open it afterwards
 *   $6 where to note a failure  $7 the version
 * Whatever fails, the app that was there stays, and is opened again when the
 * update was to open it: before, a zip that would not unpack or a signature
 * that did not check out ended the script with Shroudly closed for good, and
 * protection off. The failure is noted for the next start (_readFailedNote).
 * The tools are passed in for the tests. */
function macSwapScript({ ditto = '/usr/bin/ditto', codesign = '/usr/bin/codesign', xattr = '/usr/bin/xattr', open = '/usr/bin/open' } = {}) {
  return `#!/bin/sh
# Wait for Shroudly to exit, then replace the app bundle with the verified update.
PID="$1"; ZIP="$2"; DIR="$3"; APP="$4"; REOPEN="$5"; NOTE="$6"; VERSION="$7"
X="$DIR/x"
fail() {
  echo "$VERSION $1" > "$NOTE"
  rm -rf "$DIR"
  [ "$REOPEN" = 1 ] && ${open} "$APP" --args ${UPDATE_FAILED_ARG}
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
[ "$REOPEN" = 1 ] && ${open} "$APP" --args --updated
rm -rf "$DIR"
`;
}

module.exports = Updater;
module.exports.RELEASES_URL = RELEASES_URL;
module.exports.MIRROR_URL = MIRROR_URL;
module.exports.mirrorOf = mirrorOf;
module.exports.installDirFor = installDirFor;
module.exports.ROUTES = ROUTES;
module.exports.setSystemRoute = setSystemRoute;
module.exports.restartPlan = restartPlan;
module.exports.inUse = inUse;
module.exports.WAIT_LIMIT_MS = WAIT_LIMIT_MS;
module.exports.WAIT_KEY = WAIT_KEY;
module.exports.FAILED_KEY = FAILED_KEY;
module.exports.UPDATE_FAILED_ARG = UPDATE_FAILED_ARG;
module.exports.download = download;
module.exports.macSwapScript = macSwapScript;
