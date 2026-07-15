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
  <div class="card mb-4">
    <div class="card-body">
      <form class="row g-2 align-items-center" @submit.prevent="submit">
        <div class="col-12 col-md">
          <input
            v-model="url"
            class="form-control"
            type="url"
            placeholder="Paste a video or playlist URL…"
            required
          />
        </div>
        <div class="col-auto">
          <select v-model="preset" class="form-select">
            <option v-for="p in presets" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div class="col-auto">
          <div class="form-check">
            <input id="playlist-check" v-model="playlist" class="form-check-input" type="checkbox" />
            <label class="form-check-label" for="playlist-check">Playlist</label>
          </div>
        </div>
        <div class="col-auto">
          <div class="btn-group" role="group">
            <button
              type="button"
              class="btn btn-sm"
              :class="destination === 'server' ? 'btn-primary' : 'btn-outline-secondary'"
              @click="destination = 'server'"
            >
              Save to server
            </button>
            <button
              type="button"
              class="btn btn-sm"
              :class="destination === 'direct' ? 'btn-primary' : 'btn-outline-secondary'"
              @click="destination = 'direct'"
            >
              Direct to device
            </button>
          </div>
        </div>
        <div class="col-auto">
          <button class="btn btn-primary" type="submit" :disabled="submitting">Download</button>
        </div>
      </form>
      <div v-if="error" class="alert alert-danger mt-3 mb-0 py-2">{{ error }}</div>
    </div>
  </div>

  <div class="d-flex justify-content-between align-items-center mb-2">
    <h2 class="h5 mb-0">Active ({{ active.length }})</h2>
  </div>
  <div>
    <DownloadCard v-for="d in active" :key="d.id" :download="d" />
    <p v-if="!active.length" class="text-body-secondary text-center py-4">No active downloads</p>
  </div>

  <div class="d-flex justify-content-between align-items-center mb-2 mt-4">
    <h2 class="h5 mb-0">History ({{ finished.length }})</h2>
    <button v-if="finished.length" class="btn btn-outline-secondary btn-sm" @click="api.clearFinished()">
      Clear all
    </button>
  </div>
  <div>
    <DownloadCard v-for="d in finished" :key="d.id" :download="d" />
    <p v-if="!finished.length" class="text-body-secondary text-center py-4">Nothing here yet</p>
  </div>
</template>
