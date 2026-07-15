import { ref, watchEffect } from 'vue'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'ytwd:theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

function systemTheme(): Theme {
  return media.matches ? 'dark' : 'light'
}

const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
export const theme = ref<Theme>(stored ?? systemTheme())

// Follow the OS/browser preference live, but only until the user picks explicitly
media.addEventListener('change', () => {
  if (!localStorage.getItem(STORAGE_KEY)) theme.value = systemTheme()
})

watchEffect(() => {
  document.documentElement.setAttribute('data-bs-theme', theme.value)
})

export function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem(STORAGE_KEY, theme.value)
}
