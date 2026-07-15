<script setup lang="ts">
import { computed } from 'vue'
import { api } from '../api'
import { formatBytes, formatEta, formatSpeed } from '../format'
import type { Download } from '../types'

const props = defineProps<{ download: Download }>()

const active = computed(
  () =>
    props.download.status === 'downloading' ||
    props.download.status === 'processing' ||
    props.download.status === 'queued'
)

async function cancel(): Promise<void> {
  await api.cancelDownload(props.download.id)
}

async function remove(): Promise<void> {
  await api.removeDownload(props.download.id)
}
</script>

<template>
  <div class="card">
    <div class="row">
      <div class="title" :title="download.title">{{ download.title }}</div>
      <span class="badge" :class="download.status">{{ download.status }}</span>
    </div>
    <div class="meta">
      <span v-if="download.filename">{{ download.filename }}</span>
      <span v-if="active">{{ formatBytes(download.downloadedBytes) }} / {{ formatBytes(download.totalBytes) }}</span>
      <span v-if="download.status === 'downloading'">{{ formatSpeed(download.speed) }}</span>
      <span v-if="download.status === 'downloading'">ETA {{ formatEta(download.eta) }}</span>
      <span>{{ download.preset }}</span>
      <span>{{ download.destination === 'direct' ? 'Direct to device' : 'Saved to server' }}</span>
    </div>
    <div v-if="active" class="progress">
      <div class="bar" :style="{ width: `${download.percent.toFixed(1)}%` }" />
    </div>
    <div v-else-if="download.status === 'completed'" class="progress">
      <div class="bar done" style="width: 100%" />
    </div>
    <p v-if="download.error" class="error-text">{{ download.error }}</p>
    <p v-if="download.destination === 'direct' && download.delivered" class="hint">
      Saved to your device
    </p>
    <div class="actions">
      <button v-if="active" class="danger" @click="cancel">Cancel</button>
      <template v-else>
        <a
          v-if="download.destination === 'direct' && download.status === 'completed' && !download.delivered"
          class="file-link"
          :href="`/api/downloads/${download.id}/file`"
          :download="download.filename ?? ''"
        >
          Save file
        </a>
        <button class="ghost" @click="remove">Remove</button>
      </template>
    </div>
  </div>
</template>
