'use strict';
// The page's only door to the desktop app. Runs sandboxed: it can load nothing but `electron`.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('skm', {
  // Same arguments as a browser-mode fetch: ('GET', '/api/scan') or ('POST', '/api/file', {...}).
  // Resolves to { json } or { error }.
  api: (method, url, body) => ipcRenderer.invoke('skm:api', method, url, body),
  // Disk path of a dropped or picked File, or '' when it has none.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  // A .mcpb / .dxt opened while the app is already running.
  onOpenFile: (cb) => { ipcRenderer.on('skm:open-file', (e, file) => cb(String(file))); },
});
