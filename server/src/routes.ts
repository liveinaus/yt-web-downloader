import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { getSettings, updateSettings } from './config.js'
import { ensureFreshCookies, getCookieCloudStatus, scheduleAutoSync, syncCookies } from './cookiecloud.js'
import { manager, PRESETS } from './downloader.js'
import type { NewDownloadRequest, Settings } from './types.js'

// express.json() is applied once at the app level in index.ts, before this
// router is mounted, so req.body is already parsed by the time routes run
export const api: Router = Router()

api.get('/downloads', (_req, res) => {
  res.json(manager.list())
})

api.post('/downloads', async (req, res) => {
  const body = req.body as NewDownloadRequest
  if (!body?.url || !/^https?:\/\//i.test(body.url)) {
    res.status(400).json({ error: 'A valid http(s) URL is required' })
    return
  }
  if (body.destination && body.destination !== 'server' && body.destination !== 'direct') {
    res.status(400).json({ error: "destination must be 'server' or 'direct'" })
    return
  }
  // Refresh CookieCloud cookies if stale so YouTube's bot check passes without
  // the user having to sync manually first.
  await ensureFreshCookies()
  res.status(201).json(manager.start(body))
})

// Streams a completed "direct" download straight to the browser, then deletes
// the server's copy once the transfer succeeds
api.get('/downloads/:id/file', (req, res) => {
  const dl = manager.get(req.params.id)
  if (!dl || dl.destination !== 'direct') {
    res.status(404).json({ error: 'Download not found' })
    return
  }
  if (dl.delivered) {
    res.status(410).json({ error: 'File already delivered and removed from the server' })
    return
  }
  if (dl.status !== 'completed' || !dl.filepath || !fs.existsSync(dl.filepath)) {
    res.status(409).json({ error: 'File is not ready yet' })
    return
  }
  res.download(dl.filepath, dl.filename ?? path.basename(dl.filepath), (err) => {
    if (err) {
      console.error('[downloads] file delivery failed:', err.message)
      return
    }
    // res.download's callback also fires for HEAD requests (no body sent), so
    // only clean up once the bytes have actually been transferred
    if (req.method === 'GET') manager.markDelivered(dl.id)
  })
})

api.delete('/downloads/finished', (_req, res) => {
  manager.clearFinished()
  res.json({ ok: true })
})

api.delete('/downloads/:id', (req, res) => {
  if (!manager.remove(req.params.id)) {
    res.status(404).json({ error: 'Download not found' })
    return
  }
  res.json({ ok: true })
})

api.post('/downloads/:id/cancel', (req, res) => {
  if (!manager.cancel(req.params.id)) {
    res.status(404).json({ error: 'Download not found' })
    return
  }
  res.json({ ok: true })
})

api.get('/presets', (_req, res) => {
  res.json(Object.keys(PRESETS))
})

api.get('/settings', (_req, res) => {
  res.json({ settings: getSettings(), cookieCloud: getCookieCloudStatus() })
})

api.put('/settings', (req, res) => {
  const updated = updateSettings(req.body as Partial<Settings>)
  scheduleAutoSync()
  res.json(updated)
})

api.post('/cookiecloud/sync', async (_req, res) => {
  try {
    res.json(await syncCookies())
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

api.get('/files', (_req, res) => {
  const dir = getSettings().downloadDir
  try {
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.endsWith('.part') && !e.name.endsWith('.ytdl'))
      .map((e) => {
        const stat = fs.statSync(path.join(dir, e.name))
        return { name: e.name, size: stat.size, modifiedAt: stat.mtimeMs }
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
    res.json(files)
  } catch {
    res.json([])
  }
})

api.get('/files/:name', (req, res) => {
  const dir = path.resolve(getSettings().downloadDir)
  const target = path.resolve(dir, req.params.name)
  if (!target.startsWith(dir + path.sep) || !fs.existsSync(target)) {
    res.status(404).json({ error: 'File not found' })
    return
  }
  res.download(target)
})

api.delete('/files/:name', (req, res) => {
  const dir = path.resolve(getSettings().downloadDir)
  const target = path.resolve(dir, req.params.name)
  if (!target.startsWith(dir + path.sep) || !fs.existsSync(target)) {
    res.status(404).json({ error: 'File not found' })
    return
  }
  fs.unlinkSync(target)
  res.json({ ok: true })
})
