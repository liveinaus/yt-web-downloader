// Persists the download form choices (everything except the URL) so users don't
// have to re-pick them each visit. Uses localStorage to match the app's other
// client-side state (auth token, theme).
import type { Destination } from './types'

const KEY = 'ytwd:downloadPrefs'

export type DownloadPrefs = {
  preset: string
  container: string
  playlist: boolean
  destination: Destination
  subtitles: boolean
  subLang1: string
  subLang2: string
  burnSubs: boolean
  burnLang: string
  translateTitle: boolean
  translateTo: string
}

export const defaultPrefs: DownloadPrefs = {
  preset: 'best',
  container: '',
  playlist: false,
  destination: 'server',
  subtitles: false,
  subLang1: 'en',
  subLang2: 'zh-Hans',
  burnSubs: false,
  burnLang: 'bilingual',
  translateTitle: false,
  translateTo: 'zh-CN'
}

export function loadPrefs(): DownloadPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...defaultPrefs, ...(JSON.parse(raw) as Partial<DownloadPrefs>) } : { ...defaultPrefs }
  } catch {
    return { ...defaultPrefs }
  }
}

export function savePrefs(prefs: DownloadPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Storage unavailable (private mode / quota) - prefs just won't persist
  }
}
