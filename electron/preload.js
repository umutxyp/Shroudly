const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform, // 'darwin' | 'win32' | 'linux'

  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  quitApp: () => ipcRenderer.send('app:quit'),
  // The window is closed for real when unused (see main.js): it reports use,
  // when it is listening, and is told to save before it goes.
  uiActive: () => ipcRenderer.send('ui:active'),
  uiReady: () => ipcRenderer.send('ui:ready'),
  onRelease: (cb) => ipcRenderer.on('ui:release', () => cb()),

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
  // Does this DNS server answer? ({ kind, server }) -> { ok, ms, address } or
  // { ok: false, error | invalid }
  testDns: (value) => ipcRenderer.invoke('dns:test', value),

  // Logs
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  // A short version of the log with its header, to the clipboard; the whole
  // log to a .txt file in Downloads, shown in the file manager (nothing is
  // sent).
  copyLogs: () => ipcRenderer.invoke('logs:copy'),
  saveLogs: () => ipcRenderer.invoke('logs:save'),
  // The background process asks for a panel to be shown (e.g. 'logs').
  onNavigate: (cb) => { const h = (e, tab) => cb(tab); ipcRenderer.on('ui:navigate', h); return () => ipcRenderer.removeListener('ui:navigate', h); },
  onNewLog: (cb) => ipcRenderer.on('log:new', (e, log) => cb(log)),
  removeLogListener: () => ipcRenderer.removeAllListeners('log:new'),

  // Network stats (real counters from the engine)
  getNetStats: () => ipcRenderer.invoke('net:stats'),
  ipv6Available: () => ipcRenderer.invoke('net:ipv6Available'),
  // Live count of running Shroudly apps (null until the first answer)
  defaultSiteList: () => ipcRenderer.invoke('settings:defaultSiteList'),
  siteListInfo: () => ipcRenderer.invoke('sitelist:info'),
  onSiteListChanged: (cb) => ipcRenderer.on('sitelist:changed', (e, p) => cb(p)),
  removeSiteListListener: () => ipcRenderer.removeAllListeners('sitelist:changed'),
  getOnlineCount: () => ipcRenderer.invoke('presence:get'),
  refreshOnlineCount: () => ipcRenderer.invoke('presence:refresh'),
  onOnlineCount: (cb) => ipcRenderer.on('presence:count', (e, n) => cb(n)),
  removeOnlineCountListener: () => ipcRenderer.removeAllListeners('presence:count'),

  // Advanced (packet-layer) mode, for filters that follow whole connections
  advancedAvailable: () => ipcRenderer.invoke('advanced:available'),
  getAdvice: () => ipcRenderer.invoke('dpi:advice'),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxyApplyAsAdmin: () => ipcRenderer.invoke('proxy:applyAsAdmin'),
  proxyReapply: () => ipcRenderer.invoke('proxy:reapply'),
  onProxyStatus: (cb) => { const h = (e, p) => cb(p); ipcRenderer.on('dpi:proxy-status', h); return () => ipcRenderer.removeListener('dpi:proxy-status', h); },
  // macOS: settings from before a restart, waiting for an administrator's password
  proxyRecovery: () => ipcRenderer.invoke('proxy:recovery'),
  proxyRecoverAsAdmin: () => ipcRenderer.invoke('proxy:recoverAsAdmin'),
  onProxyRecovery: (cb) => { const h = (e, p) => cb(p); ipcRenderer.on('dpi:proxy-recovery', h); return () => ipcRenderer.removeListener('dpi:proxy-recovery', h); },
  onAdvice: (cb) => ipcRenderer.on('dpi:advice', (e, p) => cb(p)),
  removeAdviceListener: () => ipcRenderer.removeAllListeners('dpi:advice'),
  discordStatus: () => ipcRenderer.invoke('discord:status'),
  discordSet: (on) => ipcRenderer.invoke('discord:set', on),
  // Returns a function that removes just this listener (several panels listen).
  onDiscordState: (cb) => { const h = (e, p) => cb(p); ipcRenderer.on('discord:state', h); return () => ipcRenderer.removeListener('discord:state', h); },
  removeDiscordStateListener: () => ipcRenderer.removeAllListeners('discord:state'),
  // Games and apps mode (Roblox and other programs that ignore the system proxy)
  appsStatus: (opts) => ipcRenderer.invoke('apps:status', opts),
  appsSet: (on) => ipcRenderer.invoke('apps:set', on),
  // Returns a function that removes just this listener (several panels listen).
  onAppsState: (cb) => { const h = (e, p) => cb(p); ipcRenderer.on('apps:state', h); return () => ipcRenderer.removeListener('apps:state', h); },
  removeAppsStateListener: () => ipcRenderer.removeAllListeners('apps:state'),
  // Microsoft Store apps reaching Shroudly (Windows, loopback exemptions)
  storeAppsStatus: () => ipcRenderer.invoke('storeapps:status'),
  storeAppsSet: (on) => ipcRenderer.invoke('storeapps:set', on),
  onStoreAppsState: (cb) => { const h = (e, p) => cb(p); ipcRenderer.on('storeapps:state', h); return () => ipcRenderer.removeListener('storeapps:state', h); },
  // What the autopilot did by itself (autopilot.js): the last few, then each
  // as it happens.
  autoNotices: () => ipcRenderer.invoke('auto:notices'),
  autoDismiss: (at) => ipcRenderer.send('auto:dismiss', at),
  onAutoNotice: (cb) => { const h = (e, p) => cb(p); ipcRenderer.on('auto:notice', h); return () => ipcRenderer.removeListener('auto:notice', h); },
  startAdvanced: () => ipcRenderer.invoke('advanced:start'),
  // Advanced mode turned on or off (Settings, the autopilot): every panel follows.
  onAdvancedState: (cb) => { const h = (e, p) => cb(p); ipcRenderer.on('advanced:state', h); return () => ipcRenderer.removeListener('advanced:state', h); },
  stopAdvanced: () => ipcRenderer.invoke('advanced:stop'),
  onProbeResult: (cb) => ipcRenderer.on('dpi:probe-result', (e, p) => cb(p)),
  onSiteBlocked: (cb) => ipcRenderer.on('dpi:site-blocked', (e, p) => cb(p)),
  onServiceRefused: (cb) => { const h = (e, p) => cb(p); ipcRenderer.on('dpi:service-refused', h); return () => ipcRenderer.removeListener('dpi:service-refused', h); },
  setTitleBarColors: (c) => ipcRenderer.invoke('ui:titlebar', c),
  onNeedRestart: (cb) => ipcRenderer.on('dpi:need-restart', (e, p) => cb(p)),
  onDnsAutoEnabled: (cb) => ipcRenderer.on('dpi:dns-auto-enabled', (e, p) => cb(p)),
  removeNeedRestartListener: () => ipcRenderer.removeAllListeners('dpi:need-restart'),
  removeSiteBlockedListener: () => ipcRenderer.removeAllListeners('dpi:site-blocked'),
  removeDnsAutoEnabledListener: () => ipcRenderer.removeAllListeners('dpi:dns-auto-enabled'),
  removeProbeListener: () => ipcRenderer.removeAllListeners('dpi:probe-result'),

});
