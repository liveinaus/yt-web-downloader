import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'

// Publicly known placeholder secrets that must never sign real tokens
const KNOWN_DEFAULT_SECRETS = new Set(['change-me-in-production', 'changeme', 'secret'])

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    console.error('FATAL: JWT_SECRET env var is not set. Set it before starting the server.')
    process.exit(1)
  }
  if (KNOWN_DEFAULT_SECRETS.has(secret.trim())) {
    console.error(
      'FATAL: JWT_SECRET is set to a publicly known default. Generate a unique secret, e.g. `openssl rand -hex 32`.'
    )
    process.exit(1)
  }
  return secret
}

export type SessionTokenPayload = {
  sub: string
  typ?: string
  cap?: string
  requirePasswordChange?: boolean
}

// Verifies a JWT is a genuine session token, not the short-lived captcha token
// (which carries `cap` and no `sub`) signed with the same secret
export function verifySessionToken(token: string): SessionTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as SessionTokenPayload
    if (!decoded.sub || decoded.cap !== undefined || (decoded.typ !== undefined && decoded.typ !== 'auth')) {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined

  if (!token) {
    res.status(401).json({ error: 'Unauthorised' })
    return
  }

  const decoded = verifySessionToken(token)
  if (!decoded) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  // Restrict access until the default password is changed
  if (decoded.requirePasswordChange) {
    const path = req.originalUrl.split('?')[0]
    if (!(req.method === 'PUT' && path === '/api/auth/credentials')) {
      res.status(403).json({ error: 'Password change required', requirePasswordChange: true })
      return
    }
  }
  next()
}
