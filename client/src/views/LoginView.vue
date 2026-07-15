<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authApi } from '../api'
import { setSession } from '../auth'
import { useDownloadsStore } from '../stores/downloads'

const router = useRouter()
const store = useDownloadsStore()

const form = reactive({ username: '', password: '', captchaAnswer: '' })
const error = ref<string | null>(null)
const loading = ref(false)
const captchaLoading = ref(false)
const captchaSvg = ref('')
const captchaToken = ref('')

async function loadCaptcha(): Promise<void> {
  captchaLoading.value = true
  form.captchaAnswer = ''
  try {
    const data = await authApi.getCaptcha()
    captchaSvg.value = data.svg
    captchaToken.value = data.captchaToken
  } finally {
    captchaLoading.value = false
  }
}

onMounted(loadCaptcha)

async function submit(): Promise<void> {
  error.value = null
  loading.value = true
  try {
    const { token, requirePasswordChange } = await authApi.login(
      form.username,
      form.password,
      captchaToken.value,
      form.captchaAnswer
    )
    setSession(token, requirePasswordChange ?? false)
    if (!requirePasswordChange) store.connect()
    router.push(requirePasswordChange ? '/settings' : '/')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    if (error.value.toLowerCase().includes('captcha')) await loadCaptcha()
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-vh-100 d-flex align-items-center justify-content-center bg-body-tertiary p-3">
    <div class="card shadow-sm" style="width: 100%; max-width: 380px">
      <div class="card-body p-4">
        <h1 class="h4 fw-bold text-center mb-1">yt-web-downloader</h1>
        <p class="text-body-secondary text-center mb-3">Sign in to continue</p>
        <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
        <form @submit.prevent="submit">
          <div class="mb-3">
            <label class="form-label">Username</label>
            <input v-model="form.username" class="form-control" type="text" autocomplete="username" required />
          </div>
          <div class="mb-3">
            <label class="form-label">Password</label>
            <input
              v-model="form.password"
              class="form-control"
              type="password"
              autocomplete="current-password"
              required
            />
          </div>
          <div class="mb-3">
            <label class="form-label">Captcha</label>
            <div class="d-flex align-items-center gap-2 mb-2">
              <div class="captcha-img flex-fill border rounded" v-html="captchaSvg" />
              <button
                type="button"
                class="btn btn-outline-secondary btn-sm"
                :disabled="captchaLoading"
                @click="loadCaptcha"
              >
                Refresh
              </button>
            </div>
            <input
              v-model="form.captchaAnswer"
              class="form-control"
              type="text"
              autocomplete="off"
              required
            />
          </div>
          <button class="btn btn-primary w-100" type="submit" :disabled="loading || captchaLoading">
            {{ loading ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
