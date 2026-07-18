import 'dotenv/config'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { getJwtSecret, requireAuth, verifySessionToken } from './authMiddleware.js'
import { authRouter } from './authRoutes.js'
import { bootstrapCredentials } from './credentials.js'
import { scheduleAutoSync } from './cookiecloud.js'
import { manager } from './downloader.js'
import { api } from './routes.js'
import type { Download } from './types.js'

// Validate critical env vars and seed the admin account before accepting requests
getJwtSecret()
await bootstrapCredentials()

const PORT = Number(process.env.PORT ?? 3033)
const HOST = process.env.HOST ?? '0.0.0.0'

const app = express()

// TRUST_PROXY: number of reverse-proxy hops in front of this app.
// 0 = direct internet (default); set to 1+ behind nginx/Caddy/Cloudflare so
// rate limiting and logging see the real client IP instead of the proxy's.
const trustProxy = process.env.TRUST_PROXY ?? '0'
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy)

app.use(express.json())

// Baseline security headers, dependency-free
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
})

app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', version: process.env.APP_VERSION ?? 'dev' })
)
app.use('/api/auth', authRouter)
app.use('/api', requireAuth, api)

// Serve the built client when it exists (production mode)
const clientDist = path.resolve(fileURLToPath(import.meta.url), '../../../client/dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
}

const server = http.createServer(app)
// Behind a reverse proxy (Cloudflare/nginx/Caddy), Node's default 5s keep-alive
// races the proxy's connection reuse: the app closes an idle socket just as the
// proxy sends the next request into it, which surfaces as sporadic bare 502s.
// Keep sockets open longer than any common proxy idle timeout.
server.keepAliveTimeout = 120_000
server.headersTimeout = 125_000
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  // Authenticate via the first message (not a URL query param) so tokens
  // never end up in access logs
  const authTimeout = setTimeout(() => ws.close(1008, 'Auth timeout'), 5_000)

  ws.once('message', (raw: Buffer) => {
    clearTimeout(authTimeout)
    let msg: { type?: string; token?: string }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      ws.close(1008, 'Invalid auth message')
      return
    }
    if (msg.type !== 'auth' || !msg.token) {
      ws.close(1008, 'Expected auth message')
      return
    }
    const decoded = verifySessionToken(msg.token)
    if (!decoded || decoded.requirePasswordChange) {
      ws.close(1008, 'Unauthorised')
      return
    }
    ws.send(JSON.stringify({ type: 'state', downloads: manager.list() }))
  })
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

server.listen(PORT, HOST, () => {
  console.log(`yt-web-downloader server listening on http://localhost:${PORT}`)
})
