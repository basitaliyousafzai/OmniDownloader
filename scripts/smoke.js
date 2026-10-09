'use strict';
/**
 * ============================================================================
 *  OmniDownloader — scripts/smoke.js
 * ----------------------------------------------------------------------------
 *  End-to-end smoke test for the main-process core. Runs under Electron:
 *
 *      npx electron scripts/smoke.js      (or: npm run smoke)
 *
 *  What it verifies
 *    1. binaryManager bootstraps (auto-downloads yt-dlp from GitHub Releases)
 *    2. analysis works: `yt-dlp --dump-json` → metadata + quality list
 *    3. a real download runs to completion and reports live progress
 *    4. cancellation kills the child process and purges .part / .ytdl files
 *    5. pure helpers (size parsing, filename sanitising) behave correctly
 *
 *  Exit code 0 = all checks passed, 1 = at least one failure.
 * ============================================================================
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const binaryManager = require('../src/main/binaryManager');
const DownloadManager = require('../src/main/downloadManager');

/* -------------------------------------------------------------------------- */
/* Tiny assertion harness                                                     */
/* -------------------------------------------------------------------------- */

const results = [];

function check(name, condition, extra = '') {
  const pass = !!condition;
  results.push({ name, pass, extra });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
  return pass;
}

/** Non-scoring information line (e.g. optional FFmpeg presence). */
function note(message) {
  console.log(`INFO  ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls the manager until the task reaches one of `wanted` states. */
async function waitFor(dm, taskId, wanted, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = dm.list().find((t) => t.id === taskId);
    if (task && wanted.includes(task.status)) return task;
    await sleep(250);
  }
  return dm.list().find((t) => t.id === taskId);
}

/**
 * First video/audio codec of a finished file (via ffprobe).
 *
 * The whole point of the codec work in downloadManager: a download that
 * *finishes* is worthless if the player cannot hear it — a `.mp4` built from
 * VP9 + Opus opens as silent video. `skipped: true` means ffprobe is not on
 * PATH, so the invariant degrades to INFO instead of failing the suite.
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

/* -------------------------------------------------------------------------- */
/* Test data                                                                  */
/* -------------------------------------------------------------------------- */

// A tiny, always-available YouTube clip (19 s "Me at the zoo"); falls back to
// a direct MP4 if YouTube blocks the datacentre IP.
const PRIMARY_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const FALLBACK_URL = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
// A real playlist with exactly 2 short videos — small enough to download in
// full, but enough to prove enumeration, item counters and one merged card.
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL1vkBF5RrFBCsC7bNNevkYstrTvCJu6CV';

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

app.whenReady().then(async () => {
  const events = [];

  try {
    /* ---- 0. pure helpers (no I/O) ---------------------------------------- */
    const { parseSize, sanitizeFilename, buildQualities } = DownloadManager;
    check('helper: parseSize("2.50MiB/s")', Math.round(parseSize('2.50MiB/s')) === 2621440,
      `${parseSize('2.50MiB/s')} bytes/s`);
    check('helper: parseSize("50.00MiB")', Math.round(parseSize('50.00MiB')) === 52428800);
    check('helper: sanitizeFilename strips reserved chars',
      sanitizeFilename('a/b:c*d?e"f<g>h|i').indexOf('/') === -1 &&
      sanitizeFilename('a/b:c*d?e"f<g>h|i').indexOf(':') === -1,
      sanitizeFilename('a/b:c*d?e"f<g>h|i'));

    const { isPlaylistUrl, playlistOverallPercent, genericVideoQuality, parseJsonLines } = DownloadManager;
    check('helper: playlist URL detection',
      isPlaylistUrl('https://www.youtube.com/playlist?list=PLtest') === true &&
      isPlaylistUrl('https://www.youtube.com/watch?v=abc12345678') === false &&
      // watch?v=…&list=… is how an address bar looks *inside* a playlist:
      // pasting it means "give me the whole list".
      isPlaylistUrl('https://www.youtube.com/watch?v=abc&list=PLtest') === true &&
      isPlaylistUrl('https://www.youtube.com/@somechannel/videos') === true);

    /* ---- playlist progress: one monotonic bar for the whole list ---------- */
    const agg = playlistOverallPercent(3, 10, 50);
    check('playlist: bar aggregates across items (25% at item 3/10)',
      Math.abs(agg - 25) < 0.01, `${agg}%`);
    check('playlist: bar never jumps backwards',
      playlistOverallPercent(1, 4, 100) === 25 &&
      playlistOverallPercent(2, 4, 0) === 25 &&
      playlistOverallPercent(4, 4, 100) === 100);
    check('playlist: unknown length falls back to the item percent',
      playlistOverallPercent(null, null, 42) === 42 &&
      playlistOverallPercent(0, 0, 0) === 0);

    /* ---- flat (--flat-playlist) metadata still yields a download choice --- */
    const flatQualities = buildQualities([{ id: 'a', title: 'One' }, { id: 'b', title: 'Two' }]);
    check('playlist: flat entries only need the generic Video fallback',
      flatQualities.length === 1 && flatQualities[0].kind === 'audio' &&
      genericVideoQuality().kind === 'video' &&
      genericVideoQuality().selector === 'bestvideo+bestaudio/best',
      flatQualities.map((q) => q.label).join(', '));

    check('helper: parseJsonLines ignores noise',
      parseJsonLines('{"a":1}\nnot json\n\n  {"b":2}').length === 2);

    /* ---- 1. engine bootstrap (downloads yt-dlp when missing) -------------- */
    console.log('\n--- engine bootstrap ---');
    binaryManager.init({ userDataPath: app.getPath('userData') });
    const status = await binaryManager.bootstrap({});
    check('engine: yt-dlp resolved', !!status.ytDlp,
      status.ytDlp ? `${status.ytDlp.path} (${status.ytDlp.version}, ${status.ytDlp.source})`
        : JSON.stringify(status.missing || status.error || 'not found'));
    note(status.ffmpeg
      ? `FFmpeg found: ${status.ffmpeg.path} (${status.ffmpeg.source})`
      : 'FFmpeg not installed — MP3 extraction and stream merging are unavailable');

    if (!status.ytDlp) {
      throw new Error('yt-dlp unavailable — cannot continue the smoke test');
    }

    /* ---- 2. manager under test ------------------------------------------- */
    const dest = path.join(app.getPath('temp'), `omni-smoke-${Date.now()}`);
    fs.mkdirSync(dest, { recursive: true });

    const settingsStore = {
      data: { destination: dest, concurrency: 2 },
      get(key) { return this.data[key]; },
      set(key, value) { this.data[key] = value; return value; },
      all() { return { ...this.data }; }
    };

    const dm = new DownloadManager({
      settingsStore,
      emit: (channel, payload) => events.push({ channel, payload })
    });

    /* ---- 3. analysis ------------------------------------------------------ */
    console.log('\n--- analysis (yt-dlp --dump-json) ---');
    let media = null;
    let sourceUrl = '';
    let lastError = null;

    for (const url of [PRIMARY_URL, FALLBACK_URL]) {
      try {
        media = await dm.analyze(url);
        sourceUrl = url;
        break;
      } catch (err) {
        lastError = err;
        console.log(`  analyze failed for ${url}: ${err.message}`);
      }
    }

    check('analyze: media metadata returned', !!media && !!media.title,
      media ? `"${media.title}" via ${media.extractor}` : `last error: ${lastError && lastError.message}`);
    check('analyze: quality list built', !!media && media.qualities.length > 0,
      media ? media.qualities.map((q) => `${q.label} (${q.approxBytes ? Math.round(q.approxBytes / 1048576) + 'MB' : '?'})`).join(', ') : '');
    check('analyze: Audio MP3 option present',
      !!media && media.qualities.some((q) => q.kind === 'audio'));

    // Every merged quality must name the container its codecs fit — an
    // extension that contradicts the streams is the silent-video bug.
    const videoQualities = media ? media.qualities.filter((q) => q.kind === 'video') : [];
    check('analyze: qualities declare a matching container',
      videoQualities.length > 0 &&
      videoQualities.every((q) => q.container === null || ['mp4', 'webm', 'mkv'].includes(q.container)),
      videoQualities.map((q) => `${q.key}:${q.container || '-'}`).join(' '));

    // Direct file links come back from the *generic* extractor with no
    // `vcodec`/`height` at all — the list must still offer a video download
    // instead of collapsing to "Audio MP3" only.
    let directMedia = null;
    try {
      directMedia = await dm.analyze('https://download.samplelib.com/mp4/sample-30s.mp4');
    } catch (err) {
      console.log(`  direct-link analyze failed: ${err.message}`);
    }
    check('analyze: direct file link offers a Video quality',
      !!directMedia && directMedia.qualities.some((q) => q.kind === 'video' && !q.needsMerge),
      directMedia
        ? directMedia.qualities.map((q) => `${q.kind}:${q.label}`).join(' | ')
        : 'analysis failed');

    if (media) {
      /* ---- 4. download to completion -------------------------------------- */
      console.log('\n--- download (video, smallest quality) ---');
      const videoQuality = [...media.qualities]
        .filter((q) => q.kind === 'video')
        .sort((a, b) => (a.height || 9999) - (b.height || 9999))[0];

      const task = await dm.start({
        url: sourceUrl,
        id: media.entries[0].id,
        title: 'Smoke Test Video',
        thumbnail: media.thumbnail,
        isPlaylist: false,
        quality: videoQuality || { kind: 'video', label: 'Best', selector: 'best', height: null }
      });
      check('download: task enqueued', ['queued', 'starting'].includes(task.status), task.status);

      const final = await waitFor(dm, task.id, ['completed', 'error'], 240000);
      check('download: completed', final && final.status === 'completed',
        final ? (final.error || `percent=${final.percent}`) : 'timeout');
      check('download: final file exists', !!(final && final.file && fs.existsSync(final.file)),
        final && final.file ? final.file : 'no path reported');
      check('download: live progress events streamed',
        events.filter((e) => e.payload.status === 'downloading' && e.payload.percent > 0).length > 0,
        `${events.length} events total`);
      check('download: speed/size reported at some point',
        events.some((e) => e.payload.speedBps > 0 || e.payload.totalBytes > 0));

      // Finished ≠ playable: the file must carry audio, and a `.mp4` must
      // carry the codecs every player decodes (H.264 + AAC).
      const dl = mediaCodecs(final && final.file);
      if (dl.skipped) {
        note(`download: codec check skipped (ffprobe unavailable) — ${final && final.file}`);
      } else {
        check('download: output contains an audio stream', !!dl.audio,
          `video=${dl.video} audio=${dl.audio}`);
        if (/\.mp4$/i.test(final.file)) {
          check('download: .mp4 uses player-safe codecs (H.264 + AAC)',
            dl.video === 'h264' && dl.audio === 'aac',
            `video=${dl.video} audio=${dl.audio}`);
        }
      }

      /* ---- 4b. MP3 extraction (needs FFmpeg) ------------------------------ */
      console.log('\n--- MP3 extraction ---');
      const audioQuality = media.qualities.find((q) => q.kind === 'audio');
      const audioTask = await dm.start({
        url: sourceUrl,
        id: media.entries[0].id,
        title: 'Smoke Test Audio',
        thumbnail: media.thumbnail,
        isPlaylist: false,
        quality: audioQuality
      });
      const audioFinal = await waitFor(dm, audioTask.id, ['completed', 'error'], 240000);

      if (status.ffmpeg) {
        check('audio: MP3 extraction completed',
          audioFinal && audioFinal.status === 'completed',
          audioFinal ? (audioFinal.error || `percent=${audioFinal.percent}`) : 'timeout');
        check('audio: produced a .mp3 file',
          !!(audioFinal && audioFinal.file && /\.mp3$/i.test(audioFinal.file) && fs.existsSync(audioFinal.file)),
          audioFinal && audioFinal.file ? audioFinal.file : 'no path');
      } else {
        // Without FFmpeg the app must fail fast with an actionable message.
        check('audio: fails fast when FFmpeg is missing',
          audioFinal && audioFinal.status === 'error' && /FFmpeg/i.test(audioFinal.error || ''),
          audioFinal ? audioFinal.error : 'no status');
      }

      /* ---- 4c. non-ASCII titles must still resolve to a real file --------- */
      // yt-dlp's *plain* stdout drops non-ASCII on Windows, so `FINAL_FILE`
      // comes back as a path with gaps — without #resolveFileSync the app
      // stores a path that exists nowhere and "Open in Folder" dies quietly.
      console.log('\n--- non-ASCII title path resolution ---');
      try {
        const oddMedia = await dm.analyze(FALLBACK_URL);
        const oddQuality = oddMedia.qualities.find((q) => q.kind === 'video');
        const oddTask = await dm.start({
          url: FALLBACK_URL,
          id: 'nonascii-test',
          title: 'Smoke عنوان تجريبي 🎬',
          thumbnail: oddMedia.thumbnail,
          isPlaylist: false,
          quality: oddQuality
        });
        const oddFinal = await waitFor(dm, oddTask.id, ['completed', 'error'], 240000);
        check('non-ascii: download completed',
          oddFinal && oddFinal.status === 'completed',
          oddFinal ? (oddFinal.error || `percent=${oddFinal.percent}`) : 'timeout');
        check('non-ascii: reported path exists on disk',
          !!(oddFinal && oddFinal.file && fs.existsSync(oddFinal.file)),
          oddFinal ? JSON.stringify(oddFinal.file) : 'no task');
        check('non-ascii: the title survived into the filename',
          !!(oddFinal && oddFinal.file && /[\u0600-\u06FF]/.test(oddFinal.file)),
          oddFinal && oddFinal.file ? path.basename(oddFinal.file) : 'no path');
      } catch (err) {
        check('non-ascii: download completed', false, err.message.slice(0, 100));
      }

      /* ---- 5. cancellation + partial cleanup ------------------------------ */
      console.log('\n--- cancellation ---');
      // A ~21 MB file guarantees the task is mid-flight when we cancel it.
      const CANCEL_URL = 'https://download.samplelib.com/mp4/sample-30s.mp4';
      const task2 = await dm.start({
        url: CANCEL_URL,
        id: 'cancel-test',
        title: 'Cancel Me',
        thumbnail: media.thumbnail,
        isPlaylist: false,
        quality: { kind: 'video', label: '360p', selector: 'best[height<=360]/best', height: 360 }
      });
      // Poll until bytes are actually being written, then cancel immediately.
      const beganAt = Date.now();
      let running = null;
      while (Date.now() - beganAt < 30000) {
        running = dm.list().find((t) => t.id === task2.id);
        if (!running) break;                                    // vanished
        if (['completed', 'error', 'canceled'].includes(running.status)) break;
        if (running.status === 'downloading' && running.percent > 0) break;
        await sleep(50);
      }
      check('cancel: task was downloading before cancel',
        !!running && running.status === 'downloading' && running.percent > 0,
        running ? `${running.status} @ ${running.percent}%` : 'task missing');

      await dm.cancel(task2.id);
      const canceled = await waitFor(dm, task2.id, ['canceled', 'error', 'completed'], 20000);
      check('cancel: task status is canceled', canceled && canceled.status === 'canceled',
        canceled ? canceled.status : 'timeout');

      await sleep(500);
      const leftovers = fs.readdirSync(dest)
        .filter((n) => /\.(part|ytdl|temp)$/i.test(n) || /\.f\d+\.[A-Za-z0-9]+$/i.test(n));
      check('cancel: no .part/.ytdl/fragment leftovers', leftovers.length === 0, leftovers.join(', '));

      /* ---- 5b. playlist: analyze + download every item -------------------- */
      console.log('\n--- playlist (whole list, one task) ---');
      let pl = null;
      try {
        pl = await dm.analyze(PLAYLIST_URL);
      } catch (err) {
        console.log(`  playlist analyze failed: ${err.message}`);
      }
      check('playlist: analyze reports a playlist',
        !!pl && pl.isPlaylist && pl.entryCount >= 2,
        pl ? `${pl.entryCount} items — "${pl.title}"` : 'analysis failed');
      check('playlist: qualities come from real formats',
        !!pl && pl.qualities.some((q) => q.kind === 'video' && q.height),
        pl ? pl.qualities.map((q) => q.label).join(', ') : '');
      check('playlist: size estimate covers the whole list',
        !!pl && pl.qualities.some((q) => q.kind === 'video' && q.approxBytes > 0));

      if (pl && pl.isPlaylist && pl.entryCount >= 2) {
        const plQuality = [...pl.qualities]
          .filter((q) => q.kind === 'video')
          .sort((a, b) => (a.height || 9999) - (b.height || 9999))[0];
        const plEventsFrom = events.length;

        const plTask = await dm.start({
          url: pl.url,
          id: 'playlist',
          title: pl.title,
          thumbnail: pl.thumbnail,
          isPlaylist: true,
          quality: plQuality
        });
        const plFinal = await waitFor(dm, plTask.id, ['completed', 'error'], 300000);

        check('playlist: downloaded the whole list',
          !!plFinal && plFinal.status === 'completed',
          plFinal ? (plFinal.error || `${plFinal.status} pct=${plFinal.percent}`) : 'timeout');
        check('playlist: card carries item counters',
          !!plFinal && plFinal.playlistTotal >= 2 &&
          plFinal.playlistIndex === plFinal.playlistTotal,
          plFinal ? `${plFinal.playlistIndex}/${plFinal.playlistTotal}` : '');

        // One bar for the whole list: it may pause, but never step back.
        const percents = events.slice(plEventsFrom).map((e) => e.payload.percent);
        let monotonic = true;
        let stepped = 0;
        for (let i = 1; i < percents.length; i++) {
          if (percents[i] < percents[i - 1] - 0.001) { monotonic = false; stepped = percents[i - 1] - percents[i]; break; }
        }
        check('playlist: progress never moves backwards', monotonic,
          `${percents.length} samples${monotonic ? '' : ` (dropped by ${stepped.toFixed(1)}%)`}`);

        const plFiles = fs.readdirSync(dest).filter((n) => /^\d{3} - /.test(n));
        check('playlist: one numbered file per video', plFiles.length >= pl.entryCount,
          plFiles.join(' | '));

        // Same invariant for playlist entries — the reported bug ("video with
        // no audio") happened on a playlist download too.
        const plCodecs = plFiles
          .map((n) => ({ n, c: mediaCodecs(path.join(dest, n)) }))
          .filter((x) => !x.c.skipped);
        if (!plCodecs.length && plFiles.length) {
          note('playlist: codec check skipped (ffprobe unavailable)');
        } else if (plCodecs.length) {
          check('playlist: every file contains an audio stream',
            plCodecs.every((x) => !!x.c.audio),
            plCodecs.map((x) => `${x.n.slice(0, 12)}=${x.c.video}/${x.c.audio}`).join(' '));
          check('playlist: .mp4 files use player-safe codecs (H.264 + AAC)',
            plCodecs.every((x) => !/\.mp4$/i.test(x.n) ||
              (x.c.video === 'h264' && x.c.audio === 'aac')),
            plCodecs.map((x) => x.n.replace(/^\d{3} - /, '').slice(0, 28)).join(' '));
        }
      }

      /* ---- 6. graceful error handling ------------------------------------- */
      console.log('\n--- error handling ---');
      try {
        await dm.analyze('https://example.invalid/nothing-here');
        check('error: invalid host rejected', false, 'no error thrown');
      } catch (err) {
        check('error: invalid host rejected', true, err.message.slice(0, 90));
      }
      try {
        await dm.analyze('not a url at all');
        check('error: malformed URL rejected', false, 'no error thrown');
      } catch (err) {
        check('error: malformed URL rejected', true, err.message);
      }
      try {
        await dm.start({ url: 'https://example.com/x.mp4', quality: {} });
        check('error: missing quality rejected', false, 'no error thrown');
      } catch (err) {
        check('error: missing quality rejected', true, err.message);
      }
    }

    check('manager: no orphan tasks left running', !dm.hasActiveTasks());
  } catch (err) {
    check('unexpected exception', false, err.stack || err.message);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n========================================`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  console.log(`========================================`);

  // Give pending fs writes a beat, then exit hard (electron keeps alive).
  setTimeout(() => app.exit(failed.length ? 1 : 0), 300);
});
