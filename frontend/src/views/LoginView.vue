<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <div class="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 p-8">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-blue-600">ClawPM</h1>
        <p class="text-slate-500 mt-2">AI 專案管理平台</p>
      </div>

      <!-- Error Message -->
      <div v-if="props.authError" class="mb-4 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
        {{ props.authError }}
      </div>

      <!-- Mode: Register New Team -->
      <template v-if="mode === 'register-team'">
        <h2 class="text-lg font-bold mb-5">建立新的 Team</h2>
        <form @submit.prevent="handleRegisterTeam" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Team 名稱</label>
            <input
              type="text"
              required
              v-model="teamName"
              placeholder="例：DeviceOn"
              class="w-full px-4 py-2 rounded-lg border focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800"
              :class="teamNameError ? 'border-red-400 dark:border-red-600' : 'border-slate-300 dark:border-slate-700'"
            />
            <p v-if="teamNameError" class="text-xs text-red-500 mt-1">{{ teamNameError }}</p>
            <p v-else class="text-xs text-slate-400 mt-1">只能使用英文字母、數字、底線（_）和連字號（-）</p>
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">管理員 Email</label>
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
            <div class="mt-2 space-y-1">
              <div class="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                <div class="h-full transition-all duration-300" :class="strengthClass" :style="{ width: strength + '%' }"></div>
              </div>
              <p class="text-xs text-slate-500">密碼強度：{{ strengthText }}</p>
            </div>
          </div>
          <button
            type="submit"
            :disabled="props.isLoading || !!teamNameError || !teamName"
            class="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2 rounded-lg transition-colors"
          >
            <span v-if="props.isLoading">建立中...</span>
            <span v-else>建立 Team 並登入</span>
          </button>
        </form>
        <div class="mt-5 text-center">
          <button @click="mode = 'select-team'" class="text-sm text-blue-600 underline">
            返回選擇 Team
          </button>
        </div>
      </template>

      <!-- Mode: Select Team -->
      <template v-else-if="mode === 'select-team'">
        <button
          @click="mode = 'register-team'"
          class="w-full mb-5 py-3 rounded-xl border-2 border-dashed border-blue-400 text-blue-600 font-medium hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors"
        >
          + 建立新的 Team
        </button>

        <div class="text-sm text-slate-500 mb-3">或選擇現有 Team 登入：</div>

        <div v-if="isLoadingTeams" class="text-center py-6 text-slate-400 text-sm">載入中...</div>
        <div v-else-if="teams.length === 0" class="text-center py-6 text-slate-400 text-sm italic">尚無 Team，請先建立一個</div>
        <div v-else class="space-y-2">
          <button
            v-for="team in teams"
            :key="team.id"
            @click="selectTeam(team)"
            class="w-full text-left px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-slate-800 transition-all font-medium"
          >
            {{ team.name }}
          </button>
        </div>
      </template>

      <!-- Mode: Login with selected team -->
      <template v-else-if="mode === 'login' && selectedTeam">
        <div class="flex items-center gap-2 mb-5 p-3 bg-slate-50 dark:bg-slate-800 rounded-xl">
          <span class="text-xs text-slate-500">Team</span>
          <span class="font-semibold flex-1">{{ selectedTeam.name }}</span>
          <button @click="mode = 'select-team'" class="text-xs text-blue-600 underline">更換</button>
        </div>
        <form @submit.prevent="handleLogin" class="space-y-4">
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
          </div>
          <button
            type="submit"
            :disabled="props.isLoading"
            class="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2 rounded-lg transition-colors"
          >
            <span v-if="props.isLoading">登入中...</span>
            <span v-else>登入</span>
          </button>
        </form>
      </template>
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
        <h2 class="text-xl font-bold mb-2">正在建立 Team 環境...</h2>
        <p class="text-slate-400 text-sm">這通常需要幾秒鐘，請稍候</p>
        <div class="mt-6 h-2 w-full bg-slate-800 rounded-full overflow-hidden">
          <div class="h-full bg-blue-500 transition-all duration-500" :style="{ width: props.configProgress + '%' }"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const props = defineProps({
  isConfiguring: Boolean,
  configProgress: Number,
  authError: String,
  isLoading: Boolean
})

const emit = defineEmits(['auth'])

const mode = ref('select-team')
const teams = ref([])
const isLoadingTeams = ref(false)
const selectedTeam = ref(null)
const teamName = ref('')
const email = ref('')
const password = ref('')

const TEAM_NAME_RE = /^[A-Za-z0-9_-]+$/
const teamNameError = computed(() => {
  if (!teamName.value) return ''
  return TEAM_NAME_RE.test(teamName.value) ? '' : 'Team 名稱只能包含英文字母、數字、底線（_）和連字號（-）'
})

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

async function fetchTeams() {
  isLoadingTeams.value = true
  try {
    const res = await fetch('/api/teams')
    if (res.ok) teams.value = await res.json()
  } catch {}
  isLoadingTeams.value = false
}

function selectTeam(team) {
  selectedTeam.value = team
  email.value = ''
  password.value = ''
  mode.value = 'login'
}

function handleLogin() {
  emit('auth', {
    action: 'login',
    teamId: selectedTeam.value.id,
    email: email.value,
    password: password.value
  })
}

function handleRegisterTeam() {
  if (teamNameError.value || !teamName.value) return
  emit('auth', {
    action: 'register-team',
    teamName: teamName.value,
    email: email.value,
    password: password.value
  })
}

onMounted(fetchTeams)
</script>
