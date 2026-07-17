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
    props.download.status === 'uploading' ||
    props.download.status === 'queued'
)

// Only an in-progress download or a queued one can be meaningfully cancelled;
// post-processing/uploading can't be interrupted
const cancellable = computed(
  () => props.download.status === 'downloading' || props.download.status === 'queued'
)

const destinationLabel = computed(() => {
  switch (props.download.destination) {
    case 'direct':
      return 'Direct to device'
    case 'quark':
      return 'Save to Quark'
    default:
      return 'Saved to server'
  }
})

const statusBadge: Record<Download['status'], string> = {
  queued: 'text-bg-secondary',
  downloading: 'text-bg-warning',
  processing: 'text-bg-warning',
  uploading: 'text-bg-info',
  completed: 'text-bg-success',
  error: 'text-bg-danger',
  cancelled: 'text-bg-danger'
}

async function cancel(): Promise<void> {
  await api.cancelDownload(props.download.id)
}

async function remove(): Promise<void> {
  await api.removeDownload(props.download.id)
}
</script>

<template>
  <div class="card mb-3">
    <div class="card-body">
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div class="text-truncate fw-semibold" :title="download.title">{{ download.title }}</div>
        <span class="badge" :class="statusBadge[download.status]">{{ download.status }}</span>
      </div>
      <div class="text-body-secondary small d-flex flex-wrap gap-3 mt-1">
        <span v-if="download.filename">{{ download.filename }}</span>
        <span v-if="download.status === 'downloading'">
          {{ formatBytes(download.downloadedBytes) }} / {{ formatBytes(download.totalBytes) }}
        </span>
        <span v-if="download.status === 'downloading'">{{ formatSpeed(download.speed) }}</span>
        <span v-if="download.status === 'downloading'">ETA {{ formatEta(download.eta) }}</span>
        <span v-if="download.status === 'uploading'">Uploading to Quark… {{ download.percent.toFixed(0) }}%</span>
        <span>{{ download.preset }}</span>
        <span>{{ destinationLabel }}</span>
      </div>
      <div v-if="active" class="progress mt-2" style="height: 6px">
        <div class="progress-bar" :style="{ width: `${download.percent.toFixed(1)}%` }" />
      </div>
      <div v-else-if="download.status === 'completed'" class="progress mt-2" style="height: 6px">
        <div class="progress-bar bg-success" style="width: 100%" />
      </div>
      <p v-if="download.error" class="text-danger small mb-0 mt-2">{{ download.error }}</p>
      <p v-if="download.destination === 'direct' && download.delivered" class="text-body-secondary small mb-0 mt-2">
        Saved to your device
      </p>
      <p v-if="download.destination === 'quark' && download.status === 'completed'" class="text-body-secondary small mb-0 mt-2">
        Uploaded to Quark
      </p>
      <div class="d-flex gap-2 mt-3">
        <button v-if="cancellable" class="btn btn-outline-danger btn-sm" @click="cancel">Cancel</button>
        <template v-if="!active">
          <a
            v-if="download.destination === 'direct' && download.status === 'completed' && !download.delivered"
            class="btn btn-primary btn-sm"
            :href="`/api/downloads/${download.id}/file`"
            :download="download.filename ?? ''"
          >
            Save file
          </a>
          <button class="btn btn-outline-secondary btn-sm" @click="remove">Remove</button>
        </template>
      </div>
    </div>
  </div>
</template>
