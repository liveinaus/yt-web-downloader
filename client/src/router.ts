import { createRouter, createWebHistory } from 'vue-router'
import { isAuthenticated, requirePasswordChangeSignal } from './auth'
import ArchiveView from './views/ArchiveView.vue'
import DownloadsView from './views/DownloadsView.vue'
import LoginView from './views/LoginView.vue'
import SettingsView from './views/SettingsView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
    { path: '/', name: 'downloads', component: DownloadsView },
    { path: '/archive', name: 'archive', component: ArchiveView },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})

router.beforeEach((to) => {
  const isPublic = to.meta.public === true
  const authed = isAuthenticated()

  if (!isPublic && !authed) return '/login'
  if (isPublic && authed) return '/'
  if (authed && requirePasswordChangeSignal.value && to.path !== '/settings') return '/settings'
  return true
})
