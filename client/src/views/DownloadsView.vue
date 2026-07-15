<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import DownloadCard from '../components/DownloadCard.vue'
import { useDownloadsStore } from '../stores/downloads'

const store = useDownloadsStore()

const url = ref('')
const preset = ref('best')
const playlist = ref(false)
const destination = ref<'server' | 'direct'>('server')
const presets = ref<string[]>(['best'])
const submitting = ref(false)
const error = ref<string | null>(null)

const active = computed(() =>
  store.downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'processing' || d.status === 'queued'
  )
)
const finished = computed(() =>
  store.downloads.filter(
    (d) => d.status === 'completed' || d.status === 'error' || d.status === 'cancelled'
  )
)

onMounted(async () => {
  store.refresh()
  presets.value = await api.getPresets()
})

async function submit(): Promise<void> {
  if (!url.value.trim()) return
  submitting.value = true
  error.value = null
  try {
    await api.addDownload(url.value.trim(), preset.value, playlist.value, destination.value)
    url.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="panel">
    <form class="add-form" @submit.prevent="submit">
      <input v-model="url" type="url" placeholder="Paste a video or playlist URL…" required />
      <select v-model="preset">
        <option v-for="p in presets" :key="p" :value="p">{{ p }}</option>
      </select>
      <label class="check">
        <input v-model="playlist" type="checkbox" />
        Playlist
      </label>
      <div class="dest-toggle">
        <button
          type="button"
          :class="{ active: destination === 'server' }"
          @click="destination = 'server'"
        >
          Save to server
        </button>
        <button
          type="button"
          :class="{ active: destination === 'direct' }"
          @click="destination = 'direct'"
        >
          Direct to device
        </button>
      </div>
      <button class="primary" type="submit" :disabled="submitting">Download</button>
    </form>
    <p v-if="error" class="notice err">{{ error }}</p>
  </div>

  <div class="section-head">
    <h2>Active ({{ active.length }})</h2>
  </div>
  <div class="cards">
    <DownloadCard v-for="d in active" :key="d.id" :download="d" />
    <p v-if="!active.length" class="empty">No active downloads</p>
  </div>

  <div class="section-head">
    <h2>History ({{ finished.length }})</h2>
    <button v-if="finished.length" class="ghost" @click="api.clearFinished()">Clear all</button>
  </div>
  <div class="cards">
    <DownloadCard v-for="d in finished" :key="d.id" :download="d" />
    <p v-if="!finished.length" class="empty">Nothing here yet</p>
  </div>
</template>
