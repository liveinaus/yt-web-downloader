<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from './api'
import { isAuthenticated, requirePasswordChangeSignal } from './auth'
import { theme, toggleTheme } from './theme'
import { useDownloadsStore } from './stores/downloads'

const store = useDownloadsStore()
const route = useRoute()
const version = ref('')

// The server refuses the WebSocket (and every other route) until the forced
// password change is done, so don't attempt it -- just wait for the signal
// to clear, then connect once
onMounted(() => {
  if (isAuthenticated() && !requirePasswordChangeSignal.value) store.connect()
  api
    .getHealth()
    .then((h) => (version.value = h.version))
    .catch(() => {
      // non-fatal; the navbar just won't show a version
    })
})
watch(requirePasswordChangeSignal, (stillRequired) => {
  if (isAuthenticated() && !stillRequired) store.connect()
})
onUnmounted(() => store.disconnect())
</script>

<template>
  <template v-if="route.meta.public">
    <RouterView />
  </template>
  <template v-else>
    <nav class="navbar navbar-expand-lg bg-body-tertiary border-bottom">
      <div class="container-fluid">
        <RouterLink class="navbar-brand fw-bold" to="/">
          yt-web-downloader
          <span v-if="version" class="fw-normal small text-body-secondary ms-1">{{ version }}</span>
        </RouterLink>
        <button
          class="navbar-toggler"
          type="button"
          data-bs-toggle="collapse"
          data-bs-target="#navbarContent"
        >
          <span class="navbar-toggler-icon" />
        </button>
        <div class="collapse navbar-collapse" id="navbarContent">
          <ul class="navbar-nav me-auto">
            <li class="nav-item">
              <RouterLink class="nav-link" active-class="active" to="/">Downloads</RouterLink>
            </li>
            <li class="nav-item">
              <RouterLink class="nav-link" active-class="active" to="/archive">Archive</RouterLink>
            </li>
            <li class="nav-item">
              <RouterLink class="nav-link" active-class="active" to="/settings">Settings</RouterLink>
            </li>
          </ul>
          <div class="d-flex align-items-center gap-3">
            <span class="badge rounded-pill" :class="store.connected ? 'text-bg-success' : 'text-bg-secondary'">
              <span class="rounded-circle bg-white d-inline-block status-dot me-1" />
              {{ store.connected ? 'Live' : requirePasswordChangeSignal ? 'Locked' : 'Reconnecting…' }}
            </span>
            <button class="btn btn-outline-secondary btn-sm" type="button" @click="toggleTheme">
              {{ theme === 'dark' ? 'Light mode' : 'Dark mode' }}
            </button>
          </div>
        </div>
      </div>
    </nav>
    <div v-if="requirePasswordChangeSignal" class="alert alert-danger rounded-0 mb-0 text-center">
      You're using the default password. Set a new one below before continuing.
    </div>
    <main class="container py-4">
      <RouterView />
    </main>
  </template>
</template>
