<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useDownloadsStore } from './stores/downloads'

const store = useDownloadsStore()

onMounted(() => store.connect())
onUnmounted(() => store.disconnect())
</script>

<template>
  <header class="topbar">
    <div class="brand"><span class="dot" /> yt-web-downloader</div>
    <nav class="nav">
      <RouterLink to="/">Downloads</RouterLink>
      <RouterLink to="/archive">Archive</RouterLink>
      <RouterLink to="/settings">Settings</RouterLink>
    </nav>
    <div class="conn" :class="{ online: store.connected }">
      <span class="dot" />
      {{ store.connected ? 'Live' : 'Reconnecting…' }}
    </div>
  </header>
  <main class="page">
    <RouterView />
  </main>
</template>
