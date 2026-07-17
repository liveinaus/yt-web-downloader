<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import DownloadCard from '../components/DownloadCard.vue'
import { loadPrefs, savePrefs } from '../prefs'
import { useDownloadsStore } from '../stores/downloads'
import type { Destination } from '../types'

const store = useDownloadsStore()

// Restore the last-used form choices; the URL is always left blank
const prefs = loadPrefs()
const url = ref('')
const preset = ref(prefs.preset)
const playlist = ref(prefs.playlist)
const destination = ref<Destination>(prefs.destination)
const container = ref(prefs.container)
const subtitles = ref(prefs.subtitles)
const subLang1 = ref(prefs.subLang1)
const subLang2 = ref(prefs.subLang2)
const burnSubs = ref(prefs.burnSubs)
const burnLang = ref(prefs.burnLang)
const presets = ref<string[]>(['best'])
const submitting = ref(false)
const error = ref<string | null>(null)

// Persist choices whenever any of them change
watch(
  [preset, playlist, destination, container, subtitles, subLang1, subLang2, burnSubs, burnLang],
  () => {
    savePrefs({
      preset: preset.value,
      playlist: playlist.value,
      destination: destination.value,
      container: container.value,
      subtitles: subtitles.value,
      subLang1: subLang1.value,
      subLang2: subLang2.value,
      burnSubs: burnSubs.value,
      burnLang: burnLang.value
    })
  }
)

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
    await api.addDownload({
      url: url.value.trim(),
      preset: preset.value,
      playlist: playlist.value,
      destination: destination.value,
      subtitles: subtitles.value,
      subLang1: subtitles.value ? subLang1.value.trim() : undefined,
      subLang2: subtitles.value ? subLang2.value.trim() : undefined,
      burnSubs: subtitles.value ? burnSubs.value : undefined,
      burnLang: subtitles.value && burnSubs.value ? burnLang.value : undefined,
      container: container.value || undefined
    })
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
      <form class="d-flex flex-column gap-3" @submit.prevent="submit">
        <div>
          <label class="form-label">Video or playlist URL</label>
          <input
            v-model="url"
            class="form-control"
            type="url"
            placeholder="Paste a video or playlist URL…"
            required
          />
        </div>

        <div class="row g-3 align-items-end">
          <div class="col-6 col-sm-auto">
            <label class="form-label">Quality</label>
            <select v-model="preset" class="form-select">
              <option v-for="p in presets" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div class="col-6 col-sm-auto">
            <label class="form-label">Format</label>
            <select v-model="container" class="form-select">
              <option value="">Auto</option>
              <option value="mp4">mp4</option>
              <option value="mkv">mkv</option>
              <option value="webm">webm</option>
            </select>
          </div>
          <div class="col-auto">
            <div class="form-check pb-2">
              <input id="playlist-check" v-model="playlist" class="form-check-input" type="checkbox" />
              <label class="form-check-label" for="playlist-check">Playlist</label>
            </div>
          </div>
        </div>

        <div>
          <label class="form-label d-block">Destination</label>
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
            <button
              type="button"
              class="btn btn-sm"
              :class="destination === 'quark' ? 'btn-primary' : 'btn-outline-secondary'"
              @click="destination = 'quark'"
            >
              Save to Quark
            </button>
          </div>
          <small v-if="destination === 'quark'" class="text-body-secondary d-block mt-1">
            Downloads on the server, uploads to your Quark drive, then deletes the local copy.
            Set your Quark cookie in Settings first.
          </small>
        </div>

        <div>
          <div class="form-check">
            <input id="subtitles-check" v-model="subtitles" class="form-check-input" type="checkbox" />
            <label class="form-check-label" for="subtitles-check">Subtitles</label>
          </div>
          <template v-if="subtitles">
            <div class="d-flex gap-2 mt-2" style="max-width: 22rem">
              <input
                v-model="subLang1"
                class="form-control form-control-sm"
                placeholder="Language 1 e.g. en"
                aria-label="First subtitle language"
              />
              <input
                v-model="subLang2"
                class="form-control form-control-sm"
                placeholder="Language 2 e.g. zh-Hans"
                aria-label="Second subtitle language"
              />
            </div>
            <small class="text-body-secondary d-block mt-1">
              Both languages are embedded as selectable tracks, plus a combined bilingual track
              (set as the default). Leave the second blank for a single language. Includes YouTube
              auto-generated / auto-translated captions; forces mp4 (or mkv) since webm can't carry
              subtitles.
            </small>
            <div class="form-check mt-2">
              <input id="burn-check" v-model="burnSubs" class="form-check-input" type="checkbox" />
              <label class="form-check-label" for="burn-check">Burn subtitles into the video</label>
            </div>
            <template v-if="burnSubs">
              <select v-model="burnLang" class="form-select form-select-sm mt-2" style="max-width: 16rem">
                <option value="bilingual">Bilingual ({{ subLang1 }} + {{ subLang2 }})</option>
                <option :value="subLang1">{{ subLang1 }}</option>
                <option v-if="subLang2" :value="subLang2">{{ subLang2 }}</option>
              </select>
              <small class="text-body-secondary d-block mt-1">
                Renders the chosen track permanently onto the picture so it shows in any player
                (browsers, QuickTime). Re-encodes the video and is no longer selectable.
              </small>
            </template>
          </template>
        </div>

        <div>
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
