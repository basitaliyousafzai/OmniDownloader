# Software Requirements Specification (SRS)
## Project Name: OmniDownloader Desktop (Vanilla JS Edition)
**Version:** 1.0.0  
**License:** Free & Open Source (Zero API Subscriptions)  
**Target Environment:** Cross-Platform Desktop (Windows, macOS, Linux)  
**Core Technologies:** Electron.js, Node.js, Vanilla HTML5, Vanilla CSS3, Vanilla JavaScript (ES6+), yt-dlp, FFmpeg

---

## 1. System Overview & Philosophy
OmniDownloader is a lightweight, cross-platform desktop application designed to download videos, audio tracks, and playlists from any platform (YouTube, Facebook, Instagram, Twitter/X, TikTok, Reddit, Vimeo, LinkedIn, etc.) without watermarks, zero subscription fees, and no third-party API dependencies.

Unlike bloated modern setups, this architecture uses **pure Vanilla HTML, CSS, and JavaScript** for the renderer process. It contains zero frontend build tooling (no React, no bundlers, no transpilers). The backend utilizes Electron's Node.js engine with `yt-dlp` and `ffmpeg` native binaries to ensure performance, fast startup, small memory footprint, and lifetime maintainability through binary self-updating.

---

## 2. System Architecture

```
+--------------------------------------------------------------------------+
|                  OmniDownloader Electron Desktop App                     |
|                                                                          |
|  +--------------------------------------------------------------------+  |
|  | Renderer Process (Vanilla Web Standards)                           |  |
|  | - index.html (Semantic UI layout, pure CSS design, SVG icons)      |  |
|  | - renderer.js (DOM manipulation, event listeners, IPC rendering)   |  |
|  | - style.css (Dark theme, responsive flexbox/grid, animations)       |  |
|  +---------------------------------+----------------------------------+  |
|                                    | IPC Secure Bridge (preload.js)      |
|  +---------------------------------v----------------------------------+  |
|  | Electron Main Process (Node.js)                                    |  |
|  | - main.js (Window lifecycle, IPC handlers, app directory manager)  |  |
|  | - downloadManager.js (Child-process executor, live progress regex) |  |
|  | - binaryManager.js (Auto-updater for yt-dlp via GitHub API)        |  |
|  +---------------------------------+----------------------------------+  |
|                                    | Child Process (spawn)               |
|  +---------------------------------v----------------------------------+  |
|  | Local Executables (Embedded in User Data / Assets)                  |  |
|  | - yt-dlp binary (Streams extraction, platform decoders)            |  |
|  | - FFmpeg binary (Audio/video merging without quality loss)         |  |
+--+--------------------------------------------------------------------+--+
```

---

## 3. Modular Breakdown

### Module 1: Renderer Process (Pure Vanilla Frontend)
* **Sub-module 1.1: UI Layout (`index.html`)**
  * Clean, dark-mode single-page layout.
  * URL input field with paste button and auto-detect indicators.
  * Quality selection modal overlay.
  * Dynamic list container for real-time download task cards.
  * Minimalist settings modal for download path and concurrency limits.
* **Sub-module 1.2: Style Engine (`style.css`)**
  * Modern CSS custom variables (CSS variables for dark theme tokens).
  * Flexbox and Grid layouts; zero external CSS frameworks.
  * Smooth animations for progress bars and modals.
* **Sub-module 1.3: DOM & State Controller (`renderer.js`)**
  * Listens to user inputs, URL validation, and button clicks.
  * Dynamically builds DOM nodes for download progress without virtual DOM overhead.
  * Subscribes to IPC progress streams via `window.api`.

### Module 2: IPC Security Bridge (`preload.js`)
* Uses `contextBridge.exposeInMainWorld` to expose secure, typed methods:
  * `window.api.getMediaInfo(url)`: Fetches video titles, thumbnails, and available formats.
  * `window.api.startDownload(payload)`: Dispatches download task.
  * `window.api.cancelDownload(taskId)`: Aborts running tasks and cleans temp files.
  * `window.api.onDownloadProgress(callback)`: Streams real-time progress events to the DOM.
  * `window.api.openFolder(path)`: Shows downloaded files in native file manager (Explorer/Finder).
  * `window.api.selectDirectory()`: Opens native folder selection dialog.
  * `window.api.updateEngine()`: Triggers background self-update of `yt-dlp`.

### Module 3: Core Download & Execution Engine (Node.js Main Process)
* **Sub-module 3.1: Binary Manager (`binaryManager.js`)**
  * Resolves OS-specific binary locations (`win32`, `darwin`, `linux`).
  * On app launch or manual trigger, checks GitHub API (`https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest`) to pull the newest `yt-dlp` executable into `app.getPath('userData')`.
* **Sub-module 3.2: Download Orchestrator (`downloadManager.js`)**
  * Spawns `yt-dlp` with `--dump-json` to parse stream options safely.
  * Spawns download process with arguments:
    `-f <selected_format>+bestaudio/best --merge-output-format mp4 --newline --ffmpeg-location <path>`
  * Regex parser for streaming stdout:
    `/\[download\]\s+([\d\.]+)%\s+of\s+([~\d\.]+\w+)\s+at\s+([\d\.]+\w+\/s)\s+ETA\s+([\d:]+)/`
  * Relays status events: `starting` -> `downloading` -> `merging` -> `completed` -> `error`.
* **Sub-module 3.3: Storage & Cleanup Manager**
  * Strips illegal filesystem characters (`\ / : * ? " < > |`).
  * Handles process cancellation via `SIGTERM` and purges `.part` and `.ytdl` cache files.

---

## 4. Functional Requirements (FR)

| ID | Requirement | Priority |
| :--- | :--- | :--- |
| **FR-01** | Inspect URLs and extract metadata (title, author, duration, thumbnail, resolutions) via JSON without downloading the file. | Critical |
| **FR-02** | Support single videos, audio tracks, YouTube Shorts, Instagram Reels, TikToks, and Facebook videos. | Critical |
| **FR-03** | Provide choice of video resolutions (4K, 1440p, 1080p, 720p, 480p) and audio-only extraction (MP3/M4A). | High |
| **FR-04** | Losslessly multiplex video and audio tracks into a single container using local `ffmpeg`. | High |
| **FR-05** | Stream live progress metrics to the UI: percentage, file size, download speed, and ETA. | High |
| **FR-06** | Self-update `yt-dlp` binary independently from Electron app updates to ensure platform changes never break extractors. | Critical |
| **FR-07** | Cancel button that terminates background child processes and removes temporary chunk files immediately. | High |
| **FR-08** | "Show in Folder" button that highlights the completed download in Windows Explorer, macOS Finder, or Linux file manager. | Medium |

---

## 5. Non-Functional Requirements (NFR)

* **Zero Framework Bloat:** 100% pure vanilla HTML/CSS/JS renderer. No build step, no Webpack/Vite, no React. Starts in milliseconds.
* **Cost:** 100% free of charge; zero recurring API costs.
* **Security:** `contextIsolation: true`, `nodeIntegration: false`, parameterized CLI arguments to prevent shell injection.
* **Cross-Platform:** Works seamlessly on Windows 10/11, macOS (Intel & Apple Silicon), and standard Linux distributions.

---

## 6. Project Directory Structure

```text
omni-downloader/
|-- assets/
|   |-- binaries/
|   |   |-- win32/ (yt-dlp.exe, ffmpeg.exe)
|   |   |-- darwin/ (yt-dlp, ffmpeg)
|   |   +-- linux/ (yt-dlp, ffmpeg)
|   +-- icons/
|       +-- icon.png
|-- src/
|   |-- main/
|   |   |-- main.js                 # Electron main lifecycle & window creation
|   |   |-- binaryManager.js        # Locates and auto-updates yt-dlp binary
|   |   |-- downloadManager.js      # Child process spawner, queue & stream parser
|   |   +-- ipcHandlers.js          # IPC registration
|   |-- preload/
|   |   +-- preload.js              # ContextBridge safe API
|   +-- renderer/
|       |-- index.html              # Pure HTML structure
|       |-- style.css               # Pure CSS dark-mode styling
|       +-- renderer.js             # Pure JavaScript UI logic & DOM manipulation
|-- package.json
+-- README.md
```