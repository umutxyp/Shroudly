'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification } = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');
const Store = require('electron-store');
const EngineManager = require('./engine-manager');
const AdvancedMode = require('./advanced-mode');

const store = new Store();
let mainWindow = null;
let tray = null;
let engine = null;
let advanced = null;
let systemLogs = [];
let exitInProgress = false;

const isDev = !app.isPackaged;
const DEV_PORT = process.env.PORT || 3000;
const AUTOSTART_ARG = '--autostart';

function appVersion() {
  try { return app.isPackaged ? app.getVersion() : require('../package.json').version; }
  catch { return app.getVersion(); }
}

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
  if (!exitInProgress) { exitInProgress = true; shutdownAndQuit(); }
});
process.on('unhandledRejection', (r) => console.error('[Shroudly] rejection:', r));

/* ── helpers ─────────────────────────────────────────────────────────────── */
function getAssetPath(...segments) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...segments)
    : path.join(__dirname, '..', ...segments);
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
  return process.argv.includes(AUTOSTART_ARG);
}

function notify(title, body) {
  if (store.get('showNotifications', true) && Notification.isSupported()) {
    try { new Notification({ title, body, icon: trayIconPath() }).show(); } catch {}
  }
}

/* ── tray + status ───────────────────────────────────────────────────────── */
function trayIconPath() {
  return process.platform === 'win32' ? getAssetPath('public', 'icon.ico')
                                      : getAssetPath('public', 'icon-small.png');
}

function makeTrayIcon() {
  try {
    const img = nativeImage.createFromPath(trayIconPath());
    return img.isEmpty() ? nativeImage.createEmpty() : img;
  } catch { return nativeImage.createEmpty(); }
}

function rebuildTrayMenu(active) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open Shroudly', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Status', enabled: false },
    { label: active ? '● Active' : '○ Inactive', enabled: false },
    { type: 'separator' },
    {
      label: active ? 'Stop' : 'Start',
      click: async () => { active ? await safeStop() : await safeStart(); },
    },
    { type: 'separator' },
    { label: 'Exit', click: () => { app.isQuitting = true; shutdownAndQuit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Shroudly — ${active ? 'Active' : 'Inactive'}`);
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
    frame: false,
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
      notify('Shroudly', 'Minimized to tray');
    }
  });

  createTray();
}

/* ── engine lifecycle wrappers ───────────────────────────────────────────── */
async function safeStart() {
  try {
    const r = await engine.start();
    broadcastStatus(true);
    notify('Shroudly', 'Protection started');
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
    return { success: true };
  } catch (e) {
    addLog('error', `Stop failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function shutdownAndQuit() {
  try { if (engine) await engine.stop(); } catch {}
  try { if (advanced) await advanced.stop(); } catch {}
  app.quit();
}

/* ── auto-start (per-OS, no elevation) ───────────────────────────────────── */
function setAutoStart(enable) {
  try {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: enable,
        args: [AUTOSTART_ARG],
        ...(process.platform === 'win32' ? { path: process.execPath } : {}),
      });
      return true;
    }
    const dir = path.join(app.getPath('home'), '.config', 'autostart');
    const file = path.join(dir, 'shroudly.desktop');
    if (enable) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file,
        `[Desktop Entry]\nType=Application\nName=Shroudly\nExec=${process.execPath} ${AUTOSTART_ARG}\nX-GNOME-Autostart-enabled=true\n`);
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
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}

/* ── app ready ───────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  engine = new EngineManager(store, {
    addLog, onStatusChange: broadcastStatus,
    onProbe: (p) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dpi:probe-result', p); },
  });
  advanced = new AdvancedMode(addLog);
  await engine.recover();

  await createWindow();

  const savedAuto = store.get('autoStart', false);
  if (savedAuto !== getAutoStartEnabled()) setAutoStart(savedAuto);

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

app.on('before-quit', async (e) => {
  if (exitInProgress) return;
  if (engine && engine.isActive()) {
    e.preventDefault();
    exitInProgress = true;
    app.isQuitting = true;
    addLog('info', 'Restoring system before exit...');
    await engine.stop();
    app.quit();
  }
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
    return { success: false, error: e.message };
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
ipcMain.handle('settings:getAll', () => store.store);
ipcMain.handle('settings:set', (e, key, value) => {
  store.set(key, value);
  if (key === 'autoStart') {
    const ok = setAutoStart(value);
    if (!ok) { store.set('autoStart', false); return { success: false, error: 'Could not set auto-start' }; }
  }
  return { success: true };
});

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
  };
});
