'use strict';

/* The hidden Snowflake window's only link to the app (electron/snowflake.js):
 * its settings, its counts, and the word to stop. Nothing else of the app's. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snowflakeHost', {
  config: () => ipcRenderer.invoke('snowflake:config'),
  report: (s) => ipcRenderer.send('snowflake:report', s),
  onStop: (fn) => ipcRenderer.on('snowflake:stop', () => fn()),
});
