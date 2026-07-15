# yt-web-downloader

A self-hosted web UI for [yt-dlp](https://github.com/yt-dlp/yt-dlp), inspired by
[yt-dlp-web-ui](https://github.com/marcopiovanello/yt-dlp-web-ui) but rewritten from scratch as a
Vue 3 + Vite frontend with a Node.js (Express + TypeScript) backend, plus built-in
[CookieCloud](https://github.com/easychen/CookieCloud) cookie syncing.

## Features

- Queue downloads by URL with quality presets (best, 2160p, 1080p, 720p, audio-only MP3)
- Live progress (speed, ETA, size) streamed over WebSocket
- Playlist support, cancel/remove, persistent download history
- Archive page to browse, download and delete completed files
- Extra yt-dlp arguments configurable from the UI
- CookieCloud integration: pulls your encrypted browser cookies from a CookieCloud server,
  decrypts them locally and writes a Netscape `cookies.txt` that is passed to every yt-dlp run
  (manual "Sync now" plus optional interval auto-sync)

## Requirements

- Node.js >= 20
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on the PATH (or set its path in Settings)
- ffmpeg (recommended, needed for merging/transcoding)

## Quick start (Docker)

```bash
docker run -d \
  --name yt-web-downloader \
  -p 3033:3033 \
  -v /docker/yt-web-downloader-data:/app/data \
  liveinaus/yt-web-downloader:latest
```

Or with compose (see [docker-compose.yml](docker-compose.yml)):

```bash
docker compose up -d
```

The image bundles the latest yt-dlp and ffmpeg and runs as the non-root `node` user. Config,
cookies, history and downloaded files all live under the mounted `/app/data` volume. Images are
published to Docker Hub (`liveinaus/yt-web-downloader`) and GHCR
(`ghcr.io/liveinaus/yt-web-downloader`) for amd64 and arm64.

## Development

```bash
./dev.sh
```

Starts the backend on port 3033 and the Vite dev server on http://localhost:54444 (proxying
`/api` and `/ws` to the backend), kills anything already bound to those ports, and stops both on
Ctrl+C. Ports/hosts can be overridden via `BACKEND_PORT`, `FRONTEND_PORT`, `BACKEND_HOST` and
`FRONTEND_HOST` env vars. Or run the pieces manually:

```bash
npm install
npm run dev
```

## Production (bare metal)

```bash
npm install
npm run build
npm start
```

The server listens on http://localhost:3033 and serves the built client. Configuration, cookies,
history and downloads live in `./data` by default (override with the `DATA_DIR` env var; port
with `PORT`).

## Releasing

Publishing a GitHub release (or pushing a `dev-*` / `v*-beta*` tag) triggers the
[docker-publish workflow](.github/workflows/docker-publish.yml), which builds amd64 and arm64
images natively, pushes them to Docker Hub and GHCR, and merges them into a multi-arch manifest
tagged with the version plus a channel alias (`latest` / `beta` / `dev`). Requires the
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repo secrets.

## CookieCloud setup

1. Install the [CookieCloud browser extension](https://github.com/easychen/CookieCloud) and point
   it at your CookieCloud server (self-hosted or the public one).
2. Copy the extension's user key (UUID) and password into Settings → CookieCloud.
3. Hit "Sync now" (or set an auto-sync interval). Cookies are decrypted server-side in this app
   using AES (the same OpenSSL-compatible scheme CookieCloud uses) and written to
   `data/cookies.txt`.
4. All subsequent downloads pass `--cookies data/cookies.txt` to yt-dlp automatically.

## Notes

- The CookieCloud password is stored in plain text in `data/config.json`; keep the data directory
  private.
- No authentication is built in; put the app behind a reverse proxy with auth if exposing it.
