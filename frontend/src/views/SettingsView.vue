<template>
  <div class="max-w-4xl mx-auto space-y-8 pb-20">
  <DeleteTeamModal
    :show="showDeleteTeamModal"
    :is-deleting="isDeletingTeam"
    :team-name="currentTeamName"
    @close="showDeleteTeamModal = false"
    @confirm="handleDeleteTeam"
  />
    <div class="flex justify-between items-center gap-4">
      <h2 class="text-2xl font-bold">系統設定</h2>
    </div>

    <!-- Container Info -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><Server class="w-5 h-5 text-emerald-500" /> OpenClaw 系統資訊</h3>
      </div>
      <div class="p-8 space-y-5">
        <div v-if="!containerConfig" class="text-sm text-slate-400 italic">尚未建立系統設定，請先完成初始化。</div>
        <template v-else>
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-500">Workspace 路徑</label>
            <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm break-all">
              <FolderOpen class="w-4 h-4 text-slate-400 shrink-0" />
              <span>{{ containerConfig.workspacePath || '--' }}</span>
            </div>
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-500">Gateway 設定路徑</label>
            <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm break-all">
              <FolderOpen class="w-4 h-4 text-slate-400 shrink-0" />
              <span>{{ containerConfig.gatewayWorkspacePath || containerConfig.gatewayConfigPath || '--' }}</span>
            </div>
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-500">Gateway Token</label>
            <div class="relative">
              <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm pr-12 break-all">
                <KeyRound class="w-4 h-4 text-slate-400 shrink-0" />
                <span>{{ showToken ? (containerConfig.gatewayToken || '--') : maskToken(containerConfig.gatewayToken) }}</span>
              </div>
              <button @click="showToken = !showToken" class="absolute right-3 top-3 text-slate-400 hover:text-slate-600" type="button" aria-label="切換 Gateway Token 顯示">
                <EyeOff v-if="showToken" class="w-4 h-4" />
                <Eye v-else class="w-4 h-4" />
              </button>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Gateway Port</label>
              <div class="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm">
                {{ containerConfig.gatewayPort || '--' }}
              </div>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Bridge Port</label>
              <div class="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm">
                {{ containerConfig.bridgePort || '--' }}
              </div>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!-- AI Keys -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <div class="flex items-center justify-between gap-4">
          <h3 class="font-bold flex items-center gap-2"><KeyRound class="w-5 h-5 text-blue-500" /> AI 服務金鑰</h3>
          <span v-if="providerLabel" class="text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300">
            {{ providerLabel }}
          </span>
        </div>
      </div>
      <div class="p-8 space-y-5">
        <div v-if="isLoadingUserSettings" class="text-sm text-slate-400 italic">正在讀取 AI 服務設定...</div>
        <div v-else-if="settingsError" class="text-sm text-red-500">{{ settingsError }}</div>
        <div v-else-if="!llmProvider" class="text-sm text-slate-400 italic">尚未選擇 LLM Provider。</div>

        <template v-else-if="llmProvider === 'gemini'">
          <ReadOnlyField label="模型名稱" :value="llmConfig.model" mono />
        </template>

        <template v-else-if="llmProvider === 'custom'">
          <ReadOnlyField label="Endpoint" :value="llmConfig.baseUrl" />
          <ReadOnlyField label="模型名稱" :value="llmConfig.model" mono />
        </template>
      </div>
    </section>

    <!-- Transcription Settings -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><AudioWaveform class="w-5 h-5 text-purple-500" /> 轉錄設定</h3>
      </div>
      <div class="p-8 space-y-6">
        <div class="space-y-2">
          <label class="text-sm font-medium">Whisper 模型選擇</label>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div
              v-for="m in whisperModels" :key="m.name"
              @click="selectedModel = m.name"
              :class="selectedModel === m.name ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-slate-200 dark:border-slate-800 hover:border-slate-300'"
              class="p-4 rounded-xl border-2 cursor-pointer transition-colors"
            >
              <div class="font-bold mb-1">{{ m.name }}</div>
              <div class="text-[10px] text-slate-500 uppercase">{{ m.desc }}</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Notification Settings -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><Mail class="w-5 h-5 text-orange-500" /> 通知設定</h3>
      </div>
      <div class="p-8">
        <div class="space-y-2">
          <label class="text-sm font-medium">Email 收件人</label>
          <input
            v-model="notificationEmails"
            type="text"
            placeholder="jason.su@example.com; alice@example.com"
            class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl outline-none ring-1 ring-slate-200 dark:ring-slate-700 focus:ring-blue-500"
          />
          <p class="text-xs text-slate-400">多位收件人請用 <code class="bg-slate-100 dark:bg-slate-800 px-1 rounded">;</code> 分隔，會議記錄發送時將自動帶入</p>
        </div>
      </div>
    </section>

    <div class="flex justify-end pt-4">
      <button @click="handleSave" :disabled="isSaving" class="bg-blue-600 text-white px-10 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-xl shadow-blue-500/20 transition-all disabled:opacity-60">
        {{ isSaving ? '儲存中...' : '儲存設定' }}
      </button>
    </div>

    <!-- Danger Zone -->
    <section v-if="isAdmin" class="rounded-2xl border-2 border-red-300 dark:border-red-800 overflow-hidden">
      <div class="p-6 border-b border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20">
        <h3 class="font-bold flex items-center gap-2 text-red-700 dark:text-red-400">
          <TriangleAlert class="w-5 h-5" /> 危險區域
        </h3>
        <p class="text-xs text-red-500 dark:text-red-500 mt-1">以下操作不可復原，請謹慎操作。</p>
      </div>
      <div class="p-8 bg-white dark:bg-slate-900">
        <div class="flex items-center justify-between gap-6">
          <div>
            <p class="font-semibold text-slate-800 dark:text-slate-100">刪除團隊</p>
            <p class="text-sm text-slate-500 mt-1">永久刪除此團隊、所有帳號以及所屬的容器。此操作無法復原。</p>
          </div>
          <button
            @click="showDeleteTeamModal = true"
            class="shrink-0 bg-red-600 text-white px-5 py-2.5 rounded-xl font-bold hover:bg-red-700 shadow-lg shadow-red-500/20 transition-all text-sm"
          >
            刪除團隊
          </button>
        </div>
      </div>
    </section>

  </div>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, ref } from 'vue'
import { KeyRound, Eye, EyeOff, AudioWaveform, Mail, Server, FolderOpen, TriangleAlert } from 'lucide-vue-next'
import DeleteTeamModal from '../components/DeleteTeamModal.vue'

const props = defineProps({
  containerConfig: { type: Object, default: null },
})
const emit = defineEmits(['save', 'logout'])

const showToken = ref(false)
const selectedModel = ref('large-v3')
const userSettings = ref(null)
const isLoadingUserSettings = ref(false)
const settingsError = ref('')
const notificationEmails = ref('')
const isSaving = ref(false)
const showDeleteTeamModal = ref(false)
const isDeletingTeam = ref(false)

const currentTeamName = computed(() => userSettings.value?.team?.name ?? userSettings.value?.teamName ?? '')
const isAdmin = computed(() => userSettings.value?.role === 'admin')

const whisperModels = [
  { name: 'large-v3', desc: '高準確度' },
  { name: 'medium', desc: '平衡速度' },
  { name: 'small', desc: '快速處理' }
]

const llmConfig = computed(() => userSettings.value?.team?.setup_config ?? userSettings.value?.setup_config ?? {})
const llmProvider = computed(() => llmConfig.value.provider ?? '')
const providerLabel = computed(() => {
  if (llmProvider.value === 'gemini') return 'Google Gemini'
  if (llmProvider.value === 'custom') return 'Custom Provider'
  return ''
})

const fieldBaseClass = 'w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl outline-none ring-1 ring-slate-200 dark:ring-slate-700 text-sm break-all'

const ReadOnlyField = defineComponent({
  name: 'ReadOnlyField',
  props: {
    label: { type: String, required: true },
    value: { type: String, default: '' },
    mono: { type: Boolean, default: false }
  },
  setup(props) {
    return () => h('div', { class: 'space-y-2' }, [
      h('label', { class: 'text-sm font-medium' }, props.label),
      h('div', { class: [fieldBaseClass, props.mono ? 'font-mono' : ''] }, props.value || '--')
    ])
  }
})


function maskToken(token) {
  if (!token) return '--'
  return `${token.slice(0, 8)}${'*'.repeat(16)}${token.slice(-4)}`
}

async function fetchUserSettings() {
  const token = localStorage.getItem('clawpm_token')
  if (!token) return

  isLoadingUserSettings.value = true
  settingsError.value = ''
  try {
    const res = await fetch('/api/user/me', {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '讀取 AI 服務設定失敗')
    userSettings.value = data
  } catch (err) {
    settingsError.value = err.message || '讀取 AI 服務設定失敗'
  } finally {
    isLoadingUserSettings.value = false
  }
}

async function fetchAppSettings() {
  const token = localStorage.getItem('clawpm_token')
  if (!token) return
  try {
    const res = await fetch('/api/settings', { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      if (data.notificationEmails) notificationEmails.value = data.notificationEmails
      if (data.whisperModel) selectedModel.value = data.whisperModel
    }
  } catch {}
}

async function handleSave() {
  isSaving.value = true
  const token = localStorage.getItem('clawpm_token')
  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationEmails: notificationEmails.value, whisperModel: selectedModel.value })
    })
  } catch {}
  isSaving.value = false
  emit('save')
}

async function handleDeleteTeam() {
  isDeletingTeam.value = true
  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/team', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '刪除團隊失敗')
    localStorage.removeItem('clawpm_token')
    localStorage.removeItem('clawpm_user')
    emit('logout')
  } catch (err) {
    alert(`刪除失敗：${err.message}`)
    isDeletingTeam.value = false
    showDeleteTeamModal.value = false
  }
}

onMounted(() => {
  fetchUserSettings()
  fetchAppSettings()
})
</script>
