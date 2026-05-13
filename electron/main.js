const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const DPIBypass = require('./dpi-bypass');
const fs = require('fs');
const url = require('url');
const { execFile } = require('child_process');

const store = new Store();
let mainWindow;
let tray = null;
let dpiBypass = null;
let systemLogs = [];
let currentOverlayColor = null;
let cleanupBeforeQuitComplete = false;
let exitInProgress = false;
const AUTO_START_TASK_NAME = 'Shroudly';
const AUTO_START_LAUNCH_ARG = '--autostart';

// Configuration
const isDev = !app.isPackaged;
const PORT = process.env.PORT || 3000;

// ─── Crash / hard-exit safety ─────────────────────────────────────────────────

// Synchronous last resort on any process exit (including crashes / OOM kills).
// Cannot use async here, so we only do the engine kill — network settings are
// recovered by recoverPreviousSession() on the next app start.
process.on('exit', () => {
  try { dpiBypass?.killShroudlyEngineSync(); } catch {}
});

// Catch JS exceptions that bubble to the top so we can clean up before exiting.
process.on('uncaughtException', (error) => {
  console.error('[Shroudly] Uncaught exception:', error);
  if (!exitInProgress) {
    exitInProgress = true;
    stopDPIForExit()
      .catch(() => {})
      .finally(() => {
        cleanupBeforeQuitComplete = true;
        app.quit();
      });
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[Shroudly] Unhandled rejection:', reason);
});

// ─────────────────────────────────────────────────────────────────────────────

function getAssetPath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  }

  return path.join(__dirname, '..', ...segments);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
const SAFE_NETWORK_DEFAULTS = {
  allowSystemNetworkChanges: false,
  customDNS: false,
  nativeFrag: false,
  ttlManipulation: false,
};

if (!gotSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
});

function enforceSafeNetworkDefaults() {
  for (const [key, value] of Object.entries(SAFE_NETWORK_DEFAULTS)) {
    if (store.get(key) !== value) {
      store.set(key, value);
    }
  }
}

function isAutoStartLaunch() {
  return process.argv.includes(AUTO_START_LAUNCH_ARG);
}

function runPowerShellSync(script, options = {}) {
  const { execFileSync } = require('child_process');
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    windowsHide: true,
    ...options,
  });
}

// Check if dev server is available
async function checkDevServer() {
  if (!isDev) return false;
  
  try {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${PORT}`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

// Log function
function addLog(level, message) {
  const log = {
    time: new Date().toISOString(),
    level,
    message,
  };
  systemLogs.push(log);
  
  // Keep only last 1000 logs
  if (systemLogs.length > 1000) {
    systemLogs.shift();
  }
  
  // Send to renderer if window exists
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log:new', log);
  }
  
  console.log(`[${level.toUpperCase()}] ${message}`);
}

// Create status overlay icon (green/red dot)
function createOverlayIcon(color) {
  const iconPath = color === '#22c55e'
    ? getAssetPath('icon-small.png')
    : getAssetPath('icon.ico');
  return nativeImage.createFromPath(iconPath);
}

// Create tray icon with status indicator
function createTrayIcon(isActive) {
  const iconPath = isActive
    ? getAssetPath('icon-small.png')
    : getAssetPath('icon.ico');
  return nativeImage.createFromPath(iconPath);
}

// Update status indicators
function updateStatusIndicators(isActive) {
  const color = isActive ? '#22c55e' : '#ef4444'; // green : red
  
  // Update taskbar overlay (Windows footer icon)
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (currentOverlayColor !== color) {
      const overlay = createOverlayIcon(color);
      mainWindow.setOverlayIcon(overlay, isActive ? 'DPI Bypass Active' : 'DPI Bypass Inactive');
      currentOverlayColor = color;
    }
  }
  
  // Update system tray icon
  if (tray && !tray.isDestroyed()) {
    const trayIcon = createTrayIcon(isActive);
    tray.setImage(trayIcon);
    tray.setToolTip(`Shroudly - ${isActive ? 'Active' : 'Inactive'}`);
    
    // Update tray menu
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Shroudly',
        click: () => mainWindow.show(),
      },
      { type: 'separator' },
      {
        label: 'Status',
        enabled: false,
      },
      {
        label: isActive ? '🟢 Active' : '🔴 Inactive',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: async () => {
          if (!exitInProgress) {
            exitInProgress = true;
            app.isQuitting = true;
            await stopDPIForExit();
            cleanupBeforeQuitComplete = true;
          }
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
  }
}

function broadcastDPIStatus(isActive) {
  updateStatusIndicators(isActive);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dpi:status-changed', isActive);
  }
}

async function stopDPIForExit() {
  if (!dpiBypass) {
    return;
  }

  try {
    await Promise.race([
      dpiBypass.stop(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Cleanup timed out after 18s')), 18000)
      ),
    ]);
  } catch (error) {
    addLog('error', `Cleanup failed during exit: ${error.message}`);
    // Force-kill engine as last resort so internet is not left broken.
    try { dpiBypass.killShroudlyEngineSync(); } catch {}
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 820,
    minWidth: 420,
    minHeight: 680,
    maxWidth: 620,
    maxHeight: 960,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
    icon: getAssetPath('icon.ico'),
    title: 'Shroudly - Unseen. Unstoppable.',
    frame: false,
    backgroundColor: '#0A0E1A',
    show: false,
  });

  // Determine which URL to load
  let startUrl;
  const devServerAvailable = await checkDevServer();
  
  if (isDev && devServerAvailable) {
    // Development with Next.js dev server
    startUrl = `http://localhost:${PORT}`;
    console.log('🌐 Mode: Development (with dev server)');
  } else {
    // Production or development without dev server
    const indexPath = path.join(__dirname, '../out/index.html');
    
    // Check if out folder exists
    if (!fs.existsSync(indexPath)) {
      console.error('❌ Build files not found! Run: npm run build');
      addLog('error', 'Build files not found. Please run "npm run build" first.');
      
      // Show error dialog
      const { dialog } = require('electron');
      dialog.showErrorBox(
        'Build Required',
        'Application build files not found.\n\nPlease run: npm run build\n\nOr use: npm run electron:dev for development'
      );
      app.quit();
      return;
    }
    
    // Use file:// protocol with proper path formatting
    startUrl = url.format({
      pathname: indexPath,
      protocol: 'file:',
      slashes: true
    });
    console.log('🌐 Mode: Production (using static files)');
  }

  console.log('🚀 Shroudly starting...');
  console.log('📍 isDev:', isDev);
  console.log('🌐 Loading URL:', startUrl);
  
  addLog('info', 'Shroudly initializing...');
  addLog('info', `Loading from: ${devServerAvailable ? 'Dev Server' : 'Static Files'}`);

  mainWindow.loadURL(startUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:\/\//i.test(targetUrl)) {
      shell.openExternal(targetUrl);
    }

    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    const launchToTray = isAutoStartLaunch() && store.get('minimizeToTray', true);
    if (launchToTray) {
      mainWindow.hide();
      console.log('[Shroudly] Auto-start launch detected, staying in tray');
      addLog('info', 'Application auto-started in tray');
    } else {
      mainWindow.show();
    }
    console.log(launchToTray ? '[Shroudly] Window ready in tray' : '[Shroudly] Window ready and shown');
    addLog('success', 'Application started successfully');
    addLog('info', 'DPI Bypass engine ready');
  });

  // Error handling
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('❌ Failed to load:', validatedURL);
    console.error('Error code:', errorCode);
    console.error('Error description:', errorDescription);
  });

  mainWindow.on('close', (event) => {
    // Check minimize to tray setting
    const minimizeToTray = store.get('minimizeToTray', true);
    
    if (!app.isQuitting && minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      
      // Show notification if enabled
      const showNotifications = store.get('showNotifications', true);
      if (showNotifications) {
        const { Notification } = require('electron');
        if (Notification.isSupported()) {
          new Notification({
            title: 'Shroudly',
            body: 'Application minimized to system tray',
            icon: getAssetPath('icon-small.png')
          }).show();
        }
      }
    }
  });

  // Create tray
  createTray();
  
  // Initialize status indicators as inactive
  updateStatusIndicators(false);
}

function createTray() {
  // Create initial tray icon (inactive state)
  const trayIcon = createTrayIcon(false);
  
  tray = new Tray(trayIcon);
  tray.setToolTip('Shroudly - Inactive');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Shroudly',
      click: () => mainWindow.show(),
    },
    { type: 'separator' },
    {
      label: 'Status',
      enabled: false,
    },
    {
      label: '🔴 Inactive',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: async () => {
        app.isQuitting = true;
        await stopDPIForExit();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    mainWindow.show();
  });
}

// Auto-start functionality
// Elevated apps launched from the HKCU Run key are unreliable on Windows login.
// Use Task Scheduler with highest privileges so the packaged app actually starts.
function setAutoStart(enable) {
  if (isDev) {
    addLog('warning', 'Auto-start not available in development mode');
    return false;
  }

  try {
    if (enable) {
      const exePath = process.execPath.replace(/'/g, "''");
      runPowerShellSync(`
$taskName = '${AUTO_START_TASK_NAME}'
$exePath = '${exePath}'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $exePath -Argument '${AUTO_START_LAUNCH_ARG}'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`, { stdio: 'ignore' });
    } else {
      runPowerShellSync(`
$task = Get-ScheduledTask -TaskName '${AUTO_START_TASK_NAME}' -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName '${AUTO_START_TASK_NAME}' -Confirm:$false
}
`, { stdio: 'ignore' });
    }
    addLog('success', `Auto-start ${enable ? 'enabled' : 'disabled'}`);
    return true;
  } catch (error) {
    console.error('[Shroudly] Auto-start error:', error.message);
    addLog('error', `Auto-start error: ${error.message}`);
    return false;
  }
}

function getAutoStartEnabled() {
  if (isDev) return false;
  try {
    const out = runPowerShellSync(`
$task = Get-ScheduledTask -TaskName '${AUTO_START_TASK_NAME}' -ErrorAction SilentlyContinue
if (-not $task) { return }
$action = $task.Actions | Select-Object -First 1
if ($action -and $action.Execute -eq '${process.execPath.replace(/'/g, "''")}' -and $task.State -ne 'Disabled') {
  'true'
}
`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out === 'true';
  } catch {
    return false;
  }
}

function relaunchAsAdmin() {
  const args = isDev ? [app.getAppPath()] : [];
  const escapedPath = process.execPath.replace(/'/g, "''");
  const escapedArgs = args
    .map((arg) => `'${String(arg).replace(/'/g, "''")}'`)
    .join(',');
  const argumentList = escapedArgs ? ` -ArgumentList @(${escapedArgs})` : '';

  execFile('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Start-Process -FilePath '${escapedPath}'${argumentList} -Verb RunAs`,
  ], { windowsHide: true });
}

app.whenReady().then(async () => {
  enforceSafeNetworkDefaults();

  dpiBypass = new DPIBypass(store, {
    addLog,
    onStatusChange: broadcastDPIStatus,
  });

  await dpiBypass.initialize();
  await createWindow();

  // Check and sync auto-start setting on startup
  if (!isDev) {
    const savedAutoStart = store.get('autoStart', false);
    const currentlyEnabled = getAutoStartEnabled();
    if (savedAutoStart !== currentlyEnabled) {
      console.log('[Shroudly] Auto-start setting mismatch detected, syncing...');
      setAutoStart(savedAutoStart);
    }
  }

  let autoStartAttempted = false; // Prevent multiple auto-start attempts

  // Auto-start DPI bypass if Auto Mode is enabled
  mainWindow.webContents.on('did-finish-load', async () => {
    if (autoStartAttempted) {
      return; // Already attempted, skip
    }
    autoStartAttempted = true;

    const autoMode = store.get('autoMode', true);
    if (autoMode) {
      addLog('info', 'Auto Mode enabled - starting DPI bypass automatically');
      
      // Wait a bit for UI to be ready
      setTimeout(async () => {
        try {
          if (!dpiBypass) {
            addLog('error', 'DPI Bypass engine not initialized');
            return;
          }

          const result = await dpiBypass.start();
          if (result && result.success) {
            addLog('success', 'DPI bypass started automatically');
            broadcastDPIStatus(true);
            
            // Show notification if enabled
            const showNotifications = store.get('showNotifications', true);
            if (showNotifications) {
              const { Notification } = require('electron');
              if (Notification.isSupported()) {
                new Notification({
                  title: 'Shroudly - Auto Mode',
                  body: 'DPI bypass started automatically',
                  icon: getAssetPath('icon.ico')
                }).show();
              }
            }
          } else {
            const errorMsg = result?.error || 'Unknown error';
            addLog('error', `Auto-start failed: ${errorMsg}`);
            updateStatusIndicators(false);
          }
        } catch (error) {
          addLog('error', `Auto-start error: ${error?.message || 'Unknown error'}`);
          updateStatusIndicators(false);
        }
      }, 2000); // 2 second delay for UI to load
    }
  });

  // Register F12 to toggle DevTools
  if (isDev) {
    const { globalShortcut } = require('electron');
    globalShortcut.register('F12', () => {
      if (mainWindow) {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit, just hide to tray
  }
});

app.on('before-quit', async (event) => {
  if (cleanupBeforeQuitComplete || exitInProgress) {
    return;
  }

  const pendingRestore = Boolean(store.get('dpiRuntimeState')?.pendingRestore);
  if (dpiBypass?.isActive || pendingRestore) {
    event.preventDefault();
    exitInProgress = true;
    app.isQuitting = true;
    addLog('info', 'Restoring network settings before exit...');
    await stopDPIForExit();
    cleanupBeforeQuitComplete = true;
    app.quit();
  }
});

// IPC Handlers
ipcMain.on('window:minimize', () => {
  mainWindow.minimize();
});

ipcMain.on('window:maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window:close', () => {
  mainWindow.hide();
});

ipcMain.handle('dpi:start', async (event, config) => {
  try {
    addLog('info', 'Starting DPI Bypass...');
    const result = await dpiBypass.start(config);
    broadcastDPIStatus(true);
    addLog('success', 'DPI Bypass activated successfully');
    return result || { success: true };
  } catch (error) {
    addLog('error', `Failed to start DPI Bypass: ${error.message}`);
    
    // Check if it's an admin rights error
    if (error.message.includes('Administrator')) {
      const { dialog } = require('electron');
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Administrator Rights Required',
        message: 'DPI Bypass requires administrator privileges to modify network settings.',
        detail: 'Please restart the application as administrator.',
        buttons: ['Restart as Admin', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      });
      
      if (result.response === 0) {
        // Restart with admin rights
        relaunchAsAdmin();
        app.quit();
      }
    }
    
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dpi:stop', async () => {
  try {
    addLog('info', 'Stopping DPI Bypass...');
    await dpiBypass.stop();
    broadcastDPIStatus(false);
    addLog('success', 'DPI Bypass stopped successfully');
    return { success: true };
  } catch (error) {
    addLog('error', `Failed to stop DPI Bypass: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dpi:status', () => {
  return {
    active: dpiBypass?.isActive || false,
    stats: dpiBypass?.getStats() || {},
  };
});

ipcMain.handle('app:getInfo', async () => {
  return {
    version: app.getVersion(),
    year: new Date().getFullYear(),
    isAdmin: await dpiBypass?.checkAdminRights(),
  };
});

ipcMain.handle('settings:get', (event, key) => {
  return store.get(key);
});

ipcMain.handle('settings:set', (event, key, value) => {
  if (Object.prototype.hasOwnProperty.call(SAFE_NETWORK_DEFAULTS, key)) {
    store.set(key, SAFE_NETWORK_DEFAULTS[key]);
    return {
      success: true,
      value: SAFE_NETWORK_DEFAULTS[key],
      warning: 'System-level DNS, MTU and TTL changes are disabled in safe mode.',
    };
  }

  store.set(key, value);
  
  // Handle special settings
  if (key === 'autoStart') {
    const success = setAutoStart(value);
    if (!success && !isDev) {
      // If setting failed, revert the store value
      store.set('autoStart', false);
      return { success: false, error: 'Failed to set auto-start. Try running as administrator.' };
    }
  }
  
  return { success: true };
});

ipcMain.handle('settings:getAll', () => {
  return store.store;
});

ipcMain.handle('logs:get', () => {
  return systemLogs;
});

ipcMain.handle('logs:clear', () => {
  systemLogs = [];
  addLog('info', 'Logs cleared');
  return true;
});

// ── Network stats (ping + speed) ────────────────────────────────────────────
const net = require('net');
let _prevNetBytes = null;
let _prevNetTime  = null;

function measurePing() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s  = net.createConnection(53, '8.8.8.8');
    s.setTimeout(3000);
    s.once('connect', () => { s.destroy(); resolve(Date.now() - t0); });
    s.once('error',   () => { s.destroy(); resolve(null); });
    s.once('timeout', () => { s.destroy(); resolve(null); });
  });
}

function measureNetSpeed() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('netstat -e', { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve({ dl: 0, ul: 0 });
      const m = stdout.match(/Bytes\s+([\d,]+)\s+([\d,]+)/i);
      if (!m) return resolve({ dl: 0, ul: 0 });
      const rx = parseInt(m[1].replace(/,/g, ''));
      const tx = parseInt(m[2].replace(/,/g, ''));
      const now = Date.now();
      let dl = 0, ul = 0;
      if (_prevNetBytes && _prevNetTime) {
        const secs = (now - _prevNetTime) / 1000;
        if (secs > 0) {
          dl = Math.max(0, (rx - _prevNetBytes.rx) / secs);
          ul = Math.max(0, (tx - _prevNetBytes.tx) / secs);
        }
      }
      _prevNetBytes = { rx, tx };
      _prevNetTime  = now;
      resolve({ dl, ul });
    });
  });
}

ipcMain.handle('net:stats', async () => {
  const [ping, speed] = await Promise.all([measurePing(), measureNetSpeed()]);
  return { ping, dl: speed.dl, ul: speed.ul };
});

function updateTrayStatus(isActive) {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Shroudly',
      click: () => mainWindow.show(),
    },
    { type: 'separator' },
    {
      label: 'Status',
      enabled: false,
    },
    {
      label: isActive ? '● Active' : '○ Inactive',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: async () => {
        app.isQuitting = true;
        await stopDPIForExit();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}
