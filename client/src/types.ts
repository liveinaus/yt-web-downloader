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

export type NewDownloadRequest = {
  url: string
  preset: string
  playlist: boolean
  destination: Destination
  subtitles?: boolean
  subLangs?: string
  container?: string
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
  ffmpegPath: string
  extraArgs: string
  cookieCloud: CookieCloudSettings
}

export type ArchiveFile = {
  name: string
  size: number
  modifiedAt: number
}
