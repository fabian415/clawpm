<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <div class="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 p-8">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-blue-600">ClawPM</h1>
        <p class="text-slate-500 mt-2">
          {{ mode === 'login' ? '歡迎回來，請登入帳號' : '建立您的 AI 專案管理空間' }}
        </p>
      </div>

      <!-- Error Message -->
      <div v-if="props.authError" class="mb-4 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
        {{ props.authError }}
      </div>

      <form @submit.prevent="handleAuth" class="space-y-4">
        <div>
          <label class="block text-sm font-medium mb-1">電子郵件</label>
          <input
            type="email"
            required
            v-model="email"
            placeholder="you@example.com"
            class="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">密碼</label>
          <input
            type="password"
            required
            v-model="password"
            placeholder="••••••••"
            class="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none"
          />
          <div v-if="mode === 'register'" class="mt-2 space-y-1">
            <div class="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
              <div class="h-full transition-all duration-300" :class="strengthClass" :style="{ width: strength + '%' }"></div>
            </div>
            <p class="text-xs text-slate-500">密碼強度：{{ strengthText }}</p>
          </div>
        </div>
        <button
          type="submit"
          :disabled="props.isLoading"
          class="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2 rounded-lg transition-colors"
        >
          <span v-if="props.isLoading">處理中...</span>
          <span v-else>{{ mode === 'login' ? '登入' : '立即註冊' }}</span>
        </button>
      </form>

      <div class="mt-6 text-center text-sm">
        <span class="text-slate-500">{{ mode === 'login' ? '還沒有帳號？' : '已經有帳號了？' }}</span>
        <button @click="switchMode" class="text-blue-600 font-medium ml-1 underline">
          {{ mode === 'login' ? '註冊' : '登入' }}
        </button>
      </div>
    </div>

    <!-- Configuring Overlay -->
    <div v-if="props.isConfiguring" class="fixed inset-0 bg-slate-900 text-white flex flex-col items-center justify-center z-50">
      <div class="w-64 text-center">
        <div class="mb-8">
          <svg class="animate-spin h-12 w-12 text-blue-500 mx-auto" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
        <h2 class="text-xl font-bold mb-2">正在為您配置 OpenClaw 環境...</h2>
        <p class="text-slate-400 text-sm">這通常需要幾秒鐘，請稍候</p>
        <div class="mt-6 h-2 w-full bg-slate-800 rounded-full overflow-hidden">
          <div class="h-full bg-blue-500 transition-all duration-500" :style="{ width: props.configProgress + '%' }"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  isConfiguring: Boolean,
  configProgress: Number,
  authError: String,
  isLoading: Boolean
})

const emit = defineEmits(['auth'])

const mode = ref('login')
const email = ref('')
const password = ref('')

const strength = computed(() => {
  if (!password.value) return 0
  let s = 0
  if (password.value.length > 6) s += 40
  if (/[A-Z]/.test(password.value)) s += 30
  if (/[0-9]/.test(password.value)) s += 30
  return s
})

const strengthText = computed(() => {
  if (strength.value < 40) return '弱'
  if (strength.value < 80) return '中等'
  return '強'
})

const strengthClass = computed(() => {
  if (strength.value < 40) return 'bg-red-500'
  if (strength.value < 80) return 'bg-yellow-500'
  return 'bg-green-500'
})

function switchMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  password.value = ''
}

function handleAuth() {
  emit('auth', { mode: mode.value, email: email.value, password: password.value })
}
</script>
