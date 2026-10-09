'use strict';
/**
 * ============================================================================
 *  OmniDownloader — ipcHandlers.js
 * ----------------------------------------------------------------------------
 *  The *only* place where the renderer can reach the main process.
 *
 *  Rules enforced here:
 *    • every channel is explicitly whitelisted (no dynamic channel strings)
 *    • every payload is type-checked before use
 *    • errors are re-thrown with clean, user-readable messages
 *    • file paths handed to the OS go through `shell` (never `exec`)
 * ============================================================================
 */

const { ipcMain, dialog, shell, clipboard, app } = require('electron');
const fs = require('fs');
const path = require('path');

const logger = require('./logger');

/** Settings keys the renderer is allowed to write. */
const WRITABLE_SETTINGS = new Set(['destination', 'concurrency']);

/**
 * Wraps an IPC handler so thrown errors reach the renderer as plain,
 * readable messages (instead of Electron's "Error invoking remote method").
 *
 * @param {string} channel
 * @param {(event:Electron.IpcMainInvokeEvent, ...args:any[])=>any} handler
 */
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      const message = (err && err.message ? err.message : String(err))
        .replace(/^Error invoking remote method '[^']+':\s*/i, '')
        .replace(/^Error:\s*/i, '');
      throw new Error(message);
    }
  });
}

/** Basic guard: non-empty string with a sane maximum length. */
function assertString(value, name, maxLength = 4096) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${name}.`);
  }
  if (value.length > maxLength) throw new Error(`${name} is too long.`);
  return value.trim();
}

/**
 * Registers every IPC channel used by `preload.js`.
 *
 * @param {object} deps
 * @param {()=>Electron.BrowserWindow|null} deps.getMainWindow
 * @param {object} deps.settingsStore
 * @param {object} deps.downloadManager
 * @param {object} deps.binaryManager
 */
function registerIpcHandlers({ getMainWindow, settingsStore, downloadManager, binaryManager }) {
  /** Fire-and-forget event to the renderer. */
  const send = (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  /* ---------------------------------------------------------------------- */
  /* Media analysis                                                         */
  /* ---------------------------------------------------------------------- */

  // FR-01: inspect a URL and return metadata + available qualities.
  handle('media:analyze', async (_event, url) => {
    return downloadManager.analyze(assertString(url, 'URL', 8192));
  });

  /* ---------------------------------------------------------------------- */
  /* Download tasks                                                         */
  /* ---------------------------------------------------------------------- */

  handle('download:start', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid download request.');
    return downloadManager.start(payload);
  });

  handle('download:cancel', async (_event, taskId) =>
    downloadManager.cancel(assertString(taskId, 'task id', 128)));

  handle('download:list', async () => downloadManager.list());

  handle('download:clearFinished', async () => downloadManager.clearFinished());

  /* ---------------------------------------------------------------------- */
  /* Settings                                                               */
  /* ---------------------------------------------------------------------- */

  handle('settings:get', async () => settingsStore.all());

  handle('settings:set', async (_event, key, value) => {
    if (!WRITABLE_SETTINGS.has(key)) throw new Error('This setting cannot be changed.');
    if (key === 'destination') {
      const dir = assertString(value, 'folder path', 3000);
      fs.mkdirSync(dir, { recursive: true });      // the folder must be usable
      if (!fs.statSync(dir).isDirectory()) throw new Error('Not a folder.');
      settingsStore.set('destination', dir);
    } else if (key === 'concurrency') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1 || n > 6) throw new Error('Concurrency must be between 1 and 6.');
      settingsStore.set('concurrency', Math.round(n));
    }
    return settingsStore.all();
  });

  // FR-08 / settings modal: native folder picker.
  handle('settings:chooseDirectory', async () => {
    const win = getMainWindow();
    const current = settingsStore.get('destination');
    const options = {
      title: 'Choose download folder',
      // Electron's option is `defaultPath` — the picker opens right where the
      // user's current destination is instead of at "This PC".
      defaultPath: fs.existsSync(current) ? current : app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null; // user bailed out
    const dir = result.filePaths[0];
    settingsStore.set('destination', dir);
    return dir;
  });

  /* ---------------------------------------------------------------------- */
  /* Shell / clipboard helpers                                              */
  /* ---------------------------------------------------------------------- */

  // FR-08: highlight the finished file in Explorer / Finder / Files.
  handle('shell:showItemInFolder', async (_event, filePath) => {
    const file = assertString(filePath, 'file path', 3000);
    if (!path.isAbsolute(file)) throw new Error('Invalid file path.');
    if (!fs.existsSync(file)) throw new Error('That file no longer exists.');
    shell.showItemInFolder(file);
    return true;
  });

  // Convenience: double-click a finished card to play it with the OS player.
  handle('shell:openFile', async (_event, filePath) => {
    const file = assertString(filePath, 'file path', 3000);
    if (!path.isAbsolute(file)) throw new Error('Invalid file path.');
    if (!fs.existsSync(file)) throw new Error('That file no longer exists.');
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return true;
  });

  // "Paste" button (read-only access to the system clipboard).
  handle('clipboard:readText', async () => clipboard.readText());

  handle('app:version', async () => app.getVersion());

  // Renderer → log file. The UI runs sandboxed with no console access to the
  // main process, so this is how an on-screen failure gets a paper trail.
  handle('app:log', async (_event, message) => {
    logger.warn(`[renderer] ${assertString(message, 'log message', 2000)}`);
    return true;
  });

  /* ---------------------------------------------------------------------- */
  /* Engine (yt-dlp / FFmpeg) status + self-update                          */
  /* ---------------------------------------------------------------------- */

  // The renderer pulls this once at boot: wait for the first engine probe so a
  // slow lookup can never report a false "missing" state. Bounded at 15 s —
  // after that the pending flag tells the UI to keep showing "Starting…".
  handle('engine:status', async () => {
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, 15000); });
    try {
      await Promise.race([binaryManager.whenReady(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return binaryManager.getStatus();
  });

  // FR-06: report whether a newer yt-dlp exists on GitHub Releases.
  handle('engine:checkUpdate', async () => binaryManager.checkForUpdates(true));

  // FR-06: download + swap the newest yt-dlp into userData.
  handle('engine:update', async () => {
    const result = await binaryManager.updateYtDlp((percent) => {
      send('engine:updateProgress', Math.round(percent));
    });
    const status = binaryManager.getStatus();
    send('engine:status', status);
    return { ...result, status };
  });

  // Push background engine updates (auto-update finished) to the UI.
  binaryManager.onEngineStatus((status) => send('engine:status', status));
}

module.exports = { registerIpcHandlers };
