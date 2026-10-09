'use strict';
/**
 * ============================================================================
 *  OmniDownloader — main.js
 * ----------------------------------------------------------------------------
 *  Electron main process entry point.
 *
 *  Responsibilities:
 *    • Secure BrowserWindow creation (contextIsolation ON, nodeIntegration OFF)
 *    • Application lifecycle (ready / activate / window-all-closed / quit)
 *    • Bootstrapping the core services:
 *         - settingsStore  (persisted user preferences in userData)
 *         - binaryManager  (locate / auto-update yt-dlp + locate FFmpeg)
 *         - downloadManager(child-process orchestrator + progress parser)
 *         - ipcHandlers    (the only bridge between renderer and main)
 *
 *  Nothing in this file ever trusts data coming from the renderer: every
 *  string that reaches a child process is passed through `spawn()` as an
 *  argv element (never through a shell), which removes shell-injection risk.
 * ============================================================================
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const logger = require('./logger');
const binaryManager = require('./binaryManager');
const DownloadManager = require('./downloadManager');
const { registerIpcHandlers } = require('./ipcHandlers');

/** @type {BrowserWindow|null} Single-window application. */
let mainWindow = null;

/** In-memory + on-disk settings (see ipcHandlers.js for the file format). */
let settingsStore = null;

/** @type {DownloadManager|null} Child-process download orchestrator. */
let downloadManager = null;

/** URL handed to us on the command line, delivered once the UI is ready. */
let pendingOpenUrl = null;

/** One-shot guard: an error dialog must never become a dialog storm. */
let errorDialogShown = false;

/* -------------------------------------------------------------------------- */
/* Crash safety net                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Records an unexpected error and (once per run) tells the user about it.
 * The process keeps running: a transient failure must not close the window
 * and leave a headless instance behind.
 *
 * @param {Error|string} err
 */
function reportFatal(err) {
  logger.error('Unexpected error:', err);
  if (errorDialogShown) return;
  errorDialogShown = true;
  try {
    dialog.showErrorBox(
      'OmniDownloader hit an unexpected error',
      `${(err && err.message) || err}\n\n` +
      'The app is still running — you can keep using it.\n' +
      `Technical details were saved to:\n${logger.file() || 'the application log'}`
    );
  } catch (_) { /* dialog unavailable while quitting */ }
}

/**
 * Pushes an event to the renderer without ever throwing in the caller.
 * (`webContents.send()` throws once the renderer is gone — it is called from
 * child-process stream handlers, where a throw would take the app down.)
 *
 * @param {string} channel
 * @param {any} payload
 * @returns {boolean} whether the message was handed to the renderer
 */
function sendToRenderer(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
      return true;
    }
  } catch (err) {
    logger.warn(`send("${channel}") failed:`, err.message);
  }
  return false;
}

/** First http(s) URL in an argv list — used for `OmniDownloader <url>`. */
function urlFromArgv(argv) {
  return (argv || []).find((arg) => /^https?:\/\//i.test(arg)) || null;
}

/**
 * Hands a URL to the renderer (fills the bar and starts the analysis).
 * While the window is still loading the message is queued for `did-finish-load`.
 *
 * @param {string} url
 */
function openUrlInApp(url) {
  if (!url) return;
  const busy = !mainWindow || mainWindow.isDestroyed()
    || mainWindow.webContents.isDestroyed()
    || mainWindow.webContents.isLoading();
  if (busy) pendingOpenUrl = url;
  else sendToRenderer('app:openUrl', url);
}

/* ---------------------------------------------------------------------------
 *  Global handlers — installed first, so *nothing* can end the process
 *  silently. Everything is logged to <userData>/logs/main.log.
 * ------------------------------------------------------------------------- */
process.on('uncaughtException', (err) => reportFatal(err));
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection:', reason));

/* -------------------------------------------------------------------------- */
/* Single instance lock                                                       */
/* -------------------------------------------------------------------------- */

// Prevent two copies of the app fighting over the same .part files / ports.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Another copy was launched: focus this one instead of starting a second.
    // If our window is gone (it crashed, or we quit while downloading) bring
    // it back — otherwise the new copy exits and the user sees a "crash".
    if (!mainWindow || mainWindow.isDestroyed()) {
      logger.info('second-instance: recreating the window');
      mainWindow = createMainWindow();
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    openUrlInApp(urlFromArgv(argv));
  });
}

/* -------------------------------------------------------------------------- */
/* Settings store (tiny JSON document, no dependencies)                       */
/* -------------------------------------------------------------------------- */

/**
 * Creates a tiny, dependency-free settings persistence layer.
 *
 * File layout (userData/settings.json):
 *   {
 *     "destination": "C:\\Users\\me\\Downloads",
 *     "concurrency": 2,
 *     "engineVersion": "2026.08.19",
 *     "lastUpdateCheck": 1760000000000
 *   }
 *
 * @returns {{get: Function, set: Function, all: Function, file: string}}
 */
function createSettingsStore() {
  const file = path.join(app.getPath('userData'), 'settings.json');

  // Sensible defaults: never write into the app install directory.
  const defaults = {
    destination: app.getPath('downloads') || app.getPath('videos') || app.getPath('home'),
    concurrency: 2,      // parallel child processes (queued otherwise)
    engineVersion: null, // last known yt-dlp version (cache for GitHub API)
    lastUpdateCheck: 0   // epoch ms of the last update check
  };

  let cache = { ...defaults };

  try {
    if (fs.existsSync(file)) {
      cache = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  } catch (err) {
    // Corrupt settings must never brick the app — fall back to defaults.
    logger.warn('[settings] could not read settings.json, using defaults:', err.message);
  }

  // The configured destination must exist; otherwise fall back gracefully.
  if (!fs.existsSync(cache.destination)) {
    cache.destination = defaults.destination;
  }

  const persist = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
      logger.warn('[settings] could not persist settings.json:', err.message);
    }
  };

  return {
    file,
    get: (key) => cache[key],
    set: (key, value) => {
      cache[key] = value;
      persist();
      return cache[key];
    },
    all: () => ({ ...cache })
  };
}

/* -------------------------------------------------------------------------- */
/* Window creation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * True while a crashed window is being replaced. That swap briefly passes
 * through a state with zero windows, which must never be mistaken for the
 * user closing the app (see the `window-all-closed` guard).
 */
let rebuildingWindow = false;

/** True once a quit has been requested — cancels pending UI loads quietly. */
let quitting = false;

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    show: false,              // avoid the white flash; shown on `ready-to-show`
    backgroundColor: '#0b0f14', // matches the CSS `--bg` token
    title: 'OmniDownloader',
    autoHideMenuBar: true,     // clean look; Alt still reveals the menu
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,   // renderer cannot reach Node/Electron globals
      nodeIntegration: false,   // no `require()` inside the page
      sandbox: true,            // renderer runs in the OS sandbox
      webviewTag: false,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());

  // A renderer crash must not leave a dead window behind (it would hold the
  // single-instance lock while showing nothing — the exact "it opens and
  // immediately crashes" symptom). Rebuild the window; downloads live in the
  // main process and are unaffected, so the cards come back on rehydration.
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`Renderer process gone: ${details.reason} (exit code ${details.exitCode})`);
    if (details.reason === 'clean-exit') return;
    setTimeout(() => {
      // Order matters: destroying the (last) window fires `window-all-closed`
      // synchronously, so the rebuild guard has to be up *before* the destroy
      // — otherwise recovery calls app.quit() on itself and the replacement
      // window dies with "Could not load the UI". Once `closed` has nulled
      // mainWindow, the fresh reference is installed here.
      rebuildingWindow = true;
      const stale = mainWindow;
      if (stale && !stale.isDestroyed()) {
        try { stale.destroy(); } catch (_) { /* already gone */ }
      }
      mainWindow = createMainWindow();
      // Release the guard once the replacement is on screen (or loading).
      setTimeout(() => { rebuildingWindow = false; }, 1500);
    }, 400);
  });

  // Deliver a URL that was queued while the window was still loading.
  win.webContents.once('did-finish-load', () => {
    logger.info('Renderer loaded');
    if (pendingOpenUrl) {
      const url = pendingOpenUrl;
      pendingOpenUrl = null;
      sendToRenderer('app:openUrl', url);
    }
  });

  // Security: keep every navigation inside the bundled UI.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url); // external links
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    // Block any attempt to navigate the app window away from the local UI.
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
    // A missing/unreadable UI is a real error — log it and tell the user
    // instead of rejecting an unobserved promise and dying silently. During a
    // shutdown the load is cancelled on purpose, though: that is not a broken
    // UI and must not raise a fatal dialog over a closing app.
    .catch((err) => {
      if (quitting) {
        logger.warn('UI load cancelled by shutdown:', err && err.message);
        return;
      }
      reportFatal(new Error(`Could not load the UI: ${err.message}`));
    });

  return win;
}

/* -------------------------------------------------------------------------- */
/* Application lifecycle                                                      */
/* -------------------------------------------------------------------------- */

app.whenReady().then(async () => {
  // NOTE: outbound navigation is already locked down by `will-navigate` and
  // `setWindowOpenHandler` below; remote *sub-resources* (video thumbnails)
  // are intentionally still allowed by the CSP declared in index.html.

  // ---- Logging (works from here on; earlier messages are buffered) ---------
  logger.init(app.getPath('userData'));
  logger.info(`Starting OmniDownloader v${app.getVersion()} on ${process.platform} (${process.arch})`);
  logger.info(`userData=${app.getPath('userData')}`);
  if (urlFromArgv(process.argv)) logger.info(`Launch URL: ${urlFromArgv(process.argv)}`);

  // ---- Directory bootstrap --------------------------------------------------
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
  } catch (err) {
    // A read-only profile must not brick the app: fall back to defaults.
    logger.warn('Could not create the userData folder:', err.message);
  }
  settingsStore = createSettingsStore();
  logger.info(`Settings: ${JSON.stringify(settingsStore.all())}`);

  // ---- Core services -------------------------------------------------------
  binaryManager.init({ userDataPath: app.getPath('userData') });

  downloadManager = new DownloadManager({
    settingsStore,
    // Pushes a `download:*` event straight to the renderer (progress stream).
    emit: (channel, payload) => sendToRenderer(channel, payload)
  });

  // `OmniDownloader https://…` (or a link forwarded from a second copy).
  pendingOpenUrl = urlFromArgv(process.argv);

  mainWindow = createMainWindow();

  registerIpcHandlers({
    getMainWindow: () => mainWindow,
    settingsStore,
    downloadManager,
    binaryManager
  });

  // Warm-up: resolve the engines, provision yt-dlp if missing, then keep it
  // up to date in the background. `onEngineStatus` pushes the result to the UI.
  binaryManager.bootstrap({
    onProgress: (percent) => sendToRenderer('engine:updateProgress', Math.round(percent))
  }).then((status) => {
    sendToRenderer('engine:status', status);
    logger.info(`Engines: yt-dlp=${status.ytDlp ? status.ytDlp.version : 'missing'}` +
      ` ffmpeg=${status.ffmpeg ? status.ffmpeg.version : 'missing'}`);
  }).catch((err) => logger.warn('[engine] bootstrap failed:', err && err.message));

  // macOS convention: re-create the window when the dock icon is clicked.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
}).catch((err) => reportFatal(err));

app.on('window-all-closed', () => {
  // Crash recovery swaps windows through a zero-window state on purpose —
  // treating that as "the user closed the app" would kill the app mid-repair.
  if (rebuildingWindow) {
    logger.info('[app] window-all-closed during window rebuild — staying alive');
    return;
  }
  // Quit everywhere except macOS, where the app stays alive until ⌘Q.
  if (process.platform !== 'darwin') app.quit();
});

/** Set while a graceful shutdown is in flight (see `before-quit` below). */
let shutdownTimer = null;
let shutdownAttempted = false;

app.on('before-quit', (event) => {
  // From here on, cancelled work (a UI load, a queued IPC call) is expected —
  // report it as a warning instead of as a fatal error.
  quitting = true;
  // Terminate any running yt-dlp children so no orphan processes survive.
  if (!shutdownAttempted && downloadManager && downloadManager.hasActiveTasks()) {
    event.preventDefault();
    shutdownAttempted = true; // at most ONE graceful attempt per session

    // Hard deadline: a hung shutdown would keep the single-instance lock
    // alive, and the *next* launch would exit immediately — which looks to
    // the user exactly like "the app crashes every time I open it".
    shutdownTimer = setTimeout(() => {
      logger.warn('Shutdown deadline reached — exiting hard');
      app.exit(0);
    }, 8000);

    downloadManager.shutdown()
      .catch((err) => logger.warn('Shutdown failed:', err && err.message))
      .finally(() => {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
        app.quit();
      });
  }
});

// Last-resort breadcrumbs: an app that exits with no window should still be
// explainable from the log.
app.on('quit', () => logger.info('App quit'));
