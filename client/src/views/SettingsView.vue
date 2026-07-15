<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, authApi } from '../api'
import { clearSession, requirePasswordChangeSignal, setSession } from '../auth'
import { formatDate } from '../format'
import { useDownloadsStore } from '../stores/downloads'
import type { CookieCloudStatus, Settings } from '../types'

const router = useRouter()
const store = useDownloadsStore()

const settings = ref<Settings | null>(null)
const cookieStatus = ref<CookieCloudStatus | null>(null)
const saving = ref(false)
const syncing = ref(false)
const notice = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

const accountForm = reactive({ username: '', currentPassword: '', newPassword: '' })
const accountSaving = ref(false)
const accountNotice = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

onMounted(async () => {
  // Every other endpoint 403s until the forced password change is done, so
  // there's nothing to load yet -- the Account panel below still works
  if (requirePasswordChangeSignal.value) return
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

async function updateAccount(): Promise<void> {
  accountSaving.value = true
  accountNotice.value = null
  try {
    const { token } = await authApi.updateCredentials(
      accountForm.currentPassword,
      accountForm.username || undefined,
      accountForm.newPassword || undefined
    )
    const wasForced = requirePasswordChangeSignal.value
    setSession(token, false)
    accountForm.currentPassword = ''
    accountForm.newPassword = ''
    accountNotice.value = { kind: 'ok', text: 'Credentials updated' }
    // The rest of the API (and the WebSocket) was 403/refused until now --
    // load it and reconnect now that the forced change is done
    if (wasForced) {
      store.connect()
      const data = await api.getSettings()
      settings.value = data.settings
      cookieStatus.value = data.cookieCloud
    }
  } catch (err) {
    accountNotice.value = { kind: 'err', text: err instanceof Error ? err.message : String(err) }
  } finally {
    accountSaving.value = false
  }
}

function logout(): void {
  clearSession()
  router.push('/login')
}
</script>

<template>
  <h2 class="h5 mb-2">Account</h2>
  <div class="card mb-4">
    <div class="card-body">
      <div v-if="requirePasswordChangeSignal" class="alert alert-danger py-2">
        You're using the default password. Set a new one now to unlock the rest of the app.
      </div>
      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label">New username (optional)</label>
          <input v-model="accountForm.username" class="form-control" type="text" autocomplete="username" />
        </div>
        <div class="col-md-6">
          <label class="form-label">New password (optional)</label>
          <input
            v-model="accountForm.newPassword"
            class="form-control"
            type="password"
            autocomplete="new-password"
          />
        </div>
        <div class="col-12">
          <label class="form-label">Current password</label>
          <input
            v-model="accountForm.currentPassword"
            class="form-control"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
      </div>
      <div class="d-flex gap-2 mt-3">
        <button class="btn btn-primary" :disabled="accountSaving" @click="updateAccount">
          {{ accountSaving ? 'Saving…' : 'Update credentials' }}
        </button>
        <button class="btn btn-outline-secondary" @click="logout">Log out</button>
      </div>
      <div
        v-if="accountNotice"
        class="alert mt-3 mb-0 py-2"
        :class="accountNotice.kind === 'ok' ? 'alert-success' : 'alert-danger'"
      >
        {{ accountNotice.text }}
      </div>
    </div>
  </div>

  <template v-if="settings">
    <h2 class="h5 mb-2">General</h2>
    <div class="card mb-4">
      <div class="card-body">
        <div class="row g-3">
          <div class="col-md-6">
            <label class="form-label">Download directory</label>
            <input v-model="settings.downloadDir" class="form-control" type="text" />
          </div>
          <div class="col-md-6">
            <label class="form-label">yt-dlp path</label>
            <input v-model="settings.ytdlpPath" class="form-control" type="text" placeholder="yt-dlp" />
          </div>
          <div class="col-12">
            <label class="form-label">Extra yt-dlp arguments</label>
            <input
              v-model="settings.extraArgs"
              class="form-control"
              type="text"
              placeholder="--embed-thumbnail --embed-metadata"
            />
            <div class="form-text">Appended to every download command.</div>
          </div>
        </div>
      </div>
    </div>

    <h2 class="h5 mb-2">CookieCloud</h2>
    <div class="card mb-4">
      <div class="card-body">
        <div class="row g-3">
          <div class="col-12">
            <label class="form-label">Server URL</label>
            <input
              v-model="settings.cookieCloud.serverUrl"
              class="form-control"
              type="url"
              placeholder="https://cookiecloud.example.com"
            />
          </div>
          <div class="col-md-6">
            <label class="form-label">User key (UUID)</label>
            <input v-model="settings.cookieCloud.uuid" class="form-control" type="text" />
          </div>
          <div class="col-md-6">
            <label class="form-label">Password</label>
            <input
              v-model="settings.cookieCloud.password"
              class="form-control"
              type="password"
              autocomplete="new-password"
            />
          </div>
          <div class="col-md-6">
            <label class="form-label">Auto sync every (minutes, 0 = off)</label>
            <input
              v-model.number="settings.cookieCloud.autoSyncMinutes"
              class="form-control"
              type="number"
              min="0"
            />
          </div>
        </div>
        <div class="form-text mt-2">
          Cookies are pulled from your CookieCloud server, decrypted locally and written to a
          cookies.txt that yt-dlp uses for every download. Handy for members-only or age-gated
          content.
        </div>
        <div class="d-flex align-items-center gap-3 mt-3">
          <button class="btn btn-outline-secondary" :disabled="syncing" @click="syncNow">
            {{ syncing ? 'Syncing…' : 'Sync now' }}
          </button>
          <span v-if="cookieStatus?.lastSyncAt" class="form-text mb-0">
            Last sync: {{ formatDate(cookieStatus.lastSyncAt) }} ({{ cookieStatus.cookieCount }}
            cookies, {{ cookieStatus.domainCount }} domains)
          </span>
          <span v-else-if="cookieStatus?.lastError" class="form-text mb-0">
            Last attempt failed: {{ cookieStatus.lastError }}
          </span>
        </div>
      </div>
    </div>

    <div class="d-flex gap-2">
      <button class="btn btn-primary" :disabled="saving" @click="save">
        {{ saving ? 'Saving…' : 'Save settings' }}
      </button>
    </div>
    <div
      v-if="notice"
      class="alert mt-3 mb-0 py-2"
      :class="notice.kind === 'ok' ? 'alert-success' : 'alert-danger'"
    >
      {{ notice.text }}
    </div>
  </template>
  <p v-else-if="!requirePasswordChangeSignal" class="text-body-secondary text-center py-4">
    Loading…
  </p>
</template>
