# Bundled engine binaries (optional)

OmniDownloader locates its two engines in this order:

1. `<userData>/binaries/` — managed by the app (yt-dlp is auto-downloaded
   and auto-updated there from the official GitHub Releases API)
2. `assets/binaries/<platform>/` — **this folder** (optional, for offline /
   portable installs)
3. `$PATH` — a system-wide `yt-dlp` / `ffmpeg` install

## Files

| Platform   | Folder      | yt-dlp binary      | FFmpeg binary |
| ---------- | ----------- | ------------------ | ------------- |
| Windows    | `win32/`    | `yt-dlp.exe`       | `ffmpeg.exe`  |
| macOS      | `darwin/`   | `yt-dlp`           | `ffmpeg`      |
| Linux      | `linux/`    | `yt-dlp`           | `ffmpeg`      |

FFmpeg is **never** downloaded automatically (it is a large binary with
GPL/LGPL build choices). Either install it system-wide
(`winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`)
or drop the executable here — the Settings → Download engine panel tells you
whether it was found.

**Do not commit real binaries to source control.** Only this README lives in
the repository; the executables are downloaded or copied in at install time.
