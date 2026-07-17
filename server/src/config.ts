import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from './types.js'

export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data')
export const COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt')

const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

const defaults: Settings = {
  downloadDir: path.join(DATA_DIR, 'downloads'),
  ytdlpPath: 'yt-dlp',
  ffmpegPath: '',
  extraArgs: '',
  cookieCloud: {
    serverUrl: '',
    uuid: '',
    password: '',
    autoSyncMinutes: 0
  },
  quark: {
    client: 'quark',
    cookie: '',
    folderId: '0',
    folderName: 'Root'
  }
}

let settings: Settings = load()

function load(): Settings {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Settings>
    return {
      ...defaults,
      ...raw,
      cookieCloud: { ...defaults.cookieCloud, ...(raw.cookieCloud ?? {}) },
      quark: { ...defaults.quark, ...(raw.quark ?? {}) }
    }
  } catch {
    return { ...defaults, cookieCloud: { ...defaults.cookieCloud }, quark: { ...defaults.quark } }
  }
}

export function getSettings(): Settings {
  return settings
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings = {
    ...settings,
    ...patch,
    cookieCloud: { ...settings.cookieCloud, ...(patch.cookieCloud ?? {}) },
    quark: { ...settings.quark, ...(patch.quark ?? {}) }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2))
  return settings
}
