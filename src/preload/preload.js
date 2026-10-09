'use strict';
/**
 * ============================================================================
 *  OmniDownloader — preload.js
 * ----------------------------------------------------------------------------
 *  The secure context bridge. The page only ever sees plain functions:
 *
 *      window.api.analyze(url)              → Promise<mediaInfo>
 *      window.api.startDownload(payload)    → Promise<task>
 *      window.api.cancelDownload(taskId)    → Promise<task>
 *      window.api.onDownloadProgress(cb)    → unsubscribe function
 *      …
 *
 *  With `contextIsolation: true` + `sandbox: true` the renderer has no
 *  Node.js globals, no `require`, and cannot name its own IPC channels:
 *  every channel below is hard-coded here (whitelisted).
 * ============================================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Subscribes to a main → renderer push channel.
 * @param {string} channel whitelisted channel name
 * @returns {(callback:(payload:any)=>void)=>()=>void} unsubscribe
 */
const subscribe = (channel) => (callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  // Always return a disposer so listeners can never leak.
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  /* ---- media analysis (yt-dlp --dump-json) ------------------------------ */
  analyze: (url) => ipcRenderer.invoke('media:analyze', url),

  /* ---- download task control ------------------------------------------- */
  startDownload: (payload) => ipcRenderer.invoke('download:start', payload),
  cancelDownload: (taskId) => ipcRenderer.invoke('download:cancel', taskId),
  listDownloads: () => ipcRenderer.invoke('download:list'),
  clearFinished: () => ipcRenderer.invoke('download:clearFinished'),

  /** Live progress stream: {id,status,percent,speedBps,eta,file,…} */
  onDownloadProgress: subscribe('download:progress'),

  /* ---- files & shell ---------------------------------------------------- */
  openFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  openFile: (filePath) => ipcRenderer.invoke('shell:openFile', filePath),
  readClipboard: () => ipcRenderer.invoke('clipboard:readText'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  /* ---- diagnostics + deep links ----------------------------------------- */
  /** Writes a renderer-side breadcrumb into <userData>/logs/main.log. */
  log: (message) => ipcRenderer.invoke('app:log', message),
  /** Fires when the app is started as `OmniDownloader <url>`. */
  onOpenUrl: subscribe('app:openUrl'),

  /* ---- settings --------------------------------------------------------- */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  selectDirectory: () => ipcRenderer.invoke('settings:chooseDirectory'),

  /* ---- engine (yt-dlp / FFmpeg) ---------------------------------------- */
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),
  checkEngineUpdate: () => ipcRenderer.invoke('engine:checkUpdate'),
  updateEngine: () => ipcRenderer.invoke('engine:update'),
  onEngineStatus: subscribe('engine:status'),
  onEngineUpdateProgress: subscribe('engine:updateProgress')
});
