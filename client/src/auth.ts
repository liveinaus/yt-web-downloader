import { ref } from 'vue'

const TOKEN_KEY = 'ytwd:token'
const FORCE_PWD_KEY = 'ytwd:requirePasswordChange'

// Reactive so the router guard and the App shell banner update the instant
// the server flags (or clears) a forced password change
export const requirePasswordChangeSignal = ref(localStorage.getItem(FORCE_PWD_KEY) === '1')

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function isAuthenticated(): boolean {
  return getToken() !== null
}

export function setSession(token: string, requirePasswordChange: boolean): void {
  localStorage.setItem(TOKEN_KEY, token)
  if (requirePasswordChange) {
    localStorage.setItem(FORCE_PWD_KEY, '1')
  } else {
    localStorage.removeItem(FORCE_PWD_KEY)
  }
  requirePasswordChangeSignal.value = requirePasswordChange
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(FORCE_PWD_KEY)
  requirePasswordChangeSignal.value = false
}
