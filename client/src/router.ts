import { createRouter, createWebHistory } from 'vue-router'
import ArchiveView from './views/ArchiveView.vue'
import DownloadsView from './views/DownloadsView.vue'
import SettingsView from './views/SettingsView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'downloads', component: DownloadsView },
    { path: '/archive', name: 'archive', component: ArchiveView },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})
