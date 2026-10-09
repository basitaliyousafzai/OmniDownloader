'use strict';
/**
 * ============================================================================
 *  OmniDownloader — downloadManager.js
 * ----------------------------------------------------------------------------
 *  Child-process orchestrator for yt-dlp.
 *
 *  • `analyze()`  → `yt-dlp --dump-json`  → parsed metadata + quality list
 *  • `start()`    → queued download tasks, each one `spawn()`ed locally
 *  • stdout regex parser → live percent / speed / ETA / size + status phases
 *  • `cancel()`   → kills the whole process tree and purges `.part` / `.ytdl`
 *
 *  Security notes:
 *    – every argument is passed as an argv element (no shell, no interpolation)
 *    – the user-supplied URL is validated before it ever reaches a child
 *    – file names come from our own sanitizer (output template), never from
 *      raw remote titles
 * ============================================================================
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const binaryManager = require('./binaryManager');
const logger = require('./logger');

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Matches yt-dlp `--newline` progress lines, e.g.
 *  `[download]  12.5% of ~50.00MiB at  2.50MiB/s ETA 00:12`               */
const RE_PROGRESS =
  /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.,]+\s*[KMGTP]?i?B)\s+at\s+([\d.,]+\s*[KMGTP]?i?B\/s)(?:\s+ETA\s+([\d:]+))?/i;

/** Fallback when yt-dlp cannot determine size/speed (`unknown B/s`). */
const RE_PERCENT_ONLY = /\[download\]\s+([\d.]+)%/;
/** Final summary line: `[download] 100% of 302.04KiB in 00:00:00 at 4.10MiB/s` */
const RE_PROGRESS_SUMMARY =
  /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.,]+\s*[KMGTP]?i?B)\s+in\s+[\d:]+\s+at\s+([\d.,]+\s*[KMGTP]?i?B\/s)/i;
/** `[download] Destination: <path>` / `[ExtractAudio] Destination: <path>` */
const RE_DESTINATION = /^\[(?:download|ExtractAudio|Merger)\]\s+(?:Destination|Converting to):\s*(.+)$/;
/** `[Merger] Merging formats into "<path>"` */
const RE_MERGER = /^\[Merger\]\s+Merging formats into\s+"(.+)"$/;
/** `FINAL_FILE:<path>` emitted by our own `--print after_move:` template. */
const RE_FINAL_FILE = /^FINAL_FILE:(.+)$/;
/** Anything the extractor reports as fatal. */
const RE_ERROR = /^(?:ERROR|FATAL):\s*(.+)$/;
/** Playlist run counter: `[download] Downloading item 3 of 12`. */
const RE_PLAYLIST_ITEM = /^\[download\]\s+Downloading item\s+(\d+)\s+of\s+(\d+)/i;

/**
 * Overall progress of a playlist download (one bar for the whole list).
 *
 * A playlist is one task with N videos; yt-dlp reports 0→100% for *each*
 * video, which would make the bar jump back to zero over and over. This
 * flattens it into a single monotonic value:
 *
 *     item 3 of 12, half downloaded → ((3 - 1) + 0.5) / 12 → 20.8%
 *
 * @param {number|null} index current item (1-based)
 * @param {number|null} total number of items
 * @param {number} itemPercent progress of the current item (0..100)
 * @returns {number} overall percent (0..100)
 */
function playlistOverallPercent(index, total, itemPercent) {
  const pct = Number.isFinite(itemPercent) ? Math.min(100, Math.max(0, itemPercent)) : 0;
  const count = Number(total) > 0 ? Math.floor(total) : 0;
  if (!count) return pct; // unknown length → show the current item's progress
  const current = Math.min(Math.max(Math.floor(index) || 1, 1), count);
  return Math.min(100, (((current - 1) + pct / 100) / count) * 100);
}

/**
 * Turns raw yt-dlp stderr into the single most useful human-readable line.
 * Strips ANSI colours, deprecation banners and warnings first.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractErrorMessage(text) {
  const clean = String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^Deprecated Feature/i.test(l)
      && !/^Please remove them from/i.test(l)
      && !/^See\s+https:\/\/github\.com\/yt-dlp/i.test(l)
      && !/^WARNING:/i.test(l));
  if (!lines.length) return null;
  // Prefer the real extractor error over generic chatter.
  const explicit = [...lines].reverse().find((l) => RE_ERROR.test(l));
  const chosen = explicit || lines[lines.length - 1];
  return chosen.replace(/^(?:ERROR|FATAL):\s*/i, '').slice(0, 400);
}

const UNIT_FACTORS = {
  B: 1,
  KB: 1e3, KIB: 1024,
  MB: 1e6, MIB: 1024 ** 2,
  GB: 1e9, GIB: 1024 ** 3
};

/** Converts `"2.50MiB/s"` / `"50.00MiB"` → bytes (number). */
function parseSize(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^([\d.,]+)\s*([KMGTP]i?B|B)(?:\/s)?$/i);
  if (!m) return null;
  const value = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const factor = UNIT_FACTORS[m[2].toUpperCase()] || 1;
  return value * factor;
}

/**
 * Filesystem-safe base name: replaces characters reserved on Windows
 * (`\ / : * ? " < > |`) and ASCII control characters.
 */
function sanitizeFilename(name, maxLength = 140) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')     // reserved on Windows
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')        // control characters
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'omnidownloader').slice(0, maxLength).trim() || 'omnidownloader';
}

/** `125` → `"2:05"` (UI helper; the raw ETA string is also kept). */
function durationToText(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Playlist detection.
 *
 * YouTube (and most sites) mark a playlist either with a dedicated path or
 * with a `list=` parameter. `list=` is treated as a playlist **even when a
 * `v=` id is present**, because that is exactly how the address bar looks
 * while watching something inside a playlist — and pasting that link is the
 * normal way to say "give me all of these videos".
 *
 * Channel / profile pages (`/@handle`, `/channel/…`) are lists too.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isPlaylistUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '');
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
      if (u.pathname.startsWith('/playlist')) return true;
      if (/^\/(?:@|channel\/|user\/|c\/|playlist)/i.test(u.pathname)) return true;
      if (u.searchParams.has('list')) return true; // watch?v=…&list=… too
      return false;
    }
    return /\/(?:playlist|set|album|albums)\b/i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

/** Strict URL validation — only http(s) URLs are ever executed. */
function validateUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Please paste a video URL first.');
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error('That does not look like a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// links are supported.');
  }
  return parsed.toString();
}

/* -------------------------------------------------------------------------- */
/* Format / quality analysis (turns `--dump-json` into UI options)            */
/* -------------------------------------------------------------------------- */

/** Human label for a vertical resolution. */
function heightLabel(height, fps) {
  const fpsPart = fps && fps >= 50 ? ' 60fps' : '';
  if (height >= 2160) return `${height}p (4K)${fpsPart}`;
  if (height >= 1440) return `${height}p (2K)${fpsPart}`;
  if (height >= 1080) return `${height}p (Full HD)${fpsPart}`;
  if (height >= 720) return `${height}p (HD)${fpsPart}`;
  return `${height}p${fpsPart}`;
}

/** Estimated bytes for a stream of `tbr` kbps over `duration` seconds. */
function estimateBytes(tbr, duration) {
  if (!tbr || !duration) return 0;
  return (tbr * 1000 * duration) / 8;
}

/* --------------------------------------------------------------------------
 * Codec helpers. The pair we quote decides whether the finished file plays:
 * H.264 + AAC inside `.mp4` is understood by every player on every platform,
 * while VP9/AV1 + Opus — perfectly valid technically — inside the `.mp4` this
 * app used to force leaves Windows' built-in players with a silent picture.
 * That reads to a user exactly as "it downloaded the video but not the audio".
 * ------------------------------------------------------------------------ */

/** H.264/AVC video — or a direct file link we have to assume is player-safe. */
function isH264(f) {
  const vc = (f.vcodec || '').toLowerCase();
  if (vc && vc !== 'none') return vc.startsWith('avc');
  // Direct links carry no codec fields: a plain `.mp4` URL is the file the
  // site itself ships, so it is treated as the safe default.
  return (f.ext || '').toLowerCase() === 'mp4';
}

/** AAC audio — the only audio codec every `.mp4` player decodes. */
function isAac(f) {
  const ac = (f.acodec || '').toLowerCase();
  if (ac && ac !== 'none') return ac.startsWith('mp4a') || ac.startsWith('aac');
  return ['m4a', 'mp4', 'aac', 'mp3'].includes((f.ext || '').toLowerCase());
}

/**
 * Container for a merged pair. `.mp4` only when both codecs are the ones
 * every player ships with; the WebM family (VP9/AV1 + Opus) goes to `.webm` —
 * the container yt-dlp itself picks for such pairs — and anything mixed
 * (H.264 + Opus, an unknown codec) lands in `.mkv`, which holds every
 * combination without needing the codecs to agree with the extension.
 *
 * @returns {'mp4'|'webm'|'mkv'}
 */
function mergeContainerFor(video, audio) {
  const vc = (video && (video.vcodec || '').toLowerCase()) || '';
  const ac = (audio && (audio.acodec || '').toLowerCase()) || '';
  const h264 = vc.startsWith('avc');
  const webmFamily = /^(vp09|vp9|vp8|av01)/.test(vc);
  const aac = ac.startsWith('mp4a') || ac.startsWith('aac');
  const opusFamily = /^(opus|vorbis)/.test(ac);
  if (h264 && aac) return 'mp4';
  if (webmFamily && opusFamily) return 'webm';
  return 'mkv';
}

/**
 * Best audio-only format entry of a parsed video JSON object.
 *
 * @param {Array<object>} formats every format of the video
 * @param {boolean} [preferAac] pair the result with H.264 video → take AAC
 *   even when a higher-bitrate Opus stream exists (see `mergeContainerFor`)
 */
function pickAudio(formats, preferAac) {
  const audioOnly = formats.filter((f) =>
    f.acodec && f.acodec !== 'none' && (!f.height || f.vcodec === 'none'));
  const pool = audioOnly.length
    ? audioOnly
    : formats.filter((f) => f.acodec && f.acodec !== 'none');
  if (pool.length) {
    const byBitrate = pool.slice().sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
    if (preferAac) {
      const aac = byBitrate.find(isAac);
      if (aac) return aac;
    }
    return byBitrate[0];
  }
  // Direct file links report no codec fields at all — the single format IS
  // the whole file, so it can still be used to size the MP3 estimate.
  return formats.length === 1 ? formats[0] : null;
}

/**
 * Is this format a video stream?
 *
 * Site extractors always set `vcodec`, but direct file links (the *generic*
 * extractor) come back with `vcodec: null`, `video_ext: 'mp4'` and no
 * resolution. Those must still be offered as a video download — otherwise a
 * pasted MP4 link would only ever offer "Audio MP3".
 *
 * @param {object} f
 * @returns {boolean}
 */
function isVideoFormat(f) {
  if (!f || f.vcodec === 'none') return false;
  if (f.vcodec) return true;                 // codec known (and not "none")
  if (f.height) return true;                 // resolution known
  return Boolean(f.video_ext && f.video_ext !== 'none');
}

/**
 * Does this format already carry audio?
 *
 * Only `acodec === 'none'` proves audio is missing (YouTube marks its
 * video-only renditions exactly that way). When the field is absent — direct
 * file links — the format is a complete file, and appending `+bestaudio`
 * would make yt-dlp fail with "cannot merge", so we assume it is complete.
 *
 * @param {object} f
 * @returns {boolean}
 */
function formatHasAudio(f) {
  if (!f) return false;
  if (f.acodec) return f.acodec !== 'none';
  return true;
}

/**
 * Builds the quality option list for one or more parsed entries.
 *
 * @param {Array<object>} entries yt-dlp video JSON objects
 * @returns {Array<{key,kind,label,note,selector,height,approxBytes}>}
 */
function buildQualities(entries) {
  const videoByEntry = entries.map((entry) =>
    (entry.formats || []).filter(isVideoFormat));

  // Union of every vertical resolution the media offers (4K, 1440p, …).
  let heights = [...new Set(videoByEntry.flat().map((f) => f.height).filter(Boolean))]
    .sort((a, b) => b - a);

  // No resolution reported (direct MP4/WebM links) → offer the file itself
  // as a single, height-less video option instead of hiding the video choice.
  if (!heights.length && videoByEntry.some((list) => list.length)) heights = [null];

  const qualities = heights.map((height) => {
    let bytes = 0;
    let fps = 0;
    const exacts = [];              // per-entry "video[+audio]" id pairs
    const progressiveSelectors = [];   // single-file ids (no FFmpeg needed)
    const heightFilter = height === null ? '' : `[height<=${height}]`;
    let container = null;           // merge target ('mp4' | 'webm' | 'mkv')
    let merging = false;            // at least one entry joins two streams
    let outExt = null;              // extension a single-stream entry keeps

    entries.forEach((entry, i) => {
      const duration = entry.duration || 0;
      const candidates = videoByEntry[i]
        .filter((f) => (height === null ? true : f.height === height))
        // Prefer plain HTTP(S) streams (exact size, no HLS segmenting), then
        // H.264 — the one video codec every `.mp4` player decodes — then the
        // highest bitrate. `protocol` is "https", "m3u8_native", …
        .sort((a, b) => {
          const directA = /^https?$/i.test(a.protocol || '') ? 1 : 0;
          const directB = /^https?$/i.test(b.protocol || '') ? 1 : 0;
          if (directB - directA) return directB - directA;
          const safeA = isH264(a) ? 1 : 0;
          const safeB = isH264(b) ? 1 : 0;
          if (safeB - safeA) return safeB - safeA;
          return (b.tbr || 0) - (a.tbr || 0);
        });

      if (!candidates.length) return;
      const video = candidates[0];
      fps = Math.max(fps, video.fps || 0);

      const hasAudio = formatHasAudio(video);
      // Pairing H.264 with AAC is what keeps a finished `.mp4` audible —
      // see pickAudio() and mergeContainerFor().
      const audio = hasAudio ? null : pickAudio(entry.formats || [], isH264(video));

      // Exact ids for what we quoted.
      const exact = hasAudio
        ? video.format_id
        : `${video.format_id}+${audio ? audio.format_id : 'bestaudio'}`;
      exacts.push(exact);

      if (hasAudio) {
        outExt = video.ext || outExt;   // one stream → nothing to merge
      } else {
        // Decide the container *before* anything downloads: a container that
        // disagrees with the codecs is how a finished file ends up silent.
        merging = true;
        const wanted = mergeContainerFor(video, audio);
        container = container && container !== wanted ? 'mkv' : (container || wanted);
      }

      // Single-file (progressive) alternatives that work WITHOUT FFmpeg —
      // used when only yt-dlp is available on the machine.
      const progressive = candidates
        .filter((f) => formatHasAudio(f))
        .map((f) => f.format_id);
      if (progressive.length) progressiveSelectors.push(...progressive);

      bytes += (video.filesize || video.filesize_approx ||
        estimateBytes(video.tbr, duration) || 0);
      if (!hasAudio && audio) {
        bytes += (audio.filesize || audio.filesize_approx ||
          estimateBytes(audio.tbr, duration) || 0);
      }
    });

    if (!exacts.length) return null;

    // The generic fallback must respect the container too: if the quoted ids
    // rotate out (sites do that), the replacement pair still has to fit the
    // extension, or yt-dlp ends up merging codecs the file cannot hold.
    const safeFallback = container === 'mp4'
      ? `bestvideo${heightFilter}[vcodec^=avc]+bestaudio[acodec^=mp4a]/`
      : '';
    const fallback = `${safeFallback}bestvideo${heightFilter}+bestaudio/best${heightFilter}`;
    const shownExt = merging ? container : (outExt || 'mp4');

    return {
      key: height === null ? 'video-original' : `h${height}`,
      kind: 'video',
      height,
      label: height === null ? 'Video' : heightLabel(height, fps),
      note: `${shownExt.toUpperCase()} • video + audio`,
      // Alternatives are joined as a fallback chain (`a/b/c`), which is how
      // yt-dlp expects several selectors to be combined. Every entry already
      // contributes its own `exact` ids — for a playlist that also lets one
      // rule serve videos that report different format ids.
      selector: [...new Set(exacts.map((e) => `${e}/${fallback}`))].join('/'),
      // Merge-free alternative used when FFmpeg is unavailable on this machine.
      // NOTE: `/` (first available wins) — a `,` would select *every* id and
      // request exactly the merge a FFmpeg-less machine cannot perform.
      progressiveSelector: progressiveSelectors.length
        ? `${[...new Set(progressiveSelectors)].join('/')}/best${heightFilter}[acodec!=none]/best[acodec!=none]`
        : null,
      needsMerge: progressiveSelectors.length === 0,
      // Value for --merge-output-format (null → no merge of ours to shape).
      container: merging ? container : null,
      approxBytes: Math.round(bytes) || null
    };
  }).filter(Boolean);

  // ---- Always-present Audio MP3 option ------------------------------------
  let audioBytes = 0;
  entries.forEach((entry) => {
    const audio = pickAudio(entry.formats || []);
    if (audio) {
      audioBytes += (audio.filesize || audio.filesize_approx ||
        estimateBytes(audio.tbr, entry.duration) || 0);
    }
  });
  qualities.push({
    key: 'audio-mp3',
    kind: 'audio',
    height: null,
    label: 'Audio MP3',
    note: 'Best audio • extracted to MP3',
    selector: 'bestaudio/best',
    approxBytes: Math.round(audioBytes) || null
  });

  return qualities;
}

/**
 * Generic video option used when the metadata we read carries no format list
 * (a `--flat-playlist` enumeration only contains ids + titles). yt-dlp picks
 * the best available format at download time, so the choice stays available
 * instead of the modal offering *only* "Audio MP3".
 *
 * @returns {{key,kind,height,label,note,selector,progressiveSelector,needsMerge,approxBytes}}
 */
function genericVideoQuality() {
  return {
    key: 'video-original',
    kind: 'video',
    height: null,
    label: 'Video',
    note: 'Best available • video + audio',
    selector: 'bestvideo+bestaudio/best',
    progressiveSelector: 'best[acodec!=none]/best[acodec!=none]',
    needsMerge: true,
    // Unknown codecs → no container of ours; yt-dlp's own default applies.
    container: null,
    approxBytes: null
  };
}

/** Parses the newline-delimited JSON emitted by `--dump-json`. */
function parseJsonLines(stdout) {
  const entries = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try { entries.push(JSON.parse(trimmed)); } catch (_) { /* skip noise */ }
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/* DownloadManager                                                            */
/* -------------------------------------------------------------------------- */

class DownloadManager {
  /**
   * @param {object} opts
   * @param {object} opts.settingsStore persisted settings (destination, …)
   * @param {(channel:string, payload:object)=>void} opts.emit → webContents.send
   */
  constructor({ settingsStore, emit }) {
    this.settingsStore = settingsStore;
    this.emit = emit || (() => {});

    /** @type {Map<string, object>} taskId → task record */
    this.tasks = new Map();
    /** FIFO of queued task ids (concurrency-limited). */
    this.queue = [];
    /** @type {Map<string, object>} taskId → currently running tasks */
    this.active = new Map();
  }

  /* ---------------------------------------------------------------------- */
  /* Analysis: `yt-dlp --dump-json`                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Extracts metadata + quality options without downloading anything.
   *
   * @param {string} rawUrl
   * @returns {Promise<object>} media info for the quality modal
   */
  async analyze(rawUrl) {
    const url = validateUrl(rawUrl);
    const engines = await binaryManager.resolveEngines();
    if (!engines.ytDlp) {
      throw new Error('yt-dlp is not installed yet — check the Engine panel, it is downloaded automatically.');
    }

    const playlist = isPlaylistUrl(url);
    const baseArgs = [
      '--ignore-config',   // ignore the user's global yt-dlp.conf (predictable runs)
      '--no-warnings',
      '--socket-timeout', '20',
      '--retries', '3'
    ];
    const run = (args, timeoutMs) =>
      this.#execCapture(engines.ytDlp.path, [...baseArgs, ...args], timeoutMs);
    const fail = (stderr, fallback) => new Error(extractErrorMessage(stderr) || fallback);

    let entries = [];

    if (playlist) {
      // Pass 1 — enumerate the list WITHOUT opening every video page.
      // A 200-item playlist dumped in full would take minutes and time out.
      const flatRun = await run(['--dump-json', '--flat-playlist', '--yes-playlist', url], 90 * 1000);
      entries = parseJsonLines(flatRun.stdout);
      if (!entries.length) {
        throw fail(flatRun.stderr,
          'Could not read this playlist. It may be private, removed or unsupported.');
      }

      // Pass 2 — real format data for ONE item (heights, codecs, sizes) so the
      // quality picker shows true options. Non-fatal: without it we fall back
      // to a generic "Video" choice further down.
      try {
        const fullRun = await run(
          ['--dump-json', '--playlist-items', '1', '--yes-playlist', url], 60 * 1000);
        const detailed = parseJsonLines(fullRun.stdout);
        if (detailed.length) entries = detailed.concat(entries.slice(1));
      } catch (err) {
        logger.warn('analyze: detailed probe failed, keeping flat data:', err.message);
      }
    } else {
      const full = await run(['--dump-json', '--no-playlist', url], 90 * 1000);
      entries = parseJsonLines(full.stdout);
      if (!entries.length) {
        throw fail(full.stderr,
          'Could not read this URL. It may be private, removed or unsupported.');
      }
    }

    const first = entries[0];
    const isPlaylist = playlist || entries.length > 1;
    const entryCount = isPlaylist ? entries.length : 1;
    const totalDuration = entries.reduce((sum, e) => sum + (e.duration || 0), 0);

    // Fast enumeration carries no format list → guarantee a video choice,
    // otherwise a pasted playlist would only offer "Audio MP3".
    let qualities = buildQualities(entries);
    const formatsUnknown = entries.some((e) => !Array.isArray(e.formats) || !e.formats.length);
    if (formatsUnknown && !qualities.some((q) => q.kind === 'video')) {
      qualities = [genericVideoQuality(), ...qualities];
    }

    // Sizes come from one item → scale them to the whole list so the modal
    // shows what the download will actually cost (≈ 1.4 GB for 12 videos).
    if (entryCount > 1) {
      qualities = qualities.map((q) => (q.approxBytes
        ? { ...q, approxBytes: Math.round(q.approxBytes * entryCount) }
        : q));
    }

    return {
      url,
      isPlaylist,
      entryCount,
      title: (isPlaylist && (first.playlist_title || first.playlist)) || first.title,
      uploader: first.uploader || first.channel || first.uploader_id
        || first.playlist_uploader || '',
      extractor: first.extractor_key || first.extractor || '',
      thumbnail: first.thumbnail || (first.thumbnails && first.thumbnails.length
        ? first.thumbnails[first.thumbnails.length - 1].url : ''),
      duration: totalDuration || null,
      durationText: durationToText(totalDuration) ||
        (isPlaylist ? `${entryCount} videos` : ''),
      entries: entries.slice(0, 50).map((e) => ({
        id: e.id,
        title: e.title,
        thumbnail: e.thumbnail,
        durationText: durationToText(e.duration),
        url: e.webpage_url || e.url || url
      })),
      qualities
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Download lifecycle                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates + enqueues a download task.
   *
   * @param {object} payload
   * @param {string} payload.url
   * @param {string} payload.id       media id (used inside the file name)
   * @param {string} payload.title
   * @param {string} payload.thumbnail
   * @param {boolean} payload.isPlaylist
   * @param {{kind:string,label:string,selector:string,height:number}} payload.quality
   * @returns {Promise<object>} task snapshot
   */
  async start(payload) {
    const url = validateUrl(payload && payload.url);
    const quality = payload.quality || {};
    if (!quality.selector) throw new Error('No quality selected.');

    const engines = await binaryManager.resolveEngines();
    if (!engines.ytDlp) {
      throw new Error('yt-dlp is not available yet — see the Engine panel.');
    }

    const isPlaylist = !!payload.isPlaylist;
    const destDir = this.settingsStore.get('destination');
    fs.mkdirSync(destDir, { recursive: true });

    // Deterministic output base → predictable cleanup + "Open in Folder".
    const mediaId = sanitizeFilename(payload.id || crypto.randomBytes(4).toString('hex'), 40);
    const base = isPlaylist ? null : `${sanitizeFilename(payload.title)} [${mediaId}]`;

    const outputTemplate = isPlaylist
      ? path.join(destDir, '%(playlist_index)03d - %(title)s [%(id)s].%(ext)s')
      : path.join(destDir, `${base}.%(ext)s`);

    const task = {
      id: crypto.randomUUID(),
      url,
      title: payload.title || 'Untitled',
      thumbnail: payload.thumbnail || '',
      qualityLabel: quality.label || 'Best',
      kind: quality.kind === 'audio' ? 'audio' : 'video',
      selector: quality.selector,
      progressiveSelector: quality.progressiveSelector || null,
      needsMerge: !!quality.needsMerge,
      // Container chosen from the codecs (see mergeContainerFor) — must reach
      // the spawn argv so the file extension cannot contradict the streams.
      container: quality.container || null,
      height: quality.height || null,
      isPlaylist,
      // Playlist bookkeeping (see playlistOverallPercent / #handleLine).
      playlistIndex: null,
      playlistTotal: null,
      itemPercent: 0,
      /** Streams finished inside the current item (video → audio restarts). */
      itemStreamsDone: 0,
      /** Learned from item 1: how many 0→100% runs one video takes here. */
      itemStreamExpectation: null,
      itemTotalBytes: null,
      completedFiles: 0,
      failedItems: 0,
      /** Absolute paths of videos that already finished (playlists keep them). */
      doneFiles: new Set(),
      destDir,
      base,
      outputTemplate,
      ytDlpPath: engines.ytDlp.path,
      ffmpegPath: engines.ffmpeg ? engines.ffmpeg.path : null,
      status: 'queued',
      percent: 0,
      loadedBytes: 0,
      totalBytes: null,
      speedBps: null,
      eta: null,
      file: null,
      error: null,
      warning: null,
      cancelRequested: false,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      child: null,
      // Every path yt-dlp tells us about — used for cancellation cleanup.
      touched: new Set()
    };

    this.tasks.set(task.id, task);
    this.queue.push(task.id);

    this.#pump();
    return this.#snapshot(task);
  }

  /** Cancels a queued or running task and purges its partial files. */
  async cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Unknown task.');
    if (['completed', 'error', 'canceled'].includes(task.status)) return this.#snapshot(task);

    task.cancelRequested = true;

    // Queued: simply drop it out of the FIFO.
    if (task.status === 'queued' || !task.child) {
      this.queue = this.queue.filter((id) => id !== taskId);
      task.status = 'canceled';
      task.finishedAt = Date.now();
      try {
        await this.#cleanupPartials(task);
      } catch (_) { /* a locked temp file must not block the status update */ }
      this.#emit(task);
      this.#pump();
      return this.#snapshot(task);
    }

    // Running: terminate the whole tree (yt-dlp + its ffmpeg children).
    if (task.child.exitCode === null) {
      this.#killTree(task.child);
      await new Promise((resolve) => {
        task.child.once('close', () => resolve());
        setTimeout(resolve, 5000); // never block the renderer indefinitely
      });
    }
    // The `close` handler performs the cleanup + final emit.
    return this.#snapshot(task);
  }

  /** Cancel everything (app shutdown). */
  async cancelAll() {
    await Promise.allSettled([...this.tasks.keys()].map((id) => this.cancel(id)));
  }

  /** Current snapshots (the renderer re-hydrates its list on reload). */
  list() {
    return [...this.tasks.values()].map((t) => this.#snapshot(t));
  }

  /** Removes finished tasks from the internal list ("Clear finished"). */
  clearFinished() {
    for (const [id, t] of [...this.tasks.entries()]) {
      if (['completed', 'error', 'canceled'].includes(t.status)) this.tasks.delete(id);
    }
    this.queue = this.queue.filter((id) => this.tasks.has(id));
    return this.list();
  }

  hasActiveTasks() {
    return this.active.size > 0 || this.queue.length > 0;
  }

  /** Kill everything, then resolve once all children are gone. */
  async shutdown() {
    for (const id of this.queue) {
      const t = this.tasks.get(id);
      if (t) { t.status = 'canceled'; this.#emit(t); }
    }
    this.queue = [];
    await Promise.allSettled([...this.active.keys()].map((id) => this.cancel(id)));
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /** Starts queued tasks while capacity allows. */
  #pump() {
    let limit = Number(this.settingsStore.get('concurrency')) || 2;
    limit = Math.min(6, Math.max(1, limit));

    while (this.active.size < limit && this.queue.length) {
      const id = this.queue.shift();
      const task = this.tasks.get(id);
      if (!task || task.cancelRequested) continue;
      try {
        this.#run(task);
      } catch (err) {
        // One malformed task must never wedge the queue or the app.
        logger.error(`Failed to launch task ${id}:`, err);
        if (task.child) continue; // the child is already running — its own
        task.status = 'error';     // handlers will take it from here
        task.error = err.message || 'Could not start the download.';
        task.finishedAt = Date.now();
        this.#emit(task);
      }
    }
  }

  /** Builds the argv and spawns yt-dlp for a single task. */
  #run(task) {
    const ffmpegPath = task.ffmpegPath;
    let selector = task.selector;

    if (task.kind === 'audio' && !ffmpegPath) {
      // MP3 extraction is impossible without FFmpeg → fail fast with a fix.
      task.status = 'error';
      task.error = 'FFmpeg is required for MP3 extraction. Install FFmpeg or place it in ' +
        'assets/binaries/' + (process.platform === 'win32' ? 'win32'
          : process.platform === 'darwin' ? 'darwin' : 'linux') + '.';
      task.finishedAt = Date.now();
      this.#emit(task);
      this.#pump();
      return;
    }

    if (task.kind === 'video' && !ffmpegPath) {
      if (task.progressiveSelector) {
        // No FFmpeg → fall back to a single-file stream (no merge step).
        selector = task.progressiveSelector;
        task.warning = 'FFmpeg not found — using a single-file stream, so quality may be limited.';
      } else if (task.kind === 'video' && task.needsMerge) {
        // Every stream at this height is video-only → merging is mandatory.
        task.status = 'error';
        task.error = 'FFmpeg is required for this quality: the selected resolution only exists as ' +
          'separate video/audio streams. Install FFmpeg or place it in assets/binaries/' +
          (process.platform === 'win32' ? 'win32'
            : process.platform === 'darwin' ? 'darwin' : 'linux') + '.';
        task.finishedAt = Date.now();
        this.#emit(task);
        this.#pump();
        return;
      } else {
        selector = task.height ? `best[height<=${task.height}]/best` : 'best';
        task.warning = 'FFmpeg not found — multi-stream formats are disabled, quality may be limited.';
      }
    }

    const args = [
      '--ignore-config',
      '--newline',            // one progress event per line (parser-friendly)
      '--progress',           // --print implies --quiet: force progress output
      '--no-quiet',           // …and restore Destination/Merger/error lines
      '--progress-delta', '0.5', // ~2 progress events/sec (keeps IPC light)
      '--no-warnings',
      '--retries', '10',
      '--fragment-retries', '10',
      '--concurrent-fragments', '4',
      '--no-mtime',
      '--continue',           // resume partial downloads
      '--format', selector,
      '--output', task.outputTemplate,
      // Authoritative final path (printed after the file is moved in place).
      '--print', 'after_move:FINAL_FILE:%(filepath)s'
    ];

    // The container has to match the codecs we quoted (mergeContainerFor):
    // forcing `mp4` around VP9 + Opus produced files players opened as silent
    // video. No container recorded → leave yt-dlp to its own default.
    if (task.kind === 'video' && task.container) {
      args.push('--merge-output-format', task.container);
    }
    if (task.kind === 'audio') args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
    // IMPORTANT: yt-dlp resolves --ffmpeg-location against its CWD, so only an
    // absolute path is safe — a bare name silently disables stream merging.
    if (ffmpegPath && path.isAbsolute(ffmpegPath)) {
      args.push('--ffmpeg-location', ffmpegPath);
    }
    if (task.isPlaylist) {
      args.push('--yes-playlist');
      // One private/removed video must not abort the remaining ones.
      args.push('--no-abort-on-error');
    } else {
      args.push('--no-playlist');
    }
    args.push(task.url);

    task.status = 'starting';
    task.startedAt = Date.now();
    this.#emit(task);

    let child;
    try {
      child = spawn(task.ytDlpPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX → kill yt-dlp *and* ffmpeg at once.
        detached: process.platform !== 'win32'
      });
    } catch (err) {
      task.status = 'error';
      task.error = `Could not start yt-dlp: ${err.message}`;
      task.finishedAt = Date.now();
      this.#emit(task);
      this.#pump();
      return;
    }

    task.child = child;
    this.active.set(task.id, task);

    let tail = '';
    const onChunk = (isStderr) => (data) => {
      // Stream handlers run outside any promise chain: an exception thrown
      // here would be an *uncaught exception* and would take the whole app
      // down mid-download. Parse defensively instead.
      try {
        const text = data.toString();
        if (isStderr) tail = (tail + text).slice(-4000);
        for (const line of text.split(/\r?\n/)) this.#handleLine(task, line);
      } catch (err) {
        logger.warn('Could not parse yt-dlp output:', err.message);
      }
    };
    child.stdout.on('data', onChunk(false));
    child.stderr.on('data', onChunk(true));

    child.on('error', (err) => {
      task.status = 'error';
      task.error = `yt-dlp process error: ${err.message}`;
    });

    child.on('close', async (code, signal) => {
      try {
        this.active.delete(task.id);
        task.child = null;

        const canceled = task.cancelRequested || signal === 'SIGTERM' || signal === 'SIGKILL';

        // `--no-abort-on-error` makes the exit code unreliable for playlists:
        // it can be 0 even when every video failed, and non-zero when nearly
        // all of them landed. Judge by what is actually on disk instead.
        const savedSomething = task.completedFiles > 0;
        const failedEverything = task.failedItems > 0 && !savedSomething;
        const succeeded = code === 0 || (task.isPlaylist && savedSomething);

        if (canceled) {
          task.status = 'canceled';
          task.finishedAt = Date.now();
          await this.#cleanupPartials(task);
        } else if (succeeded && !failedEverything) {
          // Most videos landed: show "Completed" plus a warning rather than a
          // red failure over a folder full of finished files.
          const partialFailure = code !== 0 || task.failedItems > 0;
          task.status = 'completed';
          task.percent = 100;
          task.speedBps = null;
          task.eta = null;
          task.finishedAt = Date.now();
          if (partialFailure) {
            task.warning = task.isPlaylist && task.failedItems > 0
              ? `${task.failedItems} video${task.failedItems === 1 ? '' : 's'} in this playlist could not be downloaded.`
              : 'Finished with warnings — some videos may be missing.';
          }
          // Heal a path that yt-dlp's stdout may have mangled (see
          // #resolveFileSync), then fall back to the JSON-derived base name.
          task.file = this.#resolveFileSync(task, task.file)
            || await this.#guessFinalFile(task);
          // Report the size of the *finished* file (after merge / audio convert)
          // instead of the bytes that went over the wire.
          if (task.file) {
            try {
              const stat = fs.statSync(task.file);
              if (stat.isFile() && stat.size > 0) task.totalBytes = stat.size;
            } catch (_) { /* keep the transferred size as a fallback */ }
          }
          await this.#cleanupPartials(task, { keepFinal: true });
        } else {
          task.status = 'error';
          task.error = this.#extractError(tail) || `yt-dlp exited with code ${code}`;
          task.finishedAt = Date.now();
          await this.#cleanupPartials(task, { keepFinal: true });
        }
      } catch (err) {
        // Never leave a task in a transient state — the card would hang on
        // "Starting…" forever if this block failed before the emit.
        logger.error('[download] post-processing failed:', err && err.message);
        if (!['completed', 'error', 'canceled'].includes(task.status)) {
          task.status = task.cancelRequested ? 'canceled' : 'error';
          task.error = task.error || (err && err.message) || 'post-processing failed';
          task.finishedAt = Date.now();
        }
      } finally {
        this.#emit(task);
        this.#pump(); // release the slot to the next queued task
      }
    });
  }

  /** Feeds one stdout/stderr line into the state machine. */
  #handleLine(task, line) {
    if (!line) return;
    const text = line.trim();
    if (!text) return;

    // 0) Playlist bookkeeping: which video are we on, and did one fail?
    const item = text.match(RE_PLAYLIST_ITEM);
    if (item) {
      if (task.playlistIndex) {
        // The video that just ended taught us how many 0→100% runs one item
        // needs (2 = video + audio, 1 = single file) — use it for the rest.
        task.itemStreamExpectation = task.itemStreamsDone + 1;
      }
      task.playlistIndex = parseInt(item[1], 10) || 1;
      task.playlistTotal = Math.max(task.playlistTotal || 0, parseInt(item[2], 10) || 0);
      task.itemPercent = 0;
      task.itemStreamsDone = 0;
      logger.info(`[playlist] item ${task.playlistIndex}/${task.playlistTotal} ` +
        `(expect ${task.itemStreamExpectation || 2} streams/video, pct=${task.percent.toFixed(1)})`);
      this.#emit(task);
      return;
    }
    if (RE_ERROR.test(text)) {
      // yt-dlp reports per-video failures here (the run keeps going because
      // of --no-abort-on-error). Counted so the card can summarise them.
      task.failedItems += 1;
      return;
    }

    // 1) Authoritative final path (`--print after_move:FINAL_FILE:…`)
    const finalMatch = text.match(RE_FINAL_FILE);
    if (finalMatch) {
      // Resolve before recording: on Windows yt-dlp's plain (non-JSON) stdout
      // drops non-ASCII, so a title in Arabic/JP/emoji comes back as a path
      // with gaps — pointing at nothing. The id + extension always survive.
      task.file = this.#resolveFileSync(task, finalMatch[1]);
      task.completedFiles += 1;
      if (task.file) task.doneFiles.add(task.file); // finished → never cleaned up
      this.#emit(task);
      return;
    }

    // 2) Progress line: percent, total size, speed, ETA
    const progress = text.match(RE_PROGRESS);
    if (progress) {
      this.#applyProgress(task, {
        percent: parseFloat(progress[1]),
        totalBytes: parseSize(progress[2]),
        speedBps: parseSize(progress[3]),
        eta: progress[4] || null
      });
      return;
    }

    // 3) Final per-stream summary (often the only progress line we get for
    //    very fast downloads): size + speed, but no ETA.
    const summary = text.match(RE_PROGRESS_SUMMARY);
    if (summary) {
      this.#applyProgress(task, {
        percent: parseFloat(summary[1]),
        totalBytes: parseSize(summary[2]),
        speedBps: parseSize(summary[3]),
        eta: null
      });
      return;
    }

    const percentOnly = text.match(RE_PERCENT_ONLY);
    if (percentOnly) {
      // Size/speed unknown here — keep whatever we learned earlier.
      this.#applyProgress(task, { percent: parseFloat(percentOnly[1]) });
      return;
    }

    // 4) Destination lines → tracked for cancellation cleanup
    const dest = text.match(RE_DESTINATION);
    if (dest) {
      const file = dest[1].trim().replace(/^"|"$/g, '');
      if (file && !file.includes('%(')) task.touched.add(file);
      if (/Merger|ExtractAudio|Converting|AudioConvert/.test(text) && task.status === 'downloading') {
        task.status = 'merging';
        this.#emit(task);
      }
      return;
    }

    // 5) Explicit merger line → "merging" badge
    const merger = text.match(RE_MERGER);
    if (merger) {
      task.status = 'merging';
      task.file = merger[1].trim();
      task.touched.add(task.file);
      this.#emit(task);
      return;
    }

    // 6) Fix-up / conversion phases also count as merging
    if (/^\[(?:FixupM3u8|FixupTimestamp|FixupDuration|ExtractAudio|AudioConvert|VideoRemuxer)\]/.test(text)) {
      if (task.status !== 'completed') {
        task.status = 'merging';
        this.#emit(task);
      }
    }
  }

  /**
   * Applies one progress sample to the task and emits the update.
   *
   * • a percentage *drop* means yt-dlp started the next stream (audio after
   *   video) → restart the bar instead of lying about overall progress
   * • 100% means every byte is local; what follows is post-processing
   *   (merge / extract / final move) → surface that as the "Merging" phase
   *
   * @param {object} task
   * @param {{percent:number, totalBytes?:number, speedBps?:number, eta?:string|null}} sample
   */
  #applyProgress(task, { percent, totalBytes = null, speedBps = null, eta = undefined }) {
    if (!Number.isFinite(percent)) return;
    const value = Math.min(100, Math.max(0, percent));

    if (task.isPlaylist) {
      // One card covers the whole playlist, so the bar climbs 0 → 100 across
      // *all* items instead of restarting for every video.
      //
      // Inside one item yt-dlp runs 0→100% again for every stream it fetches
      // (video first, then audio). A drop therefore means "next stream of the
      // same item": count it, and credit the item only for
      //     (streams finished + this stream's fraction) / streams expected.
      // The expectation is learned from the first video, so item 1 is the only
      // one that runs on the usual video+audio assumption. min(1, …) plus the
      // hold-if-lower rule below guarantees the bar never moves backwards.
      //
      // IMPORTANT: compare against `task.itemPercent` *before* updating it —
      // assigning first would compare the value with itself and silently
      // disable this whole restart detection.
      const regressed = value < task.itemPercent - 1;
      task.itemPercent = regressed ? value : Math.max(task.itemPercent, value);
      if (regressed) {
        task.itemStreamsDone += 1;
        logger.info(`[playlist] stream restart in item ${task.playlistIndex} ` +
          `(streams done=${task.itemStreamsDone}, value=${value.toFixed(1)})`);
      }

      const expected = task.playlistTotal === 1
        ? 1
        : (task.itemStreamExpectation || 2);
      const fraction = Math.min(1,
        (task.itemStreamsDone + task.itemPercent / 100) / expected);

      const overall = playlistOverallPercent(
        task.playlistIndex, task.playlistTotal, fraction * 100);

      if (overall < task.percent - 0.001) {
        // Safety net: within one playlist run progress only ever advances, so
        // a lower value means our per-item model mis-read the output (e.g. an
        // item line arriving twice). Hold the bar where it is — a progress bar
        // that jumps backwards reads as "the download restarted" to a user —
        // and record what happened so the model can be corrected.
        logger.warn(`[playlist] computed ${overall.toFixed(1)}% after ` +
          `${task.percent.toFixed(1)}% — holding (index=${task.playlistIndex} ` +
          `done=${task.itemStreamsDone} exp=${expected} itemPct=${task.itemPercent.toFixed(1)})`);
      } else {
        task.percent = overall;
      }
    } else {
      // A drop means yt-dlp started the next stream (audio after video).
      task.percent = value < task.percent - 1 ? value : Math.max(task.percent, value);
      if (totalBytes) task.totalBytes = totalBytes;
      if (task.totalBytes) {
        task.loadedBytes = Math.round(task.totalBytes * (task.percent / 100));
      }
    }

    // Byte counters only describe the item that is running right now.
    if (totalBytes) task.itemTotalBytes = totalBytes;
    if (speedBps) task.speedBps = speedBps;
    if (eta !== undefined) task.eta = eta;

    task.status = task.percent >= 100 ? 'merging' : 'downloading';
    this.#emit(task);
  }

  /** Pulls the most meaningful message out of the stderr tail. */
  #extractError(tail) {
    return extractErrorMessage(tail);
  }

  /**
   * Turns a path *printed by yt-dlp* into a path that actually exists.
   *
   * `--dump-json` escapes non-ASCII (`\uXXXX`), but yt-dlp's plain stdout on
   * Windows drops it: an Arabic/Japanese/emoji title comes back with gaps
   * (`…Basit _   _ 180 [id].mp4`) — a file that is not there. The id and the
   * extension are ASCII and survive, and together they are unique inside the
   * destination folder, so the real file is recovered in two steps:
   *   1. the JSON-derived `<base>` (exact title from our own analysis), then
   *   2. any name ending in ` [id].<ext>` — which also covers playlists,
   *      where no `base` exists (their template uses the playlist index).
   * Newest match wins, so a renamed/re-encoded older copy is never picked.
   *
   * Synchronous on purpose: it runs inside the stdout line handler, where
   * awaiting would let two `FINAL_FILE` lines (playlists) resolve out of order.
   *
   * @param {object} task task snapshot holding `destDir` (+ `base` when any)
   * @param {string} printed path as reported by yt-dlp
   * @returns {string} a path that exists, else the original text unchanged
   */
  #resolveFileSync(task, printed) {
    const candidate = String(printed || '').trim().replace(/^"|"$/g, '');
    if (!candidate) return candidate;
    if (fs.existsSync(candidate)) return candidate;

    let names = [];
    try {
      names = fs.readdirSync(task.destDir);
    } catch (_) {
      return candidate; // folder unreadable → keep what yt-dlp said
    }
    const usable = (n) =>
      !/\.(part|ytdl|temp)$/i.test(n) && !/\.f\d+\.[A-Za-z0-9]+$/i.test(n);

    // 1) exact title from our own analysis (never goes through stdout)
    if (task.base) {
      const byBase = names.find((n) => n.startsWith(`${task.base}.`) && usable(n));
      if (byBase) return path.join(task.destDir, byBase);
    }

    // 2) `… [id].ext` marker (ASCII) — works for playlists too
    const marker = candidate.match(/\[([^\[\]]+)\]\.([A-Za-z0-9]+)$/);
    if (marker) {
      const suffix = ` [${marker[1]}].${marker[2]}`;
      const matches = names
        .filter((n) => n.endsWith(suffix) && usable(n))
        .map((n) => {
          try {
            return { n, m: fs.statSync(path.join(task.destDir, n)).mtimeMs };
          } catch (_) {
            return { n, m: 0 };
          }
        })
        .sort((a, b) => b.m - a.m);
      if (matches.length) return path.join(task.destDir, matches[0].n);
    }

    return candidate;
  }

  /** If yt-dlp never printed FINAL_FILE, look for `<base>.*` in the folder. */
  async #guessFinalFile(task) {
    if (!task.base) return null;
    try {
      const names = await fsp.readdir(task.destDir);
      const match = names.find((n) =>
        n.startsWith(`${task.base}.`) &&
        !/\.(part|ytdl|temp)$/i.test(n) &&
        !/\.f\d+\.[A-Za-z0-9]+$/i.test(n));
      return match ? path.join(task.destDir, match) : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Removes `.part` / `.ytdl` / `.temp` / `*.f137.mp4` leftovers.
   * Completed downloads are only ever touched for their *partial* variants.
   */
  async #cleanupPartials(task, { keepFinal = false } = {}) {
    const isPartial = (name) =>
      /\.(part|ytdl|temp)$/i.test(name) || /\.f\d+\.[A-Za-z0-9]+$/i.test(name);

    const targets = new Set(task.touched);
    if (task.file) targets.add(task.file);

    for (const file of targets) {
      // A playlist keeps the videos that already finished — cancelling means
      // "stop here", not "throw away everything I already got".
      if (task.doneFiles && task.doneFiles.has(file)) continue;
      const name = path.basename(file);
      const candidates = [file, `${file}.part`, `${file}.ytdl`, `${file}.temp`];
      for (const candidate of candidates) {
        // Never delete a finished, fully-named download.
        if (keepFinal && candidate === file && !isPartial(name)) continue;
        await fsp.rm(candidate, { force: true }).catch(() => {});
      }
    }

    // Belt & braces: sweep the destination for fragments of this exact base.
    if (task.base) {
      try {
        const names = await fsp.readdir(task.destDir);
        for (const n of names) {
          if (n.startsWith(`${task.base}.`) && isPartial(n)) {
            await fsp.rm(path.join(task.destDir, n), { force: true }).catch(() => {});
          }
        }
      } catch (_) { /* folder may already be gone */ }
    }
  }

  /** Kills yt-dlp and all of its children (ffmpeg, shaka-packager, …). */
  #killTree(child) {
    if (!child || child.pid == null) return;
    if (process.platform === 'win32') {
      // /T = terminate the whole tree, /F = force.
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
          .on('error', () => { try { child.kill(); } catch (_) { /* gone */ } });
      } catch (_) {
        try { child.kill(); } catch (_) { /* gone */ }
      }
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } // negative pid → process group
      catch (_) {
        try { child.kill('SIGTERM'); } catch (_) { /* gone */ }
      }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* exited */ }
      }, 2500);
    }
  }

  /** Generic argv runner with timeout + captured output (used by analyze). */
  #execCapture(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return reject(err);
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
        reject(new Error('The request timed out. Check your network connection.'));
      }, timeoutMs);

      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
  }

  #emit(task) {
    // Emitted from child-process stream handlers — never let a dead renderer
    // (or a serialization hiccup) propagate as an uncaught exception.
    try {
      this.emit('download:progress', this.#snapshot(task));
    } catch (err) {
      logger.warn('Progress event dropped:', err.message);
    }
  }

  /** Renderer-facing plain object (no child process / Set references). */
  #snapshot(task) {
    return {
      id: task.id,
      url: task.url,
      title: task.title,
      thumbnail: task.thumbnail,
      qualityLabel: task.qualityLabel,
      kind: task.kind,
      isPlaylist: task.isPlaylist,
      playlistIndex: task.playlistIndex || null,
      playlistTotal: task.playlistTotal || null,
      /** Progress of the current item alone (the bar itself is aggregate). */
      itemPercent: task.isPlaylist ? Math.round(task.itemPercent || 0) : null,
      failedItems: task.failedItems || 0,
      status: task.status,
      percent: Math.round(task.percent * 10) / 10,
      loadedBytes: task.loadedBytes,
      totalBytes: task.totalBytes,
      speedBps: task.speedBps,
      eta: task.eta,
      file: task.file,
      error: task.error,
      warning: task.warning,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt
    };
  }
}

module.exports = DownloadManager;
module.exports.buildQualities = buildQualities;
module.exports.parseSize = parseSize;
module.exports.sanitizeFilename = sanitizeFilename;
module.exports.isPlaylistUrl = isPlaylistUrl;
module.exports.extractErrorMessage = extractErrorMessage;
module.exports.playlistOverallPercent = playlistOverallPercent;
module.exports.genericVideoQuality = genericVideoQuality;
module.exports.parseJsonLines = parseJsonLines;
