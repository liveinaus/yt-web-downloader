import { clearSession, getToken, requirePasswordChangeSignal } from './auth'
import type {
  ArchiveFile,
  CookieCloudStatus,
  Download,
  NewDownloadRequest,
  QuarkClientOption,
  QuarkFolder,
  QuarkStatus,
  Settings
} from './types'

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(url, { ...init, headers })

  // A 401 on the login/captcha endpoints themselves just means "wrong
  // password" -- only treat it as a dead session on every other endpoint
  const isAuthEndpoint = url.startsWith('/api/auth/')
  if (res.status === 401 && !isAuthEndpoint) {
    clearSession()
    window.location.href = '/login'
    throw new Error('Session expired')
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string; requirePasswordChange?: boolean }
      | null
    if (res.status === 403 && body?.requirePasswordChange) {
      requirePasswordChangeSignal.value = true
    }
    throw new Error(body?.error ?? `Request failed with status ${res.status}`)
  }
  return res.json() as Promise<T>
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

// Fetches a protected file with the auth header. A plain anchor navigation
// can't carry the bearer token, so the file routes 401 without this.
async function fetchBlob(url: string): Promise<Blob> {
  const token = getToken()
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(url, { headers })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Download failed with status ${res.status}`)
  }
  return res.blob()
}

export const authApi = {
  getCaptcha: () => request<{ svg: string; captchaToken: string }>('/api/auth/captcha'),
  login: (username: string, password: string, captchaToken: string, captchaAnswer: string) =>
    request<{ token: string; requirePasswordChange?: boolean }>('/api/auth/login', {
      method: 'POST',
      ...json({ username, password, captchaToken, captchaAnswer })
    }),
  updateCredentials: (currentPassword: string, username?: string, newPassword?: string) =>
    request<{ message: string; token: string }>('/api/auth/credentials', {
      method: 'PUT',
      ...json({ currentPassword, username, newPassword })
    })
}

export const api = {
  getHealth: () => request<{ status: string; version: string }>('/api/health'),
  listDownloads: () => request<Download[]>('/api/downloads'),
  addDownload: (req: NewDownloadRequest) =>
    request<Download>('/api/downloads', {
      method: 'POST',
      ...json(req)
    }),
  retryDownload: (id: string) =>
    request<Download>(`/api/downloads/${id}/retry`, { method: 'POST' }),
  cancelDownload: (id: string) => request<void>(`/api/downloads/${id}/cancel`, { method: 'POST' }),
  removeDownload: (id: string) => request<void>(`/api/downloads/${id}`, { method: 'DELETE' }),
  clearFinished: () => request<void>('/api/downloads/finished', { method: 'DELETE' }),
  getPresets: () => request<string[]>('/api/presets'),
  getYtdlpVersion: () => request<{ version: string }>('/api/ytdlp/version'),
  updateYtdlp: () =>
    request<{ version: string; path: string }>('/api/ytdlp/update', { method: 'POST' }),
  getSettings: () =>
    request<{ settings: Settings; cookieCloud: CookieCloudStatus }>('/api/settings'),
  saveSettings: (settings: Settings) =>
    request<Settings>('/api/settings', { method: 'PUT', ...json(settings) }),
  syncCookies: () => request<CookieCloudStatus>('/api/cookiecloud/sync', { method: 'POST' }),
  getQuarkClients: () => request<QuarkClientOption[]>('/api/quark/clients'),
  startQuarkLogin: (client: string) =>
    request<{ token: string; qrUrl: string }>('/api/quark/login/start', {
      method: 'POST',
      ...json({ client })
    }),
  pollQuarkLogin: (token: string) =>
    request<{ status: 'pending' | 'confirmed' | 'expired' }>(
      `/api/quark/login/poll?token=${encodeURIComponent(token)}`
    ),
  listQuarkFolders: (parentId: string) =>
    request<QuarkFolder[]>(`/api/quark/folders?parentId=${encodeURIComponent(parentId)}`),
  createQuarkFolder: (parentId: string, name: string) =>
    request<{ ok: boolean }>('/api/quark/folders', { method: 'POST', ...json({ parentId, name }) }),
  getQuarkStatus: () => request<QuarkStatus>('/api/quark/status'),
  setQuarkTarget: (folderId: string, folderName: string) =>
    request<{ ok: boolean }>('/api/quark/target', { method: 'PUT', ...json({ folderId, folderName }) }),
  listFiles: () => request<ArchiveFile[]>('/api/files'),
  deleteFile: (name: string) =>
    request<void>(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  fetchDownloadFile: (id: string) => fetchBlob(`/api/downloads/${id}/file`),
  fetchArchiveFile: (name: string) => fetchBlob(`/api/files/${encodeURIComponent(name)}`)
}
