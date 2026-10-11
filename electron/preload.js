const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
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

  // Advanced (packet-layer) mode — optional, stateful-DPI countries
  advancedAvailable: () => ipcRenderer.invoke('advanced:available'),
  startAdvanced: () => ipcRenderer.invoke('advanced:start'),
  stopAdvanced: () => ipcRenderer.invoke('advanced:stop'),
  onProbeResult: (cb) => ipcRenderer.on('dpi:probe-result', (e, p) => cb(p)),
  removeProbeListener: () => ipcRenderer.removeAllListeners('dpi:probe-result'),

});
