const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform, // 'darwin' | 'win32' | 'linux'

  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // Engine controls
  startDPI: () => ipcRenderer.invoke('dpi:start'),
  stopDPI: () => ipcRenderer.invoke('dpi:stop'),
  getDPIStatus: () => ipcRenderer.invoke('dpi:status'),
  probeHost: (host) => ipcRenderer.invoke('dpi:probe', host),
  onDPIStatusChanged: (cb) => ipcRenderer.on('dpi:status-changed', (e, active) => cb(active)),
  removeDPIStatusListener: () => ipcRenderer.removeAllListeners('dpi:status-changed'),

  // App info
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  // Auto-update (GitHub releases)
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  postponeUpdate: () => ipcRenderer.invoke('update:postpone'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (e, s) => cb(s)),
  removeUpdateListener: () => ipcRenderer.removeAllListeners('update:state'),

  // OS UI languages in preference order (e.g. ["tr-TR", "en-US"])
  getSystemLanguages: () => ipcRenderer.invoke('app:systemLanguages'),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  getAllSettings: () => ipcRenderer.invoke('settings:getAll'),

  // Logs
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  onNewLog: (cb) => ipcRenderer.on('log:new', (e, log) => cb(log)),
  removeLogListener: () => ipcRenderer.removeAllListeners('log:new'),

  // Network stats (real counters from the engine)
  getNetStats: () => ipcRenderer.invoke('net:stats'),
  ipv6Available: () => ipcRenderer.invoke('net:ipv6Available'),
  // Live count of running Shroudly apps (null until the first answer)
  defaultSiteList: () => ipcRenderer.invoke('settings:defaultSiteList'),
  getOnlineCount: () => ipcRenderer.invoke('presence:get'),
  refreshOnlineCount: () => ipcRenderer.invoke('presence:refresh'),
  onOnlineCount: (cb) => ipcRenderer.on('presence:count', (e, n) => cb(n)),
  removeOnlineCountListener: () => ipcRenderer.removeAllListeners('presence:count'),

  // Advanced (packet-layer) mode — optional, stateful-DPI countries
  advancedAvailable: () => ipcRenderer.invoke('advanced:available'),
  startAdvanced: () => ipcRenderer.invoke('advanced:start'),
  stopAdvanced: () => ipcRenderer.invoke('advanced:stop'),
  onProbeResult: (cb) => ipcRenderer.on('dpi:probe-result', (e, p) => cb(p)),
  onSiteBlocked: (cb) => ipcRenderer.on('dpi:site-blocked', (e, p) => cb(p)),
  setTitleBarColors: (c) => ipcRenderer.invoke('ui:titlebar', c),
  onNeedRestart: (cb) => ipcRenderer.on('dpi:need-restart', (e, p) => cb(p)),
  onDnsAutoEnabled: (cb) => ipcRenderer.on('dpi:dns-auto-enabled', (e, p) => cb(p)),
  removeNeedRestartListener: () => ipcRenderer.removeAllListeners('dpi:need-restart'),
  removeSiteBlockedListener: () => ipcRenderer.removeAllListeners('dpi:site-blocked'),
  removeDnsAutoEnabledListener: () => ipcRenderer.removeAllListeners('dpi:dns-auto-enabled'),
  removeProbeListener: () => ipcRenderer.removeAllListeners('dpi:probe-result'),

});
