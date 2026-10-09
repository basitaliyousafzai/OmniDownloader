'use strict';
/**
 * ============================================================================
 *  OmniDownloader — scripts/screenshots.js
 * ----------------------------------------------------------------------------
 *  Regenerates the screenshots used in README.md (`npm run shots`).
 *
 *  Unlike the test suites (which build their own windows), this drives the
 *  *real* application: `electron .` boots `src/main/main.js`, so the frames
 *  show the product exactly as a user sees it — v1.0.0 badge, engine pill,
 *  real yt-dlp progress — but over CDP so every moment can be captured:
 *
 *      01 landing      02 quality picker   03 downloading      04 completed
 *      05 settings     06 playlist picker  07 playlist running 08 playlist done
 *
 *  Downloads are redirected to a throwaway folder by temporarily re-pointing
 *  the profile's settings.json, which is restored afterwards — so no file
 *  ever lands in the user's real destination folder.
 *
 *  Requires network access (it analyses real YouTube links) and FFmpeg.
 *  Exit code 0 = all frames written to docs/screenshots/.
 * ============================================================================
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
// The app derives userData from package.json's name, so `electron .` shares
// %APPDATA%\OmniDownloader with the installed build. The profile is backed up
// and restored around the run (see main()), so settings are never disturbed.
const PROFILE = path.join(process.env.APPDATA, 'OmniDownloader');
const SETTINGS_FILE = path.join(PROFILE, 'settings.json');
const PORT = 9337;

/** Any live instance would hold the single-instance lock — stop them first. */
function killExisting() {
  try {
    require('child_process').spawnSync('taskkill',
      ['/F', '/IM', 'OmniDownloader.exe'], { stdio: 'ignore' });
  } catch (_) { /* nothing was running */ }
}

const VIDEO_URL = 'https://www.youtube.com/watch?v=a8JMqoYgqio'; // has 1080p, colourful thumb
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL1vkBF5RrFBCsC7bNNevkYstrTvCJu6CV';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];

/* ---------------------------------------------------------------- CDP glue */

async function pages() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`,
      { signal: AbortSignal.timeout(1500) });
    return (await res.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch (_) {
    return [];
  }
}

/** Evaluates `expression` inside the page (3 s timeout — never hangs). */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (err) { return reject(err); }
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('ws timeout')); }, 3000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id === 1) {
        ws.send(JSON.stringify({
          id: 2, method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        }));
      } else if (msg.id === 2) {
        clearTimeout(timer);
        if (msg.result && msg.result.exceptionDetails) {
          return reject(new Error(msg.result.exceptionDetails.text || 'eval failed'));
        }
        resolve(msg.result && msg.result.result && msg.result.result.value);
        try { ws.close(); } catch (_) {}
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

/**
 * Saves one PNG; frames are named for the README.
 * Windows may throttle compositing for an occluded window, so a capture that
 * does not answer is retried with the page raised and an explicit clip —
 * an offscreen render that does not depend on visibility.
 */
async function shot(wsUrl, name) {
  const size = await evaluate(wsUrl,
    `({ w: window.innerWidth, h: window.innerHeight })`).catch(() => null);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const params = attempt === 1
      ? { format: 'png' }
      : { format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: (size && size.w) || 1180,
                  height: (size && size.h) || 800, scale: 1 } };
    if (attempt > 1) {
      await evaluate(wsUrl, `document.title`).catch(() => {});   // keep WS warm
      await new Promise((r) => setTimeout(r, 400));
    }
    try {
      const data = await new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(wsUrl); } catch (err) { return reject(err); }
        const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('capture timeout')); }, 15000);
        ws.onopen = () => ws.send(JSON.stringify({
          id: 1, method: 'Page.captureScreenshot', params
        }));
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (_) { return; }
          if (msg.id === 1) {
            clearTimeout(timer);
            try { ws.close(); } catch (_) {}
            if (msg.result && msg.result.data) resolve(msg.result.data);
            else reject(new Error('capture failed: ' + JSON.stringify(msg).slice(0, 120)));
          }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
      });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
      shots.push(name);
      console.log(`  [shot] docs/screenshots/${name}`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`  capture attempt ${attempt} failed: ${err.message}`);
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------ page actions */

/** Sets the URL bar the way a paste would (React-style value setter). */
const setUrl = (ws, url) => evaluate(ws, `(() => {
  const i = document.getElementById('urlInput');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, ${JSON.stringify(url)});
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return i.value;
})()`);

const click = (ws, selector) => evaluate(ws, `document.querySelector(${JSON.stringify(selector)}).click()`);

/** Picks a quality by its label prefix (e.g. "360p"), skipping Audio MP3. */
const pickQuality = (ws, label) => evaluate(ws, `(() => {
  const items = [...document.querySelectorAll('.quality-item')];
  const target = items.find((el) => !el.classList.contains('is-audio')
    && el.textContent.trim().startsWith(${JSON.stringify(label)}));
  if (!target) return false;
  target.click();
  return true;
})()`);

/** Snapshot of every task card: chip, status, percent, error text. */
const cardReport = (ws) => evaluate(ws, `(() => [...document.querySelectorAll('.task')].map((c) => {
  const badge = c.querySelector('.badge');
  const pct = c.querySelector('.stat-pct b');
  const msg = c.querySelector('.task-msg');
  const chip = c.querySelector('.kind-chip');
  return {
    chip: chip ? chip.textContent : '',
    status: badge && badge.dataset ? badge.dataset.status : '?',
    pct: pct ? parseFloat(pct.textContent) : 0,
    err: msg ? msg.textContent.replace(/\\s+/g, ' ').trim() : ''
  };
}))()`);

const isTerminal = (c) => ['completed', 'error', 'canceled'].includes(c.status);
const allSettled = (cards) => cards.length > 0 && cards.every(isTerminal);

/** Some card genuinely mid-flight with real progress (never 0 % or done). */
const midFlightMatch = (cards) => cards.some((c) =>
  c.status === 'downloading' && c.pct > 2 && c.pct < 95);

const hasPlaylistCard = (cards) => cards.some((c) => c.chip === 'PLAYLIST');

/**
 * Polls the cards until `match(cards)` holds.
 * Resolves `{ok:true, cards}` — or `{ok:false, reason, detail}` the moment
 * the run errors, finishes before a frame can be captured, or times out, so
 * the caller can print diagnostics and retry after a cooldown.
 */
async function watchFlight(ws, timeoutMs, match) {
  const started = Date.now();
  let cards = [];
  while (Date.now() - started < timeoutMs) {
    cards = (await cardReport(ws).catch(() => null)) || cards;
    if (match(cards)) return { ok: true, cards };
    const bad = cards.find((c) => c.status === 'error');
    if (bad) return { ok: false, reason: 'download error', detail: bad.err || '(no message)' };
    if (allSettled(cards)) {
      return { ok: false, reason: 'finished before the frame', detail: JSON.stringify(cards) };
    }
    await sleep(250);
  }
  return { ok: false, reason: 'timeout', detail: JSON.stringify(cards) };
}

/** Removes focus rings and lets thumbnails settle before the capture. */
const settle = async (ws) => {
  await evaluate(ws, `(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return true;
  })()`);
  await sleep(700);
};

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;      // forwards the polled value ('modal', 'error', …)
    } catch (_) { /* page busy */ }
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Analyzes a link; waits for the overlay itself (never stale nodes). */
async function analyze(ws, url) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await setUrl(ws, url);
    await evaluate(ws, `(() => {
      const err = document.getElementById('analyzeError');
      if (err) err.classList.add('hidden');
      return true;
    })()`);
    await click(ws, '#analyzeBtn');
    try {
      const outcome = await waitFor(() => evaluate(ws, `(() => {
        const overlay = document.getElementById('qualityOverlay');
        const err = document.getElementById('analyzeError');
        if (overlay && !overlay.classList.contains('hidden')) return 'modal';
        if (err && !err.classList.contains('hidden')) return 'error';
        return false;
      })()`), 75000, 'quality modal');
      if (outcome === 'modal') return;
      throw new Error('analysis error: ' + await evaluate(ws, `(() => {
        const err = document.getElementById('analyzeError');
        return err ? err.textContent.replace(/\\s+/g, ' ').trim() : '(unknown)';
      })()`));
    } catch (err) {
      console.warn(`  analyze attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3) throw err;
      await sleep(45000);   // YouTube throttles back-to-back extractions
    }
  }
}

/* -------------------------------------------------------------------- main */

/**
 * From an open quality modal: pick 360p, start, and drive the run to a
 * genuine mid-flight frame. When YouTube refuses the transfer (403), the
 * frame is missed, or no card appears, it clears the board, waits out the
 * known back-to-back cooldown, re-analyzes and tries again (3 attempts).
 */
async function startAndWatch(ws, downloadsDir, { url, playlist, midTimeoutMs }) {
  let last = { reason: 'not started', detail: '' };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      console.warn(`  retry ${attempt - 1} after "${last.reason}": ${last.detail}`);
      await click(ws, '#clearFinishedBtn').catch(() => {});
      // Empty the folder so yt-dlp cannot skip with "has already been downloaded".
      try {
        for (const f of fs.readdirSync(downloadsDir)) {
          fs.rmSync(path.join(downloadsDir, f), { force: true });
        }
      } catch (_) { /* nothing there */ }
      await sleep(60000);                    // YouTube's back-to-back cooldown
      await analyze(ws, url);                // fresh media + open modal
      await settle(ws);
    }

    if (!await pickQuality(ws, '360p')) throw new Error('360p quality not offered');
    await click(ws, '#startDownloadBtn');

    // 1) the task card must appear (a start click that did not take lands here)
    try {
      await waitFor(async () => {
        const cards = (await cardReport(ws)) || [];
        return playlist ? hasPlaylistCard(cards) : cards.length > 0;
      }, 45000, 'task card');
    } catch (_) {
      const cards = (await cardReport(ws).catch(() => [])) || [];
      last = { reason: 'no task card appeared', detail: JSON.stringify(cards) };
      continue;
    }

    // 2) a real mid-flight frame (cardReport short-circuits on error / too-fast)
    const flight = await watchFlight(ws, midTimeoutMs, midFlightMatch);
    if (flight.ok) return flight;
    last = flight;
  }
  throw new Error(`could not capture a mid-download frame — last: "${last.reason}" ${last.detail}`);
}

/** Waits until every card is terminal, then surfaces any failure. */
async function waitForSettled(ws, timeoutMs, label) {
  await waitFor(async () => {
    const cards = (await cardReport(ws)) || [];
    return allSettled(cards);
  }, timeoutMs, label);
  const cards = (await cardReport(ws)) || [];
  const bad = cards.find((c) => c.status === 'error');
  if (bad) throw new Error(`task failed: ${bad.err || '(no message)'}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  killExisting();

  // Point the shared profile at a throwaway folder (restored at the end).
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shots-'));
  const hadSettings = fs.existsSync(SETTINGS_FILE);
  const settingsBackup = hadSettings ? fs.readFileSync(SETTINGS_FILE, 'utf8') : null;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(
    { destination: downloads, concurrency: 2, engineVersion: null, lastUpdateCheck: 0 }, null, 2));

  const child = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 80 && !target; i += 1) {
      await sleep(500);
      target = (await pages())[0] || null;
    }
    if (!target) throw new Error('app never exposed a page');
    ws = target.webSocketDebuggerUrl;
    console.log(`app up: ${target.title}`);

    // Engines must be resolved before analysis works.
    await waitFor(() => evaluate(ws,
      `!!document.getElementById('urlInput') && !/Starting/i.test(
         (document.getElementById('engineText') || {}).textContent || '')`), 60000, 'engines ready');

    console.log('--- single video ---');
    await shot(ws, '01-landing.png');

    await analyze(ws, VIDEO_URL);
    await settle(ws);
    await shot(ws, '02-quality-picker.png');

    await startAndWatch(ws, downloads, { url: VIDEO_URL, playlist: false, midTimeoutMs: 180000 });
    await settle(ws);
    await shot(ws, '03-downloading.png');

    await waitForSettled(ws, 300000, 'single download completion');
    await settle(ws);
    await shot(ws, '04-completed.png');

    console.log('--- settings ---');
    await click(ws, '#settingsBtn');
    await waitFor(() => evaluate(ws, `!!document.getElementById('destPath')`), 15000, 'settings modal');
    await settle(ws);
    await shot(ws, '05-settings.png');
    await click(ws, '#settingsOverlay [data-close-modal]');

    console.log('--- playlist ---');
    await analyze(ws, PLAYLIST_URL);
    await settle(ws);
    await shot(ws, '06-playlist-picker.png');

    await startAndWatch(ws, downloads, { url: PLAYLIST_URL, playlist: true, midTimeoutMs: 420000 });
    await settle(ws);
    await shot(ws, '07-playlist-running.png');

    await waitForSettled(ws, 600000, 'playlist completion');
    await settle(ws);
    await shot(ws, '08-playlist-done.png');

    console.log(`\nOK: ${shots.length} screenshots in docs/screenshots/`);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    console.error(`captured so far: ${shots.join(', ') || '(none)'}`);
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(800);
    // Restore the shared profile exactly as it was.
    if (hadSettings) fs.writeFileSync(SETTINGS_FILE, settingsBackup);
    else fs.rmSync(SETTINGS_FILE, { force: true });
    try { fs.rmSync(downloads, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
