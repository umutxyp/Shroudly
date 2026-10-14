'use strict';

/*
 * Auto-update from GitHub releases (umutxyp/Shroudly).
 *
 * Checks shortly after launch and then every 30 minutes, so a closed app
 * updates on its next start and a running one within half an hour of a
 * release. With "Install updates automatically" on (default), the update
 * downloads in the background, then Shroudly restarts to install it after a
 * short countdown the user can postpone; a postponed update installs on quit.
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
const FIRST_CHECK_MS = 8000;
const CHECK_EVERY_MS = 30 * 60 * 1000;
const RESTART_COUNTDOWN_S = 60;

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
const ROUTES = ['direct', 'system'];
const routeSessions = {};
let systemRoute = { mode: 'system' };
async function routeSession(route) {
  if (!routeSessions[route]) {
    const s = session.fromPartition(`shroudly-updater-${route}`, { cache: false });
    await s.setProxy(route === 'system' ? systemRoute : { mode: route });
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

class Updater {
  constructor({ log, store, notify, beforeInstall }) {
    this.log = log || (() => {});
    this.store = store;
    this.notify = notify || (() => {});
    this.beforeInstall = beforeInstall || (async () => {});
    this.listeners = new Set();
    this.state = { status: 'idle', current: app.getVersion(), version: null, percent: 0, restartAt: null, error: null };
    this.timer = null;
    this.restartTimer = null;
    this.mac = process.platform === 'darwin';
    this.macDownload = null; // { zip, version }
    this.eu = null;
  }

  get auto() { return this.store.get('autoUpdate', true) !== false; }

  onState(fn) { this.listeners.add(fn); }
  _set(patch) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) { try { fn(this.state); } catch {} }
  }

  start() {
    if (!app.isPackaged) { this._set({ status: 'unsupported' }); return; }
    if (!this.mac) this._initElectronUpdater();
    setTimeout(() => this.check(false), FIRST_CHECK_MS);
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
  async _euRoute(route) { await this.eu.netSession.setProxy({ mode: route }); }

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
    const arm = process.arch === 'arm64';
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
    const restartAt = this.auto ? Date.now() + RESTART_COUNTDOWN_S * 1000 : null;
    this._set({ status: 'ready', version, percent: 100, restartAt });
    clearTimeout(this.restartTimer);
    if (restartAt) {
      this.notify(version); // "will restart to install it"
      this.restartTimer = setTimeout(() => this.install(), RESTART_COUNTDOWN_S * 1000);
    }
  }

  /* Keep the downloaded update for the next quit instead of restarting now. */
  postpone() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this._set({ restartAt: null });
  }

  async install() {
    if (this.state.status !== 'ready') return;
    clearTimeout(this.restartTimer);
    this.log('info', `Installing update ${this.state.version}`);
    this.installing = true;
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
[ "$5" = 1 ] && /usr/bin/open "$4"
rm -rf "$3"
`);
    const p = spawn('/bin/sh', [script, String(process.pid), zip, dir, bundle, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
    p.unref();
  }
}

module.exports = Updater;
module.exports.RELEASES_URL = RELEASES_URL;
module.exports.setSystemRoute = setSystemRoute;
