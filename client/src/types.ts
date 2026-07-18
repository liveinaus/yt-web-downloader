export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'uploading'
  | 'completed'
  | 'error'
  | 'cancelled'

export type Destination = 'server' | 'direct' | 'quark'

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
  request?: NewDownloadRequest
  autoRetries?: number
}

export type NewDownloadRequest = {
  url: string
  preset: string
  playlist: boolean
  destination: Destination
  subtitles?: boolean
  subLang1?: string
  subLang2?: string
  burnSubs?: boolean
  burnLang?: string
  container?: string
  seqStart?: number
  translateTitle?: boolean
  translateTo?: string
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

export type QuarkSettings = {
  client: string
  cookie: string
  folderId: string
  folderName: string
}

export type QuarkClientOption = { id: string; label: string }
export type QuarkFolder = { fid: string; name: string }
export type QuarkStatus = { loggedIn: boolean; folderId: string; folderName: string }

export type Settings = {
  downloadDir: string
  ytdlpPath: string
  ffmpegPath: string
  extraArgs: string
  playlistSleep: number
  cookieCloud: CookieCloudSettings
  quark: QuarkSettings
}

export type ArchiveFile = {
  name: string
  size: number
  modifiedAt: number
}
