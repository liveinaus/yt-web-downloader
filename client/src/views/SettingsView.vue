<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import { formatDate } from '../format'
import type { CookieCloudStatus, Settings } from '../types'

const settings = ref<Settings | null>(null)
const cookieStatus = ref<CookieCloudStatus | null>(null)
const saving = ref(false)
const syncing = ref(false)
const notice = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

onMounted(async () => {
  const data = await api.getSettings()
  settings.value = data.settings
  cookieStatus.value = data.cookieCloud
})

async function save(): Promise<void> {
  if (!settings.value) return
  saving.value = true
  notice.value = null
  try {
    settings.value = await api.saveSettings(settings.value)
    notice.value = { kind: 'ok', text: 'Settings saved' }
  } catch (err) {
    notice.value = { kind: 'err', text: err instanceof Error ? err.message : String(err) }
  } finally {
    saving.value = false
  }
}

async function syncNow(): Promise<void> {
  if (!settings.value) return
  syncing.value = true
  notice.value = null
  try {
    await api.saveSettings(settings.value)
    cookieStatus.value = await api.syncCookies()
    notice.value = {
      kind: 'ok',
      text: `Synced ${cookieStatus.value.cookieCount} cookies across ${cookieStatus.value.domainCount} domains`
    }
  } catch (err) {
    notice.value = { kind: 'err', text: err instanceof Error ? err.message : String(err) }
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <template v-if="settings">
    <div class="section-head">
      <h2>General</h2>
    </div>
    <div class="panel">
      <div class="form-grid">
        <div>
          <label>Download directory</label>
          <input v-model="settings.downloadDir" type="text" />
        </div>
        <div>
          <label>yt-dlp path</label>
          <input v-model="settings.ytdlpPath" type="text" placeholder="yt-dlp" />
        </div>
        <div class="full">
          <label>Extra yt-dlp arguments</label>
          <input v-model="settings.extraArgs" type="text" placeholder="--embed-thumbnail --embed-metadata" />
          <p class="hint">Appended to every download command.</p>
        </div>
      </div>
    </div>

    <div class="section-head">
      <h2>CookieCloud</h2>
    </div>
    <div class="panel">
      <div class="form-grid">
        <div class="full">
          <label>Server URL</label>
          <input
            v-model="settings.cookieCloud.serverUrl"
            type="url"
            placeholder="https://cookiecloud.example.com"
          />
        </div>
        <div>
          <label>User key (UUID)</label>
          <input v-model="settings.cookieCloud.uuid" type="text" />
        </div>
        <div>
          <label>Password</label>
          <input v-model="settings.cookieCloud.password" type="password" autocomplete="new-password" />
        </div>
        <div>
          <label>Auto sync every (minutes, 0 = off)</label>
          <input v-model.number="settings.cookieCloud.autoSyncMinutes" type="number" min="0" />
        </div>
      </div>
      <p class="hint">
        Cookies are pulled from your CookieCloud server, decrypted locally and written to a
        cookies.txt that yt-dlp uses for every download. Handy for members-only or age-gated
        content.
      </p>
      <div class="actions">
        <button :disabled="syncing" @click="syncNow">
          {{ syncing ? 'Syncing…' : 'Sync now' }}
        </button>
        <span v-if="cookieStatus?.lastSyncAt" class="hint">
          Last sync: {{ formatDate(cookieStatus.lastSyncAt) }} ({{ cookieStatus.cookieCount }}
          cookies, {{ cookieStatus.domainCount }} domains)
        </span>
        <span v-else-if="cookieStatus?.lastError" class="hint">
          Last attempt failed: {{ cookieStatus.lastError }}
        </span>
      </div>
    </div>

    <div class="actions">
      <button class="primary" :disabled="saving" @click="save">
        {{ saving ? 'Saving…' : 'Save settings' }}
      </button>
    </div>
    <p v-if="notice" class="notice" :class="notice.kind">{{ notice.text }}</p>
  </template>
  <p v-else class="empty">Loading…</p>
</template>
