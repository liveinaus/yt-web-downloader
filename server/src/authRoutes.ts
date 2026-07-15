import { Router } from 'express'
import jwt from 'jsonwebtoken'
import rateLimit from 'express-rate-limit'
import svgCaptcha from 'svg-captcha'
import { getCredentials, setCredentials, verifyPassword } from './credentials.js'
import { getJwtSecret, requireAuth } from './authMiddleware.js'

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
})

export const authRouter: Router = Router()

authRouter.get('/captcha', (_req, res) => {
  const captcha = svgCaptcha.create({ noise: 2, color: true, size: 5, ignoreChars: '0oO1lI' })
  // Store the answer (lowercase) in a short-lived signed token -- no session needed
  const captchaToken = jwt.sign({ cap: captcha.text.toLowerCase(), typ: 'captcha' }, getJwtSecret(), {
    expiresIn: '5m'
  })
  res.json({ svg: captcha.data, captchaToken })
})

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { username, password, captchaToken, captchaAnswer } = req.body as {
    username?: string
    password?: string
    captchaToken?: string
    captchaAnswer?: string
  }

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' })
    return
  }
  if (!captchaToken || !captchaAnswer) {
    res.status(400).json({ error: 'Captcha is required' })
    return
  }

  let captchaPayload: { cap?: string }
  try {
    captchaPayload = jwt.verify(captchaToken, getJwtSecret(), { algorithms: ['HS256'] }) as { cap?: string }
  } catch {
    res.status(400).json({ error: 'Captcha expired, please refresh' })
    return
  }
  if (captchaPayload.cap !== captchaAnswer.toLowerCase().trim()) {
    res.status(400).json({ error: 'Incorrect captcha' })
    return
  }

  const stored = getCredentials()
  const valid = username === stored.username && (await verifyPassword(password, stored.passwordHash))
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  const defaultPwd = process.env.ADMIN_DEFAULT_PASSWORD ?? 'changeme'
  const requirePasswordChange = password === defaultPwd
  const payload = requirePasswordChange
    ? { sub: username, typ: 'auth', requirePasswordChange: true }
    : { sub: username, typ: 'auth' }
  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' })
  res.json(requirePasswordChange ? { token, requirePasswordChange: true } : { token })
})

authRouter.put('/credentials', requireAuth, async (req, res) => {
  const { username, currentPassword, newPassword } = req.body as {
    username?: string
    currentPassword?: string
    newPassword?: string
  }

  if (!currentPassword) {
    res.status(400).json({ error: 'Current password is required' })
    return
  }

  const stored = getCredentials()
  const validCurrent = await verifyPassword(currentPassword, stored.passwordHash)
  if (!validCurrent) {
    res.status(401).json({ error: 'Current password is incorrect' })
    return
  }
  if (!username && !newPassword) {
    res.status(400).json({ error: 'Provide a new username or password' })
    return
  }

  const newUsername = username || stored.username
  const newPasswordValue = newPassword || currentPassword
  await setCredentials(newUsername, newPasswordValue)

  // Issue a fresh token so any requirePasswordChange claim is cleared
  const freshToken = jwt.sign({ sub: newUsername, typ: 'auth' }, getJwtSecret(), { expiresIn: '7d' })
  res.json({ message: 'Credentials updated', token: freshToken })
})
