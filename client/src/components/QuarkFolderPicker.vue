<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import type { QuarkFolder } from '../types'

const emit = defineEmits<{
  (e: 'select', payload: { folderId: string; folderName: string }): void
  (e: 'cancel'): void
}>()

const path = ref<QuarkFolder[]>([])
const list = ref<QuarkFolder[]>([])
const loading = ref(false)
const error = ref('')
const newName = ref('')
const creating = ref(false)

function currentId(): string {
  return path.value.length ? path.value[path.value.length - 1]!.fid : '0'
}
function currentName(): string {
  return path.value.length ? path.value[path.value.length - 1]!.name : 'Root'
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    list.value = await api.listQuarkFolders(currentId())
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

function enter(f: QuarkFolder): void {
  path.value.push(f)
  void load()
}
function crumb(index: number): void {
  path.value = path.value.slice(0, index + 1)
  void load()
}

async function create(): Promise<void> {
  const name = newName.value.trim()
  if (!name) return
  creating.value = true
  error.value = ''
  try {
    await api.createQuarkFolder(currentId(), name)
    newName.value = ''
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

function choose(): void {
  emit('select', {
    folderId: currentId(),
    folderName: ['Root', ...path.value.map((p) => p.name)].join(' / ')
  })
}
</script>

<template>
  <div class="border rounded p-2">
    <nav class="small mb-2">
      <a href="#" @click.prevent="crumb(-1)">Root</a>
      <template v-for="(p, i) in path" :key="p.fid">
        / <a href="#" @click.prevent="crumb(i)">{{ p.name }}</a>
      </template>
    </nav>
    <div v-if="loading" class="text-body-secondary small">Loading…</div>
    <div v-else-if="error" class="text-danger small">{{ error }}</div>
    <ul v-else class="list-unstyled mb-2" style="max-height: 12rem; overflow: auto">
      <li v-for="f in list" :key="f.fid">
        <button class="btn btn-link btn-sm p-0 text-decoration-none" @click="enter(f)">
          📁 {{ f.name }}
        </button>
      </li>
      <li v-if="!list.length" class="text-body-secondary small">No sub-folders here</li>
    </ul>
    <div class="input-group input-group-sm mb-2">
      <input
        v-model="newName"
        class="form-control"
        placeholder="New folder name"
        @keyup.enter="create"
      />
      <button class="btn btn-outline-secondary" :disabled="creating || !newName.trim()" @click="create">
        Create
      </button>
    </div>
    <div class="d-flex gap-2">
      <button class="btn btn-primary btn-sm" @click="choose">Use “{{ currentName() }}”</button>
      <button class="btn btn-outline-secondary btn-sm" @click="emit('cancel')">Cancel</button>
    </div>
  </div>
</template>
