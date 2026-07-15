import type { ArchiveFile, CookieCloudStatus, Destination, Download, Settings } from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with status ${res.status}`)
  }
  return res.json() as Promise<T>
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

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
