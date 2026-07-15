import { createDecipheriv, createHash } from 'node:crypto'
import fs from 'node:fs'
import { COOKIES_FILE, getSettings } from './config.js'
import type { CookieCloudStatus } from './types.js'

type CloudCookie = {
  name: string
  value: string
  domain: string
  path?: string
  expirationDate?: number
  secure?: boolean
  hostOnly?: boolean
  session?: boolean
}

type CookiePayload = {
  cookie_data?: Record<string, CloudCookie[]>
}

const status: CookieCloudStatus = {
  lastSyncAt: null,
  cookieCount: 0,
  domainCount: 0,
  lastError: null
}

let syncTimer: NodeJS.Timeout | null = null

export function getCookieCloudStatus(): CookieCloudStatus {
  return status
}

// CookieCloud encrypts with CryptoJS AES (OpenSSL EVP format, MD5 key derivation).
// Passphrase is the first 16 chars of md5(uuid + '-' + password).
function decryptPayload(encryptedB64: string, uuid: string, password: string): CookiePayload {
  const passphrase = createHash('md5').update(`${uuid}-${password}`).digest('hex').slice(0, 16)
  const data = Buffer.from(encryptedB64, 'base64')
  if (data.subarray(0, 8).toString('latin1') !== 'Salted__') {
    throw new Error('Unexpected payload format from CookieCloud server')
  }
  const salt = data.subarray(8, 16)
  const ciphertext = data.subarray(16)

  let keyIv = Buffer.alloc(0)
  let block = Buffer.alloc(0)
  while (keyIv.length < 48) {
    block = createHash('md5')
      .update(Buffer.concat([block, Buffer.from(passphrase), salt]))
      .digest()
    keyIv = Buffer.concat([keyIv, block])
  }
  const decipher = createDecipheriv('aes-256-cbc', keyIv.subarray(0, 32), keyIv.subarray(32, 48))
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  return JSON.parse(plain) as CookiePayload
}

function toNetscape(cookieData: Record<string, CloudCookie[]>): { text: string; count: number } {
  const lines = ['# Netscape HTTP Cookie File', '# Synced from CookieCloud', '']
  let count = 0
  for (const cookies of Object.values(cookieData)) {
    for (const c of cookies) {
      if (!c.name || !c.domain) continue
      const includeSubdomains = c.domain.startsWith('.') ? 'TRUE' : 'FALSE'
      const secure = c.secure ? 'TRUE' : 'FALSE'
      const expiry = c.session || !c.expirationDate ? 0 : Math.floor(c.expirationDate)
      lines.push(
        [c.domain, includeSubdomains, c.path ?? '/', secure, expiry, c.name, c.value ?? ''].join('\t')
      )
      count++
    }
  }
  lines.push('')
  return { text: lines.join('\n'), count }
}

export async function syncCookies(): Promise<CookieCloudStatus> {
  const { serverUrl, uuid, password } = getSettings().cookieCloud
  if (!serverUrl || !uuid || !password) {
    throw new Error('CookieCloud is not configured (server URL, UUID and password are required)')
  }
  try {
    const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/get/${encodeURIComponent(uuid)}`)
    if (!res.ok) throw new Error(`CookieCloud server responded with ${res.status}`)
    const body = (await res.json()) as { encrypted?: string }
    if (!body.encrypted) throw new Error('CookieCloud response did not contain encrypted data')

    const payload = decryptPayload(body.encrypted, uuid, password)
    const cookieData = payload.cookie_data ?? {}
    const { text, count } = toNetscape(cookieData)
    fs.writeFileSync(COOKIES_FILE, text)

    status.lastSyncAt = Date.now()
    status.cookieCount = count
    status.domainCount = Object.keys(cookieData).length
    status.lastError = null
    return status
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err)
    throw err
  }
}

export function hasCookies(): boolean {
  return fs.existsSync(COOKIES_FILE)
}

export function scheduleAutoSync(): void {
  if (syncTimer) clearInterval(syncTimer)
  syncTimer = null
  const { autoSyncMinutes, serverUrl, uuid, password } = getSettings().cookieCloud
  if (autoSyncMinutes > 0 && serverUrl && uuid && password) {
    syncTimer = setInterval(() => {
      syncCookies().catch((err) => console.error('[cookiecloud] auto sync failed:', err.message))
    }, autoSyncMinutes * 60_000)
    syncTimer.unref()
  }
}
