import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegStatic from 'ffmpeg-static'
import { COOKIES_FILE, DATA_DIR, getSettings, updateSettings } from './config.js'
import { hasCookies, syncCookies } from './cookiecloud.js'
import { QuarkClient } from './quark.js'
import { translateText } from './translate.js'
import { langIso3, langName, mergeBilingual, parseVtt, toVtt } from './subtitles.js'
import type { Download, NewDownloadRequest } from './types.js'

const HISTORY_FILE = path.join(DATA_DIR, 'history.json')
// Direct downloads are ephemeral: streamed to the browser then deleted, so they
// live outside settings.downloadDir and never show up in the Archive listing
const DIRECT_DIR = path.join(DATA_DIR, 'direct')
// Quark downloads are also ephemeral: fetched here, uploaded to Quark Drive,
// then deleted so they use no server disk
const QUARK_DIR = path.join(DATA_DIR, 'quark')
// One yt-dlp download-archive per job; retries read it to skip finished items
const ARCHIVES_DIR = path.join(DATA_DIR, 'archives')
const TITLE_MARK = '__TITLE__'
const PATH_MARK = '__PATH__'

// YouTube's bot check: the session cookies are stale or rejected. Recoverable
// by re-syncing from CookieCloud and retrying, which happens automatically.
const BOT_CHECK_RE = /sign in to confirm|not a bot/i
const MAX_AUTO_RETRIES = 2

function archivePath(id: string): string {
  return path.join(ARCHIVES_DIR, `${id}.txt`)
}

// Parses a PATH_MARK line "<mark><playlist_index>\t<filepath>" from yt-dlp's
// after_move print. index is 0 for a non-playlist item.
function parsePathMark(line: string): { index: number; path: string } {
  const raw = line.slice(PATH_MARK.length)
  const tab = raw.indexOf('\t')
  if (tab === -1) return { index: 0, path: raw }
  const idx = Number(raw.slice(0, tab))
  return { index: Number.isFinite(idx) ? idx : 0, path: raw.slice(tab + 1) }
}

// Drops archive entries for the given video IDs so a retry re-fetches them.
// Used for Quark, where yt-dlp records an item on download but the upload (our
// step) may still have failed.
function pruneArchive(file: string, ids: Set<string>): void {
  try {
    const kept = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => {
        const id = l.trim().split(/\s+/).pop()
        return !(id && ids.has(id))
      })
    fs.writeFileSync(file, kept.join('\n'))
  } catch {
    // archive missing or unreadable -- nothing to prune
  }
}

export const PRESETS: Record<string, string[]> = {
  best: [],
  '2160p': ['-S', 'res:2160'],
  '1080p': ['-S', 'res:1080'],
  '720p': ['-S', 'res:720'],
  audio: ['-x', '--audio-format', 'mp3']
}

type ProgressLine = {
  status?: string
  downloaded_bytes?: number
  total_bytes?: number
  total_bytes_estimate?: number
  speed?: number
  eta?: number
  filename?: string
}

// Naive shell-style tokeniser for the user-supplied extra args string
function tokenise(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matches.map((t) => t.replace(/^["']|["']$/g, ''))
}

const SUBTITLE_EXTS = new Set([
  'vtt', 'srt', 'ass', 'ssa', 'lrc', 'ttml', 'srv1', 'srv2', 'srv3', 'json3', 'dfxp'
])

function isSubtitleFile(name?: string): boolean {
  const ext = name?.split('.').pop()?.toLowerCase()
  return !!ext && SUBTITLE_EXTS.has(ext)
}

// Splits a yt-dlp output stem "Title [id]" into title and bare id. The id is the
// last bracketed group so titles containing brackets still work.
function parseTitleId(stem: string): { title: string; id: string } {
  const m = /^(.*) \[([^\]]+)\]$/.exec(stem)
  return m ? { title: m[1]!, id: m[2]! } : { title: stem, id: '' }
}

// Filesystem-safe name: keep letters (including CJK) and digits, turn everything
// else - whitespace, punctuation, brackets - into single underscores.
function toUnderscoreName(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// yt-dlp emits these once the media streams are downloaded and it begins
// remuxing / converting / embedding: the real post-download work
const POSTPROCESS_RE =
  /^\[(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|EmbedSubtitle|SubtitlesConvertor|Metadata|Fixup\w*)\]/

const CONTAINERS = new Set(['mp4', 'mkv', 'webm'])

// The two subtitle languages to fetch, de-duplicated and trimmed. Empty entries
// are dropped so a single-language request still works.
function subLangs(req: NewDownloadRequest): string[] {
  const raw = [req.subLang1, req.subLang2].map((l) => l?.trim()).filter((l): l is string => !!l)
  return [...new Set(raw)]
}

// Builds the yt-dlp subtitle flags: download both languages' tracks (manual and
// auto-generated, the latter also covering YouTube's auto-translated captions)
// as VTT sidecars. Embedding is done afterwards by embedSubtitles() so we can
// add the generated bilingual track and pick the default, so --embed-subs is
// deliberately not used here.
function subtitleArgs(req: NewDownloadRequest, preset: string): string[] {
  if (!req.subtitles) return []
  const langs = subLangs(req)
  if (!langs.length) return []
  return [
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    langs.join(','),
    '--convert-subs',
    'vtt',
    // Space out the several subtitle (timedtext) requests per video; YouTube
    // rate-limits them hard from datacentre IPs and otherwise returns HTTP 429.
    // Appended extraArgs win, so users can raise this if 429s persist.
    '--sleep-requests',
    '1'
  ]
}

// Forces the output container. Subtitle embedding only works reliably in
// mp4/mkv (webm silently drops the track), so an embed request upgrades any
// webm/unset choice to mp4.
function containerArgs(req: NewDownloadRequest, preset: string): string[] {
  if (preset === 'audio') return []
  let target = req.container && CONTAINERS.has(req.container) ? req.container : ''
  if (req.subtitles && target !== 'mkv') target = 'mp4'
  if (!target) return []
  const args = ['--merge-output-format', target, '--remux-video', target]
  // mp4 only plays cleanly with H.264 video + AAC audio. Left to its default,
  // yt-dlp picks YouTube's best streams (VP9/AV1 + Opus); merge/remux only
  // rewraps the container, never the codec, so the file opens nowhere (notably
  // macOS/QuickTime). Sort to prefer H.264/AAC, matching yt-dlp's own "-t mp4"
  // recipe. Only falls back to other codecs when no H.264 exists (e.g. 2160p).
  if (target === 'mp4') {
    args.push('-S', 'vcodec:h264,acodec:aac')
  }
  return args
}

// Resolves the ffmpeg binary: a user-set path wins, else the bundled static
// build. ffmpeg-static's default export is the binary path; its typings mis-model it.
function resolveFfmpeg(): string | null {
  const bundled = ffmpegStatic as unknown as string | null
  return getSettings().ffmpegPath?.trim() || bundled
}

const SUB_CODEC: Record<string, string> = { mp4: 'mov_text', mkv: 'srt', webm: 'srt' }

// Bundled CJK font for burn-in. libass otherwise renders Chinese/Japanese/Korean
// as boxes since neither the base image nor most hosts ship a CJK font. Resolved
// relative to this module so it works from both src (dev) and dist (prod).
const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')
const CJK_FONT_FILE = path.join(FONTS_DIR, 'NotoSansCJKsc-Regular.otf')
const CJK_FONT_NAME = 'Noto Sans CJK SC'

// Runs a child process to completion, resolving on exit 0 and rejecting with the
// tail of stderr otherwise.
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let err = ''
    proc.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000)
    })
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `exited with code ${code}`))
    )
  })
}

// Finds the VTT sidecar yt-dlp wrote for a language, e.g. "Title [id].zh-Hans.vtt".
// Prefers an exact code match, then falls back to the base language (so "en"
// still matches an "en-orig" file).
function findSidecar(dir: string, stem: string, code: string, entries: string[]): string | null {
  const prefix = `${stem}.`
  const candidates = entries.filter((n) => n.startsWith(prefix) && n.toLowerCase().endsWith('.vtt'))
  const langSeg = (n: string) => n.slice(prefix.length, n.length - 4).toLowerCase()
  const want = code.toLowerCase()
  const base = want.split('-')[0]!
  return (
    candidates.find((n) => langSeg(n) === want) ??
    candidates.find((n) => langSeg(n).split('-')[0] === base) ??
    null
  )
}

// Runs a command capturing its output, resolving with the exit code and streams.
function runCapture(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(cmd, args)
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code: code ?? -1, out, err }))
  })
}

// Returns the installed yt-dlp version string (e.g. "2025.01.15").
export async function ytdlpVersion(): Promise<string> {
  const { code, out, err } = await runCapture(getSettings().ytdlpPath, ['--version'])
  if (code !== 0) throw new Error(err.trim() || `yt-dlp exited with code ${code}`)
  return out.trim()
}

// Downloads the latest yt-dlp release into the data dir (writable by the app,
// unlike /usr/local/bin) and points the configured path at it. Kept as the
// release zipapp to match the container's python3 runtime. The download is
// verified to run before the path is switched, so a bad fetch can't break
// downloads. Returns the new version.
export async function updateYtdlp(): Promise<{ version: string; path: string }> {
  const dest = path.join(DATA_DIR, 'yt-dlp')
  const tmp = `${dest}.download`
  const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp')
  if (!res.ok) throw new Error(`Download failed with status ${res.status}`)
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
  fs.chmodSync(tmp, 0o755)
  const { code, out, err } = await runCapture(tmp, ['--version'])
  if (code !== 0) {
    fs.unlink(tmp, () => {})
    throw new Error(err.trim() || `Downloaded yt-dlp failed to run (code ${code})`)
  }
  fs.renameSync(tmp, dest)
  updateSettings({ ytdlpPath: dest })
  return { version: out.trim(), path: dest }
}

class DownloadManager extends EventEmitter {
  private downloads = new Map<string, Download>()
  private processes = new Map<string, ChildProcessWithoutNullStreams>()

  constructor() {
    super()
    this.loadHistory()
  }

  list(): Download[] {
    return [...this.downloads.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Download | undefined {
    return this.downloads.get(id)
  }

  start(req: NewDownloadRequest): Download {
    const preset = req.preset && req.preset in PRESETS ? req.preset : 'best'
    const destination =
      req.destination === 'direct' || req.destination === 'quark' ? req.destination : 'server'
    const dl: Download = {
      id: randomUUID(),
      url: req.url,
      title: req.url,
      filename: null,
      filepath: null,
      status: 'queued',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      speed: null,
      eta: null,
      error: null,
      preset,
      playlist: req.playlist ?? false,
      destination,
      delivered: false,
      createdAt: Date.now(),
      finishedAt: null,
      request: req
    }
    this.downloads.set(dl.id, dl)
    this.launch(dl, req)
    return dl
  }

  // Re-runs a failed/cancelled download with its original options. The job's
  // download-archive is kept, so a playlist resumes from the items that didn't
  // finish rather than re-fetching the whole list. Returns null when the job
  // can't be retried (not found or still active).
  retry(id: string, auto = false): Download | null {
    const dl = this.downloads.get(id)
    if (!dl || (dl.status !== 'error' && dl.status !== 'cancelled')) return null
    // A manual retry starts a fresh auto-recovery budget
    if (!auto) dl.autoRetries = 0
    // Entries saved before requests were persisted lack dl.request; rebuild a
    // minimal one from the record (loses subtitle/translate/sequence options).
    const req: NewDownloadRequest = dl.request ?? {
      url: dl.url,
      preset: dl.preset,
      playlist: dl.playlist,
      destination: dl.destination
    }
    dl.request = req
    dl.status = 'queued'
    dl.percent = 0
    dl.downloadedBytes = 0
    dl.totalBytes = null
    dl.speed = null
    dl.eta = null
    dl.error = null
    dl.delivered = false
    dl.finishedAt = null
    this.launch(dl, req)
    return dl
  }

  private launch(dl: Download, req: NewDownloadRequest): void {
    const settings = getSettings()
    const preset = dl.preset
    const outDir =
      dl.destination === 'direct'
        ? DIRECT_DIR
        : dl.destination === 'quark'
          ? QUARK_DIR
          : settings.downloadDir
    fs.mkdirSync(outDir, { recursive: true })
    fs.mkdirSync(ARCHIVES_DIR, { recursive: true })
    const archive = archivePath(dl.id)

    // yt-dlp needs ffmpeg to merge separate video/audio streams and convert audio
    const ffmpegLocation = resolveFfmpeg()

    const baseArgs = [
      req.url,
      '-P', outDir,
      '-o', '%(title)s [%(id)s].%(ext)s',
      '--newline',
      '--no-simulate',
      '--progress',
      // YouTube's n-challenge needs a JS runtime; Deno (yt-dlp's default) isn't
      // bundled, but Node.js >=22 is always present since the server runs on it
      '--js-runtimes', 'node',
      '--progress-template', 'download:%(progress)j',
      '--print', `before_dl:${TITLE_MARK}%(title)s`,
      // playlist_index numbers items by their true position, so a resumed
      // playlist keeps correct sequence numbers even with items already done
      '--print', `after_move:${PATH_MARK}%(playlist_index|0)s\t%(filepath)s`,
      // Skip items already recorded as done, so a retry resumes from the failures
      '--download-archive', archive,
      ...PRESETS[preset]!,
      ...(ffmpegLocation ? ['--ffmpeg-location', ffmpegLocation] : []),
      ...containerArgs(req, preset),
      ...subtitleArgs(req, preset),
      ...(dl.playlist ? [] : ['--no-playlist']),
      ...(hasCookies() ? ['--cookies', COOKIES_FILE] : []),
      ...tokenise(settings.extraArgs)
    ]

    // --sleep-interval also sleeps before the FIRST download, which would delay
    // the job's start by the whole gap. So a playlist with a gap runs as two
    // passes: item 1 immediately, then the rest with the gap. The shared archive
    // makes pass 2 skip item 1 (archived items skip the sleep too, so retries
    // stay fast).
    const gap = dl.playlist ? settings.playlistSleep : 0
    const passes: string[][] =
      gap > 0
        ? [
            [...baseArgs, '--playlist-items', '1'],
            [...baseArgs, '--sleep-interval', String(gap)]
          ]
        : [baseArgs]

    // Shared across passes: post-processing chain, error collection and stderr
    // tail all describe the one logical job.
    let stderrTail = ''
    let downloadActive = true
    // Post-process (rename -> subtitle -> upload) each item as soon as yt-dlp
    // finishes it, so for a playlist the uploads overlap the remaining downloads.
    // Items are chained so they process one at a time, but concurrently with the
    // ongoing download.
    let postChain: Promise<void> = Promise.resolve()
    const postErrors: string[] = []
    // For Quark, yt-dlp records an item as done once downloaded, before our
    // upload runs. IDs whose upload fails are pruned from the archive after the
    // run so a retry re-fetches and re-uploads them.
    const failedUploadIds = new Set<string>()

    const handleStdoutLine = (trimmed: string): void => {
      if (trimmed.startsWith(PATH_MARK)) {
        const { index, path: itemPath } = parsePathMark(trimmed)
        const seqOffset = dl.playlist && index >= 1 ? index - 1 : 0
        postChain = postChain.then(() =>
          this.postProcessItem(
            dl,
            req,
            preset,
            ffmpegLocation,
            itemPath,
            seqOffset,
            () => downloadActive,
            postErrors,
            failedUploadIds
          )
        )
      }
      this.handleLine(dl, trimmed)
    }

    // Runs one yt-dlp pass, resolving with its exit code (rejects on spawn errors)
    const runPass = (args: string[]): Promise<number> =>
      new Promise((resolve, reject) => {
        let proc: ChildProcessWithoutNullStreams
        try {
          proc = spawn(settings.ytdlpPath, args, { detached: true })
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        this.processes.set(dl.id, proc)
        let stdoutBuf = ''
        proc.stdout.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString()
          const lines = stdoutBuf.split('\n')
          stdoutBuf = lines.pop() ?? ''
          for (const line of lines) handleStdoutLine(line.trim())
        })
        proc.stderr.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-4000)
        })
        proc.on('error', (err) => {
          this.processes.delete(dl.id)
          reject(err)
        })
        proc.on('close', (code) => {
          this.processes.delete(dl.id)
          resolve(code ?? -1)
        })
      })

    dl.status = 'downloading'
    this.emitUpdate()

    void (async () => {
      let code = 0
      try {
        for (const args of passes) {
          code = await runPass(args)
          // cancel() already finished the record; don't overwrite its state
          if (dl.status === 'cancelled' || dl.status === 'error') return
          if (code !== 0) break
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        dl.status = 'error'
        dl.error = message.includes('ENOENT')
          ? `yt-dlp binary not found at '${settings.ytdlpPath}'. Install yt-dlp or set its path in Settings.`
          : message
        this.finish(dl)
        return
      }
      downloadActive = false
      // Reflect the tail of the pipeline still finishing after the last download
      if (code === 0) {
        dl.status = dl.destination === 'quark' ? 'uploading' : 'processing'
        this.emitUpdate()
      }
      postChain
        .catch((err) =>
          console.error('[downloader] post-processing failed:', err instanceof Error ? err.message : err)
        )
        .then(() => {
          if (dl.destination === 'quark' && failedUploadIds.size) {
            pruneArchive(archive, failedUploadIds)
          }
          if (code !== 0) {
            dl.status = 'error'
            const errLine = stderrTail
              .split('\n')
              .reverse()
              .find((l) => l.includes('ERROR'))
            dl.error = errLine?.trim() ?? `yt-dlp exited with code ${code}`
          } else if (postErrors.length) {
            dl.status = 'error'
            dl.error = postErrors.join('; ')
          } else {
            dl.status = 'completed'
            dl.percent = 100
          }
          this.finish(dl)
          if (code !== 0) this.maybeAutoRetry(dl)
        })
    })()
  }

  // Self-heals YouTube's "Sign in to confirm you're not a bot" failure: forces a
  // CookieCloud sync (the scheduled freshness window doesn't apply -- the cookies
  // were just rejected) and restarts the job, at most MAX_AUTO_RETRIES times per
  // user action so a genuinely dead login can't retry forever.
  private maybeAutoRetry(dl: Download): void {
    if (dl.status !== 'error' || !dl.error || !BOT_CHECK_RE.test(dl.error)) return
    const attempts = dl.autoRetries ?? 0
    if (attempts >= MAX_AUTO_RETRIES) return
    dl.autoRetries = attempts + 1
    console.log(
      `[downloader] bot check hit; syncing cookies and retrying (attempt ${dl.autoRetries}/${MAX_AUTO_RETRIES})`
    )
    void syncCookies()
      .catch((err) =>
        // Retry with the existing cookies anyway; the sync failing shouldn't
        // strand a job that might still succeed
        console.error('[downloader] auto-retry cookie sync failed:', (err as Error).message)
      )
      .then(() => {
        this.retry(dl.id, true)
      })
  }

  cancel(id: string): boolean {
    const dl = this.downloads.get(id)
    const proc = this.processes.get(id)
    if (!dl) return false
    if (proc?.pid) {
      dl.status = 'cancelled'
      try {
        process.kill(-proc.pid, 'SIGTERM')
      } catch {
        proc.kill('SIGTERM')
      }
      this.finish(dl)
    }
    return true
  }

  remove(id: string): boolean {
    const dl = this.downloads.get(id)
    if (!dl) return false
    if (this.processes.has(id)) this.cancel(id)
    this.deleteDirectFile(dl)
    fs.unlink(archivePath(id), () => {})
    this.downloads.delete(id)
    this.saveHistory()
    this.emitUpdate()
    return true
  }

  clearFinished(): void {
    for (const [id, dl] of this.downloads) {
      if (dl.status === 'completed' || dl.status === 'error' || dl.status === 'cancelled') {
        this.deleteDirectFile(dl)
        fs.unlink(archivePath(id), () => {})
        this.downloads.delete(id)
      }
    }
    this.saveHistory()
    this.emitUpdate()
  }

  // Called once a direct download has been streamed to the browser: the
  // server's copy is no longer needed, so drop it and free the disk space
  markDelivered(id: string): void {
    const dl = this.downloads.get(id)
    if (!dl) return
    if (dl.filepath) fs.unlink(dl.filepath, () => {})
    dl.delivered = true
    dl.filepath = null
    this.saveHistory()
    this.emitUpdate()
  }

  // Processes one finished item: rename (sequence + translated title, always
  // sanitised), embed/burn subtitles, then - for the quark destination - upload
  // and delete locally. Runs while later playlist items are still downloading, so
  // subtitle/upload failures are recorded but never abort the whole download.
  private async postProcessItem(
    dl: Download,
    req: NewDownloadRequest,
    preset: string,
    ffmpeg: string | null,
    videoPath: string,
    index: number,
    isDownloadActive: () => boolean,
    errors: string[],
    failedUploadIds: Set<string>
  ): Promise<void> {
    // Grab the id before finalizeName renames the file away from "Title [id]"
    const { id } = parseTitleId(path.basename(videoPath, path.extname(videoPath)))
    let current = videoPath
    try {
      current = await this.finalizeName(dl, req, current, index)
    } catch (err) {
      console.error('[downloader] rename failed:', err instanceof Error ? err.message : err)
    }

    if (req.subtitles && preset !== 'audio' && ffmpeg) {
      try {
        if (req.burnSubs) await this.burnSubtitles(current, req, ffmpeg)
        else await this.embedTracks(current, req, ffmpeg)
      } catch (err) {
        console.error(
          '[downloader] subtitle post-processing failed:',
          err instanceof Error ? err.message : err
        )
      }
    }

    if (dl.destination === 'quark') {
      try {
        await this.uploadOneToQuark(dl, current, isDownloadActive)
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
        if (id) failedUploadIds.add(id)
        // The local copy is ephemeral (kept only to upload); drop the failed one
        fs.unlink(current, () => {})
      }
    }
  }

  // Renames a finished file (and its subtitle sidecars) to the final filename:
  // "<seq>_<translated title>_<original title>_<id>.ext", with all whitespace and
  // special characters replaced by underscores. Returns the new path.
  private async finalizeName(
    dl: Download,
    req: NewDownloadRequest,
    videoPath: string,
    index: number
  ): Promise<string> {
    if (!fs.existsSync(videoPath)) return videoPath
    const dir = path.dirname(videoPath)
    const ext = path.extname(videoPath)
    const oldStem = path.basename(videoPath, ext)
    const { title, id } = parseTitleId(oldStem)

    const parts: string[] = []
    if (req.seqStart != null) parts.push(String(req.seqStart + index).padStart(2, '0'))
    if (req.translateTitle) {
      try {
        const translated = await translateText(title, req.translateTo || 'zh-CN')
        if (translated) parts.push(translated)
      } catch (err) {
        console.error('[downloader] title translation failed:', err instanceof Error ? err.message : err)
      }
    }
    parts.push(title)
    if (id) parts.push(id)

    const newStem = toUnderscoreName(parts.join(' ')) || oldStem
    if (newStem === oldStem) return videoPath

    const newVp = path.join(dir, newStem + ext)
    fs.renameSync(videoPath, newVp)
    // Rename sidecars sharing the old stem (e.g. subtitle files) to match
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${oldStem}.`)) {
          fs.renameSync(path.join(dir, name), path.join(dir, newStem + name.slice(oldStem.length)))
        }
      }
    } catch {
      // best-effort sidecar rename
    }
    dl.filepath = newVp
    dl.filename = path.basename(newVp)
    this.emitUpdate()
    return newVp
  }

  // Uploads a single finished file to Quark Drive, then deletes the local copy.
  // Upload progress is only shown once downloading is done, so it doesn't fight
  // the download progress bar while a playlist is still in flight.
  private async uploadOneToQuark(
    dl: Download,
    videoPath: string,
    isDownloadActive: () => boolean
  ): Promise<void> {
    if (!fs.existsSync(videoPath)) return
    const cookie = getSettings().quark.cookie?.trim()
    if (!cookie) throw new Error('Quark cookie is not set (add it in Settings)')
    const client = new QuarkClient(cookie, (updated) => {
      updateSettings({ quark: { ...getSettings().quark, cookie: updated } })
    })
    dl.filename = path.basename(videoPath)
    this.emitUpdate()
    await client.uploadFile(videoPath, {
      parentId: getSettings().quark.folderId || '0',
      onProgress: (percent) => {
        if (!isDownloadActive()) {
          dl.percent = percent
          this.emitUpdate()
        }
      }
    })
    fs.unlink(videoPath, () => {})
    dl.filepath = null
  }

  // Locates the video's downloaded subtitle sidecars, in request order (so
  // subLang1 stays the primary/top language of the bilingual track).
  private findTracks(
    videoPath: string,
    req: NewDownloadRequest
  ): { dir: string; stem: string; ext: string; found: { code: string; file: string }[] } | null {
    if (!fs.existsSync(videoPath)) return null
    const dir = path.dirname(videoPath)
    const ext = path.extname(videoPath).slice(1).toLowerCase()
    const stem = path.basename(videoPath, path.extname(videoPath))
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return null
    }
    const found = subLangs(req)
      .map((code) => ({ code, file: findSidecar(dir, stem, code, entries) }))
      .filter((l): l is { code: string; file: string } => !!l.file)
    return { dir, stem, ext, found }
  }

  // Merges the first two found languages into a bilingual VTT string (primary on
  // top). Returns null when fewer than two tracks exist or the merge is empty.
  private buildBilingual(dir: string, found: { code: string; file: string }[]): string | null {
    if (found.length < 2) return null
    const [a, b] = found
    const primary = parseVtt(fs.readFileSync(path.join(dir, a!.file), 'utf8'))
    const secondary = parseVtt(fs.readFileSync(path.join(dir, b!.file), 'utf8'))
    const merged = mergeBilingual(primary, secondary)
    return merged.length ? toVtt(merged) : null
  }

  // Embeds the downloaded subtitle tracks into a finished video: each requested
  // language, plus a generated bilingual track (set as the default) when both
  // languages are present. Whatever's available is embedded; the sidecar files
  // are removed afterwards so the result is a single file.
  private async embedTracks(
    videoPath: string,
    req: NewDownloadRequest,
    ffmpeg: string
  ): Promise<void> {
    const info = this.findTracks(videoPath, req)
    if (!info) return
    const { dir, stem, ext, found } = info
    const codec = SUB_CODEC[ext]
    if (!codec || !found.length) return // container can't carry subtitles

    const tracks: { path: string; iso: string; title: string; default: boolean }[] = []

    const bilingual = this.buildBilingual(dir, found)
    if (bilingual) {
      const biPath = path.join(dir, `${stem}.bilingual.vtt`)
      fs.writeFileSync(biPath, bilingual)
      tracks.push({
        path: biPath,
        iso: 'mul',
        title: `${langName(found[0]!.code)} + ${langName(found[1]!.code)}`,
        default: true
      })
    }

    for (const l of found) {
      tracks.push({
        path: path.join(dir, l.file),
        iso: langIso3(l.code),
        title: langName(l.code),
        // The first single-language track is the default only if no bilingual one exists
        default: tracks.length === 0
      })
    }

    const tmpPath = path.join(dir, `.${stem}.embed.${ext}`)
    const args = ['-y', '-i', videoPath]
    for (const t of tracks) args.push('-i', t.path)
    args.push('-map', '0:v?', '-map', '0:a?')
    tracks.forEach((_, i) => args.push('-map', String(i + 1)))
    args.push('-c', 'copy', '-c:s', codec)
    tracks.forEach((t, i) => {
      args.push(`-metadata:s:s:${i}`, `language=${t.iso}`)
      // title is what mkv and most players read; the mp4/mov muxer ignores it
      // and shows handler_name instead, so set both for a labelled picker
      args.push(`-metadata:s:s:${i}`, `title=${t.title}`)
      args.push(`-metadata:s:s:${i}`, `handler_name=${t.title}`)
      args.push(`-disposition:s:${i}`, t.default ? 'default' : '0')
    })
    if (ext === 'mp4') args.push('-movflags', '+faststart')
    args.push(tmpPath)

    await run(ffmpeg, args)
    fs.renameSync(tmpPath, videoPath)
    this.removeSidecarSubs([videoPath])
  }

  // Burns one subtitle track permanently into the picture (re-encoding the
  // video) so it shows in any player. burnLang selects the track: "bilingual"
  // (default) merges both languages, otherwise a specific language code is used;
  // both fall back to whatever single track is available.
  private async burnSubtitles(
    videoPath: string,
    req: NewDownloadRequest,
    ffmpeg: string
  ): Promise<void> {
    const info = this.findTracks(videoPath, req)
    if (!info || !info.found.length) return
    const { dir, stem, ext, found } = info

    const target = (req.burnLang || 'bilingual').toLowerCase()
    let vtt: string | null = null
    if (target !== 'bilingual') {
      const match = found.find((l) => l.code.toLowerCase() === target)
      if (match) vtt = fs.readFileSync(path.join(dir, match.file), 'utf8')
    }
    vtt ??= this.buildBilingual(dir, found)
    vtt ??= fs.readFileSync(path.join(dir, found[0]!.file), 'utf8')

    // Write to a temp path free of the characters the subtitles filter treats
    // specially (colons, brackets, quotes) so no fragile escaping is needed
    const burnPath = path.join(os.tmpdir(), `ytwd-burn-${randomUUID()}.vtt`)
    fs.writeFileSync(burnPath, vtt)

    // Point libass at the bundled CJK font so non-Latin subtitles render. The
    // temp .vtt and fonts dir use clean paths, so no filter escaping is needed.
    let filter = `subtitles=${burnPath}`
    if (fs.existsSync(CJK_FONT_FILE)) {
      filter += `:fontsdir=${FONTS_DIR}:force_style=FontName=${CJK_FONT_NAME}`
    }

    const tmpOut = path.join(dir, `.${stem}.burn.${ext}`)
    const args = [
      '-y',
      '-i',
      videoPath,
      '-vf',
      filter,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-c:a',
      'copy'
    ]
    if (ext === 'mp4') args.push('-movflags', '+faststart')
    args.push(tmpOut)

    try {
      await run(ffmpeg, args)
      fs.renameSync(tmpOut, videoPath)
    } catch (err) {
      fs.unlink(tmpOut, () => {})
      throw err
    } finally {
      fs.unlink(burnPath, () => {})
    }
    this.removeSidecarSubs([videoPath])
  }

  // Removes subtitle sidecars (e.g. "Title [id].zh-Hans.vtt") sitting next to a
  // finished video, matching on the video's stem so unrelated files are left be
  private removeSidecarSubs(videoPaths: string[]): void {
    for (const vp of videoPaths) {
      const dir = path.dirname(vp)
      const base = path.basename(vp)
      const stem = path.basename(vp, path.extname(vp))
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const name of entries) {
        if (name === base) continue
        if (name.startsWith(`${stem}.`) && isSubtitleFile(name)) {
          fs.unlink(path.join(dir, name), () => {})
        }
      }
    }
  }

  private deleteDirectFile(dl: Download): void {
    if (dl.destination === 'direct' && dl.filepath) {
      fs.unlink(dl.filepath, () => {})
    }
  }

  private handleLine(dl: Download, line: string): void {
    if (!line) return
    if (line.startsWith(TITLE_MARK)) {
      dl.title = line.slice(TITLE_MARK.length)
      this.emitUpdate()
      return
    }
    if (line.startsWith(PATH_MARK)) {
      const { path: fp } = parsePathMark(line)
      dl.filepath = fp
      dl.filename = path.basename(fp)
      this.emitUpdate()
      return
    }
    if (POSTPROCESS_RE.test(line)) {
      dl.status = 'processing'
      dl.percent = 100
      dl.speed = null
      dl.eta = null
      this.emitUpdate()
      return
    }
    if (!line.startsWith('{')) return
    try {
      const p = JSON.parse(line) as ProgressLine
      // A single download spans several files (separate video + audio streams,
      // plus a file per subtitle track); each reports its own progress from zero.
      // Auxiliary caption files must not touch the bar, and percent must never
      // regress when yt-dlp moves on to the next stream.
      if (p.status === 'finished') {
        // One file done; more streams may follow, so only clear the live stats.
        dl.speed = null
        dl.eta = null
      } else if (p.status === 'downloading' && !isSubtitleFile(p.filename)) {
        dl.status = 'downloading'
        dl.downloadedBytes = p.downloaded_bytes ?? dl.downloadedBytes
        dl.totalBytes = p.total_bytes ?? p.total_bytes_estimate ?? dl.totalBytes
        dl.speed = p.speed ?? null
        dl.eta = p.eta ?? null
        if (dl.totalBytes) {
          const pct = Math.min(100, (dl.downloadedBytes / dl.totalBytes) * 100)
          dl.percent = Math.max(dl.percent, pct)
        }
        if (p.filename && !dl.filename) dl.filename = path.basename(p.filename)
      }
      this.emitUpdate()
    } catch {
      // Not a progress line, ignore
    }
  }

  private finish(dl: Download): void {
    dl.finishedAt = Date.now()
    dl.speed = null
    dl.eta = null
    this.saveHistory()
    this.emitUpdate()
  }

  private emitUpdate(): void {
    this.emit('update', this.list())
  }

  private loadHistory(): void {
    try {
      const items = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as Download[]
      for (const item of items) {
        // Anything that was mid-flight when the server stopped is lost
        if (
          item.status === 'downloading' ||
          item.status === 'processing' ||
          item.status === 'uploading' ||
          item.status === 'queued'
        ) {
          item.status = 'error'
          item.error = 'Interrupted by server restart'
        }
        this.downloads.set(item.id, item)
      }
    } catch {
      // No history yet
    }
  }

  private saveHistory(): void {
    const finished = this.list().filter(
      (d) => d.status === 'completed' || d.status === 'error' || d.status === 'cancelled'
    )
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(finished, null, 2))
    } catch (err) {
      console.error('[downloader] failed to persist history:', err)
    }
  }
}

export const manager = new DownloadManager()
