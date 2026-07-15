import { clearSession, getToken, requirePasswordChangeSignal } from './auth'
import type { ArchiveFile, CookieCloudStatus, Destination, Download, Settings } from './types'

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
  listDownloads: () => request<Download[]>('/api/downloads'),
  addDownload: (url: string, preset: string, playlist: boolean, destination: Destination) =>
    request<Download>('/api/downloads', {
      method: 'POST',
      ...json({ url, preset, playlist, destination })
    }),
  cancelDownload: (id: string) => request<void>(`/api/downloads/${id}/cancel`, { method: 'POST' }),
  removeDownload: (id: string) => request<void>(`/api/downloads/${id}`, { method: 'DELETE' }),
  clearFinished: () => request<void>('/api/downloads/finished', { method: 'DELETE' }),
  getPresets: () => request<string[]>('/api/presets'),
  getSettings: () =>
    request<{ settings: Settings; cookieCloud: CookieCloudStatus }>('/api/settings'),
  saveSettings: (settings: Settings) =>
    request<Settings>('/api/settings', { method: 'PUT', ...json(settings) }),
  syncCookies: () => request<CookieCloudStatus>('/api/cookiecloud/sync', { method: 'POST' }),
  listFiles: () => request<ArchiveFile[]>('/api/files'),
  deleteFile: (name: string) =>
    request<void>(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
