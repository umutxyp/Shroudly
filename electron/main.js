'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, powerMonitor, dialog, session } = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');
const os = require('os');
const netModule = require('net');
const Store = require('electron-store');
const EngineManager = require('./engine-manager');
const SystemProxy = require('./system-proxy');
const AdvancedMode = require('./advanced-mode');
const DiscordApp = require('./discord-app');
const DiscordRelay = require('./discord-relay');
const AppProxy = require('./app-proxy');
const AppEnv = require('./app-env');
const RobloxApp = require('./roblox-app');
const SiteList = require('./site-list');
const Updater = require('./updater');
const Presence = require('./presence');
const i18n = require('./main-i18n');

/* "Shroudly --restore-proxy" runs once at login after a run that never got to
 * restore the system proxy (power loss, forced reboot). Restore and exit. */
const RESTORE_PROXY_ARG = '--restore-proxy';
const proxyStateFile = () => path.join(app.getPath('userData'), 'proxy-state.json');
const appEnvStateFile = () => path.join(app.getPath('userData'), 'app-env.json');
if (process.argv.includes(RESTORE_PROXY_ARG)) {
  try { SystemProxy.recoverSync({ stateFile: proxyStateFile() }); } catch {}
  // Shroudly may already be running again (it starts at login too): its own
  // value is then left alone.
  try { AppEnv.recoverSync({ stateFile: appEnvStateFile() }, { onlyIfDead: true }); } catch {}
  app.exit(0);
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
let updater = null;
let presence = null;
let systemLogs = [];
let exitInProgress = false;
let discordRelay = null;
// Logout, shutdown or an update restart: leave Discord's line in place, so a
// Discord that starts at the next login finds the relay as soon as we are up.
let keepDiscordLine = false;
let appProxy = null;
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
  try { engine && engine.cleanupSync(); } catch {}
  try { advanced && advanced.cleanupSync(); } catch {}
  try { if (appEnv && appEnv.applied) appEnv.clearSync(); } catch {}
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
  const state = active ? s.active : s.inactive;
  const menu = Menu.buildFromTemplate([
    { label: s.open, click: () => showWindow() },
    { type: 'separator' },
    { label: `${s.status}: ${state}`, enabled: false },
    {
      label: active ? s.stop : s.start,
      click: async () => { active ? await safeStop() : await safeStart(); },
    },
    { type: 'separator' },
    { label: s.quit, click: () => { app.isQuitting = true; shutdownAndQuit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Shroudly — ${state}`);
  if (process.platform === 'darwin') tray.setImage(makeTrayIcon(active));
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  rebuildTrayMenu(false);
  tray.on('click', () => showWindow());
}

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
      set: new Set((Array.isArray(custom) ? custom : (siteList ? siteList.domains : [])).map((d) => String(d).toLowerCase())),
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
  ownProxyReady = Promise.all([session.defaultSession, session.fromPartition('electron-updater', { cache: false })]
    .map((s) => s.setProxy(cfg).catch(() => {})));
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
// One-off notices that must not be lost while there is no window: the latest
// of each is shown once the next window is up.
const STICKY = new Set(['dpi:need-restart', 'dpi:dns-auto-enabled', 'dpi:site-blocked']);
const pending = new Map();

function windowAlive() { return !!(mainWindow && !mainWindow.isDestroyed()); }

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
    notify('Shroudly', tr().minimized);
  }
}

function idleCheck() {
  if (!windowAlive()) return;
  const w = mainWindow;
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
    sessionWatch.on('query-session-end', () => { keepDiscordLine = true; });
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

async function createWindow({ show = true } = {}) {
  uiReady = false;
  const win = new BrowserWindow({
    width: 460, height: 760,
    minWidth: 360, minHeight: 560,
    maxWidth: 720, maxHeight: 1100,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
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

  win.once('ready-to-show', () => { if (show && !win.isDestroyed()) { win.show(); win.focus(); } });
  win.on('focus', markActive);
  win.on('show', markActive);
  win.on('restore', markActive);
  win.on('hide', () => { setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) releaseWindow('hidden'); }, 1000); });
  win.on('closed', () => { if (mainWindow === win) { mainWindow = null; uiReady = false; } });

  win.on('close', (e) => {
    if (!app.isQuitting && store.get('minimizeToTray', true)) {
      e.preventDefault();
      win.hide();
      notify('Shroudly', tr().minimized);
    }
  });
}

/* ── engine lifecycle wrappers ───────────────────────────────────────────── */
async function safeStart() {
  try {
    const r = await engine.start();
    broadcastStatus(true);
    notify('Shroudly', tr().started);
    syncPresence();
    return r || { success: true };
  } catch (e) {
    addLog('error', `Start failed: ${e.message}`);
    broadcastStatus(false);
    return { success: false, error: e.message };
  }
}

async function safeStop() {
  try {
    await engine.stop();
    broadcastStatus(false);
    notify('Shroudly', tr().stopped);
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
    proxyOptions: { stateFile: proxyStateFile(), watchdog, restoreCommand },
    onProbe: (p) => toWindow('dpi:probe-result', p),
    // A site that defeated every technique. Told once per site, and at most
    // once every few minutes, so a page full of blocked resources cannot turn
    // into a stream of notifications.
    // Programs that were already open when protection started are still using
    // the connection they were given at launch.
    // Encrypted DNS was switched back on because a site could not be reached
    // without it. The settings screen has to show the new state.
    // What the window should say about this network: another VPN running,
    // the kind of filtering detected, sites that connect and are then cut,
    // encrypted DNS blocked.
    onAdvice: (advice) => {
      toWindow('dpi:advice', advice);
    },
    onDnsAutoEnabled: (host) => {
      toWindow('dpi:dns-auto-enabled', { host });
    },

    onNeedRestart: (apps) => {
      // Shown inside the window only. As a system notification this reads like
      // something has gone wrong with the program it names, which is alarming
      // and untrue — nothing happened to it, it simply started before the
      // protection did.
      toWindow('dpi:need-restart', { apps });
    },

    onSiteBlocked: (host) => {
      const now = Date.now();
      if (now - lastBlockedNotice < 5 * 60 * 1000) return;
      lastBlockedNotice = now;
      notify(tr().siteBlockedTitle, tr().siteBlockedBody.replace('{host}', host));
      toWindow('dpi:site-blocked', { host });
      showWindow();
    },
  });
  advanced = new AdvancedMode(addLog);
  await engine.recover();

  // The relay goes through the engine while protection is on, straight to
  // Discord while it is off, and runs whenever Shroudly does.
  discordRelay = new DiscordRelay(addLog, () => (engine && engine.isActive() ? engine.port : null));
  if (store.get('discordMode') === true) applyDiscordMode(true, { interactive: false }).catch(() => {});

  // Like the relay: through the engine while protection is on, direct while
  // it is off, and up whenever Shroudly is with the mode on.
  appProxy = new AppProxy(addLog, () => (engine && engine.isActive() ? engine.port : null), isRouted);
  appEnv = new AppEnv({ stateFile: appEnvStateFile(), watchdog, restoreCommand });

  updater = new Updater({
    log: addLog,
    store,
    notify: (version) => notify('Shroudly', tr().updateReady.replace('{version}', version)),
    // Installing quits the app: stop the engine first so the system proxy is
    // put back, exactly as on a normal quit.
    beforeInstall: async () => {
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

  createTray();
  watchSessionEnd();
  // Started at login into the tray: no window at all until it is opened.
  if (isAutoStartLaunch() && store.get('minimizeToTray', true)) addLog('info', 'Auto-started in tray');
  else await createWindow({ show: true });
  addLog('success', 'Application started');
  updater.start();

  // After the window is up: on Windows this writes the registry, which takes
  // a moment the window should not wait for.
  if (store.get('appMode') === true && AppEnv.supported()) applyAppMode(true).catch(() => {});
  else if (fs.existsSync(appEnvStateFile())) {
    // Left by a run that never got to clean up (the file is written before
    // anything else and removed last).
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

  // Independent of the window, which may never be opened this session.
  if (store.get('autoMode', true)) {
    addLog('info', 'Auto Mode: starting protection');
    setTimeout(() => { safeStart(); }, 1200);
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
function restoreForSessionEnd() {
  keepDiscordLine = true;
  try { engine && engine.cleanupSync(); } catch {}
  try { advanced && advanced.cleanupSync(); } catch {}
  // Unlike Discord's line, HTTPS_PROXY would be read by every program at the
  // next login, before Shroudly is back: it goes, and returns when we do.
  try { if (appEnv && appEnv.applied) appEnv.clearSync(); } catch {}
}
app.on('session-end', restoreForSessionEnd); // Windows
app.whenReady().then(() => { powerMonitor.on('shutdown', restoreForSessionEnd); }); // macOS, Linux

/* Every way of quitting (Cmd+Q, Dock, tray, menu, updater) lands here. Mark
 * the app as quitting first: otherwise the window's close handler turns the
 * quit into "minimize to tray" and the app never exits (Cmd+Q on macOS while
 * protection was off). Restoring the proxy is capped so a slow system call
 * can't hold the quit hostage; the 'exit' handler still restores it
 * synchronously as a last resort. */
const QUIT_RESTORE_LIMIT_MS = 5000;
app.on('before-quit', (e) => {
  app.isQuitting = true;
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
ipcMain.on('window:close', () => { if (windowAlive()) mainWindow.hide(); });
/* The interface reports use (throttled) and when it is listening. */
ipcMain.on('ui:active', (e) => { if (windowAlive() && e.sender === mainWindow.webContents) markActive(); });
ipcMain.on('ui:ready', (e) => {
  if (!windowAlive() || e.sender !== mainWindow.webContents) return;
  uiReady = true;
  for (const [channel, payload] of pending) { try { mainWindow.webContents.send(channel, payload); } catch {} }
  pending.clear();
});

ipcMain.handle('dpi:advice', () => (engine ? engine.advice : null));
ipcMain.handle('dpi:start', async () => safeStart());
ipcMain.handle('dpi:stop', async () => safeStop());

/* Advanced (packet-layer) mode — optional, for stateful DPI (Iran/China). */
ipcMain.handle('advanced:available', () => ({
  available: advanced ? advanced.available() : false,
  reason: advanced ? advanced.reason() : 'not initialized',
  reasonCode: advanced ? advanced.reasonCode() : 'not_built',
  installCommand: process.platform === 'linux' ? AdvancedMode.linuxInstallCommand() : null,
  active: advanced ? advanced.active : false,
}));
ipcMain.handle('advanced:start', async () => {
  try {
    const ttl = Number(store.get('fakeTtl', 4)) || 4;
    const r = await advanced.start(ttl);
    addLog('success', 'Advanced mode enabled');
    return r || { success: true };
  } catch (e) {
    addLog('error', `Advanced mode failed: ${e.message}`);
    return { success: false, error: e.message, code: e.code || 'start_failed' };
  }
});
ipcMain.handle('advanced:stop', async () => {
  try { await advanced.stop(); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('dpi:status', () => ({
  active: engine ? engine.isActive() : false,
  stats: engine ? engine.getStats() : {},
}));
ipcMain.handle('dpi:probe', (e, host) => {
  if (engine && typeof host === 'string' && host) engine.probe(host);
  return { success: true };
});

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
    engine.reapplyProxy().catch((err) => addLog('error', `Proxy update failed: ${err.message}`));
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

ipcMain.handle('discord:status', async () => {
  const builds = DiscordApp.installed();
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
ipcMain.handle('discord:set', async (e, on) => applyDiscordMode(on === true));
ipcMain.handle('discord:decline', () => { if (store.get('discordMode') === undefined) store.set('discordMode', false); return { success: true }; });
ipcMain.handle('discord:restart', async () => {
  let ok = false;
  for (const v of DiscordApp.installed()) if (await DiscordApp.isRunning(v)) ok = (await DiscordApp.restart(v)) || ok;
  if (ok) { discordState.needsRestart = false; sendDiscordState(); }
  return { success: ok };
});

/* ── Games and apps mode ─────────────────────────────────────────────────── */
/* Roblox and many other programs ignore the system proxy and only read
 * HTTPS_PROXY from their environment: see app-proxy.js and app-env.js. What
 * the window shows: a Roblox that was open before the change and has to be
 * restarted, or a proxy of the user's own that is in the way. */
const appState = { needsRestart: false, foreign: false, failed: false };
let robloxPidsAtChange = [];

function sendAppState() {
  toWindow('apps:state', appState);
}

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
    appState.needsRestart = false;
    appState.foreign = false;
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
  try { r = appEnv.applySync(AppProxy.proxyUrl(port)); } catch (e) {
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
    // Roblox reads the proxy when it starts: one already open needs a restart.
    robloxPidsAtChange = await RobloxApp.pids();
    appState.needsRestart = robloxPidsAtChange.length > 0;
    addLog('success', 'Games and apps mode on: Roblox and similar programs go through Shroudly');
  }
  sendAppState();
  return { success: true, restartNeeded: appState.needsRestart };
}

/* opts.running: also say whether Roblox is running now, which lists the
 * running programs (tasklist / pgrep). Asked when the window comes into view,
 * not on every check: whether the copy that needs a restart is still open is
 * answered from its process ids alone. */
ipcMain.handle('apps:status', async (e, opts) => {
  let running = [];
  if (appState.needsRestart) {
    running = RobloxApp.alive(robloxPidsAtChange);
    // The copy that was open when the mode came on has been closed since.
    if (!running.length) appState.needsRestart = false;
  } else if (opts && opts.running === true) {
    running = await RobloxApp.pids();
  }
  return {
    available: AppEnv.supported(),
    mode: store.get('appMode') ?? null,  // true, false, or null (never asked)
    robloxInstalled: RobloxApp.installed(),
    robloxRunning: running.length > 0,
    platform: process.platform,
    ...appState,
  };
});
ipcMain.handle('apps:set', async (e, on) => applyAppMode(on === true));
ipcMain.handle('apps:decline', () => { if (store.get('appMode') === undefined) store.set('appMode', false); return { success: true }; });
ipcMain.handle('apps:restartRoblox', async () => {
  // On Windows Shroudly starts the new copy itself, with the proxy in its
  // environment; macOS starts it with the session's, which already has it.
  // Shroudly itself may have inherited an older value of ours (started from
  // Explorer before a crash's leftovers were cleaned): only a proxy that is
  // somebody else's is kept.
  const env = {};
  const ours = (v) => !v || /^http:\/\/127\.0\.0\.1:\d+$/.test(v);
  if (appProxy && appProxy.url) {
    if (ours(process.env.HTTPS_PROXY)) env.HTTPS_PROXY = appProxy.url;
    if (!process.env.NO_PROXY || process.env.NO_PROXY === AppEnv.NO_PROXY_VALUE) env.NO_PROXY = AppEnv.NO_PROXY_VALUE;
  }
  const ok = await RobloxApp.restart(env);
  if (ok) { appState.needsRestart = false; sendAppState(); }
  return { success: ok };
});

ipcMain.handle('settings:set', (e, key, value) => {
  // No list of one's own: follow the automatic list again.
  if (key === 'siteList' && !Array.isArray(value)) store.delete('siteList');
  else store.set(key, value);
  if (ENGINE_SETTINGS.has(key)) scheduleEngineRestart();
  if (PROXY_SETTINGS.has(key)) { routing = null; scheduleProxyReapply(); scheduleSiteListCheck(5000); }
  if (key === 'language') rebuildTrayMenu();
  if (key === 'autoUpdate' && value !== false && updater && updater.state.status === 'available') updater.download();
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
