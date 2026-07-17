import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { COOKIES_FILE, DATA_DIR, getSettings } from './config.js'
import { hasCookies } from './cookiecloud.js'
import type { Download, NewDownloadRequest } from './types.js'

const HISTORY_FILE = path.join(DATA_DIR, 'history.json')
// Direct downloads are ephemeral: streamed to the browser then deleted, so they
// live outside settings.downloadDir and never show up in the Archive listing
const DIRECT_DIR = path.join(DATA_DIR, 'direct')
const TITLE_MARK = '__TITLE__'
const PATH_MARK = '__PATH__'

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

// yt-dlp emits these once the media streams are downloaded and it begins
// remuxing / converting / embedding: the real post-download work
const POSTPROCESS_RE =
  /^\[(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|EmbedSubtitle|SubtitlesConvertor|Metadata|Fixup\w*)\]/

const CONTAINERS = new Set(['mp4', 'mkv', 'webm'])

// Builds the yt-dlp subtitle flags. Requests manual and auto-generated tracks
// (the latter also covers YouTube's auto-translated captions) for the chosen
// languages, then embeds them; mp3 and other audio containers can't carry a
// subtitle track, so embedding is skipped for the audio preset. Fetching the
// tracks leaves sidecar files behind, which removeSidecarSubs() cleans up once
// the download finishes so an embedded download stays a single file.
function subtitleArgs(req: NewDownloadRequest, preset: string): string[] {
  if (!req.subtitles) return []
  const langs = req.subLangs?.trim() || 'en'
  const args = ['--write-subs', '--write-auto-subs', '--sub-langs', langs]
  if (preset !== 'audio') args.push('--embed-subs')
  return args
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
    const settings = getSettings()
    const preset = req.preset && req.preset in PRESETS ? req.preset : 'best'
    const destination = req.destination === 'direct' ? 'direct' : 'server'
    const outDir = destination === 'direct' ? DIRECT_DIR : settings.downloadDir
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
      finishedAt: null
    }
    this.downloads.set(dl.id, dl)

    fs.mkdirSync(outDir, { recursive: true })

    // yt-dlp needs ffmpeg to merge separate video/audio streams, convert audio
    // and embed subtitles. Prefer a user-set path, else the bundled static build.
    // ffmpeg-static's default export is the binary path; its typings mis-model it.
    const bundledFfmpeg = ffmpegStatic as unknown as string | null
    const ffmpegLocation = settings.ffmpegPath?.trim() || bundledFfmpeg

    const args = [
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
      '--print', `after_move:${PATH_MARK}%(filepath)s`,
      ...PRESETS[preset]!,
      ...(ffmpegLocation ? ['--ffmpeg-location', ffmpegLocation] : []),
      ...containerArgs(req, preset),
      ...subtitleArgs(req, preset),
      ...(dl.playlist ? [] : ['--no-playlist']),
      ...(hasCookies() ? ['--cookies', COOKIES_FILE] : []),
      ...tokenise(settings.extraArgs)
    ]

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(settings.ytdlpPath, args, { detached: true })
    } catch (err) {
      dl.status = 'error'
      dl.error = err instanceof Error ? err.message : String(err)
      this.finish(dl)
      return dl
    }

    this.processes.set(dl.id, proc)
    dl.status = 'downloading'
    this.emitUpdate()

    let stderrTail = ''
    let stdoutBuf = ''
    // Every final media file yt-dlp produces (one per video, more for a
    // playlist); used to strip leftover subtitle sidecars once embedding is done
    const finalPaths: string[] = []

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith(PATH_MARK)) finalPaths.push(trimmed.slice(PATH_MARK.length))
        this.handleLine(dl, trimmed)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000)
    })

    proc.on('error', (err) => {
      dl.status = 'error'
      dl.error =
        err.message.includes('ENOENT')
          ? `yt-dlp binary not found at '${settings.ytdlpPath}'. Install yt-dlp or set its path in Settings.`
          : err.message
      this.processes.delete(dl.id)
      this.finish(dl)
    })

    proc.on('close', (code) => {
      this.processes.delete(dl.id)
      if (dl.status === 'cancelled' || dl.status === 'error') return
      if (code === 0) {
        dl.status = 'completed'
        dl.percent = 100
        // Subtitles are embedded into the media; drop the sidecar files yt-dlp
        // had to write to fetch them so the result is a single file
        if (req.subtitles && preset !== 'audio') this.removeSidecarSubs(finalPaths)
      } else {
        dl.status = 'error'
        const errLine = stderrTail
          .split('\n')
          .reverse()
          .find((l) => l.includes('ERROR'))
        dl.error = errLine?.trim() ?? `yt-dlp exited with code ${code}`
      }
      this.finish(dl)
    })

    return dl
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
    this.downloads.delete(id)
    this.saveHistory()
    this.emitUpdate()
    return true
  }

  clearFinished(): void {
    for (const [id, dl] of this.downloads) {
      if (dl.status === 'completed' || dl.status === 'error' || dl.status === 'cancelled') {
        this.deleteDirectFile(dl)
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
      dl.filepath = line.slice(PATH_MARK.length)
      dl.filename = path.basename(dl.filepath)
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
        if (item.status === 'downloading' || item.status === 'processing' || item.status === 'queued') {
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
