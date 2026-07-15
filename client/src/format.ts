export function formatBytes(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatSpeed(bytesPerSec: number | null): string {
  return bytesPerSec === null ? '—' : `${formatBytes(bytesPerSec)}/s`
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function formatDate(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleString()
}
