'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, powerMonitor, dialog, session, clipboard } = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');
const os = require('os');
const netModule = require('net');
const Store = require('electron-store');
const EngineManager = require('./engine-manager');
const AdvancedMode = require('./advanced-mode');
const AdvancedProtection = require('./advanced-protection');
const DiscordApp = require('./discord-app');
const DiscordRelay = require('./discord-relay');
const AppProxy = require('./app-proxy');
const AppEnv = require('./app-env');
const RobloxApp = require('./roblox-app');
const { RobloxWatch } = require('./roblox-watch');
const Autopilot = require('./autopilot');
const StoreApps = require('./store-apps');
const BlockCheck = require('./blockcheck');
const ProcNet = require('./procnet');
const { RawWatch } = require('./raw-apps');
const BrowserCheck = require('./browser-check');
const SiteList = require('./site-list');
const Updater = require('./updater');
const Presence = require('./presence');
const i18n = require('./main-i18n');
const Families = require('./families');
const ServiceCheck = require('./service-check');
const { restoreProxy } = require('./restore-proxy');
const Launch = require('./launch');
const wake = require('./wake');
const { buildReport } = require('./log-report');
const LogGate = require('./log-gate');

/* "Shroudly --restore-proxy" runs once at login after a run that never got to
 * restore the system proxy (power loss, forced reboot), and from the watchdog
 * after a crash: restore and exit (restore-proxy.js says how, and when it
 * may ask for a macOS administrator's password). */
const RESTORE_PROXY_ARG = '--restore-proxy';
const proxyStateFile = () => path.join(app.getPath('userData'), 'proxy-state.json');
const appEnvStateFile = () => path.join(app.getPath('userData'), 'app-env.json');
if (process.argv.includes(RESTORE_PROXY_ARG)) {
  restoreProxy({
    stateFile: proxyStateFile(),
    settings: () => {
      const s = new Store();
      return { autoStart: s.get('autoStart', false), protectionOn: s.get('protectionOn', s.get('autoMode', true) !== false), language: s.get('language') };
    },
    languages: () => systemLanguages(),
    ready: () => app.whenReady().then(() => { try { if (app.dock) app.dock.hide(); } catch {} }),
    // Shroudly may already be running again (it starts at login too): its own
    // value is then left alone.
    recoverOther: () => AppEnv.recoverSync({ stateFile: appEnvStateFile() }, { onlyIfDead: true }),
  }).catch(() => {}).finally(() => app.exit(0));
  return;
}

/* The window is a few static panels: drawing them on the CPU costs nothing
 * measurable, while GPU drawing kept the GPU process 20+ MB larger for as
 * long as Shroudly runs, even after the window was closed, and spiked it to
 * about 200 MB on a first paint. */
app.disableHardwareAcceleration();
const store = new Store();
let mainWindow = null;
let tray = null;
let engine = null;
let advanced = null;
// Lines about a host that cannot be reached: the first at once, then at most
// one every half hour per host and kind (log-gate.js).
const logGate = new LogGate();
let updater = null;
let presence = null;
let systemLogs = [];
let exitInProgress = false;
let discordRelay = null;
// Logout, shutdown or an update restart: leave Discord's line in place, so a
// Discord that starts at the next login finds the relay as soon as we are up.
let keepDiscordLine = false;
let appProxy = null;
let autopilot = null;
// Apps whose own connections cannot get through, named and told (raw-apps.js).
const rawWatch = new RawWatch({
  log: (level, msg) => addLog(level, msg),
  tell: (id, params) => autoTell(id, params),
  owner: async (cport) => {
    const o = engine && engine.port ? await ProcNet.owner(cport, engine.port) : null;
    return o && o.name;
  },
});
let storeApps = null;
let appEnv = null;
let siteList = null;

const isDev = !app.isPackaged;
const DEV_PORT = process.env.PORT || 3000;
const AUTOSTART_ARG = '--autostart';

function appVersion() {
  try { return app.isPackaged ? app.getVersion() : require('../package.json').version; }
  catch { return app.getVersion(); }
}

/* Windows groups the taskbar button and shows notifications under this ID; it
 * must match build.appId so the installer's shortcuts carry the same identity. */
if (process.platform === 'win32') app.setAppUserModelId('me.codeshare.shroudly');

/* ── single instance ─────────────────────────────────────────────────────── */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

/* ── crash / hard-exit safety: restore the system proxy synchronously ─────── */
process.on('exit', () => {
  // The environment first: it is what fails outright when left behind.
  try { if (appEnv && appEnv.applied) appEnv.clearSync(); } catch {}
  try { engine && engine.cleanupSync(); } catch {}
  try { advanced && advanced.cleanupSync(); } catch {}
});
process.on('uncaughtException', (err) => {
  console.error('[Shroudly] uncaught:', err);
  if (!exitInProgress) shutdownAndQuit();
});
process.on('unhandledRejection', (r) => console.error('[Shroudly] rejection:', r));

/* ── helpers ─────────────────────────────────────────────────────────────── */
/* Icons live in public/ during development; packaged builds copy them to the
 * root of resources/ (see build.extraResources in package.json). */
function iconAssetPath(file) {
  return app.isPackaged
    ? path.join(process.resourcesPath, file)
    : path.join(__dirname, '..', 'public', file);
}

function addLog(level, message) {
  const entry = { timestamp: new Date().toISOString(), level, message };
  systemLogs.push(entry);
  if (systemLogs.length > 500) systemLogs = systemLogs.slice(-500);
  toWindow('log:new', entry);
}

function isAutoStartLaunch() {
  if (process.argv.includes(AUTOSTART_ARG)) return true;
  // macOS login items get no arguments
  if (process.platform === 'darwin') { try { return app.getLoginItemSettings().wasOpenedAtLogin; } catch {} }
  return false;
}

let lastBlockedNotice = 0;

/* Count only while protected, and only if the user left it on. */
function syncPresence() {
  if (!presence) return;
  const wanted = store.get('shareOnlineCount', true) !== false &&
                 !!(engine && engine.active);
  // The first ping waits for our own SOCKS rule: sent a moment earlier it
  // would be routed by the system's PAC file, and Chromium would start (and
  // keep) a proxy-resolver process just for that.
  if (wanted && presence.stopped) ownProxyReady.then(() => { if (presence.stopped && engine && engine.active) presence.restart(); });
  else if (!wanted && !presence.stopped) presence.leave();
}

function notify(title, body) {
  if (store.get('showNotifications', true) && Notification.isSupported()) {
    try { new Notification({ title, body, icon: trayIconPath() }).show(); } catch {}
  }
}

/* "Copy logs": the whole log with a short header (log-report.js), to the
 * clipboard. Nothing is sent anywhere. */
function copyLogs() {
  const report = buildReport({
    version: appVersion(),
    os: `${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform} ${(() => { try { return process.getSystemVersion(); } catch { return os.release(); } })()}`,
    arch: process.arch,
    protection: engine && engine.isActive() ? 'on' : engine && engine.coming ? 'starting' : 'off',
    routeMode: store.get('routeMode') === 'listed' ? 'listed' : 'all',
    advanced: { on: !!(advanced && advanced.active), available: !!(advanced && advanced.available()) },
    discordMode: store.get('discordMode') === true,
    appsMode: store.get('appMode') === true,
    storeApps: process.platform === 'win32' ? store.get('storeAppsMode') === true : null,
  }, systemLogs);
  try { clipboard.writeText(report); } catch { return { ok: false }; }
  return { ok: true, lines: systemLogs.length, chars: report.length };
}

/* ── tray + status ───────────────────────────────────────────────────────── */
function trayIconPath() {
  return process.platform === 'win32' ? iconAssetPath('icon.ico')
                                      : iconAssetPath('icon-small.png');
}

/* macOS menu bar: monochrome template images (sources in scripts/tray-icons)
 * that macOS tints for light and dark menu bars; @2x/@3x are picked up
 * automatically. A solid pupil means protection is on. Elsewhere: app icon. */
function makeTrayIcon(active = false) {
  try {
    if (process.platform === 'darwin') {
      const img = nativeImage.createFromPath(iconAssetPath(active ? 'trayTemplate.png' : 'trayInactiveTemplate.png'));
      img.setTemplateImage(true);
      return img;
    }
    const img = nativeImage.createFromPath(trayIconPath());
    return img.isEmpty() ? nativeImage.createEmpty() : img;
  } catch { return nativeImage.createEmpty(); }
}

function systemLanguages() {
  try { return app.getPreferredSystemLanguages(); } catch { return [app.getLocale()]; }
}

/* Main-process strings in the user's chosen language, else the OS language. */
function tr() {
  return i18n.strings(i18n.resolveLanguage(store.get('language'), systemLanguages()));
}

let trayActive = false;
function rebuildTrayMenu(active = trayActive) {
  trayActive = active;
  if (!tray) return;
  const s = tr();
  const state = active ? s.trayActive : s.trayInactive;
  const menu = Menu.buildFromTemplate([
    { label: s.trayOpen, click: () => showWindow() },
    { type: 'separator' },
    { label: `${s.trayStatus}: ${state}`, enabled: false },
    {
      label: active ? s.trayStop : s.trayStart,
      click: async () => { active ? await safeStop({ user: true }) : await safeStart({ user: true }); },
    },
    { type: 'separator' },
    { label: s.trayCopyLogs, click: () => { copyLogs(); notify('Shroudly', s.notifyLogsCopied); } },
    { label: s.trayQuit, click: () => { app.isQuitting = true; shutdownAndQuit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Shroudly — ${state}`);
  if (process.platform === 'darwin') tray.setImage(makeTrayIcon(active));
}

/* The icon in the notification area (the menu bar on macOS), unless the user
 * hid it in Settings (issue #12). Shroudly keeps running in the background
 * all the same, and starting it again (Start menu, Applications, the
 * desktop's launcher) brings the window back: see 'second-instance'. */
const trayWanted = () => store.get('showTrayIcon', true) !== false;
function setTrayIcon(on) {
  if (on && !tray) {
    tray = new Tray(makeTrayIcon(trayActive));
    rebuildTrayMenu();
    tray.on('click', () => showWindow());
  } else if (!on && tray) {
    tray.destroy();
    tray = null;
  }
}

/* Resolves once it is known whether the tray icon can be seen at all
 * (launch.js): how Shroudly comes up at launch depends on it. */
function createTray() {
  setTrayIcon(trayWanted());
  return checkTrayHost();
}

/* Without a visible tray icon (a stock GNOME), the window is minimised
 * instead of sent to the tray, and never closed for being idle. */
let trayVisible = true;
async function checkTrayHost() {
  trayVisible = await Launch.trayVisible();
  if (!trayVisible) addLog('info', 'No tray on this desktop: the window is minimised instead of closed');
}

/* May the window go away entirely (closed to the background, or released
 * when idle)? Yes when there is a tray icon to come back through, and when
 * the user hid the icon on purpose: they come back by starting Shroudly
 * again. Only a desktop with no tray at all, where the user did not choose
 * that, keeps the window minimised instead, so it never vanishes. */
const canLeave = () => trayVisible || !trayWanted();

/* Does a host go through Shroudly? Always, unless the user routes only listed
 * sites. Asked for every connection Games and apps mode carries, so the
 * answer comes from memory; it is rebuilt when the routing settings or the
 * list change. */
let routing = null;
function isRouted(host) {
  if (!routing) {
    const custom = store.get('siteList');
    routing = {
      listed: store.get('routeMode') === 'listed',
      // The same list the PAC routes (engine-manager.js): a family named in a
      // custom list counts whole (families.js).
      set: new Set(Families.expand(Array.isArray(custom) ? custom : (siteList ? siteList.domains : [])).map((d) => String(d).toLowerCase())),
    };
  }
  if (!routing.listed) return true;
  for (let h = host; h; h = h.includes('.') ? h.slice(h.indexOf('.') + 1) : '') if (routing.set.has(h)) return true;
  return false;
}

/* The automatic site list: checked once protection has settled, then at most
 * once a day while it stays on (site-list.js says why only then). A newer
 * list takes effect at once for "only listed sites", unless the user keeps a
 * list of their own. */
const SITE_LIST_EVERY_MS = 24 * 60 * 60 * 1000;
let siteListTimer = null;
function scheduleSiteListCheck(delayMs) {
  clearTimeout(siteListTimer);
  siteListTimer = setTimeout(async () => {
    if (!siteList || !engine || !engine.isActive()) return;
    // Only someone routing by the automatic list needs it.
    if (store.get('routeMode') !== 'listed' || Array.isArray(store.get('siteList'))) return;
    if (Date.now() - siteList.checkedAt < SITE_LIST_EVERY_MS - 60000) return;
    if (!(await siteList.refresh())) return;
    if (engine.updateSiteList()) addLog('info', 'Proxy routing updated');
    routing = null;
    toWindow('sitelist:changed', siteList.info());
  }, delayMs);
}
setInterval(() => { if (engine && engine.isActive()) scheduleSiteListCheck(0); }, 60 * 60 * 1000).unref();

/* Shroudly's own requests (the live count, update checks) go through the
 * engine while protection is on, as they always have, but by a fixed SOCKS
 * rule rather than the system's PAC file: following the PAC keeps a Chromium
 * proxy-resolver process (about 10 MB) alive just to read our own file.
 * Protection off: whatever the system says, as before. */
let ownProxyKey = null;
let ownProxyReady = Promise.resolve();   // settles once the rule is in force
function syncOwnProxy() {
  const port = engine && engine.isActive() ? engine.port : null;
  const cfg = port ? { proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: '<local>' } : { mode: 'system' };
  const key = JSON.stringify(cfg);
  if (key === ownProxyKey) return ownProxyReady;
  ownProxyKey = key;
  ownProxyReady = Promise.all([
    ...[session.defaultSession, session.fromPartition('electron-updater', { cache: false })].map((s) => s.setProxy(cfg)),
    // Chromium's own requests that belong to no session (Windows makes some).
    app.setProxy(cfg),
  ].map((p) => Promise.resolve(p).catch(() => {})));
  Updater.setSystemRoute(cfg);
  return ownProxyReady;
}

function broadcastStatus(active) {
  syncOwnProxy();
  if (active) scheduleSiteListCheck(20000);
  rebuildTrayMenu(active);
  toWindow('dpi:status-changed', active);
}

/* ── window ──────────────────────────────────────────────────────────────── */
/* The window is most of what Shroudly costs: a renderer with the whole
 * interface in it and the GPU work to draw it. Protection, the tray and
 * everything else live in this process and never need it. So the window is
 * closed for real, not just hidden, whenever nobody is using it: when it goes
 * to the tray, and when it has sat unused for a few minutes (not focused, or
 * focused with nobody at the computer), which also covers the many people who
 * never send it to the tray at all. Opening Shroudly again builds a new one
 * in well under a second; it asks this process for the current state. */
const IDLE_RELEASE_MS = Math.max(1000, Number(process.env.SHROUDLY_IDLE_RELEASE_MS) || 3 * 60 * 1000);
let lastActive = Date.now();
let uiReady = false;          // the current window listens for one-off notices
let releaseToken = 0;         // a release in progress is called off by bumping it
let modalOpen = 0;            // a dialog belongs to the window: keep it
let idleNoticeShown = false;
let idleTimer = null;
const loading = new WeakSet();  // windows still loading on their way to the screen
/* Windows the user sent to the background (closed to the tray, or hidden
 * with the icon off) before they had appeared: ready-to-show leaves them be. */
const sentAway = new WeakSet();
// One-off notices that must not be lost while there is no window: the latest
// of each is shown once the next window is up.
const STICKY = new Set(['dpi:need-restart', 'dpi:dns-auto-enabled', 'dpi:site-blocked', 'dpi:service-refused']);
const pending = new Map();

function windowAlive() { return !!(mainWindow && !mainWindow.isDestroyed()); }

/* macOS: a Dock icon only while the window is open. With the window closed
 * Shroudly lives in the menu bar, like the taskbar button that goes with the
 * window on Windows and Linux; opening it from the menu bar, Spotlight or
 * Launchpad brings the icon back with the window. */
function setDockIcon(visible) {
  if (process.platform !== 'darwin' || !app.dock) return Promise.resolve();
  try {
    if (visible) return Promise.resolve(app.dock.show()).catch(() => {});
    app.dock.hide();
  } catch {}
  return Promise.resolve();
}

function toWindow(channel, payload) {
  const sticky = STICKY.has(channel);
  if (windowAlive() && (uiReady || !sticky)) { try { mainWindow.webContents.send(channel, payload); } catch {} return; }
  if (sticky) pending.set(channel, payload);
}

function markActive() { lastActive = Date.now(); }

function showWindow() {
  releaseToken++;
  markActive();
  if (!windowAlive()) { createWindow({ show: true }); return; }
  sentAway.delete(mainWindow);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* Close the window and free everything it held. The interface is first told
 * to save what is being typed (a field saves when it loses focus). */
async function releaseWindow(reason) {
  if (!windowAlive() || modalOpen > 0) return;
  const win = mainWindow;
  const token = ++releaseToken;
  const wasOnScreen = win.isVisible() && !win.isMinimized();
  try { win.webContents.send('ui:release'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  if (token !== releaseToken || win.isDestroyed() || modalOpen > 0) return;
  if (reason === 'idle' && (Date.now() - lastActive < IDLE_RELEASE_MS)) return;
  if (mainWindow === win) { mainWindow = null; uiReady = false; }
  win.destroy();
  if (reason === 'idle' && wasOnScreen && !idleNoticeShown) {
    idleNoticeShown = true;
    notify('Shroudly', trayWanted() ? tr().trayMinimized : tr().trayHiddenRunning);
  }
}

function idleCheck() {
  // Just woken up (or the clock jumped): the time asleep is no time unused.
  if (wake.check()) return;
  if (!windowAlive() || !canLeave()) return;
  const w = mainWindow;
  if (loading.has(w)) return;   // not shown yet because it is still loading
  if (!w.isVisible()) { releaseWindow('hidden'); return; }
  if (Date.now() - lastActive < IDLE_RELEASE_MS) return;
  if (w.isFocused() && !w.isMinimized()) {
    // In front of the user: only once the computer itself has been idle too.
    let idleMs = 0;
    try { idleMs = powerMonitor.getSystemIdleTime() * 1000; } catch {}
    if (idleMs < IDLE_RELEASE_MS) return;
  }
  releaseWindow('idle');
}

function startIdleWatch() {
  if (idleTimer) return;
  idleTimer = setInterval(idleCheck, Math.min(15000, Math.max(250, Math.floor(IDLE_RELEASE_MS / 4))));
  idleTimer.unref();
}

/* Windows announces logoff and shutdown to windows, not to the app. With the
 * main window gone most of the time, a hidden window without any web content
 * (no renderer, next to no memory) is kept just to hear it. */
let sessionWatch = null;
function watchSessionEnd() {
  if (process.platform !== 'win32' || sessionWatch) return;
  try {
    const { BaseWindow } = require('electron');
    sessionWatch = new BaseWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false });
    sessionWatch.on('query-session-end', () => { keepDiscordLine = discordLineOutlivesSession(); });
    sessionWatch.on('session-end', restoreForSessionEnd);
  } catch (e) { addLog('warning', `Logoff watch not available: ${e.message}`); }
}

async function checkDevServer() {
  if (!isDev) return false;
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get(`http://localhost:${DEV_PORT}`, (res) => resolve(res.statusCode === 200));
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

async function createWindow({ show = true, minimised = false } = {}) {
  uiReady = false;
  if (show) await setDockIcon(true);
  const win = new BrowserWindow({
    width: 460, height: 760,
    minWidth: 360, minHeight: 560,
    maxWidth: 720, maxHeight: 1100,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      // On Windows and Linux Chromium's spellchecker downloads dictionaries
      // from Google when the window opens: a request to Google from a
      // circumvention tool, and memory, for two plain text fields (a site
      // name and a list of domains) that need no spelling help.
      spellcheck: false,
    },
    icon: trayIconPath(),
    title: 'Shroudly — Unseen. Unstoppable.',
    // Native window buttons drawn over our own title bar (components/TitleBar):
    // traffic lights on macOS, the system caption buttons on Windows/Linux.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 13, y: 12 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b0f17', symbolColor: '#a3afc4', height: 36 } }),
    backgroundColor: '#0b0f17',
    show: false,
  });
  mainWindow = win;
  if (show) loading.add(win);
  markActive();
  startIdleWatch();

  let startUrl;
  if (isDev && await checkDevServer()) {
    startUrl = `http://localhost:${DEV_PORT}`;
  } else {
    const indexPath = path.join(__dirname, '..', 'out', 'index.html');
    if (!fs.existsSync(indexPath)) {
      const { dialog } = require('electron');
      dialog.showErrorBox('Build Required', 'Build files not found.\n\nRun: npm run build');
      app.quit();
      return;
    }
    startUrl = url.format({ pathname: indexPath, protocol: 'file:', slashes: true });
  }

  win.loadURL(startUrl);

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (target !== win.webContents.getURL()) e.preventDefault();
  });
  // A crashed or killed renderer leaves an empty window: start it afresh.
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit' || win.isDestroyed()) return;
    addLog('warning', `Window process ended (${d.reason}); reopening`);
    const visible = win.isVisible();
    if (mainWindow === win) { mainWindow = null; uiReady = false; }
    win.destroy();
    if (visible) createWindow({ show: true });
  });

  win.once('ready-to-show', () => {
    loading.delete(win);
    // Closed (sent to the background) before it had even appeared: it must
    // not then pop up by itself.
    if (!show || win.isDestroyed() || sentAway.has(win)) return;
    markActive();
    // In the taskbar without taking the screen (a quiet start with no tray).
    if (minimised) { win.showInactive(); win.minimize(); return; }
    win.show(); win.focus();
  });
  // A page that never finishes loading must not keep the window forever.
  if (show) setTimeout(() => loading.delete(win), 30000).unref();
  win.on('focus', markActive);
  win.on('show', markActive);
  win.on('show', askProxyRecovery);
  win.on('restore', markActive);
  win.on('hide', () => { setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) releaseWindow('hidden'); }, 1000); });
  win.on('closed', () => {
    if (mainWindow === win) { mainWindow = null; uiReady = false; }
    if (!windowAlive()) setDockIcon(false);
  });

  win.on('close', (e) => {
    if (!app.isQuitting && store.get('minimizeToTray', true)) {
      e.preventDefault();
      if (!canLeave()) { win.minimize(); return; }
      sentAway.add(win);
      win.hide();
      notify('Shroudly', trayWanted() ? tr().trayMinimized : tr().trayHiddenRunning);
    }
  });
}

/* ── engine lifecycle wrappers ───────────────────────────────────────────── */
/* Whether protection should be on is the user's call alone: it changes only
 * when they press Start or Stop (window or tray), and Shroudly comes back
 * that way after a restart, an update, a crash or a reboot. Sleep, waking,
 * locking the screen or closing the lid never change it. */
const PROTECTION_KEY = 'protectionOn';

/* Before there was a setting for that, Auto mode alone decided, and it still
 * does for anyone who has not pressed Start or Stop since. */
/* Discord app mode and Games and apps mode carry other programs'
 * connections. While protection is on its way up (the start at launch, a
 * start under way, the engine restarting after a crash or a settings change)
 * a new connection waits for it, at most ENGINE_WAIT_MS, instead of going out
 * directly: on a filtering network that fails, and Discord's updater and
 * Roblox then report errors ("retrying", "failed to load critical settings")
 * that look as if Shroudly did not work. */
const ENGINE_WAIT_MS = 15000;
let launchStartPending = false;
function engineComing() {
  if (!engine || engine.isActive() || !protectionWanted()) return false;
  return launchStartPending || engine.coming;
}
async function waitForEngine() {
  const until = Date.now() + ENGINE_WAIT_MS;
  while (engineComing() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
}

function protectionWanted() { return !!store.get(PROTECTION_KEY, store.get('autoMode', true) !== false); }

/* macOS: settings a restart of the Mac left waiting for an administrator's
 * password (EngineManager.recoverProxyAsAdmin). Asked by itself only with
 * the window on screen and protection staying off, never from the tray
 * alone; once the user dismissed it, only the window's button asks. */
function askProxyRecovery() {
  if (!engine || engine.isActive() || protectionWanted()) return;
  const windowShown = windowAlive() && mainWindow.isVisible() && !mainWindow.isMinimized();
  engine.recoverProxyAsAdmin({ windowShown }).catch(() => {});
}

/* Advanced mode as part of protection: it stops with it, comes back at the
 * user's next Start when their Stop took it down, and a Stop wins over a
 * start on protection's behalf still waiting for its permission prompt (the
 * return, the autopilot's ask). The Settings panel's own start does not go
 * through it (advanced-protection.js). */
const advancedProtection = new AdvancedProtection({
  active: () => !!(advanced && advanced.active),
  start: () => startAdvanced(),
  // After the Store apps' permission prompt, if one is on screen.
  ready: async () => { if (storeApps) await storeApps.settled(); },
  stop: async () => {
    try { await advanced.stop(); } catch {}
    toWindow('advanced:state', { active: false });
  },
  // A crash restart or a settings restart under way is still protection on.
  protectionOn: () => !!(engine && (engine.isActive() || engine.coming)),
  antiCheat: () => Autopilot.antiCheatRunning(),
  declined: () => { if (autopilot) autopilot.recordDecline(); },
  log: (level, msg) => addLog(level, msg),
});

async function safeStart({ user = false } = {}) {
  if (user) store.set(PROTECTION_KEY, true);
  try {
    const r = await engine.start();
    broadcastStatus(true);
    notify('Shroudly', tr().trayStarted);
    syncPresence();
    if (user) advancedProtection.started().catch(() => {});
    // Whether this network blocks what the installed apps need, before they
    // are opened (autopilot.js); soon: a Roblox installer a script started at
    // login waits for this verdict. And whether Microsoft Store apps can
    // reach Shroudly (store-apps.js).
    setTimeout(() => { if (autopilot) autopilot.survey().catch(() => {}); }, 1000);
    setTimeout(() => { if (storeApps) storeApps.survey().catch(() => {}); }, 3000);
    robloxWatch.warm();
    return r || { success: true };
  } catch (e) {
    addLog('error', `Start failed: ${e.message}`);
    broadcastStatus(false);
    return { success: false, error: e.message };
  }
}

async function safeStop({ user = false } = {}) {
  if (user) store.set(PROTECTION_KEY, false);
  // Nothing of Roblox's is stopped or started once protection is going off.
  robloxWatch.halt();
  // A settings change still waiting to be applied belongs to the session
  // being stopped (EngineManager ignores one that slips through anyway).
  clearTimeout(engineRestartTimer); engineRestartTimer = null;
  clearTimeout(proxyReapplyTimer); proxyReapplyTimer = null;
  try {
    // The user's own stop: the only one that may ask for a macOS
    // administrator's password, and that takes out what was written for the
    // next login (system-proxy.js).
    // Advanced mode is part of protection: stopping protection must also stop
    // its packet interception, or WinDivert / NFQUEUE would keep injecting
    // decoys into every outbound connection after the user turned protection
    // off. (A crash or quit already stops both; this is the user's Stop.)
    // A start on protection's behalf still waiting for its prompt is
    // stopped when it comes up (advanced-protection.js).
    await advancedProtection.stopped({ user });
    await engine.stop({ user });
    broadcastStatus(false);
    notify('Shroudly', tr().trayStopped);
    syncPresence();
    return { success: true };
  } catch (e) {
    addLog('error', `Stop failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/* Quit through before-quit, which stops the engine and restores the proxy. */
function shutdownAndQuit() {
  app.isQuitting = true;
  app.quit();
}

/* ── auto-start (per-OS, no elevation) ───────────────────────────────────── */
/* Windows Run-key value name. 2.0.0 registered under Electron's default
 * AppUserModelId; that entry is removed so it can't keep starting the app. */
const WIN_LOGIN_ITEM = { path: process.execPath, args: [AUTOSTART_ARG], name: 'Shroudly' };
const WIN_LEGACY_LOGIN_NAMES = ['electron.app.Shroudly', 'me.codeshare.shroudly'];

/* The real executable on disk: inside an AppImage, process.execPath is a
 * temporary mount that is gone after a reboot. */
function launcherPath() { return process.env.APPIMAGE || process.execPath; }

function setAutoStart(enable) {
  try {
    if (process.platform === 'win32') {
      for (const name of WIN_LEGACY_LOGIN_NAMES) app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, name });
      app.setLoginItemSettings({ ...WIN_LOGIN_ITEM, openAtLogin: enable });
      return true;
    }
    if (process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: enable });
      return true;
    }
    const dir = path.join(app.getPath('home'), '.config', 'autostart');
    const file = path.join(dir, 'shroudly.desktop');
    if (enable) {
      const q = (a) => `"${String(a).replace(/(["`$\\])/g, '\\$1')}"`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file,
        `[Desktop Entry]\nType=Application\nName=Shroudly\nExec=${q(launcherPath())} ${AUTOSTART_ARG}\nX-GNOME-Autostart-enabled=true\n`);
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    return true;
  } catch (e) {
    addLog('error', `Auto-start: ${e.message}`);
    return false;
  }
}

function getAutoStartEnabled() {
  if (process.platform === 'linux') {
    return fs.existsSync(path.join(app.getPath('home'), '.config', 'autostart', 'shroudly.desktop'));
  }
  try { return app.getLoginItemSettings(process.platform === 'win32' ? WIN_LOGIN_ITEM : undefined).openAtLogin; } catch { return false; }
}

/* ── app ready ───────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  const restoreCommand = {
    exe: launcherPath(),
    args: app.isPackaged ? [RESTORE_PROXY_ARG] : [app.getAppPath(), RESTORE_PROXY_ARG],
  };
  // The engine binary in its watchdog mode, which runs restoreCommand should
  // Shroudly vanish with something applied (watchdog.js).
  const watchdog = {
    core: EngineManager.coreBinaryPath(),
    restore: restoreCommand,
    copyDir: app.getPath('userData'),
    execPath: process.execPath,
    script: path.join(__dirname, 'proxy-watchdog.js'),
  };
  siteList = new SiteList({
    cacheFile: path.join(app.getPath('userData'), 'site-list.json'),
    log: addLog,
    getSocksPort: () => (engine && engine.isActive() ? engine.port : null),
  });
  engine = new EngineManager(store, {
    addLog, onStatusChange: broadcastStatus,
    siteList: () => siteList.domains,
    // A site still blocked while Advanced mode is on: nothing to suggest.
    advancedOn: () => !!(advanced && advanced.active),
    // One line per unreachable host every half hour, wherever it comes from
    // (the engine, Games and apps, the Discord relay).
    logGate,
    // Connections under the domain of Discord's voice servers, told to the
    // autopilot, which takes one to a voice server's own name for a call
    // starting, in the app or a browser (autopilot.js).
    watch: Autopilot.WATCH,
    proxyOptions: {
      stateFile: proxyStateFile(), watchdog, restoreCommand,
      // macOS's administrator password dialog says why Shroudly asks, in the
      // user's language once main-i18n.js has these strings; system-proxy.js
      // falls back to English.
      adminPrompt: (kind) => tr()[kind === 'restore' ? 'proxyAdminPromptRestore' : 'proxyAdminPrompt'],
    },
    onProbe: (p) => { onProbeResult(p).catch(() => toWindow('dpi:probe-result', p)); },
    // What the window should say about this network: another VPN running,
    // the kind of filtering detected, sites that connect and are then cut,
    // encrypted DNS blocked.
    onAdvice: (advice) => {
      toWindow('dpi:advice', advice);
      // A cut the engine believes (enough of them, not one stalled
      // connection): about a service the autopilot looks after, and what
      // Advanced mode is for.
      if (advice && advice.cut && advice.cut.host && autopilot) {
        autopilot.noteHost('cut', advice.cut.host, { believed: true });
        autopilot.needAdvanced(advice.cut.host).catch(() => {});
      }
    },
    // Encrypted DNS was switched back on because a site could not be reached
    // without it. The settings screen has to show the new state.
    onDnsAutoEnabled: (host) => {
      toWindow('dpi:dns-auto-enabled', { host });
    },

    // Programs that were already open when protection started are still using
    // the connection they were given at launch.
    onNeedRestart: (apps) => {
      // Shown inside the window only. As a system notification this reads like
      // something has gone wrong with the program it names, which is alarming
      // and untrue — nothing happened to it, it simply started before the
      // protection did.
      toWindow('dpi:need-restart', { apps });
    },

    // What really happened to the system proxy (system-proxy.js): set, needs
    // an administrator (macOS standard account), not possible on this desktop,
    // refused, or taken over by another program. Shown in the window.
    onProxyStatus: (st) => toWindow('dpi:proxy-status', st),
    // macOS: settings from before a restart still waiting for an
    // administrator's password, after the user dismissed its dialog.
    onProxyRecovery: (r) => toWindow('dpi:proxy-recovery', r),
    // An app's own connections (not TLS or HTTP) that cannot get through:
    // named and told in one line (raw-apps.js).
    onRaw: (kind, msg) => { if (rawWatch) rawWatch.onEvent(kind, msg).catch(() => {}); },
    // Which services this network filters (the autopilot turns on the mode
    // their app needs), and a site whose connections keep being answered and
    // then cut: the site may be turning the user away itself (checked, then
    // explained). Only once the cuts are as many as the engine needs before
    // it believes them (one means little), and only for a site's own page:
    // a CDN, API or storage host answers / with an error page of its own.
    onHostEvent: (kind, host, detail, info) => {
      if (autopilot) autopilot.noteHost(kind, host, info || { note: detail });
      if (kind === 'cut' && repeatedCut(host, detail) && ServiceCheck.isMainName(host)) checkServiceOnce(host).catch(() => {});
    },
    // A site that defeated every technique. Told once per site, and at most
    // once every few minutes, so a page full of blocked resources cannot turn
    // into a stream of notifications.
    onSiteBlocked: (host) => {
      // The autopilot first: its line about Advanced mode reaches the window
      // before the site does. The window shows its own offer only when the
      // autopilot does not ask (declined earlier, turned off by hand, asked
      // already this session). Not held back by the pause between
      // notifications below: the autopilot asks once a session anyway, and
      // the site that needs it (Discord's gateway, say) may come minutes
      // after another site was told.
      const asked = !!(autopilot && autopilot.willAskAdvanced());
      if (asked) autopilot.needAdvanced(host).catch(() => {});
      const now = Date.now();
      if (now - lastBlockedNotice < 5 * 60 * 1000) return;
      lastBlockedNotice = now;
      // With Advanced mode already on there is nothing to suggest: it is
      // still being tried.
      const advOn = !!(advanced && advanced.active);
      notify(tr().notifySiteBlockedTitle, (advOn ? tr().notifySiteBlockedBodyAdvancedOn : tr().notifySiteBlockedBody).replace('{host}', host));
      toWindow('dpi:site-blocked', { host, asked });
      showWindow();
    },
  });
  advanced = new AdvancedMode(addLog);
  // The backend ended by itself: the window must not keep saying it is on.
  advanced.onExit = () => toWindow('advanced:state', { active: false });
  // Protection as the user left it (see safeStart and below). Recovery needs
  // it: with protection off, what was written for the next login goes.
  const protectionOn = protectionWanted();
  await engine.recover({ protectionOn });

  // The relay goes through the engine while protection is on, straight to
  // Discord while it is off, and runs whenever Shroudly does.
  discordRelay = new DiscordRelay(addLog, () => (engine && engine.isActive() ? engine.port : null));
  discordRelay.waitForEngine = waitForEngine;
  discordRelay.engineDue = engineComing;
  discordRelay.logGate = logGate;
  if (store.get('discordMode') === true) applyDiscordMode(true, { interactive: false }).catch(() => {});

  // Like the relay: through the engine while protection is on, direct while
  // it is off, and up whenever Shroudly is with the mode on.
  appProxy = new AppProxy(addLog, () => (engine && engine.isActive() ? engine.port : null), isRouted);
  appProxy.waitForEngine = waitForEngine;
  appProxy.engineDue = engineComing;
  appProxy.logGate = logGate;
  appProxy.onTunnel = onAppTunnel;
  appProxy.onRequest = onAppRequest;
  appEnv = new AppEnv({ stateFile: appEnvStateFile(), watchdog });
  createAutopilot();
  createStoreApps();
  // The end-to-end tests look inside (tests/e2e): never in a normal run.
  if (process.env.SHROUDLY_E2E === '1') global.shroudlyE2E = { engine, appProxy, discordRelay, autopilot, wake, store, addLog, require };

  updater = new Updater({
    log: addLog,
    store,
    notify: (version) => notify('Shroudly', tr().notifyUpdateReady.replace('{version}', version)),
    // What a restart would interrupt: the Roblox player or Studio and
    // Discord, while their mode sends them through Shroudly and protection
    // is on.
    busy: () => Updater.inUse({
      protection: !!(engine && engine.isActive()),
      appMode: store.get('appMode') === true,
      discordMode: store.get('discordMode') === true,
      // A list that could not be read counts as in use: better to wait.
      robloxPlaying: async () => { const p = await RobloxApp.pids(); const s = await RobloxApp.pids('studio'); return !p || !s || p.length > 0 || s.length > 0; },
      discordOpen: async () => { for (const v of DiscordApp.installed()) { if (await DiscordApp.isRunning(v)) return true; } return false; },
    }),
    // Installing quits the app: stop the engine first so the system proxy is
    // put back, exactly as on a normal quit.
    beforeInstall: async () => {
      // Back the way it was: the window only if it was open on screen.
      try { store.set('afterUpdate', Launch.afterUpdateRecord(windowAlive() && mainWindow.isVisible() && !mainWindow.isMinimized(), appVersion())); } catch {}
      exitInProgress = true;
      keepDiscordLine = true;
      app.isQuitting = true;
      try { await engine.stop(); } catch {}
      try { await advanced.stop(); } catch {}
    },
  });
  updater.onState((s) => {
    toWindow('update:state', s);
  });

  const trayChecked = createTray();
  watchSessionEnd();
  // Started at login into the tray, or back from an update installed while
  // the window was closed: no window at all until it is opened, where the
  // tray icon can be seen (launch.js). The update's note is read once, and
  // only by the copy that update started.
  await trayChecked;
  const afterUpdate = store.get('afterUpdate');
  if (afterUpdate !== undefined) store.delete('afterUpdate');
  const how = Launch.startWindow({
    autoStart: isAutoStartLaunch(), minimizeToTray: store.get('minimizeToTray', true),
    afterUpdate: Launch.isUpdateRelaunch(afterUpdate, appVersion()) ? afterUpdate : null, trayShown: canLeave(),
  });
  if (how === 'tray') { setDockIcon(false); addLog('info', 'Auto-started in tray'); }
  else await createWindow({ show: true, minimised: how === 'minimised' });
  addLog('success', 'Application started');
  updater.start();
  // Roblox installers downloaded in an earlier run have done their work.
  if (process.platform === 'win32') RobloxApp.cleanDownloads(path.join(app.getPath('userData'), 'roblox'));

  // After the window is up: on Windows this writes the registry, which takes
  // a moment the window should not wait for.
  if (store.get('appMode') === true && AppEnv.supported()) applyAppMode(true).catch(() => {});
  else if (AppEnv.supported()) {
    // Left by a run that never got to clean up. Ours are known by their mark,
    // so they go even when the state file did not survive (a profile reset,
    // a disk image taken while Shroudly ran).
    try { if (AppEnv.recoverSync({ stateFile: appEnvStateFile() })) addLog('info', 'Games and apps: a setting left by an earlier run was removed'); } catch {}
  }

  /* The live counter is the one thing Shroudly sends on its own, and whoever
   * is filtering this connection can see where it goes. For someone using this
   * because their government blocks sites, a request to our domain is a signal
   * that they run circumvention software — which is precisely what they came
   * here to avoid.
   *
   * So it only runs while protection is on, which means it travels the same
   * protected path as everything else rather than announcing itself in the
   * clear beforehand, and it can be switched off outright. The number is worth
   * having; it is not worth more than the safety of the people it counts. */
  presence = new Presence({
    onCount: (n) => toWindow('presence:count', n),
  });
  syncPresence();

  // Re-register every launch so the entry always points at this install
  // (moved app, updated AppImage, 2.0.0's broken Linux entry, legacy names).
  setAutoStart(store.get('autoStart', false));

  // Protection as the user left it (see safeStart). Before there was a
  // setting for that, Auto mode alone decided, and it still does for anyone
  // who has not pressed Start or Stop since. Independent of the window, which
  // may never be opened this session.
  if (protectionOn) {
    addLog('info', 'Auto Mode: starting protection');
    // An update that has waited its limit for a game or a call installs
    // first, while nothing goes through Shroudly yet (updater.js); should
    // the install not get as far as quitting, protection starts anyway,
    // unless the user pressed Stop in the meantime.
    launchStartPending = true;
    const installing = await updater.installBeforeProtection().catch(() => false);
    setTimeout(() => {
      const started = protectionWanted() ? safeStart() : null;
      Promise.resolve(started).catch(() => {}).finally(() => { launchStartPending = false; });
    }, installing ? 60000 : 1200);
  } else {
    // macOS: a proxy set with an administrator's password that the previous
    // run could not put back (the Mac restarted under it). Asked with the
    // window on screen (now, or when it is first opened), asynchronously;
    // skipped when protection starts, whose own password request covers it.
    setTimeout(askProxyRecovery, 1500);
  }

  if (isDev) {
    const { globalShortcut } = require('electron');
    globalShortcut.register('F12', () => mainWindow && mainWindow.webContents.toggleDevTools());
  }

  app.on('activate', () => showWindow());
});

app.on('window-all-closed', () => { /* keep running in tray */ });

/* Logoff / shutdown / reboot: the OS may kill us before before-quit finishes,
 * so put the proxy back synchronously right away (reg.exe, networksetup,
 * gsettings: all fast). The login hook covers the case where even this
 * doesn't get to run. */
/* Discord's line stays across logout and shutdown only when Shroudly starts
 * by itself at the next login, so a Discord that starts then does not race it.
 * Without that, a Discord opened next time would wait on "Checking for
 * updates" for a Shroudly that is not coming: the line goes, as on a quit. */
function discordLineOutlivesSession() { return store.get('autoStart', false) === true; }

function restoreForSessionEnd() {
  keepDiscordLine = discordLineOutlivesSession();
  if (!keepDiscordLine && store.get('discordMode') === true) {
    try { patchDiscordSync(null); } catch {}
    // Not put back by healDiscordLine in the moments left.
    if (discordRelay) discordRelay.stop();
  }
  // Unlike Discord's line, HTTPS_PROXY would be read by every program at the
  // next login, before Shroudly is back: it goes, and returns when we do. It
  // goes first: the system may end us at any moment now.
  try { if (appEnv && appEnv.applied) appEnv.clearSync(); } catch {}
  try { engine && engine.cleanupSync(); } catch {}
  try { advanced && advanced.cleanupSync(); } catch {}
}
app.on('session-end', restoreForSessionEnd); // Windows
app.whenReady().then(() => { powerMonitor.on('shutdown', restoreForSessionEnd); }); // macOS, Linux

/* ── sleep, wake and clock changes (wake.js) ─────────────────────────────── */
/* The system says it woke up; a timer that ran late or a clock that jumped
 * says the same where it does not (macOS DarkWake, a frozen main process, a
 * clock set by hand or by NTP). Every "nothing for N seconds" starts afresh:
 * the engine is not taken for hung, encrypted DNS not for blocked, a Roblox
 * program not for one going around Shroudly, an update countdown that ran
 * out asleep starts again, and no service is judged until the network is
 * back. Said once in the log. */
let lastWakeLog = 0;
function onWake(why) {
  try { if (engine) engine.doh.resumed(); } catch {}
  try { if (autopilot) autopilot.resumed(); } catch {}
  try { robloxWatch.resumed(); } catch {}
  try { if (updater) updater.resumed(); } catch {}
  markActive();
  // Programs (VPN clients among them) set their proxy again at a wake: the
  // setting is read again soon, a takeover then counting from one.
  if (engine) engine.checkProxySoon();
  const now = Date.now();
  if (now - lastWakeLog > 60000) {
    lastWakeLog = now;
    addLog('info', `The computer woke up or its clock changed (${why}); waiting times start afresh`);
  }
}
wake.on('resume', onWake);
wake.start();
app.whenReady().then(() => {
  powerMonitor.on('resume', () => { if (engine) engine.resumed(); else wake.resumed('system'); });
  // Back at the computer: the window is in use, not idle for the time the
  // screen was locked.
  powerMonitor.on('unlock-screen', () => markActive());
});

/* Every way of quitting (Cmd+Q, Dock, tray, menu, updater) lands here. Mark
 * the app as quitting first: otherwise the window's close handler turns the
 * quit into "minimize to tray" and the app never exits (Cmd+Q on macOS while
 * protection was off). Restoring the proxy is capped so a slow system call
 * can't hold the quit hostage; the 'exit' handler still restores it
 * synchronously as a last resort. */
const QUIT_RESTORE_LIMIT_MS = 5000;
app.on('before-quit', (e) => {
  app.isQuitting = true;
  // Nothing of Roblox's is stopped or started while Shroudly quits.
  robloxWatch.halt();
  robloxWatch.stop();
  // Quitting on purpose: take the line out of Discord's settings, so Discord
  // started without Shroudly goes to Discord directly, exactly as before.
  if (!keepDiscordLine && store.get('discordMode') === true) {
    try { patchDiscordSync(null); } catch {}
    if (discordRelay) discordRelay.stop();
  }
  // Programs started after Shroudly has gone must go straight out again.
  try { if (appEnv && appEnv.applied) appEnv.clearSync(); } catch {}
  if (appProxy) appProxy.stop();
  if (presence && !presence.stopped) presence.leave();
  try { updater && updater.installOnQuit(); } catch {}
  if (exitInProgress) return;
  const engineOn = engine && engine.isActive();
  const advancedOn = advanced && advanced.active;
  if (!engineOn && !advancedOn) return;
  e.preventDefault();
  exitInProgress = true;
  addLog('info', 'Restoring system before exit...');
  const stops = Promise.allSettled([engineOn ? engine.stop() : null, advancedOn ? advanced.stop() : null]);
  Promise.race([stops, new Promise((r) => setTimeout(r, QUIT_RESTORE_LIMIT_MS))]).then(() => app.quit());
});

/* ── IPC ─────────────────────────────────────────────────────────────────── */
ipcMain.on('window:minimize', () => { if (windowAlive()) mainWindow.minimize(); });
ipcMain.on('window:maximize', () => {
  if (!windowAlive()) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => {
  if (!windowAlive()) return;
  if (canLeave()) { sentAway.add(mainWindow); mainWindow.hide(); } else mainWindow.minimize();
});
// Quit from the window itself, for desktops that show no tray icon.
ipcMain.on('app:quit', () => { app.isQuitting = true; shutdownAndQuit(); });
/* The interface reports use (throttled) and when it is listening. */
ipcMain.on('ui:active', (e) => { if (windowAlive() && e.sender === mainWindow.webContents) markActive(); });
ipcMain.on('ui:ready', (e) => {
  if (!windowAlive() || e.sender !== mainWindow.webContents) return;
  uiReady = true;
  for (const [channel, payload] of pending) { try { mainWindow.webContents.send(channel, payload); } catch {} }
  pending.clear();
});

ipcMain.handle('dpi:advice', () => (engine ? engine.advice : null));
ipcMain.handle('proxy:status', () => (engine ? engine.proxyStatus : null));
// macOS standard account: an administrator allows it once.
ipcMain.handle('proxy:applyAsAdmin', async () => (engine ? engine.applyProxyAsAdmin() : { ok: false, code: 'not_active' }));
// Taken over by another program: point the system at Shroudly again. Says
// what came of it (a password dialog dismissed is not "set again").
ipcMain.handle('proxy:reapply', async () => {
  if (!engine || !engine.isActive()) return { ok: false, code: 'not_active' };
  try {
    const st = (await engine.reapplyProxy({ userAsked: true }) || {}).status;
    return { ok: !!(st && st.ok), code: st ? st.code : 'not_active' };
  } catch (e) { return { ok: false, code: 'failed', detail: e.message }; }
});
// macOS: settings from before a restart, still waiting for an
// administrator's password after the user dismissed the dialog once.
ipcMain.handle('proxy:recovery', () => (engine ? engine.proxyRecovery : null));
ipcMain.handle('proxy:recoverAsAdmin', async () => ({ ok: engine ? await engine.recoverProxyAsAdmin({ user: true }) : false }));
ipcMain.handle('dpi:start', async () => safeStart({ user: true }));
ipcMain.handle('dpi:stop', async () => safeStop({ user: true }));

/* Advanced (packet-layer) mode — for filters that follow whole connections. */
ipcMain.handle('advanced:available', () => ({
  available: advanced ? advanced.available() : false,
  reason: advanced ? advanced.reason() : 'not initialized',
  reasonCode: advanced ? advanced.reasonCode() : 'not_built',
  installCommand: process.platform === 'linux' ? AdvancedMode.linuxInstallCommand() : null,
  active: advanced ? advanced.active : false,
}));
ipcMain.handle('advanced:start', async () => {
  const r = await startAdvanced();
  if (autopilot && r && r.success) autopilot.userSet('advancedMode', true);
  // Declined at a prompt the user started: the autopilot does not ask again.
  if (autopilot && r && r.code === 'declined') autopilot.recordDecline();
  return r;
});
ipcMain.handle('advanced:stop', async () => {
  advancedProtection.offByHand();
  if (autopilot) autopilot.userSet('advancedMode', false);
  try { await advanced.stop(); toWindow('advanced:state', { active: false }); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('dpi:status', () => ({
  active: engine ? engine.isActive() : false,
  stats: engine ? engine.getStats() : {},
}));
ipcMain.handle('dpi:probe', (e, host) => {
  if (engine && typeof host === 'string' && host) { userTests.set(host.toLowerCase(), Date.now()); engine.probe(host); }
  return { success: true };
});

/* A site test the user asked for: once the network is no longer in the way,
 * also ask whether the site itself turns this user away (service-check.js).
 * Background probes are passed on as they are. The window waits for its
 * answer only so long (it gives up on a test after 25 s): a slower answer
 * still comes, as the notice any refusal brings. */
const userTests = new Map();   // host -> when the test was asked for
const SITE_TEST_SERVICE_MS = 13000;
async function onProbeResult(p) {
  const asked = p && p.host ? userTests.get(String(p.host).toLowerCase()) : 0;
  if (asked) userTests.delete(String(p.host).toLowerCase());
  if (asked && Date.now() - asked < 120000 && engine && engine.isActive()) {
    serviceChecked.delete(String(p.host).toLowerCase());
    let timer = null;
    const service = await Promise.race([
      checkServiceOnce(p.host).catch(() => null),
      new Promise((r) => { timer = setTimeout(() => r(null), SITE_TEST_SERVICE_MS); }),
    ]);
    clearTimeout(timer);
    if (service) { toWindow('dpi:probe-result', { ...p, service }); return; }
  }
  toWindow('dpi:probe-result', p);
}

ipcMain.handle('app:getInfo', async () => ({
  // app.getVersion() returns Electron's own version when unpackaged; read the
  // real product version from package.json so the UI always shows it correctly.
  version: appVersion(),
  year: new Date().getFullYear(),
  platform: process.platform,
  isAdmin: false,
}));

ipcMain.handle('settings:get', (e, key) => store.get(key));
/* navigator.language is always en-US in packaged builds (electronLanguages
 * strips Chromium's other locales), so the UI asks the OS directly. */
ipcMain.handle('app:systemLanguages', () => systemLanguages());
ipcMain.handle('settings:getAll', () => store.store);
/* Settings the engine reads at start: while protection is on, changing one
 * restarts the engine (debounced, since a strategy pick sets several keys). */
const ENGINE_SETTINGS = new Set(['strategy', 'strategyId', 'autoMode', 'dnsProtection', 'preferIpv6', 'listenPort']);
let engineRestartTimer = null;
function scheduleEngineRestart() {
  clearTimeout(engineRestartTimer);
  engineRestartTimer = setTimeout(() => {
    if (!engine || !engine.isActive()) return;
    engine.restart().catch((e) => { addLog('error', `Start failed: ${e.message}`); broadcastStatus(false); });
  }, 700);
}

// Route mode / site list change: re-apply the system proxy (no engine restart).
const PROXY_SETTINGS = new Set(['routeMode', 'siteList']);
let proxyReapplyTimer = null;
function scheduleProxyReapply() {
  clearTimeout(proxyReapplyTimer);
  proxyReapplyTimer = setTimeout(() => {
    if (!engine || !engine.isActive()) return;
    engine.reapplyProxy().catch((err) => addLog('error', `Could not update proxy routing: ${err.message}`));
  }, 700);
}

/* Is IPv6 actually usable here? A global address alone isn't enough (some
 * networks hand one out without routing it), so also try to reach a public
 * IPv6 host. */
function ipv6Available() {
  const nets = Object.values(os.networkInterfaces()).flat();
  const global = nets.some((a) => a && (a.family === 'IPv6' || a.family === 6) && !a.internal && /^[23]/.test(a.address));
  if (!global) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = netModule.connect({ host: '2606:4700:4700::1111', port: 443, family: 6 });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(2500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
ipcMain.handle('net:ipv6Available', () => ipv6Available());
ipcMain.handle('settings:defaultSiteList', () => (siteList ? siteList.domains : EngineManager.DEFAULT_SITE_LIST));
ipcMain.handle('sitelist:info', () => ({
  ...(siteList ? siteList.info() : { count: EngineManager.DEFAULT_SITE_LIST.length, generated: null, checkedAt: 0 }),
  custom: Array.isArray(store.get('siteList')),
}));
/* Repaint the system-drawn caption strip to match the theme. Only Windows and
 * Linux have one; macOS draws its buttons over our own strip. A colour the
 * renderer sends is only ever used as a colour, and an unparseable one is
 * refused by Electron, so it is passed through inside a try. */
ipcMain.handle('ui:titlebar', (_e, c) => {
  if (process.platform === 'darwin') return false;
  if (!mainWindow || mainWindow.isDestroyed() || !c) return false;
  const ok = (v) => typeof v === 'string' && /^#[0-9a-f]{3,8}$|^rgba?\(/i.test(v.trim());
  if (!ok(c.color) || !ok(c.symbolColor)) return false;
  try { mainWindow.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: 36 }); return true; }
  catch { return false; }
});

ipcMain.handle('presence:get', () => (presence ? presence.online : null));
ipcMain.handle('presence:refresh', () => (presence ? presence.refresh() : null));

/* ── Discord app mode ────────────────────────────────────────────────────── */
/* What the window shows about it: whether a restart of Discord is still needed
 * to pick the line up, and whether macOS is withholding access to its files. */
const discordState = { needsRestart: false, needsPermission: false, pendingOn: null, foreign: false, editFailed: null, changedAt: 0 };

function sendDiscordState() {
  toWindow('discord:state', discordState);
}

/* Write our line (url) or remove it (null) in every Discord build present.
 * Returns the builds whose file changed, and those that could not be read. */
function patchDiscordSync(url, files) {
  const changed = []; const denied = []; const failed = []; let foreign = false;
  for (const v of DiscordApp.installed()) {
    const file = (files && files[v.id]) || DiscordApp.settingsFile(v);
    try {
      const r = DiscordApp.patchSync(file, url);
      if (r === 'changed') changed.push(v);
      if (r === 'foreign') foreign = true;
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') denied.push(v);
      else failed.push({ v, message: e.message });
    }
  }
  return { changed, denied, failed, foreign };
}

/* macOS keeps other apps' data behind a permission. Picking the folder in an
 * open panel counts as the user's consent; the panel opens inside Discord's
 * folder, so it is one click. */
async function askDiscordFolder(v) {
  const s = tr();
  const win = windowAlive() && mainWindow.isVisible() ? mainWindow : undefined;
  // The panel belongs to the window: it must not be closed for being idle.
  modalOpen++;
  let pick;
  try {
    pick = await dialog.showOpenDialog(win, {
      defaultPath: v.settingsDir, properties: ['openDirectory'],
      message: s.discordPickMessage, buttonLabel: s.discordPickButton,
    });
  } finally { modalOpen--; }
  if (pick.canceled || !pick.filePaths[0]) return null;
  const chosen = pick.filePaths[0];
  return path.basename(chosen) === path.basename(v.settingsDir) ? path.join(chosen, 'settings.json') : null;
}

async function applyDiscordMode(on, { interactive = true } = {}) {
  let url = null;
  if (on) {
    try {
      const port = await discordRelay.start(store.get('discordRelayPort'));
      store.set('discordRelayPort', port);
      url = DiscordApp.endpointUrl(port);
    } catch (e) {
      addLog('error', `Discord app: the relay could not start (${e.message})`);
      return { success: false, code: 'relay' };
    }
  }

  let r = patchDiscordSync(url);
  if (r.denied.length && interactive && process.platform === 'darwin') {
    const files = {};
    for (const v of r.denied) { const f = await askDiscordFolder(v); if (f) files[v.id] = f; }
    const again = patchDiscordSync(url, files);
    r = { ...again, changed: [...r.changed, ...again.changed] };
  }
  for (const f of r.failed) addLog('error', `Discord app: ${f.message}`);

  discordState.needsPermission = r.denied.length > 0;
  discordState.foreign = r.foreign;
  discordState.editFailed = r.failed.length ? `"${DiscordApp.KEY}": "${url || ''}"` : null;
  discordState.pendingOn = (r.denied.length || r.failed.length) ? on : null;
  if (r.denied.length || r.failed.length) {
    // Turning off must not leave Discord pointed at a relay that is gone, so
    // the relay stays up until the line could actually be removed.
    sendDiscordState();
    return { success: false, code: r.denied.length ? 'permission' : 'edit_failed' };
  }

  store.set('discordMode', on);
  if (!on) discordRelay.stop();

  // Discord reads the line when it starts: one that is already open needs a
  // restart to use it (or to stop using it).
  let running = false;
  for (const v of r.changed) if (await DiscordApp.isRunning(v)) running = true;
  if (r.changed.length) {
    discordState.needsRestart = on && running;
    discordState.changedAt = Date.now();
    addLog('success', on ? 'Discord app mode on: Discord updates through Shroudly' : 'Discord app mode off: Discord settings restored');
  }
  sendDiscordState();
  return { success: true, restartNeeded: discordState.needsRestart };
}

/* While the mode is on, the line stays in every build's settings, pointing
 * at the relay's port: a build installed after the mode came on (PTB, Canary,
 * a fresh install), a settings file Discord wrote back without it when it
 * closed, or one reset by a reinstall or a cleaner, gets it again within
 * seconds, before Discord is opened again. Reading the files changes nothing
 * when the line is there.
 *
 * Some Discords (or programs that change Discord) write the file back every
 * few minutes while they run: putting the line back is then routine. It is
 * logged the first time and once more (DiscordApp.healNote), and changes
 * nothing else: no system setting, no notice, and a restart of Discord only
 * through watchDiscord, which leaves alone a Discord that already goes
 * through Shroudly. */
const discordHealed = new Map();   // build -> times its line was put back this session
async function healDiscordLine() {
  if (store.get('discordMode') !== true || !discordRelay || !discordRelay.running || discordState.needsPermission) return;
  const r = patchDiscordSync(DiscordApp.endpointUrl(discordRelay.port));
  if (!r.changed.length) return;
  for (const line of DiscordApp.healNote(discordHealed, r.changed.map((v) => v.app))) addLog('info', line);
  // Discord's settings were written anew: Discord, or something started with
  // it, has just started. In issue #27's log the system proxy was taken over
  // within a minute of that, every time: it is looked at again shortly.
  if (engine) engine.checkProxySoon();
  let running = false;
  for (const v of r.changed) if (await DiscordApp.isRunning(v)) running = true;
  // Told to the window only when that changes what it shows.
  if (running && !discordState.needsRestart) {
    discordState.needsRestart = true;
    discordState.changedAt = Date.now();
    sendDiscordState();
  }
}
let discordHealBusy = false;
setInterval(() => {
  if (discordHealBusy) return;
  discordHealBusy = true;
  healDiscordLine().catch(() => {}).finally(() => { discordHealBusy = false; });
}, 3000).unref();

ipcMain.handle('discord:status', async () => {
  const builds = DiscordApp.installed();
  try { await healDiscordLine(); } catch {}
  let running = false;
  for (const v of builds) if (await DiscordApp.isRunning(v)) { running = true; break; }
  // The relay answering Discord since the change means Discord already uses it.
  if (discordState.needsRestart && discordRelay && discordRelay.lastOkAt > discordState.changedAt) discordState.needsRestart = false;
  return {
    installed: builds.length > 0,
    mode: store.get('discordMode') ?? null,  // true, false, or null (never asked)
    running,
    reached: discordRelay ? discordRelay.lastOkAt : 0,
    ...discordState,
  };
});
ipcMain.handle('discord:set', async (e, on) => {
  if (autopilot) autopilot.userSet('discordMode', on === true);
  return applyDiscordMode(on === true);
});

/* ── Games and apps mode ─────────────────────────────────────────────────── */
/* Roblox and many other programs ignore the system proxy and only read
 * HTTPS_PROXY from their environment: see app-proxy.js and app-env.js. The
 * autopilot turns the mode on when this network blocks Roblox; robloxWatch
 * then sees to Roblox's programs that started before the mode or around it.
 * What the window shows: a proxy of the user's own in the way, a change that
 * could not be made, and a Roblox Studio to reopen. */
// studioReopenAt: when the user was last asked to reopen a Roblox Studio
// that goes around Shroudly (0 while there is none).
const appState = { foreign: false, failed: false, studioReopenAt: 0 };

function sendAppState() {
  toWindow('apps:state', appState);
}

/* Evidence, not the setting: the local proxy reports every request and
 * every tunnel. A request from Roblox is what shows it uses the setting,
 * whether or not the server it asked for could then be reached; it is
 * remembered for robloxWatch. The first tunnel of a session, and Roblox's
 * first, are logged (so a support log shows the mode really works). */
const appSeen = { any: false, roblox: false, robloxAt: 0 };
function onAppRequest(host) {
  if (RobloxApp.isRobloxHost(host)) appSeen.robloxAt = Date.now();
}
function onAppTunnel(host) {
  if (!appSeen.any) { appSeen.any = true; addLog('info', `Games and apps: the first program connected through Shroudly (${host})`); }
  if (RobloxApp.isRobloxHost(host) && !appSeen.roblox) {
    appSeen.roblox = true;
    addLog('success', 'Games and apps: Roblox is connecting through Shroudly');
    checkServiceOnce('www.roblox.com').catch(() => {});
  }
}

/* The network can be beaten; a service that turns the user away itself (by
 * country, by policy) cannot, since Shroudly never changes the address. When
 * that happens it is said plainly, the same way for every site and country:
 * the user's own site test (onProbeResult), a site the engine could not get
 * through to, and the services the app modes are for (Roblox, Discord), each
 * looked at once per session at most. */
const repeatedCut = ServiceCheck.cutCounter();
const serviceChecked = new Map();   // host -> when
const serviceRefusals = new Map();  // host -> 'region' | 'stall'
async function checkServiceOnce(host) {
  const h = String(host || '').toLowerCase();
  if (!h || !engine || !engine.isActive()) return null;
  const last = serviceChecked.get(h) || 0;
  if (Date.now() - last < 30 * 60 * 1000) return serviceRefusals.get(h) || null;
  serviceChecked.set(h, Date.now());
  const kind = await ServiceCheck.serviceCheck(h, engine.port, DiscordRelay.socksConnect).catch(() => null);
  if (kind) reportServiceRefusal(h, kind);
  else serviceRefusals.delete(h);
  return kind;
}
function reportServiceRefusal(host, kind) {
  const first = !serviceRefusals.has(host);
  serviceRefusals.set(host, kind);
  // Only a page that says so is the site's own refusal. Silence after the
  // handshake may be the site, or a network that lets connections start and
  // then stops them: both are said, never just one.
  if (first) {
    addLog('warning', kind === 'region'
      ? `${host}: the site itself refuses this connection (it says it does not serve where you are); Shroudly does not change your address, so it cannot change this`
      : `${host}: accepts the connection, then nothing comes back; either the site turns away visitors from where you are, or the network stops the connection after it is made`);
  }
  toWindow('dpi:service-refused', { host, service: kind });
}

/* Roblox's programs that go around Shroudly while this network blocks Roblox
 * (roblox-watch.js: the rules, how soon, and what is done): looked at every
 * few seconds while one is being judged or may be about to start, at once
 * when the mode, protection or the verdict comes. */
const robloxSigned = RobloxApp.signedCache(store.get('robloxSigned', []), (list) => store.set('robloxSigned', list));

/* The env a Roblox started by Shroudly gets. Shroudly itself may have
 * inherited an older value of ours (started from Explorer before a crash's
 * leftovers were cleaned): only a proxy that is somebody else's is kept. */
function robloxEnv() {
  const env = {};
  const ours = (v) => !v || /^http:\/\/127\.0\.0\.1:\d+$/.test(v);
  if (appProxy && appProxy.url) {
    if (ours(process.env.HTTPS_PROXY)) { env.HTTPS_PROXY = appProxy.url; env.https_proxy = appProxy.url; }
    if (!process.env.NO_PROXY || process.env.NO_PROXY === AppEnv.NO_PROXY_VALUE) env.NO_PROXY = AppEnv.NO_PROXY_VALUE;
  }
  return env;
}

/* Roblox's current installer for the player or Studio, fetched through the
 * engine and checked to be signed by Roblox (fetchRoblox), then started
 * through Shroudly (startFetchedRoblox), if it is still that very file. */
const robloxName = (kind) => (kind === 'studio' ? 'Roblox Studio' : 'Roblox');
async function fetchRoblox(kind) {
  if (!engine || !engine.isActive()) return { success: false, code: 'unreachable', detail: 'protection is off' };
  const r = await RobloxApp.fetchInstaller({
    kind, socksPort: engine.port, connect: DiscordRelay.socksConnect,
    dir: path.join(app.getPath('userData'), 'roblox'), cache: robloxSigned,
  });
  if (r.code === 'unsigned') addLog('error', 'The downloaded Roblox installer was not signed by Roblox, so it was deleted and not started');
  else if (!r.success) addLog('error', `${robloxName(kind)} could not be downloaded (${r.detail || r.code})`);
  return r;
}
async function startFetchedRoblox(r) {
  const pid = await RobloxApp.startFetched(r, robloxEnv());
  if (pid) addLog('success', `${robloxName(r.kind)} installer downloaded through Shroudly and started (${r.version})`);
  return pid;
}

function setStudioReopen(at) {
  if (appState.studioReopenAt === at) return;
  appState.studioReopenAt = at;
  sendAppState();
}

function soonProxy(r) { if (r && engine) engine.checkProxySoon(); return r; }
const robloxWatch = new RobloxWatch({
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); if (h.unref) h.unref(); return h; },
  clearTimeout: (h) => clearTimeout(h),
  watched: RobloxApp.routeWatched(),
  on: () => store.get('appMode') === true && !!appProxy && appProxy.running,
  active: () => !!(engine && engine.isActive()),
  blocked: () => !!(autopilot && autopilot.isBlocked('roblox')),
  stillBlocked: () => (autopilot ? autopilot.stillBlocked('roblox') : Promise.resolve(false)),
  checkSoon: () => { if (autopilot) autopilot.checkSoon('roblox').catch(() => {}); },
  lastRequestAt: () => appSeen.robloxAt,
  list: () => RobloxApp.processes(),
  info: process.platform === 'win32' ? (pids) => RobloxApp.processInfo(pids) : null,
  // PowerShell started ahead (it can take 20 s to start on a slow machine),
  // while Roblox's programs may need to be seen to.
  prepare: process.platform === 'win32' ? () => RobloxApp.prepare() : null,
  signed: (file, kind) => RobloxApp.signedInstaller(file, kind, { cache: robloxSigned }),
  same: (file, hash) => RobloxApp.sameFile(file, hash),
  kill: (pids) => RobloxApp.kill(pids),
  // A program started again through Shroudly: the system proxy is looked at
  // again shortly (issue #27).
  startInstaller: (file) => soonProxy(RobloxApp.startInstaller(file, robloxEnv())),
  fetch: (kind) => fetchRoblox(kind),
  startFetched: async (r) => soonProxy(await startFetchedRoblox(r)),
  restart: async (pids) => soonProxy(await RobloxApp.restart(robloxEnv(), pids)),
  log: (level, msg) => addLog(level, msg),
  tell: (id) => autoTell(id),
  needAdvanced: () => { if (autopilot) autopilot.needAdvanced('www.roblox.com', { label: 'Roblox', why: 'Roblox does not get through' }).catch(() => {}); },
  studioReopen: setStudioReopen,
});
robloxWatch.start();

/* One change at a time: on and off in quick succession must not interleave
 * (an "on" finishing after the "off" would leave the mode on behind a toggle
 * that shows it off). */
let appModeQueue = Promise.resolve();
function applyAppMode(on) {
  const run = appModeQueue.then(() => applyAppModeNow(on));
  appModeQueue = run.catch(() => {});
  return run;
}

async function applyAppModeNow(on) {
  if (!AppEnv.supported()) return { success: false, code: 'unsupported' };
  appState.failed = false;
  if (!on) {
    try { appEnv.clearSync(); } catch {}
    appProxy.stop();
    store.set('appMode', false);
    appState.foreign = false;
    appState.studioReopenAt = 0;
    robloxWatch.modeOff();
    addLog('success', 'Games and apps mode off: settings restored');
    sendAppState();
    return { success: true };
  }

  let port;
  try {
    port = await appProxy.start(store.get('appProxyPort'));
    store.set('appProxyPort', port);
  } catch (e) {
    addLog('error', `Games and apps: the local proxy could not start (${e.message})`);
    appState.failed = true;
    sendAppState();
    return { success: false, code: 'proxy' };
  }
  let r;
  let setAt = 0;
  try { r = appEnv.applySync(AppProxy.proxyUrl(port)); setAt = Date.now(); } catch (e) {
    addLog('error', `Games and apps: ${e.message}`);
    appProxy.stop();
    appState.failed = true;
    sendAppState();
    return { success: false, code: 'edit_failed' };
  }
  if (r === 'foreign') {
    // Somebody else's proxy for programs (HTTPS_PROXY): never replaced.
    appProxy.stop();
    appState.foreign = true;
    addLog('warning', 'Games and apps: another proxy is already set for programs (HTTPS_PROXY), so it was left as it is');
    sendAppState();
    return { success: false, code: 'foreign' };
  }
  appState.foreign = false;
  store.set('appMode', true);
  if (r === 'changed') {
    // Roblox reads the proxy when it starts: what is already open does not
    // have it, installers included (robloxWatch sees to them at once, not
    // after the quiet wait).
    robloxWatch.modeOn(await RobloxApp.processes(), setAt);
    addLog('success', 'Games and apps mode on: Roblox and similar programs go through Shroudly');
  } else robloxWatch.warm();
  sendAppState();
  return { success: true };
}

/* Whether the Store edition is installed is asked once (PowerShell), when
 * the window first shows the switch. */
let storeEditionCache = null;
ipcMain.handle('apps:status', async (e, opts) => {
  if (opts && opts.running === true && process.platform === 'win32' && storeEditionCache === null) {
    storeEditionCache = await RobloxApp.storeEdition().catch(() => false);
  }
  return {
    available: AppEnv.supported(),
    mode: store.get('appMode') ?? null,  // true, false, or null (never set)
    storeEdition: storeEditionCache === true,
    platform: process.platform,
    ...appState,
  };
});
ipcMain.handle('apps:set', async (e, on) => {
  if (autopilot) autopilot.userSet('appMode', on === true);
  return applyAppMode(on === true);
});

/* ── Autopilot ───────────────────────────────────────────────────────────── */
/* What Shroudly turns on and restarts by itself (autopilot.js), and how it
 * says so: a notification, and a line in the window, which also gets the
 * last few when it opens later. */
// The latest line for a window opened later. Studio's line is not kept here:
// it comes with the apps state, for as long as that Studio runs.
let autoLatest = null;
function autoTell(id, params = {}) {
  const text = String(tr()[id] || '').replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  if (text) notify('Shroudly', text);
  const n = { id, params, at: Date.now() };
  if (id !== 'autoStudioReopen') autoLatest = n;
  toWindow('auto:notice', n);
}
// The window is closed for real when it goes to the tray: a line the user
// closed stays closed in the next window, and an older one never comes back.
ipcMain.handle('auto:notices', () => (autoLatest && !autoLatest.dismissed ? [autoLatest] : []));
ipcMain.on('auto:dismiss', (e, at) => { if (autoLatest && autoLatest.at <= at) autoLatest.dismissed = true; });

/* A browser that goes around Shroudly (browser-check.js): its own proxy or
 * VPN setting, an extension, a policy. Looked at every minute while every
 * site goes through Shroudly; a browser seen going around twice in a row is
 * named once a session. Firefox's own "no proxy" choice is put back while
 * Firefox is closed, once per profile. */
const browserAroundSeen = new Map();
const browserTold = new Set();
let browserBusy = false;
async function watchBrowsers() {
  if (browserBusy || !engine || !engine.isActive() || store.get('routeMode') === 'listed') return;
  // Just after a wake, connections opened before the sleep (or while the
  // network came back) are no sign of a browser going around Shroudly.
  if (wake.recent(2 * 60 * 1000)) { browserAroundSeen.clear(); return; }
  browserBusy = true;
  try {
    const list = await BrowserCheck.runningBrowsers();
    const ffOff = () => BrowserCheck.firefoxProfiles().some((p) => p.type === 0 || p.type === 4);
    if (!list.some((b) => b.id === 'firefox') && ffOff()) {
      const done = BrowserCheck.fixFirefox(undefined, store.get('firefoxProxyFixed', []));
      if (done.length) {
        store.set('firefoxProxyFixed', [...store.get('firefoxProxyFixed', []), ...done]);
        addLog('success', 'Firefox was set not to use the system proxy. Shroudly put it back to "Use system proxy settings".');
        autoTell('autoFirefoxFixed');
      }
    }
    if (!list.length) { browserAroundSeen.clear(); return; }
    const ports = [engine.port, engine.proxy && engine.proxy.pacPort].filter(Boolean);
    const rows = await ProcNet.connections(list.flatMap((b) => b.pids));
    for (const b of [...browserAroundSeen.keys()]) if (!list.some((x) => x.id === b)) browserAroundSeen.delete(b);
    for (const b of list) {
      const seen = BrowserCheck.goesAround(rows.filter((r) => b.pids.includes(r.pid)), ports) ? (browserAroundSeen.get(b.id) || 0) + 1 : 0;
      browserAroundSeen.set(b.id, seen);
      if (seen < 2 || browserTold.has(b.id)) continue;
      browserTold.add(b.id);
      if (b.id === 'firefox' && ffOff()) {
        addLog('warning', 'Firefox is set not to use the system proxy, so it does not go through Shroudly. Close Firefox and Shroudly will set it back.');
        autoTell('autoFirefoxClose');
      } else {
        addLog('warning', `${b.name} is not going through Shroudly: a proxy or VPN setting of its own, or an extension, is in the way. Turn it off in ${b.name}, or use another browser.`);
        autoTell('autoBrowserAround', { browser: b.name });
      }
    }
  } finally { browserBusy = false; }
}
setInterval(() => { watchBrowsers().catch(() => {}); }, 60000).unref();

/* A different network (another Wi-Fi, a cable, a hotspot): what the
 * autopilot learnt about the last one no longer holds. Told by the networks
 * this computer is on (each IPv4 address with its mask, each IPv6 /64), not
 * its addresses: IPv6 privacy addresses change daily on the same network.
 * Two networks that look the same from here are covered by
 * autopilot.stillBlocked, which checks again before anything is restarted. */
const networkFingerprint = () => Autopilot.networkFingerprint(os.networkInterfaces());
let networkPrint = networkFingerprint();
setInterval(() => {
  const now = networkFingerprint();
  // Encrypted DNS: connections and rests from the old network say nothing
  // about the new one (doh-forwarder.js).
  if (now !== networkPrint && engine && engine.doh) engine.doh.networkChanged();
  if (now !== networkPrint) rawWatch.networkChanged();
  if (now !== networkPrint && autopilot) {
    autopilot.networkChanged();
    if (engine && engine.isActive()) setTimeout(() => { autopilot.survey().catch(() => {}); }, 5000);
  }
  networkPrint = now;
}, 30000).unref();

/* A Discord that was open when its mode came on reads the line only when it
 * starts. One past its updater works through the system proxy and is left
 * alone (a call must not be cut); one that holds no connection to Shroudly at
 * all is stuck before its window, and is restarted, once per build, while
 * this network blocks Discord. */
// Build -> when it was last restarted: at most once in ten minutes each.
const discordRestarted = new Map();
const DISCORD_RESTART_EVERY_MS = 10 * 60 * 1000;
let discordBusy = false;
async function watchDiscord() {
  if (discordBusy || !discordState.needsRestart || store.get('discordMode') !== true) return;
  if (!engine || !engine.isActive() || !autopilot || !autopilot.isBlocked('discord')) return;
  // The system proxy not pointing at Shroudly (another program took it over,
  // or it still needs an administrator): no program's connections reach
  // Shroudly then, a Discord that works included, so "no connection to
  // Shroudly" says nothing about Discord, and a restart would only cut its
  // call. Looked at again once the proxy is back.
  if (engine.proxyStatus && engine.proxyStatus.ok === false) return;
  if (Date.now() - discordState.changedAt < 20000) return;
  if (discordRelay && discordRelay.lastOkAt > discordState.changedAt) { discordState.needsRestart = false; sendDiscordState(); return; }
  discordBusy = true;
  try {
    const ports = [engine.port, discordRelay && discordRelay.port].filter(Boolean);
    let still = false;
    for (const v of DiscordApp.installed()) {
      const pids = await DiscordApp.pids(v);
      if (!pids.length || Date.now() - (discordRestarted.get(v.id) || 0) < DISCORD_RESTART_EVERY_MS) continue;
      if (await ProcNet.connectsTo(pids, ports)) continue;
      if (!(await autopilot.stillBlocked('discord'))) break;
      discordRestarted.set(v.id, Date.now());
      if (await DiscordApp.restart(v)) {
        addLog('success', `Autopilot: ${v.app} did not get through Shroudly; restarted it`);
        autoTell('autoDiscordRestarted');
        engine.checkProxySoon();
      } else still = true;
    }
    if (!still) { discordState.needsRestart = false; sendDiscordState(); }
  } finally { discordBusy = false; }
}
setInterval(() => { watchDiscord().catch(() => {}); }, 20000).unref();

/* Advanced mode, started from the window or by the autopilot. */
async function startAdvanced() {
  try {
    const ttl = Number(store.get('fakeTtl', 4)) || 4;
    // QUIC forced to TCP and Discord-voice decoys are on by default; a user can
    // turn either off in settings without the browser losing TCP coverage.
    const opts = {
      quicBlock: store.get('advancedQuicBlock', true) !== false,
      udpFake: store.get('advancedUdpFake', true) !== false,
    };
    const r = await advanced.start(ttl, opts);
    addLog('success', 'Advanced mode enabled');
    toWindow('advanced:state', { active: true });
    return r || { success: true };
  } catch (e) {
    addLog('error', `Advanced mode failed: ${e.message}`);
    return { success: false, error: e.message, code: e.code || 'start_failed' };
  }
}

function createAutopilot() {
  autopilot = new Autopilot({
    store,
    log: addLog,
    tell: autoTell,
    protectionOn: () => !!(engine && engine.isActive()),
    check: (host) => BlockCheck.check(host, { socksPort: engine && engine.isActive() ? engine.port : null, connect: DiscordRelay.socksConnect }),
    services: [
      {
        id: 'discord', name: 'Discord', probe: 'discord.com', mode: 'discordMode', needsApp: true,
        present: () => DiscordApp.installed().length > 0,
        // Its app open (any system, any build): what a failing gateway is
        // judged by for Advanced mode.
        running: () => DiscordApp.anyRunning(),
        // The macOS permission panel only with the window there to show it.
        enable: () => applyDiscordMode(true, { interactive: windowAlive() && mainWindow.isVisible() }),
        logOn: 'Autopilot: Discord is blocked on this network; Discord app mode turned on',
        told: 'autoDiscordOn',
        toldOff: 'autoDiscordOffByHand',
        toldFailed: 'autoDiscordFailed',
      },
      {
        id: 'roblox', name: 'Roblox', probe: 'clientsettingscdn.roblox.com', mode: 'appMode', needsApp: false,
        present: () => AppEnv.supported() && (RobloxApp.installed() || RobloxApp.installed('studio')),
        enable: () => (AppEnv.supported() ? applyAppMode(true) : Promise.resolve({ success: false, code: 'unsupported' })),
        logOn: 'Autopilot: Roblox is blocked on this network; Games and apps mode turned on',
        told: 'autoRobloxOn',
        toldOff: 'autoRobloxOffByHand',
        toldFailed: 'autoRobloxFailed',
      },
    ],
    // Roblox found blocked: its programs that go around Shroudly are seen
    // to at once, not at the next look.
    onBlocked: (id) => { if (id === 'roblox') robloxWatch.warm(); },
    advanced: {
      available: () => !!(advanced && advanced.available()),
      active: () => !!(advanced && advanced.active),
      // On protection's behalf: a Stop while it waits wins, and it waits
      // for the Store apps' permission prompt if one is on screen.
      session: () => advancedProtection.session(),
      start: (since) => advancedProtection.start(since),
      antiCheat: () => Autopilot.antiCheatRunning(),
    },
  });
  // Apps installed later, and the check that is due again after a while.
  setInterval(() => { autopilot.survey().catch(() => {}); }, 10 * 60 * 1000).unref();
}

/* Microsoft Store apps (Windows): Windows keeps the ones that run in an app
 * container away from programs on this computer, Shroudly's proxy too, unless
 * they have a loopback exemption. Once one of them is open, the autopilot
 * adds them with one administrator prompt and says so (never by itself to an
 * account that cannot say Yes); the switch in Settings asks at once, or takes
 * Shroudly's own out again (store-apps.js). */
function createStoreApps() {
  storeApps = new StoreApps({
    store,
    log: addLog,
    tell: autoTell,
    protectionOn: () => !!(engine && engine.isActive()),
    // Advanced mode's permission prompt on screen: never a second one beside it.
    busy: () => !!(advanced && advanced._starting),
    onChange: () => toWindow('storeapps:state', storeApps.status()),
  });
  if (!storeApps.available()) return;
  // A Store app opened later is seen at the next look, once a minute: a
  // sign-in broker an app calls on may not run for long. Cheap: tasklist
  // /apps; the programs' app containers are looked at only once that list
  // changed, the app containers' list read only for a sign not seen before
  // (or every half hour).
  setInterval(() => { storeApps.survey().catch(() => {}); }, 60 * 1000).unref();
}
ipcMain.handle('storeapps:status', () => (storeApps ? storeApps.status() : { available: false, on: false }));
ipcMain.handle('storeapps:set', async (e, on) => (storeApps ? storeApps.setMode(on === true) : { success: false }));

ipcMain.handle('settings:set', (e, key, value) => {
  // No list of one's own: follow the automatic list again.
  if (key === 'siteList' && !Array.isArray(value)) store.delete('siteList');
  else store.set(key, value);
  if (ENGINE_SETTINGS.has(key)) scheduleEngineRestart();
  if (PROXY_SETTINGS.has(key)) { routing = null; scheduleProxyReapply(); scheduleSiteListCheck(5000); }
  if (key === 'language') rebuildTrayMenu();
  if (key === 'showTrayIcon') setTrayIcon(value !== false);
  if (key === 'autoUpdate' && updater) updater.autoChanged();
  if (key === 'autoStart') {
    const ok = setAutoStart(value);
    if (!ok) { store.set('autoStart', false); return { success: false, error: 'Could not set auto-start' }; }
  }
  return { success: true };
});

ipcMain.handle('update:getState', () => (updater ? updater.state : { status: 'unsupported' }));
ipcMain.handle('update:check', () => (updater ? updater.check(true) : null));
ipcMain.handle('update:download', () => updater && updater.download());
ipcMain.handle('update:install', () => updater && updater.install());
ipcMain.handle('update:postpone', () => updater && updater.postpone());

ipcMain.handle('logs:get', () => systemLogs);
// The whole log, with what a report needs to know, to the clipboard only.
ipcMain.handle('logs:copy', () => copyLogs());
ipcMain.handle('logs:clear', () => { systemLogs = []; addLog('info', 'Logs cleared'); return true; });

ipcMain.handle('net:stats', async () => {
  const s = engine ? engine.getStats() : {};
  return {
    connsActive: s.connsActive || 0,
    connsTotal: s.connsTotal || 0,
    bytesUp: s.bytesUp || 0,
    bytesDown: s.bytesDown || 0,
    desync: s.desync || 0,
    tlsSeen: s.tlsSeen || 0,
    uptime: s.uptime || 0,
    sampledAt: s.sampledAt || 0,
  };
});
