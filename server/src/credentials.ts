import argon2 from 'argon2'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

// Kept separate from config.json/Settings so the password hash can never leak
// through the general /api/settings endpoint used to populate the Settings UI
const AUTH_FILE = path.join(DATA_DIR, 'auth.json')

type StoredCredentials = {
  username: string
  passwordHash: string
}

let cached: StoredCredentials | null = null

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, password)
}

// Creates the initial admin account from env vars on first boot, so there's a
// single source of truth (auth.json) from then on regardless of env changes
export async function bootstrapCredentials(): Promise<void> {
  if (fs.existsSync(AUTH_FILE)) return
  const username = process.env.ADMIN_USERNAME ?? 'admin'
  const password = process.env.ADMIN_PASSWORD ?? 'changeme'
  await setCredentials(username, password)
}

export function getCredentials(): StoredCredentials {
  if (cached) return cached
  fs.mkdirSync(DATA_DIR, { recursive: true })
  cached = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as StoredCredentials
  return cached
}

export async function setCredentials(username: string, password: string): Promise<void> {
  cached = { username, passwordHash: await hashPassword(password) }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(AUTH_FILE, JSON.stringify(cached, null, 2))
}
