'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, powerMonitor } = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');
const os = require('os');
const netModule = require('net');
const Store = require('electron-store');
const EngineManager = require('./engine-manager');
const SystemProxy = require('./system-proxy');
const AdvancedMode = require('./advanced-mode');
const Updater = require('./updater');
const Presence = require('./presence');
const i18n = require('./main-i18n');

/* "Shroudly --restore-proxy" runs once at login after a run that never got to
 * restore the system proxy (power loss, forced reboot). Restore and exit. */
const RESTORE_PROXY_ARG = '--restore-proxy';
const proxyStateFile = () => path.join(app.getPath('userData'), 'proxy-state.json');
if (process.argv.includes(RESTORE_PROXY_ARG)) {
  try { SystemProxy.recoverSync({ stateFile: proxyStateFile() }); } catch {}
  app.exit(0);
  return;
}

const store = new Store();
let mainWindow = null;
let tray = null;
let engine = null;
let advanced = null;
let updater = null;
let presence = null;
let systemLogs = [];
let exitInProgress = false;

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
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/* ── crash / hard-exit safety: restore the system proxy synchronously ─────── */
process.on('exit', () => { try { engine && engine.cleanupSync(); } catch {} try { advanced && advanced.cleanupSync(); } catch {} });
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log:new', entry);
  }
}

function isAutoStartLaunch() {
  if (process.argv.includes(AUTOSTART_ARG)) return true;
  // macOS login items get no arguments
  if (process.platform === 'darwin') { try { return app.getLoginItemSettings().wasOpenedAtLogin; } catch {} }
  return false;
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

function broadcastStatus(active) {
  rebuildTrayMenu(active);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dpi:status-changed', active);
  }
}

/* ── window ──────────────────────────────────────────────────────────────── */
function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
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

async function createWindow() {
  mainWindow = new BrowserWindow({
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

  mainWindow.loadURL(startUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (target !== mainWindow.webContents.getURL()) e.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    const toTray = isAutoStartLaunch() && store.get('minimizeToTray', true);
    if (toTray) { addLog('info', 'Auto-started in tray'); }
    else mainWindow.show();
    addLog('success', 'Application started');
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting && store.get('minimizeToTray', true)) {
      e.preventDefault();
      mainWindow.hide();
      notify('Shroudly', tr().minimized);
    }
  });

  createTray();
}

/* ── engine lifecycle wrappers ───────────────────────────────────────────── */
async function safeStart() {
  try {
    const r = await engine.start();
    broadcastStatus(true);
    notify('Shroudly', tr().started);
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
  engine = new EngineManager(store, {
    addLog, onStatusChange: broadcastStatus,
    proxyOptions: {
      stateFile: proxyStateFile(),
      watchdog: { execPath: process.execPath, script: path.join(__dirname, 'proxy-watchdog.js') },
      restoreCommand: {
        exe: launcherPath(),
        args: app.isPackaged ? [RESTORE_PROXY_ARG] : [app.getAppPath(), RESTORE_PROXY_ARG],
      },
    },
    onProbe: (p) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dpi:probe-result', p); },
  });
  advanced = new AdvancedMode(addLog);
  await engine.recover();

  updater = new Updater({
    log: addLog,
    store,
    notify: (version) => notify('Shroudly', tr().updateReady.replace('{version}', version)),
    // Installing quits the app: stop the engine first so the system proxy is
    // put back, exactly as on a normal quit.
    beforeInstall: async () => {
      exitInProgress = true;
      app.isQuitting = true;
      try { await engine.stop(); } catch {}
      try { await advanced.stop(); } catch {}
    },
  });
  updater.onState((s) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', s);
  });

  await createWindow();
  updater.start();

  presence = new Presence({
    onCount: (n) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('presence:count', n); },
  });
  presence.start();

  // Re-register every launch so the entry always points at this install
  // (moved app, updated AppImage, 2.0.0's broken Linux entry, legacy names).
  setAutoStart(store.get('autoStart', false));

  let started = false;
  mainWindow.webContents.on('did-finish-load', async () => {
    if (started) return;
    started = true;
    if (store.get('autoMode', true)) {
      addLog('info', 'Auto Mode: starting protection');
      setTimeout(() => { safeStart(); }, 1200);
    }
  });

  if (isDev) {
    const { globalShortcut } = require('electron');
    globalShortcut.register('F12', () => mainWindow && mainWindow.webContents.toggleDevTools());
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => { /* keep running in tray */ });

/* Logoff / shutdown / reboot: the OS may kill us before before-quit finishes,
 * so put the proxy back synchronously right away (reg.exe, networksetup,
 * gsettings: all fast). The login hook covers the case where even this
 * doesn't get to run. */
function restoreForSessionEnd() {
  try { engine && engine.cleanupSync(); } catch {}
  try { advanced && advanced.cleanupSync(); } catch {}
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
ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow && mainWindow.hide());

ipcMain.handle('dpi:start', async () => safeStart());
ipcMain.handle('dpi:stop', async () => safeStop());

/* Advanced (packet-layer) mode — optional, for stateful DPI (Iran/China). */
ipcMain.handle('advanced:available', () => ({
  available: advanced ? advanced.available() : false,
  reason: advanced ? advanced.reason() : 'not initialized',
  reasonCode: advanced ? advanced.reasonCode() : 'not_built',
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
ipcMain.handle('presence:get', () => (presence ? presence.online : null));
ipcMain.handle('presence:refresh', () => (presence ? presence.refresh() : null));

ipcMain.handle('settings:set', (e, key, value) => {
  store.set(key, value);
  if (ENGINE_SETTINGS.has(key)) scheduleEngineRestart();
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
