export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'completed'
  | 'error'
  | 'cancelled'

export type Destination = 'server' | 'direct'

export type Download = {
  id: string
  url: string
  title: string
  filename: string | null
  filepath: string | null
  status: DownloadStatus
  percent: number
  downloadedBytes: number
  totalBytes: number | null
  speed: number | null
  eta: number | null
  error: string | null
  preset: string
  playlist: boolean
  destination: Destination
  delivered: boolean
  createdAt: number
  finishedAt: number | null
}

export type CookieCloudSettings = {
  serverUrl: string
  uuid: string
  password: string
  autoSyncMinutes: number
}

export type CookieCloudStatus = {
  lastSyncAt: number | null
  cookieCount: number
  domainCount: number
  lastError: string | null
}

export type Settings = {
  downloadDir: string
  ytdlpPath: string
  // Path to the ffmpeg binary (or its directory). Empty falls back to the
  // static build bundled via the ffmpeg-static package.
  ffmpegPath: string
  extraArgs: string
  cookieCloud: CookieCloudSettings
}

export type NewDownloadRequest = {
  url: string
  preset?: string
  playlist?: boolean
  destination?: Destination
  // Fetch subtitles for the given comma-separated languages (e.g. "zh-Hans").
  // Covers both OP-uploaded and YouTube auto-generated/auto-translated tracks.
  subtitles?: boolean
  subLangs?: string
  // Output container to remux into (e.g. "mp4", "mkv", "webm"). Empty leaves
  // yt-dlp's chosen container as-is.
  container?: string
}
