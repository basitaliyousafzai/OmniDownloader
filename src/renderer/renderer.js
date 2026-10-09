'use strict';
/* ==========================================================================
   OmniDownloader — renderer.js
   Vanilla DOM controller (no framework, no bundler).

   Responsibilities
     • wire the URL bar (paste / analyze) to the preload API
     • render the quality-selection modal from `yt-dlp --dump-json` metadata
     • stream download progress into live task cards
     • manage settings + engine self-update UI
   ========================================================================== */

(() => {
  /* ---------------------------------------------------------------------- */
  /* Bridge + element lookup                                                */
  /* ---------------------------------------------------------------------- */

  /** Safe API exposed by preload.js (contextBridge). */
  const api = window.api;

  /** Tiny query helper. */
  const $ = (selector, root = document) => root.querySelector(selector);

  const el = {
    urlInput: $('#urlInput'),
    pasteBtn: $('#pasteBtn'),
    analyzeBtn: $('#analyzeBtn'),
    analyzeError: $('#analyzeError'),

    taskList: $('#taskList'),
    emptyState: $('#emptyState'),
    activeCount: $('#activeCount'),
    clearFinishedBtn: $('#clearFinishedBtn'),

    enginePill: $('#enginePill'),
    engineDot: $('#engineDot'),
    engineText: $('#engineText'),
    engineUpdateBtn: $('#engineUpdateBtn'),
    versionChip: $('#versionChip'),

    settingsBtn: $('#settingsBtn'),
    qualityOverlay: $('#qualityOverlay'),
    settingsOverlay: $('#settingsOverlay'),

    qualityThumb: $('#qualityThumb'),
    qualityTitle: $('#qualityTitle'),
    qualityMeta: $('#qualityMeta'),
    qualityList: $('#qualityList'),
    qualityNote: $('#qualityNote'),
    playlistPreview: $('#playlistPreview'),
    startDownloadBtn: $('#startDownloadBtn'),

    destPath: $('#destPath'),
    chooseFolderBtn: $('#chooseFolderBtn'),
    concurrency: $('#concurrency'),
    ytDlpVersion: $('#ytDlpVersion'),
    ffmpegVersion: $('#ffmpegVersion'),
    latestVersion: $('#latestVersion'),
    engineProgressWrap: $('#engineProgressWrap'),
    engineProgressBar: $('#engineProgressBar'),
    engineProgressLabel: $('#engineProgressLabel'),
    checkUpdateBtn: $('#checkUpdateBtn'),
    updateNowBtn: $('#updateNowBtn'),
    engineHint: $('#engineHint'),
    appVersionLine: $('#appVersionLine'),

    toastStack: $('#toastStack')
  };

  /* ---------------------------------------------------------------------- */
  /* Application state                                                      */
  /* ---------------------------------------------------------------------- */

  const state = {
    /** media info currently shown in the quality modal */
    media: null,
    /** quality key selected in the modal */
    selectedKey: null,
    /** taskId → { data, ui, payload } */
    tasks: new Map(),
    settings: null,
    engine: null,
    updateAvailable: null,
    busyAnalyzing: false
  };

  /** Status → badge label (task states coming from the main process). */
  const STATUS_LABEL = {
    queued: 'Queued',
    starting: 'Starting',
    downloading: 'Downloading',
    merging: 'Merging',
    completed: 'Completed',
    error: 'Failed',
    canceled: 'Canceled'
  };

  /* ---------------------------------------------------------------------- */
  /* Formatting helpers                                                     */
  /* ---------------------------------------------------------------------- */

  /** Bytes → "12.4 MB" (1024-based, like the tools the engine reports). */
  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return '—';
    const b = Number(bytes);
    if (b < 1024) return `${b} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = b / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
  }

  /** Bytes/s → "3.1 MB/s". */
  function formatSpeed(bps) {
    if (!bps || !Number.isFinite(Number(bps))) return null;
    return `${formatBytes(Number(bps))}/s`;
  }

  /** "01:23" → "ETA 01:23" (raw yt-dlp ETA, kept as-is for precision). */
  function formatEta(eta) {
    if (!eta) return null;
    return `ETA ${eta}`;
  }

  /** Reads `http(s)` thumbnails only, upgrading plain http → https. */
  function safeThumb(url) {
    if (!url || typeof url !== 'string') return '';
    if (url.startsWith('https://')) return url;
    if (url.startsWith('http://')) return url.replace(/^http:\/\//i, 'https://');
    return '';
  }

  /* ---------------------------------------------------------------------- */
  /* Toast notifications                                                    */
  /* ---------------------------------------------------------------------- */

  function toast(message, type = 'info', timeout = 3600) {
    const node = document.createElement('div');
    node.className = `toast${type === 'info' ? '' : ` is-${type}`}`;
    node.textContent = message;
    el.toastStack.appendChild(node);

    setTimeout(() => {
      node.classList.add('is-out');
      node.addEventListener('animationend', () => node.remove(), { once: true });
    }, timeout);
  }

  /* ---------------------------------------------------------------------- */
  /* Modal helpers                                                          */
  /* ---------------------------------------------------------------------- */

  function openOverlay(node) {
    node.classList.remove('hidden');
    const focusable = node.querySelector('input, button, select');
    if (focusable) setTimeout(() => focusable.focus(), 40);
  }

  function closeOverlay(node) {
    if (!node) return;
    node.classList.add('hidden');
  }

  function closeTopOverlay() {
    const open = [...document.querySelectorAll('.overlay:not(.hidden)')];
    if (open.length) closeOverlay(open[open.length - 1]);
  }

  // Backdrop click + [data-close-modal] buttons + Escape all close modals.
  document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close-modal]');
    if (closer) closeOverlay(closer.closest('.overlay'));
    else if (event.target.classList && event.target.classList.contains('overlay')) {
      closeOverlay(event.target);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTopOverlay();
  });

  /* ---------------------------------------------------------------------- */
  /* Engine status pill + settings panel                                     */
  /* ---------------------------------------------------------------------- */

  function renderEngineStatus(status) {
    if (!status) return;

    // First engine probe still running → the state is *unknown*, not missing.
    // (Kept out of `state.engine` so the quality modal never warns about a
    // FFmpeg install that simply has not been looked up yet.)
    if (status.pending) {
      state.engine = { ...status, missing: [] };
      el.enginePill.classList.remove('is-ok', 'is-warn');
      el.enginePill.classList.add('is-busy');
      el.engineText.textContent = 'Starting…';
      el.enginePill.title = 'Looking for yt-dlp and FFmpeg…';
      return;
    }

    state.engine = status;
    el.enginePill.classList.remove('is-ok', 'is-warn', 'is-busy');

    const missing = status.missing || [];
    if (status.updating) {
      el.enginePill.classList.add('is-busy');
      el.engineText.textContent = 'Updating engine…';
    } else if (missing.length) {
      el.enginePill.classList.add('is-warn');
      el.engineText.textContent = `${missing.join(' & ')} missing`;
      el.enginePill.title = 'Install the missing engine, or place it in assets/binaries';
    } else {
      el.enginePill.classList.add('is-ok');
      el.engineText.textContent = status.ytDlp ? `yt-dlp ${status.ytDlp.version}` : 'Engines ready';
      el.enginePill.title = `yt-dlp: ${status.ytDlp ? status.ytDlp.version : '—'}\nFFmpeg: ${status.ffmpeg ? status.ffmpeg.version : '—'}`;
    }

    // Settings panel values.
    if (status.ytDlp) {
      el.ytDlpVersion.textContent = `${status.ytDlp.version} (${status.ytDlp.source})`;
      el.ytDlpVersion.classList.remove('is-missing');
    } else {
      el.ytDlpVersion.textContent = 'Not found';
      el.ytDlpVersion.classList.add('is-missing');
    }

    if (status.ffmpeg) {
      el.ffmpegVersion.textContent = `${status.ffmpeg.version} (${status.ffmpeg.source})`;
      el.ffmpegVersion.classList.remove('is-missing');
    } else {
      el.ffmpegVersion.textContent = 'Not found — needed for MP3 & 4K merging';
      el.ffmpegVersion.classList.add('is-missing');
    }

    el.latestVersion.textContent = status.latest ? status.latest.tag : 'not checked yet';
  }

  function renderEngineUpdateProgress(percent) {
    el.engineProgressWrap.classList.remove('hidden');
    el.engineProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    el.engineProgressLabel.textContent = `${Math.round(percent)}%`;
    if (percent >= 100) {
      setTimeout(() => el.engineProgressWrap.classList.add('hidden'), 1500);
    }
  }

  async function checkEngineUpdate({ silent = false } = {}) {
    try {
      const info = await api.checkEngineUpdate();
      state.updateAvailable = info.updateAvailable;
      el.engineUpdateBtn.classList.toggle('hidden', !info.updateAvailable);
      el.latestVersion.textContent = `${info.tag}${info.updateAvailable ? ' — update available' : ''}`;
      if (info.updateAvailable) {
        el.engineHint.textContent = `yt-dlp ${info.tag} is available (you have ${info.current}).`;
        if (!silent) toast(`Engine update available: yt-dlp ${info.tag}`, 'info', 5000);
      } else if (!silent) {
        toast('yt-dlp is up to date.', 'success');
      }
      return info;
    } catch (err) {
      if (!silent) toast(`Update check failed: ${err.message}`, 'error');
      return null;
    }
  }

  async function runEngineUpdate() {
    el.updateNowBtn.disabled = true;
    el.checkUpdateBtn.disabled = true;
    el.engineUpdateBtn.disabled = true;
    el.engineUpdateBtn.textContent = 'Updating…';
    try {
      const result = await api.updateEngine();
      renderEngineStatus(result.status);
      el.engineHint.textContent = `Updated to yt-dlp ${result.tag}.`;
      toast(`yt-dlp updated to ${result.tag}`, 'success');
      state.updateAvailable = false;
      el.engineUpdateBtn.classList.add('hidden');
      // Refresh engine-dependent UI (e.g. MP3 availability).
      renderEngineStatus(await api.getEngineStatus());
    } catch (err) {
      toast(`Update failed: ${err.message}`, 'error');
    } finally {
      el.updateNowBtn.disabled = false;
      el.checkUpdateBtn.disabled = false;
      el.engineUpdateBtn.disabled = false;
      el.engineUpdateBtn.textContent = 'Update engine';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Settings modal                                                         */
  /* ---------------------------------------------------------------------- */

  function openSettings() {
    const settings = state.settings || {};
    el.destPath.value = settings.destination || '';
    if (settings.concurrency) el.concurrency.value = String(settings.concurrency);
    el.engineHint.textContent = 'Updates are fetched from the official GitHub Releases.';
    el.engineProgressWrap.classList.add('hidden');
    openOverlay(el.settingsOverlay);
  }

  async function refreshSettings() {
    try {
      state.settings = await api.getSettings();
      el.destPath.value = state.settings.destination || '';
      el.concurrency.value = String(state.settings.concurrency || 2);
    } catch (err) {
      toast(`Could not load settings: ${err.message}`, 'error');
    }
  }

  el.chooseFolderBtn.addEventListener('click', async () => {
    try {
      const dir = await api.selectDirectory(); // dialog.showOpenDialog in main
      if (dir) {
        el.destPath.value = dir;
        await api.setSetting('destination', dir);
        state.settings = await api.getSettings();
        toast('Download folder updated.', 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  el.concurrency.addEventListener('change', async () => {
    try {
      state.settings = await api.setSetting('concurrency', Number(el.concurrency.value));
      toast('Parallel downloads updated.', 'success');
    } catch (err) {
      toast(err.message, 'error');
      el.concurrency.value = String(state.settings.concurrency || 2);
    }
  });

  el.settingsBtn.addEventListener('click', openSettings);
  el.checkUpdateBtn.addEventListener('click', () => checkEngineUpdate());
  el.updateNowBtn.addEventListener('click', runEngineUpdate);
  el.engineUpdateBtn.addEventListener('click', () => {
    openSettings();
    runEngineUpdate();
  });

  /* ---------------------------------------------------------------------- */
  /* URL analysis → quality modal                                           */
  /* ---------------------------------------------------------------------- */

  function setAnalyzeBusy(busy) {
    state.busyAnalyzing = busy;
    el.analyzeBtn.disabled = busy;
    el.analyzeBtn.querySelector('.spinner').classList.toggle('hidden', !busy);
    el.analyzeBtn.querySelector('.btn-label').textContent = busy ? 'Analyzing…' : 'Analyze';
  }

  function showAnalyzeError(message) {
    el.analyzeError.textContent = message || '';
    el.analyzeError.classList.toggle('hidden', !message);
  }

  /** Basic pre-check so obvious mistakes fail instantly. */
  function looksLikeUrl(value) {
    try {
      const u = new URL(value.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  async function analyze() {
    const url = el.urlInput.value.trim();
    showAnalyzeError('');

    if (!url) { showAnalyzeError('Paste a link first.'); el.urlInput.focus(); return; }
    if (!looksLikeUrl(url)) { showAnalyzeError('That does not look like a valid http(s) URL.'); return; }

    setAnalyzeBusy(true);
    try {
      const media = await api.analyze(url);
      state.media = media;
      openQualityModal(media);
    } catch (err) {
      showAnalyzeError(err.message || 'Analysis failed.');
    } finally {
      setAnalyzeBusy(false);
    }
  }

  el.analyzeBtn.addEventListener('click', analyze);
  el.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !state.busyAnalyzing) analyze();
  });
  el.urlInput.addEventListener('input', () => showAnalyzeError(''));

  el.pasteBtn.addEventListener('click', async () => {
    try {
      const text = await api.readClipboard();
      if (text && text.trim()) {
        el.urlInput.value = text.trim();
        showAnalyzeError('');
        el.urlInput.focus();
      } else {
        toast('Clipboard is empty.', 'info');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Quality modal                                                          */
  /* ---------------------------------------------------------------------- */

  function openQualityModal(media) {
    el.qualityThumb.src = safeThumb(media.thumbnail) || '';
    el.qualityThumb.style.display = media.thumbnail ? '' : 'none';
    el.qualityTitle.textContent = media.title || 'Untitled';

    const metaParts = [];
    if (media.uploader) metaParts.push(media.uploader);
    if (media.durationText) metaParts.push(media.durationText);
    if (media.extractor) metaParts.push(media.extractor);
    if (media.isPlaylist) metaParts.unshift(`${media.entryCount} items`);
    el.qualityMeta.textContent = metaParts.join('  •  ') || 'Media';

    renderPlaylistPreview(media);
    renderQualityList(media);

    // FFmpeg warning (MP3 / merged 4K need it).
    const missing = (state.engine && state.engine.missing) || [];
    if (missing.includes('ffmpeg')) {
      el.qualityNote.textContent =
        'FFmpeg was not found — MP3 extraction and high-quality merging are unavailable. ' +
        'Install FFmpeg or put it in assets/binaries to enable them.';
      el.qualityNote.classList.remove('hidden');
    } else {
      el.qualityNote.classList.add('hidden');
    }

    openOverlay(el.qualityOverlay);
  }

  /**
   * Shows what a playlist link will actually download — the promise the user
   * is agreeing to when they press "Download".
   *
   * @param {object} media result of `api.analyze`
   */
  function renderPlaylistPreview(media) {
    const box = el.playlistPreview;
    if (!box) return;
    box.textContent = '';
    const items = media.isPlaylist ? (media.entries || []) : [];

    if (!items.length || media.entryCount < 2) {
      box.classList.add('hidden');
      return;
    }

    const head = document.createElement('div');
    head.className = 'playlist-preview-head';
    head.textContent = `${media.entryCount} videos will be downloaded`;
    box.appendChild(head);

    const list = document.createElement('ul');
    items.forEach((entry, i) => {
      const row = document.createElement('li');
      row.className = 'playlist-preview-item';

      const index = document.createElement('span');
      index.className = 'pl-idx';
      index.textContent = String(i + 1).padStart(2, '0');

      const title = document.createElement('span');
      title.className = 'pl-title';
      title.textContent = entry.title || entry.id || 'Untitled';
      title.title = title.textContent;

      const duration = document.createElement('span');
      duration.className = 'pl-dur';
      duration.textContent = entry.durationText || '';

      row.append(index, title, duration);
      list.appendChild(row);
    });
    box.appendChild(list);

    if (media.entryCount > items.length) {
      const more = document.createElement('p');
      more.className = 'playlist-preview-more';
      more.textContent = `…and ${media.entryCount - items.length} more`;
      box.appendChild(more);
    }

    box.classList.remove('hidden');
  }

  function renderQualityList(media) {
    el.qualityList.textContent = '';
    const qualities = media.qualities || [];
    if (!qualities.length) {
      const note = document.createElement('p');
      note.className = 'quality-note';
      note.textContent = 'No selectable qualities were reported for this link.';
      el.qualityList.appendChild(note);
      el.startDownloadBtn.disabled = true;
      return;
    }
    el.startDownloadBtn.disabled = false;

    // Default: 1080p when offered, otherwise the best available video.
    const defaultKey = qualities.find((q) => q.kind === 'video' && q.height === 1080)?.key
      || qualities.find((q) => q.kind === 'video')?.key
      || qualities[qualities.length - 1].key;
    state.selectedKey = defaultKey;

    qualities.forEach((quality) => {
      const item = document.createElement('label');
      item.className = 'quality-item';
      item.dataset.key = quality.key;
      if (quality.kind === 'audio') item.classList.add('is-audio');
      item.setAttribute('role', 'radio');

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'quality';
      input.value = quality.key;
      input.checked = quality.key === state.selectedKey;

      const label = document.createElement('span');
      label.className = 'q-label';
      label.textContent = quality.label;

      const note = document.createElement('span');
      note.className = 'q-note';
      note.textContent = quality.note || '';

      const size = document.createElement('span');
      size.className = 'q-size';
      size.textContent = quality.approxBytes
        ? `≈ ${formatBytes(quality.approxBytes)}` +
          (media.isPlaylist && media.entryCount > 1 ? ' total' : '')
        : 'Size unknown';

      const check = document.createElement('span');
      check.className = 'q-check';

      item.append(input, label, note, size, check);
      item.classList.toggle('is-selected', quality.key === state.selectedKey);
      item.addEventListener('click', () => selectQuality(quality.key));
      el.qualityList.appendChild(item);
    });
  }

  function selectQuality(key) {
    state.selectedKey = key;
    [...el.qualityList.querySelectorAll('.quality-item')].forEach((node) => {
      const selected = node.dataset.key === key;
      node.classList.toggle('is-selected', selected);
      const input = node.querySelector('input');
      if (input) input.checked = selected;
    });
  }

  el.startDownloadBtn.addEventListener('click', async () => {
    const media = state.media;
    const quality = media && (media.qualities || []).find((q) => q.key === state.selectedKey);
    if (!media || !quality) return;

    const button = el.startDownloadBtn;
    button.disabled = true;
    button.querySelector('.spinner').classList.remove('hidden');
    button.querySelector('.btn-label').textContent = 'Starting…';

    try {
      const payload = {
        url: media.url,
        id: media.isPlaylist ? 'playlist' : (media.entries[0] ? media.entries[0].id : ''),
        title: media.title,
        thumbnail: media.thumbnail,
        isPlaylist: media.isPlaylist,
        quality
      };
      const task = await api.startDownload(payload);
      registerTask(task, payload);
      closeOverlay(el.qualityOverlay);
      toast(media.isPlaylist && media.entryCount > 1
        ? `Playlist queued — ${media.entryCount} videos at ${quality.label}.`
        : `${quality.label} added to the queue.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
      button.querySelector('.spinner').classList.add('hidden');
      button.querySelector('.btn-label').textContent = 'Download';
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Task cards                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * "Item 3 of 12" — the unit a playlist download is actually measured in.
   *
   * @param {{isPlaylist:boolean, playlistIndex:number|null, playlistTotal:number|null}} data
   * @returns {string|null} null when the task is not a (counted) playlist
   */
  function playlistPosition(data) {
    if (!data || !data.isPlaylist || !data.playlistTotal) return null;
    const current = Math.min(Math.max(data.playlistIndex || 1, 1), data.playlistTotal);
    return `Item ${current} of ${data.playlistTotal}`;
  }

  /** Builds a task card's static skeleton (user data is set via textContent). */
  function buildCard(task) {
    const card = document.createElement('article');
    card.className = 'task';
    card.dataset.id = task.id;

    card.innerHTML = `
      <div class="task-thumb">
        <img alt="" />
        <span class="thumb-play" aria-hidden="true">▶</span>
        <span class="kind-chip"></span>
      </div>
      <div class="task-body">
        <div class="task-top">
          <h3 class="task-title"></h3>
          <span class="badge" data-status="queued">Queued</span>
        </div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100">
          <div class="bar"></div>
        </div>
        <div class="task-stats">
          <span class="stat stat-pct"><b>0%</b></span>
          <span class="stat stat-speed is-muted">—</span>
          <span class="stat stat-eta is-muted">—</span>
          <span class="stat stat-size is-muted">—</span>
        </div>
        <p class="task-msg hidden"></p>
      </div>
      <div class="task-actions"></div>`;

    const thumb = card.querySelector('.task-thumb');
    const img = thumb.querySelector('img');
    const thumbUrl = safeThumb(task.thumbnail);
    if (thumbUrl) {
      img.src = thumbUrl;
      img.referrerPolicy = 'no-referrer';
    } else {
      img.remove();
    }
    thumb.classList.toggle('is-audio', task.kind === 'audio');
    thumb.querySelector('.kind-chip').textContent = task.isPlaylist
      ? 'PLAYLIST'
      : (task.kind === 'audio' ? 'MP3' : (task.qualityLabel || 'VIDEO'));

    card.querySelector('.task-title').textContent = task.title || 'Untitled';
    card.querySelector('.task-title').title = task.title || '';

    el.taskList.appendChild(card);
    return card;
  }

  /** Renders/refreshes one card from a task snapshot. */
  function renderTask(entry) {
    const { data, ui } = entry;
    const status = data.status;

    ui.card.classList.toggle('is-done', status === 'completed');
    ui.card.classList.toggle('is-error', status === 'error');

    ui.badge.dataset.status = status;
    ui.badge.textContent = STATUS_LABEL[status] || status;

    // ---- Progress bar ------------------------------------------------------
    const bar = ui.card.querySelector('.bar');
    const progress = ui.card.querySelector('.progress');
    bar.classList.remove('is-indeterminate', 'is-done', 'is-error');

    let percent = Number(data.percent) || 0;
    if (status === 'merging') {
      bar.classList.add('is-indeterminate');
      bar.style.width = '100%';
      progress.setAttribute('aria-valuenow', '100');
    } else if (status === 'completed') {
      bar.classList.add('is-done');
      bar.style.width = '100%';
      progress.setAttribute('aria-valuenow', '100');
    } else if (status === 'error') {
      bar.classList.add('is-error');
      progress.setAttribute('aria-valuenow', String(Math.round(percent)));
    } else if (status === 'canceled') {
      bar.style.width = `${percent}%`;
      progress.setAttribute('aria-valuenow', String(Math.round(percent)));
    } else {
      bar.style.width = `${percent}%`;
      progress.setAttribute('aria-valuenow', String(Math.round(percent)));
    }

    // ---- Stats -------------------------------------------------------------
    // The bar is indeterminate while merging (bytes are all local) and while
    // starting (nothing arrived yet) — a raw counter would just repeat the bar
    // or show a misleading 0%.
    ui.pct.textContent = status === 'merging' ? '100%'
      : status === 'starting' ? '—'
        : `${Math.round(percent)}%`;

    const speed = formatSpeed(data.speedBps);
    const eta = formatEta(data.eta);
    // A playlist is one task with N videos — bytes belong to the item that
    // is running right now, so the size slot shows the position instead.
    const position = playlistPosition(data);

    if (status === 'queued') {
      setStat(ui.speed, 'Waiting for a free slot…');
      setStat(ui.eta, null);
      setStat(ui.size, null);
    } else if (status === 'starting') {
      setStat(ui.speed, 'Starting…');
      setStat(ui.eta, null);
      setStat(ui.size, position || (data.totalBytes ? formatBytes(data.totalBytes) : null));
    } else if (status === 'merging') {
      setStat(ui.speed, 'Merging streams…');
      setStat(ui.eta, null);
      setStat(ui.size, position || (data.totalBytes ? formatBytes(data.totalBytes) : null));
    } else if (status === 'downloading') {
      setStat(ui.speed, speed || '—');
      setStat(ui.eta, eta || 'ETA —');
      setStat(ui.size, position || (data.totalBytes
        ? `${formatBytes(data.loadedBytes)} / ${formatBytes(data.totalBytes)}`
        : formatBytes(data.loadedBytes)));
    } else if (status === 'completed') {
      setStat(ui.speed, 'Saved');
      setStat(ui.eta, null);
      setStat(ui.size, position
        ? `${data.playlistTotal} videos`
        : (data.totalBytes ? formatBytes(data.totalBytes) : null));
    } else {
      // error / canceled
      setStat(ui.speed, status === 'canceled' ? 'Stopped' : 'Failed');
      setStat(ui.eta, null);
      setStat(ui.size, position);
    }

    // ---- Message line (errors + engine warnings) ---------------------------
    if (data.error) {
      ui.msg.textContent = data.error;
      ui.msg.classList.remove('hidden', 'is-warning');
    } else if (data.warning) {
      ui.msg.textContent = data.warning;
      ui.msg.classList.remove('hidden');
      ui.msg.classList.add('is-warning');
    } else {
      ui.msg.classList.add('hidden');
    }

    renderActions(entry);
  }

  /** Shows/hides the number and its muted styling. */
  function setStat(node, text) {
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.classList.remove('is-muted');
    } else {
      node.textContent = '—';
      node.classList.add('is-muted');
    }
  }

  /** Action buttons depend on the task status. */
  function renderActions(entry) {
    const { data, ui } = entry;
    const active = ['queued', 'starting', 'downloading', 'merging'].includes(data.status);
    const wanted = active
      ? [['cancel', 'Cancel', 'btn btn-ghost btn-sm btn-danger']]
      : data.status === 'completed'
        ? [['folder', 'Open in Folder', 'btn btn-ghost btn-sm']]
        : data.status === 'error' && entry.payload
          ? [['retry', 'Try again', 'btn btn-primary btn-sm'],
             ['cancel', 'Remove', 'btn btn-ghost btn-sm btn-danger']]
          : [['remove', 'Remove', 'btn btn-ghost btn-sm']];

    const signature = wanted.map((w) => w[0]).join('|');
    if (ui.actionsSignature === signature) return;
    ui.actionsSignature = signature;

    ui.actions.textContent = '';
    wanted.forEach(([action, label, className]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.dataset.action = action;
      button.dataset.id = data.id;
      button.textContent = label;
      ui.actions.appendChild(button);
    });
  }

  /** Adds a card for a task we have not seen yet (or restore on start-up). */
  function registerTask(task, payload = null) {
    let entry = state.tasks.get(task.id);
    if (!entry) {
      const card = buildCard(task);
      entry = {
        data: task,
        payload,
        ui: {
          card,
          badge: card.querySelector('.badge'),
          pct: card.querySelector('.stat-pct b'),
          speed: card.querySelector('.stat-speed'),
          eta: card.querySelector('.stat-eta'),
          size: card.querySelector('.stat-size'),
          msg: card.querySelector('.task-msg'),
          actions: card.querySelector('.task-actions'),
          actionsSignature: null
        }
      };
      state.tasks.set(task.id, entry);
    } else {
      entry.data = task;
      if (payload && !entry.payload) entry.payload = payload;
    }
    renderTask(entry);
    refreshChrome();
    return entry;
  }

  /* ---- Coalesced progress updates (one DOM flush per animation frame) ---- */
  const pending = new Set();
  let flushScheduled = false;

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(() => {
      flushScheduled = false;
      for (const id of pending) {
        const entry = state.tasks.get(id);
        if (entry) renderTask(entry);
      }
      pending.clear();
      refreshChrome();
    });
  }

  function refreshChrome() {
    el.emptyState.classList.toggle('hidden', state.tasks.size > 0);

    let active = 0;
    for (const entry of state.tasks.values()) {
      if (['queued', 'starting', 'downloading', 'merging'].includes(entry.data.status)) active++;
    }
    el.activeCount.textContent = `${active} active`;
    el.clearFinishedBtn.disabled = ![...state.tasks.values()]
      .some((t) => ['completed', 'error', 'canceled'].includes(t.data.status));
  }

  /* ------------------------- Task action routing ------------------------- */
  el.taskList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    const entry = state.tasks.get(id);
    if (!entry) return;

    try {
      if (action === 'cancel') {
        button.disabled = true;
        button.textContent = 'Canceling…';
        await api.cancelDownload(id); // kills the process tree + purges .part files
      } else if (action === 'folder') {
        if (entry.data.file) await api.openFolder(entry.data.file); // shell.showItemInFolder
        else toast('File path is not known yet.', 'info');
      } else if (action === 'retry' && entry.payload) {
        const task = await api.startDownload(entry.payload);
        removeCard(id);
        registerTask(task, entry.payload);
      } else if (action === 'remove') {
        removeCard(id);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /** Double-clicking a finished card opens the file in the default player. */
  el.taskList.addEventListener('dblclick', async (event) => {
    const card = event.target.closest('.task');
    if (!card) return;
    const entry = state.tasks.get(card.dataset.id);
    if (entry && entry.data.status === 'completed' && entry.data.file) {
      try { await api.openFile(entry.data.file); } catch (err) { toast(err.message, 'error'); }
    }
  });

  function removeCard(id) {
    const entry = state.tasks.get(id);
    if (entry) entry.ui.card.remove();
    state.tasks.delete(id);
    refreshChrome();
  }

  el.clearFinishedBtn.addEventListener('click', async () => {
    try {
      const remaining = await api.clearFinished();
      const ids = new Set(remaining.map((t) => t.id));
      for (const [id, entry] of [...state.tasks.entries()]) {
        if (!ids.has(id)) { entry.ui.card.remove(); state.tasks.delete(id); }
      }
      refreshChrome();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* ---------------------------------------------------------------------- */
  /* IPC listeners (main → renderer)                                        */
  /* ---------------------------------------------------------------------- */

  /** Messages already reported (so a repeating error cannot spam the log). */
  const reportedErrors = new Set();

  /**
   * Records an unexpected renderer error instead of letting it escape into
   * the IPC emitter, where it would break every other listener.
   *
   * @param {string} where short context label
   * @param {any} err
   */
  function reportRendererError(where, err) {
    const message = (err && (err.stack || err.message)) || String(err);
    try { console.error(`[omni] ${where}:`, err); } catch (_) { /* no console */ }
    if (reportedErrors.size > 100 || reportedErrors.has(message)) return;
    reportedErrors.add(message);
    try { api.log(`${where}: ${message}`); } catch (_) { /* bridge unavailable */ }
  }

  /** Wraps a main → renderer listener so it can never poison the next one. */
  function safeListener(name, handler) {
    return (payload) => {
      try { handler(payload); } catch (err) { reportRendererError(name, err); }
    };
  }

  api.onDownloadProgress(safeListener('download:progress', (task) => {
    if (!task || !task.id) return;
    if (!state.tasks.has(task.id)) registerTask(task);
    else state.tasks.get(task.id).data = task;
    pending.add(task.id);
    scheduleFlush();
  }));

  api.onEngineStatus(safeListener('engine:status', (status) => {
    renderEngineStatus(status);
    // Availability of MP3 / merged qualities may have changed.
    if (state.media && !el.qualityOverlay.classList.contains('hidden')) {
      openQualityModal(state.media);
    }
  }));

  api.onEngineUpdateProgress(safeListener('engine:updateProgress',
    (percent) => renderEngineUpdateProgress(percent)));

  // Started as `OmniDownloader <url>` (also used when a second copy forwards
  // a link): fill the bar and start the analysis right away.
  api.onOpenUrl(safeListener('app:openUrl', (url) => {
    if (typeof url !== 'string' || !url.trim()) return;
    el.urlInput.value = url.trim();
    showAnalyzeError('');
    if (!state.busyAnalyzing) analyze();
  }));

  // Last line of defence: nothing in the page may end the window silently.
  window.addEventListener('error', (event) => {
    reportRendererError('window error', event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportRendererError('unhandled rejection', event.reason);
  });

  /* ---------------------------------------------------------------------- */
  /* Boot                                                                    */
  /* ---------------------------------------------------------------------- */

  async function boot() {
    try {
      const version = await api.getAppVersion();
      el.versionChip.textContent = `v${version}`;
      el.appVersionLine.textContent = `OmniDownloader v${version} • Electron ${navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] || ''}`.trim();
    } catch (_) { /* version display is cosmetic */ }

    await refreshSettings();

    // Restore any task snapshots (there are none on a fresh start, but this
    // keeps the UI consistent if the window is reloaded).
    try {
      const tasks = await api.listDownloads();
      tasks.forEach((task) => registerTask(task));
    } catch (_) { /* ignore */ }

    try {
      renderEngineStatus(await api.getEngineStatus());
    } catch (_) { /* engine panel retries below */ }

    // Non-blocking update check (shows the top-bar "Update engine" button).
    checkEngineUpdate({ silent: true });
  }

  boot();
})();
