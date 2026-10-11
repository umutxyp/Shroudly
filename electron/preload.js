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
});
