'use strict';
/**
 * ============================================================================
 *  OmniDownloader — scripts/ui-test.js
 * ----------------------------------------------------------------------------
 *  Drives the real renderer (index.html + preload.js + renderer.js) inside a
 *  real BrowserWindow and asserts the whole UI flow:
 *
 *    load → paste/analyze → quality modal → download → live progress card →
 *    completed card ("Open in Folder") → cancel flow → playlist (whole list,
 *    "Item x of N" position) → settings modal
 *
 *  Console errors / page crashes fail the run. Screenshots land in
 *  scripts/shots/ so the design can be reviewed visually.
 *
 *      npx electron scripts/ui-test.js       (or: npm run uitest)
 * ============================================================================
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// The test wires up the very same main-process services as src/main/main.js.
const binaryManager = require('../src/main/binaryManager');
const DownloadManager = require('../src/main/downloadManager');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');

const SRC = path.join(__dirname, '..', 'src');
const SHOTS = path.join(__dirname, 'shots');
const VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const BIG_URL = 'https://download.samplelib.com/mp4/sample-30s.mp4'; // ~21 MB
// A real 2-video playlist — small enough to download fully during the run.
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL1vkBF5RrFBCsC7bNNevkYstrTvCJu6CV';

fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, condition, extra = '') {
  const pass = !!condition;
  results.push({ name, pass, extra });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
  return pass;
}

/**
 * First video/audio codec of a finished file (via ffprobe).
 *
 * A download that "completes" is worthless if the player cannot hear it: a
 * `.mp4` built from VP9 + Opus opens as silent video — the regression this
 * pins down. `skipped: true` means ffprobe is not on PATH (non-scoring).
 */
function mediaCodecs(file) {
  if (!file || !fs.existsSync(file)) return { video: null, audio: null, skipped: true };
  try {
    const { execFileSync } = require('child_process');
    const read = (sel) => execFileSync('ffprobe',
      ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=codec_name',
        '-of', 'csv=p=0', file], { encoding: 'utf8' })
      .split(/[\r\n,]/).map((s) => s.trim()).filter(Boolean)[0] || null;
    return { video: read('v:0'), audio: read('a:0'), skipped: false };
  } catch (_) {
    return { video: null, audio: null, skipped: true };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls a page expression until it is truthy. */
async function waitFor(win, expression, timeoutMs = 30000, label = expression, pollMs = 150) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await win.webContents.executeJavaScript(expression, true);
      if (value) return value;
    } catch (_) { /* page still settling */ }
    await sleep(pollMs);
  }
  return false;
}

async function shot(win, name) {
  try {
    // Chromium freezes compositing for occluded/minimized windows, which makes
    // capturePage() hand back a frame from minutes ago. Bring the window back,
    // force a relayout and wait until the compositor published a new frame.
    if (win.isMinimized()) win.restore();
    win.show();
    win.moveTop();
    win.focus();
    await js(win, `new Promise((resolve) => {
      const b = document.body;
      b.style.willChange = 'transform';
      void b.offsetHeight;            // synchronous relayout
      requestAnimationFrame(() => requestAnimationFrame(() => {
        b.style.willChange = '';
        resolve(true);
      }));
    })`);
    await sleep(150);
    const image = await win.webContents.capturePage();
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`      [shot] ${file}`);
    return file;
  } catch (err) {
    console.log(`      [shot failed] ${err.message}`);
    return null;
  }
}

const js = (win, code) => win.webContents.executeJavaScript(code, true);

/** Page expression that sets the URL field (and hides any stale error). */
const setUrl = (url) => `(() => {
  const input = document.getElementById('urlInput');
  input.value = ${JSON.stringify(url)};
  input.dispatchEvent(new Event('input'));
  const err = document.getElementById('analyzeError');
  if (err) err.classList.add('hidden');
  return true;
})()`;

/**
 * Waits until either the quality modal opens or the inline error appears.
 * Returns 'modal' | 'error' | false (timeout) — so a transient extractor
 * failure (bot check, rate limit) is detected immediately instead of
 * burning the whole modal timeout.
 */
async function awaitOutcome(win, timeoutMs = 60000) {
  return waitFor(win, `(() => {
    const overlay = document.getElementById('qualityOverlay');
    const err = document.getElementById('analyzeError');
    if (overlay && !overlay.classList.contains('hidden')) return 'modal';
    if (err && !err.classList.contains('hidden')) return 'error';
    return false;
  })()`, timeoutMs);
}

/** Text of the visible inline analysis error ('' when there is none). */
const analyzeErrorText = (win) => js(win, `(() => {
  const err = document.getElementById('analyzeError');
  return err && !err.classList.contains('hidden') ? err.textContent.replace(/\\s+/g, ' ').trim() : '';
})()`);

/**
 * Analyzes `url`, retrying on transient extractor failures.
 * @returns {Promise<{outcome: string, note: string}>}
 */
async function analyzeLink(win, url, attempts = 3) {
  let outcome = 'timeout';
  let note = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(3000);           // back off before retrying
    await js(win, setUrl(url));
    await js(win, `document.getElementById('analyzeBtn').click()`);
    outcome = await awaitOutcome(win);
    if (outcome === 'modal') return { outcome, note };
    note = (await analyzeErrorText(win).catch(() => '')) || 'no modal and no error';
    if (outcome === 'timeout') note = `timed out after 60s — ${note}`;
  }
  return { outcome, note };
}

app.whenReady().then(async () => {
  try {
  /* ---------------------------------------------------------------- boot -- */
  const win = new BrowserWindow({
    width: 1240,
    height: 880,
    show: true,
    backgroundColor: '#0b0f14',
    title: 'OmniDownloader UI test',
    webPreferences: {
      preload: path.join(SRC, 'preload', 'preload.js'),
      contextIsolation: true,   // identical to the production window
      nodeIntegration: false,
      sandbox: true,
      // Keep Chromium painting while the window is covered — otherwise
      // capturePage() hands back a frame from minutes ago.
      backgroundThrottling: false
    }
  });

  // Screenshots capture the rendered pixels, so the window can stay visible
  // while ignoring stray mouse input — a curious hand on the desktop cannot
  // derail the scripted run.
  win.setIgnoreMouseEvents(true);
  // Never fully covered → Chromium keeps compositing, so screenshots stay live.
  win.setAlwaysOnTop(true, 'screen-saver');

  /* -- wire the exact same main-process services main.js wires up ---------- */
  binaryManager.init({ userDataPath: app.getPath('userData') });

  const destination = path.join(app.getPath('temp'), 'omni-ui-test');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  /** Removes everything downloaded so far (yt-dlp skips files that exist). */
  const emptyDestination = () => {
    for (const name of fs.readdirSync(destination)) {
      fs.rmSync(path.join(destination, name), { force: true, recursive: true });
    }
  };
  const settingsStore = {
    data: { destination, concurrency: 2, autoUpdate: true, theme: 'dark' },
    get(key, fallback) { return this.data[key] === undefined ? fallback : this.data[key]; },
    set(key, value) { this.data[key] = value; return value; },
    all() { return { ...this.data }; }
  };

  const downloadManager = new DownloadManager({
    settingsStore,
    emit: (channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  });

  registerIpcHandlers({
    getMainWindow: () => (win.isDestroyed() ? null : win),
    settingsStore,
    downloadManager,
    binaryManager
  });

  // Engine status pill → same call main.js makes at boot.
  binaryManager
    .bootstrap({})
    .then((status) => { if (!win.isDestroyed()) win.webContents.send('engine:status', status); })
    .catch(() => {});

  const consoleErrors = [];
  // Electron ≥ 30 passes one event object; older builds pass positional args.
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const modern = ev && typeof ev === 'object' && 'message' in ev;
    const level = modern ? ev.level : args[1];
    const message = modern ? ev.message : args[2];
    const line = modern ? ev.line : args[3];
    const sourceId = modern ? ev.sourceId : args[4];
    const isError =
      level === 'error' || level === 3 || level === 2 ||
      (typeof level === 'string' && /error/i.test(level));
    if (isError || /error/i.test(String(message))) {
      consoleErrors.push(`${message} (${sourceId}:${line})`);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    consoleErrors.push(`did-fail-load: ${desc} (${code})`);
  });
  win.on('render-process-gone', (_e, details) => {
    consoleErrors.push(`renderer gone: ${details.reason}`);
  });

  try {
    await win.loadFile(path.join(SRC, 'renderer', 'index.html'));
  } catch (err) {
    check('renderer loads', false, err.message);
    return finish(consoleErrors);
  }
  check('renderer loads index.html', true);

  const hasApi = await waitFor(win, '!!(window.api && window.api.analyze)', 15000);
  check('preload exposes window.api', !!hasApi);

  /* ----------------------------------------------------------- empty state */
  const emptyVisible = await js(win,
    `!document.getElementById('emptyState').classList.contains('hidden')`);
  check('empty state is shown before any task', !!emptyVisible);

  const engineText = await js(win, `document.getElementById('engineText').textContent`);
  check('engine pill reports a state', !!engineText, engineText);

  /* -------------------------------------------------------------- analyze */
  await js(win, setUrl(VIDEO_URL));
  await js(win, `document.getElementById('analyzeBtn').click()`);
  await sleep(300);
  const busy = await js(win, `document.getElementById('analyzeBtn').disabled`);
  check('analyze button enters busy state', busy === true);

  // YouTube occasionally answers with a transient "confirm you're not a bot"
  // challenge — retry a couple of times before declaring the check failed.
  let outcome = await awaitOutcome(win, 60000);
  let analyzeNote = outcome === 'modal' ? '' : (await analyzeErrorText(win)) || 'no response';
  for (let attempt = 0; attempt < 2 && outcome !== 'modal'; attempt += 1) {
    await sleep(3000);
    const retry = await analyzeLink(win, VIDEO_URL, 1);
    outcome = retry.outcome;
    analyzeNote = retry.note;
  }
  check('quality modal opens after analysis', outcome === 'modal', analyzeNote);
  await shot(win, '01-quality-modal');

  const titles = await js(win, `
    [...document.querySelectorAll('.q-label')].map(n => n.textContent)`);
  check('quality list offers resolutions + MP3',
    Array.isArray(titles) && titles.some((t) => /p\b/.test(t)) && titles.some((t) => /MP3/i.test(t)),
    (titles || []).join(' | '));

  const sizes = await js(win,
    `[...document.querySelectorAll('.q-size')].map(n => n.textContent)`);
  check('each quality shows an estimated size',
    Array.isArray(sizes) && sizes.length > 0 && sizes.every((s) => /MB|KB|unknown/i.test(s)),
    (sizes || []).join(' | '));

  const previewTitle = await js(win, `document.getElementById('qualityTitle').textContent`);
  check('preview shows the media title', !!previewTitle && previewTitle !== '—', previewTitle);

  const defaultSelected = await js(win,
    `document.querySelectorAll('.quality-item.is-selected').length`);
  check('a quality is preselected', defaultSelected === 1);

  /* ------------------------------------------------- error handling in UI */
  await js(win, `(() => {
    const overlay = document.getElementById('qualityOverlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      overlay.querySelector('[data-close-modal]').click();
    }
    return true;
  })()`);
  await js(win, `(() => {
    const input = document.getElementById('urlInput');
    input.value = 'definitely not a url';
    input.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await js(win, `document.getElementById('analyzeBtn').click()`);
  const inlineError = await waitFor(win,
    `!document.getElementById('analyzeError').classList.contains('hidden')`, 5000);
  check('invalid URL shows an inline error', !!inlineError);

  /* ------------------------------------------------------------- download */
  // A 21 MB direct MP4 stays in the "Downloading" state long enough to observe
  // live progress — the tiny YouTube test clip finishes between two polls.
  const dl = await analyzeLink(win, BIG_URL);
  check('download link analyzes too', dl.outcome === 'modal', dl.note);

  await js(win, `(() => {
    const items = [...document.querySelectorAll('.quality-item')];
    if (!items.length) return false;
    const video = items.filter(i => !i.classList.contains('is-audio')).pop() || items[0];
    video.click();
    return true;
  })()`);
  await js(win, `document.getElementById('startDownloadBtn').click()`);

  const cardCreated = await waitFor(win, `document.querySelectorAll('.task').length === 1`, 30000);
  check('task card is created', !!cardCreated);

  const badgeDuring = await waitFor(win,
    `(() => { const b = document.querySelector('.task .badge'); return b && ['downloading','merging'].includes(b.dataset.status); })()`,
    60000, 'live badge', 40);
  check('card shows live Downloading/Merging state', !!badgeDuring);
  await shot(win, '02-downloading');

  // Make sure real bytes are on the wire before sampling the stats.
  const liveStats = await waitFor(win,
    `(() => {
      const card = document.querySelector('.task');
      if (!card) return false;
      const pct = card.querySelector('.stat-pct b').textContent;
      const status = card.querySelector('.badge').dataset.status;
      return status === 'merging' || (/%$/.test(pct) && pct !== '0%');
    })()`, 60000, 'live stats', 100);
  check('card shows a live percent while downloading', !!liveStats);

  const statsDuring = await js(win, `(() => {
    const card = document.querySelector('.task');
    if (!card) return null;
    return {
      status: card.querySelector('.badge').dataset.status,
      percent: card.querySelector('.stat-pct b').textContent,
      speed: card.querySelector('.stat-speed').textContent,
      size: card.querySelector('.stat-size').textContent,
      bar: card.querySelector('.bar').style.width
    };
  })()`);
  check('card renders percent/speed/bar',
    !!statsDuring && /%$/.test(statsDuring.percent) && !!statsDuring.bar &&
      (statsDuring.status === 'merging' || /\/s$/.test(statsDuring.speed)),
    JSON.stringify(statsDuring));

  const completed = await waitFor(win,
    `(() => { const b = document.querySelector('.task .badge'); return b && b.dataset.status === 'completed'; })()`,
    240000);
  check('card reaches Completed state', !!completed);
  await shot(win, '03-completed');

  const folderBtn = await js(win,
    `[...document.querySelectorAll('.task [data-action]')].some(b => b.dataset.action === 'folder')`);
  check('completed card offers "Open in Folder"', !!folderBtn);

  const cardClass = await js(win, `document.querySelector('.task').className`);
  check('completed card gets is-done styling', /is-done/.test(cardClass || ''), cardClass);

  // Finished ≠ playable: probe the very file that card just produced.
  const singleFile = fs.readdirSync(destination)
    .find((n) => !/^\d{3} - /.test(n) && /\.(mp4|webm|mkv|mov|m4v)$/i.test(n));
  const single = mediaCodecs(singleFile && path.join(destination, singleFile));
  if (!singleFile) console.log('INFO  no downloaded media file found to probe');
  else if (single.skipped) console.log('INFO  codec check skipped (ffprobe unavailable)');
  else {
    check('downloaded video has an audio stream', !!single.audio,
      `${singleFile.slice(0, 40)} → ${single.video}/${single.audio}`);
    if (/\.mp4$/i.test(singleFile)) {
      check('downloaded .mp4 uses player-safe codecs (H.264 + AAC)',
        single.video === 'h264' && single.audio === 'aac',
        `video=${single.video} audio=${single.audio}`);
    }
  }

  /* ------------------------------------------------ cancel flow (21 MB file) */
  // Empty the folder first: yt-dlp short-circuits with "already downloaded"
  // when the output exists, and that instant finish would beat the cancel.
  emptyDestination();

  const cancelAnalysis = await analyzeLink(win, BIG_URL);
  check('second link analyzes too', cancelAnalysis.outcome === 'modal', cancelAnalysis.note);

  // Record every task event the renderer receives from here on: if the badge
  // gets stuck this tells us whether the event never arrived or was dropped.
  await js(win, `(() => {
    window.__evts = [];
    window.api.onDownloadProgress((d) => {
      window.__evts.push(d.status + '@' + d.percent + '#' + String(d.id).slice(0, 8));
    });
    return true;
  })()`);

  await js(win, `document.getElementById('startDownloadBtn').click()`);

  const secondCard = await waitFor(win, `document.querySelectorAll('.task').length === 2`, 30000);
  check('second task card is created', !!secondCard);

  // Cancel the instant the card exists: the task is still queued/starting, so
  // the assertion exercises the cancel path rather than download throughput.
  const cancelClicked = await js(win, `(() => {
    const btn = [...document.querySelectorAll('.task')].pop()
      .querySelector('[data-action="cancel"]');
    if (btn) btn.click();
    return !!btn;
  })()`);
  const canceled = await waitFor(win,
    `(() => { const b = document.querySelectorAll('.task .badge')[1]; return b && b.dataset.status === 'canceled'; })()`,
    30000);

  if (!canceled) {
    // Dump everything we can about *where* the transition was lost.
    const diag = await js(win, `(() => ({
      cards: [...document.querySelectorAll('.task')].map((t) => ({
        badge: t.querySelector('.badge').dataset.status,
        title: (t.querySelector('.task-title') || {}).textContent || '',
        actions: [...t.querySelectorAll('[data-action]')]
          .map((b) => b.dataset.action + ':' + b.textContent + ':' + (b.disabled ? 'off' : 'on'))
      })),
      events: (window.__evts || []).slice(-25),
      active: (document.getElementById('activeCount') || {}).textContent || '',
      toast: (document.querySelector('.toast') || {}).textContent || ''
    }))()`);
    console.log(`      [cancel diagnostics] ${JSON.stringify(diag)}`);
  }

  const badgeAfter = await js(win, `(() => {
    const b = document.querySelectorAll('.task .badge')[1];
    return b ? b.dataset.status : null;
  })()`);
  check('cancel button stops the task', !!canceled && !!cancelClicked,
    `badge=${badgeAfter}${cancelClicked ? '' : ' (cancel button missing)'}`);
  await shot(win, '04-canceled');

  /* --------------------------------------------------------------- settings */
  await js(win, `document.getElementById('settingsBtn').click()`);
  const settingsOpen = await waitFor(win,
    `!document.getElementById('settingsOverlay').classList.contains('hidden')`, 5000);
  check('settings modal opens', !!settingsOpen);

  const dest = await js(win, `document.getElementById('destPath').value`);
  check('settings shows the destination folder', !!dest, dest);

  const engineRows = await js(win, `({
    ytdlp: document.getElementById('ytDlpVersion').textContent,
    ffmpeg: document.getElementById('ffmpegVersion').textContent
  })`);
  check('settings shows engine versions', !!engineRows.ytdlp && engineRows.ytdlp !== '—',
    `yt-dlp: ${engineRows.ytdlp} | ffmpeg: ${engineRows.ffmpeg}`);

  await shot(win, '05-settings');
  await js(win, `document.querySelector('#settingsOverlay [data-close-modal]').click()`);

  /* ------------------------------------------------------ clear finished UI */
  await js(win, `document.getElementById('clearFinishedBtn').click()`);
  const cleared = await waitFor(win, `document.querySelectorAll('.task').length <= 1`, 10000);
  check('"Clear finished" removes finished cards', !!cleared);
  await shot(win, '06-after-clear');

  /* ------------------------------------------------ playlist (whole list) */
  // The core playlist promise: paste a list link → the modal says how many
  // videos, lists them, and the single card tracks position in the list.
  const cardsBefore = await js(win, `document.querySelectorAll('.task').length`);
  await js(win, `(() => {
    window.__plPercents = [];
    window.api.onDownloadProgress((d) => { window.__plPercents.push(d.percent); });
    return true;
  })()`);

  const plAnalysis = await analyzeLink(win, PLAYLIST_URL);
  check('playlist link opens the quality modal', plAnalysis.outcome === 'modal', plAnalysis.note);

  const plMeta = await js(win, `document.getElementById('qualityMeta').textContent`);
  check('modal announces how many items', /\bitems?\b/i.test(plMeta || ''), plMeta);

  const plHead = await js(win, `document.getElementById('playlistPreview').textContent`);
  check('modal promises to download every video',
    /videos will be downloaded/.test(plHead || ''), (plHead || '').slice(0, 70));

  const plRows = await js(win,
    `document.querySelectorAll('#playlistPreview .playlist-preview-item').length`);
  check('modal lists the individual videos', plRows >= 2, `${plRows} rows`);

  const plSizes = await js(win,
    `[...document.querySelectorAll('.q-size')].map(n => n.textContent)`);
  check('playlist sizes are whole-list totals',
    (plSizes || []).some((s) => /total/i.test(s)), (plSizes || []).join(' | '));

  // The shot must show what a user sees: the thumbnail loads over the net …
  const thumbLoaded = await waitFor(win, `(() => {
    const t = document.getElementById('qualityThumb');
    return t.complete && t.naturalWidth > 0;
  })()`, 20000, 'modal thumbnail');
  check('modal thumbnail loads', !!thumbLoaded);

  // …and every row has to be *inside* the box. `overflow:hidden` made this
  // box shrinkable inside .modal-body, which silently clipped the list down
  // to its first row — exactly the kind of bug a DOM count cannot see.
  const rowsFit = await js(win, `(() => {
    const box = document.getElementById('playlistPreview');
    const rows = [...box.querySelectorAll('.playlist-preview-item')];
    if (rows.length < 2) return false;
    const b = box.getBoundingClientRect();
    return rows.every((r) => {
      const x = r.getBoundingClientRect();
      return x.top >= b.top - 1 && x.bottom <= b.bottom + 1;
    });
  })()`);
  check('every playlist row fits inside the preview box', !!rowsFit);

  await shot(win, '07-playlist-modal');

  // Smallest video quality → the whole list downloads in seconds.
  await js(win, `(() => {
    const items = [...document.querySelectorAll('.quality-item')];
    const video = items.filter(i => !i.classList.contains('is-audio')).pop();
    if (video) video.click();
    return !!video;
  })()`);
  await js(win, `document.getElementById('startDownloadBtn').click()`);

  const plCard = await waitFor(win,
    `document.querySelectorAll('.task').length === ${cardsBefore + 1}`, 30000);
  check('playlist creates one card for the whole list', !!plCard);

  const plChip = await waitFor(win,
    `(() => { const c = [...document.querySelectorAll('.task')].pop(); const k = c && c.querySelector('.kind-chip'); return k && k.textContent === 'PLAYLIST'; })()`,
    20000);
  check('playlist card is chipped PLAYLIST', !!plChip);

  const plPosition = await waitFor(win,
    `(() => { const c = [...document.querySelectorAll('.task')].pop(); const s = c && c.querySelector('.stat-size'); return s && /Item \\d+ of \\d+/.test(s.textContent); })()`,
    120000, 'item position', 100);
  check('card shows its position in the list', !!plPosition,
    await js(win, `(() => { const c = [...document.querySelectorAll('.task')].pop(); const s = c && c.querySelector('.stat-size'); return s ? s.textContent : ''; })()`));
  await shot(win, '08-playlist-downloading');

  const plDone = await waitFor(win,
    `(() => { const c = [...document.querySelectorAll('.task')].pop(); const b = c && c.querySelector('.badge'); return b && ['completed','error'].includes(b.dataset.status); })()`,
    300000, 'playlist outcome', 200);
  const plStatus = await js(win, `(() => {
    const c = [...document.querySelectorAll('.task')].pop();
    const b = c && c.querySelector('.badge');
    return b ? b.dataset.status : null;
  })()`);
  check('playlist download finishes', !!plDone && plStatus === 'completed', `status=${plStatus}`);

  const plLabel = await js(win,
    `(() => { const c = [...document.querySelectorAll('.task')].pop(); const s = c && c.querySelector('.stat-size'); return s ? s.textContent : ''; })()`);
  check('completed card summarises the list', /\d+ videos/.test(plLabel || ''), plLabel);

  const plFiles = fs.readdirSync(destination).filter((n) => /^\d{3} - /.test(n));
  check('one numbered file per video landed', plFiles.length >= 2, plFiles.join(' | '));

  // Same playability invariant for every playlist entry.
  const plProbe = plFiles.map((n) => ({ n, c: mediaCodecs(path.join(destination, n)) }));
  const plSound = plProbe.filter((x) => !x.c.skipped);
  if (plFiles.length && !plSound.length) {
    console.log('INFO  playlist codec check skipped (ffprobe unavailable)');
  } else if (plSound.length) {
    check('every playlist file has an audio stream',
      plSound.every((x) => !!x.c.audio),
      plSound.map((x) => `${x.c.video}/${x.c.audio}`).join(' '));
    check('playlist .mp4 files use player-safe codecs (H.264 + AAC)',
      plSound.every((x) => !/\.mp4$/i.test(x.n) ||
        (x.c.video === 'h264' && x.c.audio === 'aac')),
      plSound.map((x) => x.n.slice(0, 24)).join(' '));
  }

  // One bar for the whole list: it may pause at an item boundary, but a
  // backwards jump would read to the user as "the download restarted".
  const plPercents = await js(win, `window.__plPercents || []`);
  let plMonotonic = true;
  if (Array.isArray(plPercents)) {
    for (let i = 1; i < plPercents.length; i++) {
      if (plPercents[i] < plPercents[i - 1] - 0.001) { plMonotonic = false; break; }
    }
  }
  check('playlist bar never moves backwards', plMonotonic,
    `${Array.isArray(plPercents) ? plPercents.length : 0} samples`);
  await shot(win, '09-playlist-completed');

  /* ------------------------------------------------------------ console QA */
  check('no renderer console errors', consoleErrors.length === 0,
    consoleErrors.slice(0, 5).join(' | '));
} catch (err) {
  check('unexpected UI test exception', false, err.stack || err.message);
} finally {
  finish();
}

});
// end of app.whenReady().then(...)

let finished = false;
function finish() {
  if (finished) return;   // the early `return finish()` path may land here twice
  finished = true;
  const failed = results.filter((r) => !r.pass);
  console.log('\n========================================');
  console.log(`${results.length - failed.length}/${results.length} UI checks passed`);
  console.log('========================================');
  setTimeout(() => app.exit(failed.length ? 1 : 0), 400);
}
