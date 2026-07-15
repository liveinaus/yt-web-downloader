import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'
import type { Download } from '../types'

export const useDownloadsStore = defineStore('downloads', () => {
  const downloads = ref<Download[]>([])
  const connected = ref(false)

  let ws: WebSocket | null = null
  let retryTimer: number | null = null

  // Tracks the previous status per download so we can detect the exact moment
  // a "direct" download finishes and fire the browser save automatically,
  // without re-firing on every reconnect/refresh for already-seen items
  let lastStatus = new Map<string, string>()

  function triggerBrowserSave(d: Download): void {
    const a = document.createElement('a')
    a.href = `/api/downloads/${d.id}/file`
    a.download = d.filename ?? ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  function applyState(list: Download[]): void {
    for (const d of list) {
      const prevStatus = lastStatus.get(d.id)
      if (
        prevStatus !== undefined &&
        prevStatus !== 'completed' &&
        d.status === 'completed' &&
        d.destination === 'direct' &&
        !d.delivered
      ) {
        triggerBrowserSave(d)
      }
    }
    lastStatus = new Map(list.map((d) => [d.id, d.status]))
    downloads.value = list
  }

  function connect(): void {
    if (ws) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onopen = () => {
      connected.value = true
    }
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as { type: string; downloads: Download[] }
      if (msg.type === 'state') applyState(msg.downloads)
    }
    ws.onclose = () => {
      connected.value = false
      ws = null
      retryTimer = window.setTimeout(connect, 2000)
    }
    ws.onerror = () => ws?.close()
  }

  function disconnect(): void {
    if (retryTimer) window.clearTimeout(retryTimer)
    ws?.close()
    ws = null
  }

  async function refresh(): Promise<void> {
    applyState(await api.listDownloads())
  }

  return { downloads, connected, connect, disconnect, refresh }
})
