import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { scheduleAutoSync } from './cookiecloud.js'
import { manager } from './downloader.js'
import { api } from './routes.js'
import type { Download } from './types.js'

const PORT = Number(process.env.PORT ?? 3033)

const app = express()
app.use('/api', api)

// Serve the built client when it exists (production mode)
const clientDist = path.resolve(fileURLToPath(import.meta.url), '../../../client/dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
}

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', downloads: manager.list() }))
})

// Throttle broadcasts so rapid progress lines don't flood clients
let pending: Download[] | null = null
let flushTimer: NodeJS.Timeout | null = null

manager.on('update', (downloads: Download[]) => {
  pending = downloads
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (!pending) return
    const msg = JSON.stringify({ type: 'state', downloads: pending })
    pending = null
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg)
    }
  }, 350)
})

scheduleAutoSync()

server.listen(PORT, () => {
  console.log(`yt-web-downloader server listening on http://localhost:${PORT}`)
})
