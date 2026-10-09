'use strict';
/**
 * ============================================================================
 *  OmniDownloader — binaryManager.js
 * ----------------------------------------------------------------------------
 *  Locates and maintains the two native engines the app depends on:
 *
 *    1. yt-dlp  — stream extraction / downloading (auto-updatable)
 *    2. FFmpeg  — lossless stream merging + MP3 extraction (read-only)
 *
 *  Search precedence (first hit wins):
 *      a) <userData>/binaries/…      (managed by this app, always newest)
 *      b) <app>/assets/binaries/<os>/ (bundled alongside the app)
 *      c) $PATH / well-known install locations (system install)
 *
 *  The yt-dlp engine can bootstrap itself: if no binary exists anywhere the
 *  app downloads the correct asset from the official GitHub Releases API
 *  (`https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest`) into
 *  `app.getPath('userData')`, then keeps it up to date in the background.
 *
 *  ZERO third-party APIs: only the public GitHub Releases endpoints are used.
 * ============================================================================
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { app } = require('electron');

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const GITHUB_LATEST_RELEASE = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const USER_AGENT = 'OmniDownloader/1.0 (+electron)';

/** Executable file names per platform. */
const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

/** In-memory state, refreshed by init()/resolveEngines(). */
const state = {
  userDataPath: null,
  binDir: null,
  ytDlp: null, // { path, version, source }
  ffmpeg: null, // { path, version, source }
  latest: null, // cached GitHub release info
  updating: false
};

/* First-probe tracking: until the lookup finished the engine state is simply
 * *unknown* — the UI must show "Starting…", never a false "missing" alarm. */
let probeDone = false;
let readyResolve = () => {};
const ready = new Promise((resolve) => { readyResolve = resolve; });
function whenReady() { return probeDone ? Promise.resolve() : ready; }

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** @returns {'win32'|'darwin'|'linux'} current platform key (bundled folder). */
function platformKey() {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? process.platform
    : 'linux';
}

/** Bundled binaries folder shipped inside the app: assets/binaries/<os>. */
function bundledDir() {
  // Packaged builds read resources out of the (asar) app path; a plain dev
  // run (`electron scripts/smoke.js`) must resolve from the repo root instead.
  const root = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..', '..');
  return path.join(root, 'assets', 'binaries', platformKey());
}

/** The directory this app fully controls (survives app updates). */
function managedDir() {
  return state.binDir || path.join(state.userDataPath || app.getPath('userData'), 'binaries');
}

/**
 * Executes a binary and captures its stdout/stderr.
 * Uses `spawn` with an argv array — never a shell string.
 *
 * @param {string} bin absolute path (or bare command name for PATH lookup)
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function execCapture(bin, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      reject(new Error(`timeout: ${path.basename(bin)} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Runs `<bin> --version` (or `-version`, which FFmpeg prefers) and returns
 * the first line of output, or `null` when the binary is not usable.
 *
 * @param {string} bin
 * @returns {Promise<string|null>}
 */
async function queryVersion(bin) {
  // yt-dlp / most tools use `--version`; FFmpeg uses a single dash.
  for (const flag of ['--version', '-version']) {
    try {
      const { code, stdout, stderr } = await execCapture(bin, [flag]);
      const text = (stdout || stderr || '').trim();
      if (code === 0 && text) return text.split(/\r?\n/)[0].trim();
    } catch (_) {
      // ENOENT / timeout → try the next spelling, then give up.
    }
  }
  return null;
}

/** Checks that a candidate path exists (and is executable on POSIX). */
function isUsable(file) {
  try {
    if (!file || !fs.existsSync(file)) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

/**
 * Turns a bare command name ("ffmpeg") into an absolute path by scanning
 * `$PATH`. Absolute paths are returned unchanged.
 *
 * Why this matters: yt-dlp resolves `--ffmpeg-location` **relative to the
 * process CWD** — a bare name silently disables stream merging, so we must
 * always hand it an absolute path (or omit the flag entirely).
 *
 * @param {string} candidate
 * @returns {string} absolute path when resolvable, otherwise the input
 */
function toAbsolute(candidate) {
  if (!candidate) return candidate;
  if (path.isAbsolute(candidate)) return candidate;
  if (candidate.includes(path.sep) || candidate.includes('/')) return candidate;
  return findOnPath(candidate) || candidate;
}

/**
 * Scans `$PATH` (plus a few well-known locations) for an executable name.
 * @returns {string|null}
 */
function findOnPath(name) {
  const names = process.platform === 'win32' ? [name, `${name}.exe`] : [name];
  const roots = [
    ...(process.env.PATH || '').split(path.delimiter),
    '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin',
    path.join(os.homedir(), '.local', 'bin')
  ].filter(Boolean);

  for (const root of roots) {
    for (const n of names) {
      const candidate = path.join(root, n);
      if (isUsable(candidate)) return candidate;
    }
  }
  return null;
}

/** Compares "2026.08.19" / "2025.12.30" style versions numerically. */
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Called once from main.js with `app.getPath('userData')`. */
function init({ userDataPath }) {
  state.userDataPath = userDataPath;
  state.binDir = path.join(userDataPath, 'binaries');
  fs.mkdirSync(state.binDir, { recursive: true });
}

/**
 * Picks the release asset that matches this machine.
 * Assets verified against the official release manifest:
 *   yt-dlp.exe / yt-dlp_arm64.exe / yt-dlp_x86.exe / yt-dlp_macos /
 *   yt-dlp_linux / yt-dlp_linux_aarch64 (+ .zip variants, avoided here)
 *
 * @param {Array<{name:string,browser_download_url:string,size:number}>} assets
 * @returns {{name:string,url:string,size:number}|null}
 */
function pickAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const arch = process.arch; // 'x64' | 'arm64' | 'ia32' | …

  let wanted;
  if (process.platform === 'win32') {
    wanted = arch === 'arm64' ? 'yt-dlp_arm64.exe'
      : arch === 'ia32' ? 'yt-dlp_x86.exe'
        : 'yt-dlp.exe';
  } else if (process.platform === 'darwin') {
    wanted = 'yt-dlp_macos';
  } else {
    wanted = arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  }

  const exact = assets.find((a) => a.name === wanted);
  if (exact) return { name: exact.name, url: exact.browser_download_url, size: exact.size };

  // Last-resort fallbacks (never pick the 3 MB source archive named `yt-dlp`).
  const generic = assets.find((a) =>
    a.name.startsWith('yt-dlp_') && /\.(zip|tar\.gz)$/.test(a.name) === false);
  return generic
    ? { name: generic.name, url: generic.browser_download_url, size: generic.size }
    : null;
}

/**
 * Queries the GitHub Releases API for the newest yt-dlp build.
 * Results are cached in memory + `settings` for one hour to stay well below
 * the unauthenticated GitHub rate limit (60 req/hour/IP).
 *
 * @param {boolean} [force=false] ignore the cache
 * @returns {Promise<{tag:string, url:string, size:number, current:string, updateAvailable:boolean}>}
 */
async function checkForUpdates(force = false) {
  const current = state.ytDlp?.version || (await queryVersion(await resolveYtDlpPath())) || '0';

  if (!force && state.latest && Date.now() - state.latest.fetchedAt < 60 * 60 * 1000) {
    return { ...state.latest.info, current, updateAvailable: compareVersions(state.latest.info.tag, current) > 0 };
  }

  const res = await fetch(GITHUB_LATEST_RELEASE, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/vnd.github+json'
    }
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);

  const json = await res.json();
  const asset = pickAsset(json.assets || []);
  if (!asset) throw new Error('No compatible yt-dlp asset found in release manifest');

  const info = {
    tag: String(json.tag_name || '').replace(/^v/i, ''),
    name: asset.name,
    url: asset.url,
    size: asset.size,
    publishedAt: json.published_at || null
  };
  state.latest = { info, fetchedAt: Date.now() };

  return { ...info, current, updateAvailable: compareVersions(info.tag, current) > 0 };
}

/**
 * Downloads the latest yt-dlp build into `<userData>/binaries/`.
 * Downloads land on a temp file first, then are atomically renamed, so an
 * interrupted update can never corrupt a working installation.
 *
 * @param {(percent:number)=>void} [onProgress] 0..100
 * @returns {Promise<{path:string, version:string, tag:string}>}
 */
async function updateYtDlp(onProgress) {
  if (state.updating) throw new Error('An engine update is already running');
  state.updating = true;

  try {
    const release = await checkForUpdates(true);
    if (!release.updateAvailable && state.ytDlp?.path) {
      return { path: state.ytDlp.path, version: state.ytDlp.version, tag: release.tag };
    }

    const target = path.join(managedDir(), `yt-dlp${EXE_SUFFIX}`);
    const tmp = `${target}.download-${process.pid}`;

    const res = await fetch(release.url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream' }
    });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length')) || release.size || 0;
    let received = 0;

    // Wrap the web ReadableStream so we can report byte-level progress.
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      if (total > 0 && onProgress) onProgress(Math.min(100, (received / total) * 100));
    });

    await pipeline(body, fs.createWriteStream(tmp));

    // Make it executable before it becomes the active binary (POSIX).
    if (process.platform !== 'win32') await fsp.chmod(tmp, 0o755);

    // Atomic swap: unlink first (Windows cannot rename onto an existing file).
    await fsp.rm(target, { force: true });
    await fsp.rename(tmp, target);
    if (process.platform !== 'win32') await fsp.chmod(target, 0o755);

    const version = (await queryVersion(target)) || release.tag;
    state.ytDlp = { path: target, version, source: 'managed' };
    if (onProgress) onProgress(100);
    return { path: target, version, tag: release.tag };
  } catch (err) {
    // Leave the previous working binary untouched on any failure.
    await fsp.rm(`${path.join(managedDir(), `yt-dlp${EXE_SUFFIX}`)}.download-${process.pid}`, { force: true });
    throw err;
  } finally {
    state.updating = false;
  }
}

/** Resolves the absolute path of a yt-dlp candidate without caching it. */
async function resolveYtDlpPath() {
  const status = await resolveEngines();
  return status.ytDlp?.path || 'yt-dlp';
}

/**
 * Resolves (and caches) both engines.
 * @param {boolean} [refresh=false] re-run the lookup even if cached
 * @returns {Promise<{ytDlp:object|null, ffmpeg:object|null, missing:string[]}>}
 */
async function resolveEngines(refresh = false) {
  if (!refresh && state.ytDlp && state.ffmpeg) {
    probeDone = true;
    return { ytDlp: state.ytDlp, ffmpeg: state.ffmpeg, missing: missingList() };
  }

  const candidates = (exeName) => [
    path.join(managedDir(), exeName),
    path.join(bundledDir(), exeName),
    // System install (bare name → searched on $PATH by spawn itself).
    exeName.replace(/\.exe$/i, '')
  ];

  // ---- yt-dlp -------------------------------------------------------------
  if (!state.ytDlp) {
    for (const candidate of candidates(`yt-dlp${EXE_SUFFIX}`)) {
      const resolved = toAbsolute(candidate);
      if (path.isAbsolute(resolved) && !isUsable(resolved)) continue;
      const version = await queryVersion(resolved);
      if (version) {
        const source = resolved.startsWith(managedDir()) ? 'managed'
          : resolved.startsWith(bundledDir()) ? 'bundled' : 'system';
        state.ytDlp = { path: resolved, version, source };
        break;
      }
    }
  }

  // ---- FFmpeg (never auto-downloaded: large binary, LGPL/GPL build choice) --
  if (!state.ffmpeg) {
    for (const candidate of candidates(`ffmpeg${EXE_SUFFIX}`)) {
      const resolved = toAbsolute(candidate);
      if (path.isAbsolute(resolved) && !isUsable(resolved)) continue;
      const version = await queryVersion(resolved);
      if (version) {
        const source = resolved.startsWith(managedDir()) ? 'managed'
          : resolved.startsWith(bundledDir()) ? 'bundled' : 'system';
        state.ffmpeg = { path: resolved, version, source };
        break;
      }
    }
  }

  probeDone = true;
  return { ytDlp: state.ytDlp, ffmpeg: state.ffmpeg, missing: missingList() };
}

function missingList() {
  const missing = [];
  if (!state.ytDlp) missing.push('yt-dlp');
  if (!state.ffmpeg) missing.push('ffmpeg');
  return missing;
}

/**
 * One-shot bootstrap used at app start:
 *  • resolves both engines
 *  • auto-installs yt-dlp when nothing is available
 *  • checks GitHub for a newer yt-dlp in the background
 *
 * Never throws — the renderer receives a descriptive status object instead.
 *
 * @param {object} [opts]
 * @param {(percent:number)=>void} [opts.onProgress]
 * @returns {Promise<object>} engine status for the UI
 */
async function bootstrap({ onProgress } = {}) {
  try {
    let status = await resolveEngines(true);

    // Nothing installed → provision yt-dlp automatically (FFmpeg still manual).
    if (!status.ytDlp) {
      const installed = await updateYtDlp(onProgress);
      status = await resolveEngines(true);
      state.latest = null;
      return {
        ...toStatus(status),
        message: `Installed yt-dlp ${installed.tag}`
      };
    }

    // Background update check (best-effort, never blocks the UI).
    checkForUpdates(false)
      .then((info) => {
        if (info.updateAvailable) {
          return updateYtDlp(onProgress).then((res) => {
            state.ytDlp = { path: res.path, version: res.version, source: 'managed' };
          });
        }
        return null;
      })
      .then(() => {
        const refreshed = toStatus(state.ytDlp && state.ffmpeg
          ? { ytDlp: state.ytDlp, ffmpeg: state.ffmpeg, missing: missingList() }
          : status);
        emitEngineStatus(refreshed);
      })
      .catch((err) => console.warn('[engine] update check failed:', err.message));

    return toStatus(status);
  } catch (err) {
    return {
      ytDlp: null,
      ffmpeg: null,
      missing: missingList(),
      error: err.message,
      message: `Engine check failed: ${err.message}`
    };
  } finally {
    // The first probe is over — `whenReady()` consumers may read the status.
    probeDone = true;
    readyResolve();
  }
}

/** Optional hook — set by ipcHandlers so background updates can notify UI. */
let engineStatusSink = null;
function onEngineStatus(fn) { engineStatusSink = fn; }
function emitEngineStatus(payload) {
  if (engineStatusSink) { try { engineStatusSink(payload); } catch (_) { /* ignore */ } }
}

function toStatus(status) {
  return {
    ytDlp: status.ytDlp,
    ffmpeg: status.ffmpeg,
    missing: status.missing || [],
    updating: state.updating,
    latest: state.latest ? state.latest.info : null,
    message: status.missing && status.missing.length
      ? `Missing: ${status.missing.join(', ')}`
      : 'Engines ready'
  };
}

/** Public status snapshot (renderer "Engine" panel). */
function getStatus() {
  return {
    ...toStatus({
      ytDlp: state.ytDlp,
      ffmpeg: state.ffmpeg,
      missing: missingList()
    }),
    // `pending` = the very first probe has not finished yet, so `missing`
    // would be a guess — the UI shows "Starting…" instead of an alarm.
    pending: !probeDone
  };
}

module.exports = {
  init,
  bootstrap,
  resolveEngines,
  checkForUpdates,
  updateYtDlp,
  getStatus,
  whenReady,
  onEngineStatus,
  // exported for downloadManager / tests
  helpers: { queryVersion, execCapture, compareVersions, pickAsset, findOnPath }
};
