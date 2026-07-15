import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
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

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) this.handleLine(dl, line.trim())
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
    if (!line.startsWith('{')) return
    try {
      const p = JSON.parse(line) as ProgressLine
      if (p.status === 'finished') {
        // Download stream done; yt-dlp may still be merging or converting
        dl.status = 'processing'
        dl.percent = 100
        dl.speed = null
        dl.eta = null
      } else if (p.status === 'downloading') {
        dl.status = 'downloading'
        dl.downloadedBytes = p.downloaded_bytes ?? dl.downloadedBytes
        dl.totalBytes = p.total_bytes ?? p.total_bytes_estimate ?? dl.totalBytes
        dl.speed = p.speed ?? null
        dl.eta = p.eta ?? null
        if (dl.totalBytes) dl.percent = Math.min(100, (dl.downloadedBytes / dl.totalBytes) * 100)
      }
      if (p.filename && !dl.filename) dl.filename = path.basename(p.filename)
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
