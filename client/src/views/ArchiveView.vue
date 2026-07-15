<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import { formatBytes, formatDate } from '../format'
import type { ArchiveFile } from '../types'

const files = ref<ArchiveFile[]>([])
const loading = ref(true)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    files.value = await api.listFiles()
  } finally {
    loading.value = false
  }
}

async function remove(name: string): Promise<void> {
  if (!confirm(`Delete "${name}" from disk?`)) return
  await api.deleteFile(name)
  await refresh()
}

onMounted(refresh)
</script>

<template>
  <div class="d-flex justify-content-between align-items-center mb-2">
    <h2 class="h5 mb-0">Downloaded files</h2>
    <button class="btn btn-outline-secondary btn-sm" @click="refresh">Refresh</button>
  </div>
  <div class="card">
    <div class="table-responsive" v-if="files.length">
      <table class="table table-hover align-middle mb-0">
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th>Modified</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in files" :key="f.name">
            <td class="text-truncate" style="max-width: 380px" :title="f.name">
              <a :href="`/api/files/${encodeURIComponent(f.name)}`">{{ f.name }}</a>
            </td>
            <td>{{ formatBytes(f.size) }}</td>
            <td>{{ formatDate(f.modifiedAt) }}</td>
            <td class="text-end">
              <button class="btn btn-outline-danger btn-sm" @click="remove(f.name)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="text-body-secondary text-center py-4 mb-0">
      {{ loading ? 'Loading…' : 'No files downloaded yet' }}
    </p>
  </div>
</template>
