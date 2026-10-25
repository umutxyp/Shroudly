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
 *   its own path: read latest-mac.yml, download the zip for this CPU, verify its
 *   SHA-512, then a small script swaps the .app bundle after Shroudly quits and
 *   relaunches it.
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

/* Run fn(route) for each route until one succeeds. */
async function viaRoutes(fn) {
  let last;
  for (const route of ROUTES) {
    try { return await fn(route); } catch (e) { last = e; }
  }
  throw last;
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

async function download(url, dest, onProgress, route) {
  const ses = await routeSession(route);
  if (route === 'mirror') url = mirrorOf(url);
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow', session: ses });
    req.on('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(dest);
      const hash = crypto.createHash('sha512');
      res.on('data', (d) => { got += d.length; hash.update(d); out.write(d); if (total) onProgress(got / total); });
      res.on('end', () => out.end(() => resolve(hash.digest('base64'))));
      res.on('error', (e) => { out.destroy(); reject(e); });
    });
    req.on('error', reject);
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

class Updater {
  constructor({ log, store, notify, beforeInstall, busy, away }) {
    this.log = log || (() => {});
    this.store = store;
    this.notify = notify || (() => {});
    this.beforeInstall = beforeInstall || (async () => {});
    // Is something running that a restart would cut off (a game, a call)?
    this.busy = busy || (async () => false);
    this.away = away || awayFromComputer;
    this.waitTimer = null;
    this.listeners = new Set();
    this.state = { status: 'idle', current: app.getVersion(), version: null, percent: 0, restartAt: null, error: null };
    this.timer = null;
    this.restartTimer = null;
    this.mac = process.platform === 'darwin';
    this.macDownload = null; // { zip, version }
    this.eu = null;
    this.atLaunch = false;
    this.onInstall = null;
    // A wait for an update this version already has is over.
    try { const w = store.get(WAIT_KEY); if (w && !newer(w.version, app.getVersion())) store.delete(WAIT_KEY); } catch {}
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
    if (!this.mac) this._initElectronUpdater();
    // Spread over the first minutes: computers started together (a classroom,
    // an internet cafe, an office after a power cut) do not all ask and
    // download at the same moment.
    setTimeout(() => this.check(false), FIRST_CHECK_MS + Math.floor(Math.random() * FIRST_CHECK_SPREAD_MS));
    this.timer = setInterval(() => this.check(false), CHECK_EVERY_MS);
  }

  _initElectronUpdater() {
    const { autoUpdater } = require('electron-updater');
    this.eu = autoUpdater;
    autoUpdater.autoDownload = false;          // we decide, based on the setting
    autoUpdater.autoInstallOnAppQuit = true;   // a downloaded update installs on quit
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
    autoUpdater.on('error', (e) => { if (!this.euQuiet) this._fail(e); });
  }

  _fail(e) {
    const msg = (e && e.message ? e.message : String(e)).split('\n')[0];
    if (msg !== this.lastLoggedError) { this.lastLoggedError = msg; this.log('warning', `Update failed: ${msg}`); }
    this._set({ status: 'error', error: msg });
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
    if (!this._macCanReplace()) { this._set({ status: 'manual' }); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-update-'));
    const zip = path.join(dir, path.basename(file.url));
    this._set({ status: 'downloading', percent: 0 });
    try {
      const sha = await viaRoutes((route) => download(`https://github.com/${OWNER}/${REPO}/releases/download/v${feed.version}/${file.url}`, zip,
        (f) => this._set({ percent: Math.round(f * 100) }), route));
      if (sha !== file.sha512) throw new Error('checksum mismatch');
      this.macDownload = { zip, dir, version: feed.version };
      this._downloaded(feed.version);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      this._fail(e);
    }
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
    this._set({ status: 'ready', version, percent: 100, restartAt: null });
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.auto) this._armRestart();
  }

  /* Restarting interrupts for a few seconds what goes through Shroudly: the
   * HTTPS of a Roblox game or of Discord (their game and voice traffic is not
   * proxied and carries on). So while one of them goes through Shroudly (busy)
   * the countdown does not start; it is looked at again every minute. The
   * wait has an end: after WAIT_LIMIT_MS the update also installs once nobody
   * is at the computer, and at the next launch before protection starts
   * (installBeforeProtection). Everything is looked at again when the
   * countdown ends, the setting included. */
  _mayInstall() { return this.auto && this.state.status === 'ready' && !this.installing; }

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
      if (!this.waiting) { this.waiting = true; this.log('info', 'Update ready: it waits while Roblox or Discord goes through Shroudly, and installs once they are closed or the computer has not been used for a while'); }
      this.waitTimer = setTimeout(() => this._armRestart(), WAIT_CHECK_MS);
      if (this.waitTimer.unref) this.waitTimer.unref();
      return;
    }
    this.waiting = false;
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
    if (this.mac || !this.eu || !this.auto || this.installing || this._waitedMs() < WAIT_LIMIT_MS || (w && w.route && w.route !== 'direct')) return Promise.resolve(false);
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
    this.log('info', `Installing update ${this.state.version}`);
    this.installing = true;
    if (this.onInstall) { try { this.onInstall(); } catch {} }
    await this.beforeInstall(); // stop the engine: puts the system proxy back first
    if (!this.mac) { this.eu.quitAndInstall(true, true); return; }
    this._macSwapOnExit();
    app.exit(0);
  }

  /* Called on a normal quit: a downloaded macOS update installs then. */
  installOnQuit() {
    if (this.mac && this.macDownload && !this.installing) { this.installing = true; this._macSwapOnExit(false); }
  }

  _macSwapOnExit(relaunch = true) {
    const { zip, dir } = this.macDownload;
    const bundle = this._macBundle();
    const script = path.join(dir, 'install.sh');
    fs.writeFileSync(script, `#!/bin/sh
# Wait for Shroudly to exit, then replace the app bundle with the verified update.
while kill -0 "$1" 2>/dev/null; do sleep 0.3; done
X="$3/x"; rm -rf "$X"; mkdir -p "$X"
/usr/bin/ditto -x -k "$2" "$X" || exit 1
NEW=$(ls -d "$X"/*.app 2>/dev/null | head -n 1)
[ -d "$NEW" ] && /usr/bin/codesign --verify --deep --strict "$NEW" || exit 1
rm -rf "$4.old"
mv "$4" "$4.old" || exit 1
if mv "$NEW" "$4"; then rm -rf "$4.old"; else mv "$4.old" "$4"; fi
/usr/bin/xattr -dr com.apple.quarantine "$4" 2>/dev/null
[ "$5" = 1 ] && /usr/bin/open "$4" --args --updated
rm -rf "$3"
`);
    const p = spawn('/bin/sh', [script, String(process.pid), zip, dir, bundle, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
    p.unref();
  }
}

module.exports = Updater;
module.exports.RELEASES_URL = RELEASES_URL;
module.exports.MIRROR_URL = MIRROR_URL;
module.exports.mirrorOf = mirrorOf;
module.exports.ROUTES = ROUTES;
module.exports.setSystemRoute = setSystemRoute;
module.exports.restartPlan = restartPlan;
module.exports.inUse = inUse;
module.exports.WAIT_LIMIT_MS = WAIT_LIMIT_MS;
module.exports.WAIT_KEY = WAIT_KEY;
