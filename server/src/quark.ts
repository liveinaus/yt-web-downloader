// Minimal client for uploading a local file to Quark Drive (pan.quark.cn).
// Quark has no official API; this ports the reverse-engineered upload flow used
// by AList's quark_uc driver: pre -> instant-upload(hash) -> per-part OSS auth +
// PUT -> commit -> finish. Quark signs each OSS request server-side (we send it
// the canonical string as "auth_meta" and it returns the Authorization header).
import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const API = 'https://drive.quark.cn/1/clouddrive'
const REFERER = 'https://pan.quark.cn'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch'
const OSS_UA = 'aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit'
const LOGIN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
const UOP = 'https://uop.quark.cn/cas/ajax'
const QR_BASE = 'https://su.quark.cn/4_eMHBJ'

// Supported login clients. Each maps to a Quark CAS client_id. Only the web
// client currently yields a cookie the drive upload API accepts.
export const QUARK_CLIENTS: Record<string, { label: string; clientId: string }> = {
  quark: { label: 'Quark', clientId: '532' }
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', wav: 'audio/wav',
  vtt: 'text/vtt', srt: 'application/x-subrip'
}

function mimeOf(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

type UpPreData = {
  task_id: string
  upload_id: string
  obj_key: string
  upload_url: string
  fid: string
  bucket: string
  auth_info: string
  callback: { callbackUrl: string; callbackBody: string }
}
type UpPreResp = {
  status?: number; code?: number; message?: string
  data: UpPreData
  metadata: { part_size: number }
}
type HashResp = { status?: number; code?: number; message?: string; data: { finish: boolean; fid: string } }
type UpAuthResp = { status?: number; code?: number; message?: string; data: { auth_key: string } }

type SortResp = {
  status?: number; code?: number; message?: string
  data: { list: { fid: string; file_name: string; file: boolean }[] }
  metadata: { _total: number }
}

export type QuarkFolder = { fid: string; name: string }

export type UploadProgress = (percent: number) => void

export class QuarkClient {
  private cookie: string
  private onCookieUpdate?: (cookie: string) => void

  constructor(cookie: string, onCookieUpdate?: (cookie: string) => void) {
    this.cookie = cookie
    this.onCookieUpdate = onCookieUpdate
  }

  // Quark rotates the __puus cookie on each response; keep it fresh or the
  // session dies mid-upload
  private absorbCookie(res: Response): void {
    const setCookies = res.headers.getSetCookie?.() ?? []
    for (const sc of setCookies) {
      const m = /^__puus=([^;]+)/.exec(sc)
      if (m) {
        const re = /(^|;\s*)__puus=[^;]*/
        this.cookie = re.test(this.cookie)
          ? this.cookie.replace(re, `$1__puus=${m[1]}`)
          : this.cookie
            ? `${this.cookie}; __puus=${m[1]}`
            : `__puus=${m[1]}`
        this.onCookieUpdate?.(this.cookie)
      }
    }
  }

  private async call<T>(
    pathname: string,
    method: string,
    opts: { body?: unknown; query?: Record<string, string | number> } = {}
  ): Promise<T> {
    const url = new URL(API + pathname)
    url.searchParams.set('pr', 'ucpro')
    url.searchParams.set('fr', 'pc')
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v))
    const res = await fetch(url, {
      method,
      headers: {
        Cookie: this.cookie,
        Accept: 'application/json, text/plain, */*',
        Referer: REFERER,
        'User-Agent': UA,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    })
    this.absorbCookie(res)
    const json = (await res.json()) as { status?: number; code?: number; message?: string }
    if ((json.status ?? 0) >= 400 || (json.code ?? 0) !== 0) {
      throw new Error(json.message || `Quark API error (status ${json.status}, code ${json.code})`)
    }
    return json as T
  }

  private hashFile(localPath: string): Promise<{ md5: string; sha1: string }> {
    return new Promise((resolve, reject) => {
      const md5 = crypto.createHash('md5')
      const sha1 = crypto.createHash('sha1')
      const stream = fs.createReadStream(localPath)
      stream.on('data', (c) => {
        md5.update(c)
        sha1.update(c)
      })
      stream.on('error', reject)
      stream.on('end', () => resolve({ md5: md5.digest('hex'), sha1: sha1.digest('hex') }))
    })
  }

  private ossUrl(d: UpPreData): string {
    // upload_url comes back as http://<host>; the real endpoint prefixes the bucket
    return `https://${d.bucket}.${d.upload_url.replace(/^https?:\/\//, '')}/${d.obj_key}`
  }

  private async upPart(
    d: UpPreData,
    mime: string,
    partNumber: number,
    chunk: ArrayBuffer
  ): Promise<string> {
    const timeStr = new Date().toUTCString()
    const authMeta = `PUT\n\n${mime}\n${timeStr}\nx-oss-date:${timeStr}\nx-oss-user-agent:${OSS_UA}\n/${d.bucket}/${d.obj_key}?partNumber=${partNumber}&uploadId=${d.upload_id}`
    const auth = await this.call<UpAuthResp>('/file/upload/auth', 'POST', {
      body: { auth_info: d.auth_info, auth_meta: authMeta, task_id: d.task_id }
    })
    const res = await fetch(`${this.ossUrl(d)}?partNumber=${partNumber}&uploadId=${d.upload_id}`, {
      method: 'PUT',
      headers: {
        Authorization: auth.data.auth_key,
        'Content-Type': mime,
        Referer: 'https://pan.quark.cn/',
        'x-oss-date': timeStr,
        'x-oss-user-agent': OSS_UA
      },
      body: chunk
    })
    if (res.status !== 200) {
      throw new Error(`Quark part ${partNumber} failed: ${res.status} ${await res.text()}`)
    }
    const etag = res.headers.get('etag')
    if (!etag) throw new Error(`Quark part ${partNumber}: response had no ETag`)
    return etag
  }

  private async upCommit(d: UpPreData, etags: string[]): Promise<void> {
    const timeStr = new Date().toUTCString()
    let body = '<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n'
    etags.forEach((etag, i) => {
      body += `<Part>\n<PartNumber>${i + 1}</PartNumber>\n<ETag>${etag}</ETag>\n</Part>\n`
    })
    body += '</CompleteMultipartUpload>'
    const contentMd5 = crypto.createHash('md5').update(body).digest('base64')
    const callbackBase64 = Buffer.from(
      JSON.stringify({ callbackUrl: d.callback.callbackUrl, callbackBody: d.callback.callbackBody })
    ).toString('base64')
    const authMeta = `POST\n${contentMd5}\napplication/xml\n${timeStr}\nx-oss-callback:${callbackBase64}\nx-oss-date:${timeStr}\nx-oss-user-agent:${OSS_UA}\n/${d.bucket}/${d.obj_key}?uploadId=${d.upload_id}`
    const auth = await this.call<UpAuthResp>('/file/upload/auth', 'POST', {
      body: { auth_info: d.auth_info, auth_meta: authMeta, task_id: d.task_id }
    })
    const res = await fetch(`${this.ossUrl(d)}?uploadId=${d.upload_id}`, {
      method: 'POST',
      headers: {
        Authorization: auth.data.auth_key,
        'Content-MD5': contentMd5,
        'Content-Type': 'application/xml',
        Referer: 'https://pan.quark.cn/',
        'x-oss-callback': callbackBase64,
        'x-oss-date': timeStr,
        'x-oss-user-agent': OSS_UA
      },
      body
    })
    if (res.status !== 200) {
      throw new Error(`Quark commit failed: ${res.status} ${await res.text()}`)
    }
  }

  // Uploads a local file to the given Quark folder (parentId "0" = root). Returns
  // the created file's id. Uses instant-upload when Quark already has the content.
  async uploadFile(
    localPath: string,
    opts: { parentId?: string; fileName?: string; onProgress?: UploadProgress } = {}
  ): Promise<{ fid: string }> {
    const size = fs.statSync(localPath).size
    const fileName = opts.fileName ?? path.basename(localPath)
    const mime = mimeOf(fileName)
    const parentId = opts.parentId || '0'
    const { md5, sha1 } = await this.hashFile(localPath)

    const now = Date.now()
    const pre = await this.call<UpPreResp>('/file/upload/pre', 'POST', {
      body: {
        ccp_hash_update: true,
        dir_name: '',
        file_name: fileName,
        format_type: mime,
        l_created_at: now,
        l_updated_at: now,
        pdir_fid: parentId,
        size
      }
    })
    const d = pre.data

    const hash = await this.call<HashResp>('/file/update/hash', 'POST', {
      body: { md5, sha1, task_id: d.task_id }
    })
    if (hash.data.finish) {
      opts.onProgress?.(100)
      return { fid: hash.data.fid || d.fid }
    }

    const partSize = pre.metadata.part_size
    const fh = await fs.promises.open(localPath, 'r')
    const etags: string[] = []
    try {
      let offset = 0
      let partNumber = 1
      while (offset < size) {
        const len = Math.min(partSize, size - offset)
        const chunk = new ArrayBuffer(len)
        await fh.read(new Uint8Array(chunk), 0, len, offset)
        etags.push(await this.upPart(d, mime, partNumber, chunk))
        offset += len
        partNumber++
        opts.onProgress?.(Math.round((offset / size) * 100))
      }
    } finally {
      await fh.close()
    }

    await this.upCommit(d, etags)
    await this.call('/file/upload/finish', 'POST', { body: { obj_key: d.obj_key, task_id: d.task_id } })
    // Quark registers the file asynchronously; give it a moment
    await new Promise((r) => setTimeout(r, 1000))
    return { fid: d.fid }
  }

  // Lists the sub-folders of a Quark folder ("0" is the drive root), for the
  // folder picker. Files are omitted; all pages are fetched.
  async listFolders(parentId = '0'): Promise<QuarkFolder[]> {
    const folders: QuarkFolder[] = []
    const size = 100
    let page = 1
    for (;;) {
      const resp = await this.call<SortResp>('/file/sort', 'GET', {
        query: {
          pdir_fid: parentId,
          _size: size,
          _page: page,
          _fetch_total: 1,
          _sort: 'file_type:asc,file_name:asc'
        }
      })
      for (const f of resp.data.list) if (!f.file) folders.push({ fid: f.fid, name: f.file_name })
      if (page * size >= resp.metadata._total) break
      page++
    }
    return folders
  }

  // Creates a sub-folder under parentId ("0" = root) and returns nothing; the
  // caller should re-list to pick up the new folder.
  async createFolder(parentId: string, name: string): Promise<void> {
    await this.call('/file', 'POST', {
      body: { dir_init_lock: false, dir_path: '', file_name: name, pdir_fid: parentId }
    })
    // Quark registers the folder asynchronously; give it a moment
    await new Promise((r) => setTimeout(r, 800))
  }
}

export type QuarkLoginStatus = 'pending' | 'confirmed' | 'expired'

// Drives Quark's QR-scan web login: fetch a QR token, poll until the phone
// confirms, then trade the service ticket for the drive session cookie. One
// instance holds the cookie jar for the whole flow.
export class QuarkLogin {
  private token = ''
  private jar = new Map<string, string>()
  readonly createdAt = Date.now()

  constructor(private clientId: string) {}

  private cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  // Fetches following redirects manually so Set-Cookie from every hop is kept
  // (global fetch only exposes the final response's cookies otherwise)
  private async fetchJar(url: string): Promise<Response> {
    let current = url
    for (let hop = 0; hop < 5; hop++) {
      const cookie = this.cookieHeader()
      const res = await fetch(current, {
        redirect: 'manual',
        headers: {
          'User-Agent': LOGIN_UA,
          Accept: 'application/json, text/plain, */*',
          ...(cookie ? { Cookie: cookie } : {})
        }
      })
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const m = /^([^=]+)=([^;]*)/.exec(sc)
        if (m) this.jar.set(m[1]!, m[2]!)
      }
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString()
        continue
      }
      return res
    }
    throw new Error('Too many redirects during Quark login')
  }

  async start(): Promise<{ token: string; qrUrl: string }> {
    const res = await this.fetchJar(
      `${UOP}/getTokenForQrcodeLogin?client_id=${this.clientId}&v=1.2&request_id=${randomUUID()}`
    )
    const data = (await res.json()) as {
      status?: number
      message?: string
      data?: { members?: { token?: string } }
    }
    const token = data.data?.members?.token
    if (data.status !== 2000000 || !token) {
      throw new Error(data.message || 'Failed to get Quark QR token')
    }
    this.token = token
    const params = new URLSearchParams({
      token,
      client_id: this.clientId,
      ssb: 'weblogin',
      uc_param_str: '',
      uc_biz_str: 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0'
    })
    return { token, qrUrl: `${QR_BASE}?${params.toString()}` }
  }

  async poll(): Promise<{ status: QuarkLoginStatus; cookie?: string }> {
    const res = await this.fetchJar(
      `${UOP}/getServiceTicketByQrcodeToken?client_id=${this.clientId}&v=1.2&token=${this.token}&request_id=${randomUUID()}`
    )
    const data = (await res.json()) as {
      status?: number
      message?: string
      data?: { members?: { service_ticket?: string } }
    }
    const serviceTicket = data.data?.members?.service_ticket
    if (data.status === 2000000 && data.message === 'ok' && serviceTicket) {
      return { status: 'confirmed', cookie: await this.exchange(serviceTicket) }
    }
    if ([50004002, 50004003, 50004004].includes(data.status ?? 0)) return { status: 'expired' }
    return { status: 'pending' }
  }

  // Trades the scan's service ticket for the drive session cookie: hitting
  // account/info?st=... makes Quark set the cookies, which we collect from the jar.
  private async exchange(serviceTicket: string): Promise<string> {
    const res = await this.fetchJar(
      `https://pan.quark.cn/account/info?st=${encodeURIComponent(serviceTicket)}&lw=scan`
    )
    await res.text()
    return this.cookieHeader()
  }
}
