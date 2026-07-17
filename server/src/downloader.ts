import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegStatic from 'ffmpeg-static'
import { COOKIES_FILE, DATA_DIR, getSettings, updateSettings } from './config.js'
import { hasCookies } from './cookiecloud.js'
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

// Strips characters that are illegal in filenames and collapses whitespace
function sanitizeName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Splits a yt-dlp output stem "Title [id]" into its title and id-suffix parts.
// The id is the last bracketed group so titles containing brackets still work.
function splitStem(stem: string): { title: string; idSuffix: string } {
  const m = /^(.*) (\[[^\]]+\])$/.exec(stem)
  return m ? { title: m[1]!, idSuffix: ` ${m[2]!}` } : { title: stem, idSuffix: '' }
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
    'vtt'
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
    const destination =
      req.destination === 'direct' || req.destination === 'quark' ? req.destination : 'server'
    const outDir =
      destination === 'direct' ? DIRECT_DIR : destination === 'quark' ? QUARK_DIR : settings.downloadDir
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

    // yt-dlp needs ffmpeg to merge separate video/audio streams and convert audio
    const ffmpegLocation = resolveFfmpeg()

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
        // Embedding runs after yt-dlp so we can add the bilingual track and pick
        // the default; it repoints filepath at the muxed file when done.
        void this.postProcess(dl, req, preset, finalPaths)
      } else {
        dl.status = 'error'
        const errLine = stderrTail
          .split('\n')
          .reverse()
          .find((l) => l.includes('ERROR'))
        dl.error = errLine?.trim() ?? `yt-dlp exited with code ${code}`
        this.finish(dl)
      }
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

  // Runs after yt-dlp exits cleanly: embeds subtitle tracks (when requested) and
  // then marks the download complete. Embedding failures are logged but never
  // fail the download, and the fetched sidecars are left in place so the subs
  // aren't lost.
  private async postProcess(
    dl: Download,
    req: NewDownloadRequest,
    preset: string,
    finalPaths: string[]
  ): Promise<void> {
    // Apply the sequence-number prefix / translated-title rename first, so the
    // subsequent subtitle and upload steps see the final filenames
    if (req.seqStart != null || req.translateTitle) {
      dl.status = 'processing'
      this.emitUpdate()
      finalPaths = await this.renameOutputs(dl, req, finalPaths)
    }

    const ffmpeg = resolveFfmpeg()
    if (req.subtitles && preset !== 'audio' && ffmpeg) {
      dl.status = 'processing'
      dl.percent = 100
      dl.speed = null
      dl.eta = null
      this.emitUpdate()
      for (const videoPath of finalPaths) {
        try {
          if (req.burnSubs) await this.burnSubtitles(videoPath, req, ffmpeg)
          else await this.embedTracks(videoPath, req, ffmpeg)
        } catch (err) {
          console.error(
            '[downloader] subtitle post-processing failed:',
            err instanceof Error ? err.message : err
          )
        }
      }
    }
    if (dl.destination === 'quark') {
      try {
        await this.uploadToQuark(dl, finalPaths)
      } catch (err) {
        dl.status = 'error'
        dl.error = `Quark upload failed: ${err instanceof Error ? err.message : String(err)}`
        // The local copies are ephemeral (kept only to upload); drop them so the
        // quark temp dir doesn't accumulate failed downloads
        for (const fp of finalPaths) fs.unlink(fp, () => {})
        dl.filepath = null
        this.finish(dl)
        return
      }
    }
    dl.status = 'completed'
    dl.percent = 100
    this.finish(dl)
  }

  // Renames each finished file (and its subtitle sidecars) to add a zero-padded
  // sequence-number prefix and/or a translated-title prefix:
  // "<seq> <translated title> <original title> [id].ext". Files are in playlist
  // order, so the sequence increments per item. Returns the new video paths.
  private async renameOutputs(
    dl: Download,
    req: NewDownloadRequest,
    paths: string[]
  ): Promise<string[]> {
    const seqStart = req.seqStart
    const width = seqStart != null ? Math.max(2, String(seqStart + paths.length - 1).length) : 0
    const out: string[] = []
    for (let i = 0; i < paths.length; i++) {
      const vp = paths[i]!
      if (!fs.existsSync(vp)) {
        out.push(vp)
        continue
      }
      const dir = path.dirname(vp)
      const ext = path.extname(vp)
      const oldStem = path.basename(vp, ext)
      const { title, idSuffix } = splitStem(oldStem)

      const parts: string[] = []
      if (seqStart != null) parts.push(String(seqStart + i).padStart(width, '0'))
      if (req.translateTitle) {
        try {
          const translated = sanitizeName(await translateText(title, req.translateTo || 'zh-CN'))
          if (translated && translated !== title) parts.push(translated)
        } catch (err) {
          console.error('[downloader] title translation failed:', err instanceof Error ? err.message : err)
        }
      }
      parts.push(title)
      const newStem = `${parts.join(' ')}${idSuffix}`
      if (newStem === oldStem) {
        out.push(vp)
        continue
      }

      const newVp = path.join(dir, newStem + ext)
      fs.renameSync(vp, newVp)
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
      out.push(newVp)
    }
    const last = out[out.length - 1]
    if (last) {
      dl.filepath = last
      dl.filename = path.basename(last)
      this.emitUpdate()
    }
    return out
  }

  // Uploads each finished file to Quark Drive, updating progress, then deletes
  // the local copy so the server keeps no data. A rotated session cookie is
  // persisted back to settings.
  private async uploadToQuark(dl: Download, finalPaths: string[]): Promise<void> {
    const { quark } = getSettings()
    const cookie = quark.cookie?.trim()
    if (!cookie) throw new Error('Quark cookie is not set (add it in Settings)')
    const client = new QuarkClient(cookie, (updated) => {
      updateSettings({ quark: { ...getSettings().quark, cookie: updated } })
    })
    dl.status = 'uploading'
    dl.percent = 0
    dl.speed = null
    dl.eta = null
    this.emitUpdate()
    for (const fp of finalPaths) {
      if (!fs.existsSync(fp)) continue
      await client.uploadFile(fp, {
        parentId: getSettings().quark.folderId || '0',
        onProgress: (percent) => {
          dl.percent = percent
          this.emitUpdate()
        }
      })
      fs.unlink(fp, () => {})
    }
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
