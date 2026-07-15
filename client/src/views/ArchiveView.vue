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
  <div class="section-head">
    <h2>Downloaded files</h2>
    <button class="ghost" @click="refresh">Refresh</button>
  </div>
  <div class="panel">
    <table v-if="files.length" class="files">
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
          <td class="name" :title="f.name">
            <a :href="`/api/files/${encodeURIComponent(f.name)}`">{{ f.name }}</a>
          </td>
          <td>{{ formatBytes(f.size) }}</td>
          <td>{{ formatDate(f.modifiedAt) }}</td>
          <td><button class="ghost danger" @click="remove(f.name)">Delete</button></td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty">{{ loading ? 'Loading…' : 'No files downloaded yet' }}</p>
  </div>
</template>
