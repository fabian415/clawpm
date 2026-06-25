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
          <h3 class="font-bold flex items-center gap-2"><KeyRound class="w-5 h-5 text-blue-500" /> AI 服務設定</h3>
          <span v-if="providerLabel" class="text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300">
            目前：{{ providerLabel }}
          </span>
        </div>
      </div>
      <div class="p-8 space-y-6">
        <div v-if="isLoadingUserSettings" class="text-sm text-slate-400 italic">正在讀取 AI 服務設定...</div>
        <div v-else-if="settingsError" class="text-sm text-red-500">{{ settingsError }}</div>
        <template v-else>
          <!-- Current config (read-only) -->
          <div v-if="llmProvider" class="space-y-3">
            <template v-if="llmProvider === 'gemini'">
              <ReadOnlyField label="模型名稱" :value="llmConfig.model" mono />
            </template>
            <template v-else-if="llmProvider === 'custom' || llmProvider === 'azure'">
              <ReadOnlyField label="Endpoint" :value="llmConfig.baseUrl" />
              <ReadOnlyField label="模型名稱" :value="llmConfig.model" mono />
            </template>
          </div>
          <div v-else class="text-sm text-slate-400 italic">尚未選擇 LLM Provider。</div>

          <!-- Change LLM (admin only) -->
          <template v-if="isAdmin && containerConfig">
            <div class="border-t border-slate-100 dark:border-slate-800 pt-5">
              <button @click="showLlmForm = !showLlmForm"
                class="flex items-center gap-2 text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                <RefreshCw class="w-4 h-4" />
                {{ showLlmForm ? '收起' : '更換 LLM Provider' }}
              </button>
            </div>

            <div v-if="showLlmForm" class="space-y-5 pt-1">
              <!-- Provider selector -->
              <div class="grid grid-cols-3 gap-3">
                <button @click="newProvider = 'gemini'"
                  class="p-3 rounded-xl border-2 text-left transition-all"
                  :class="newProvider === 'gemini' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/60' : 'border-slate-200 dark:border-slate-700 hover:border-blue-300'">
                  <div class="flex items-center gap-2 mb-1">
                    <Sparkles class="w-4 h-4 text-purple-500" />
                    <span class="font-bold text-xs">Gemini</span>
                  </div>
                  <p class="text-[10px] text-slate-400">Google Gemini API</p>
                </button>
                <button @click="newProvider = 'azure'"
                  class="p-3 rounded-xl border-2 text-left transition-all"
                  :class="newProvider === 'azure' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/60' : 'border-slate-200 dark:border-slate-700 hover:border-blue-300'">
                  <div class="flex items-center gap-2 mb-1">
                    <Cloud class="w-4 h-4 text-sky-500" />
                    <span class="font-bold text-xs">Azure</span>
                  </div>
                  <p class="text-[10px] text-slate-400">Azure OpenAI GPT</p>
                </button>
                <button @click="newProvider = 'custom'"
                  class="p-3 rounded-xl border-2 text-left transition-all"
                  :class="newProvider === 'custom' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/60' : 'border-slate-200 dark:border-slate-700 hover:border-blue-300'">
                  <div class="flex items-center gap-2 mb-1">
                    <Server class="w-4 h-4 text-slate-500" />
                    <span class="font-bold text-xs">Custom</span>
                  </div>
                  <p class="text-[10px] text-slate-400">OpenAI 相容端點</p>
                </button>
              </div>

              <!-- Gemini fields -->
              <div v-if="newProvider === 'gemini'" class="space-y-3">
                <div>
                  <label class="block text-sm font-medium mb-1">Gemini API Key <span class="text-red-500">*</span></label>
                  <input v-model="newGeminiKey" :type="showNewKey ? 'text' : 'password'" placeholder="AIzaSy..."
                    class="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>

              <!-- Azure fields -->
              <div v-else-if="newProvider === 'azure'" class="space-y-3">
                <div>
                  <label class="block text-sm font-medium mb-1">Azure Endpoint <span class="text-red-500">*</span></label>
                  <input v-model="newAzureEndpoint" type="url" placeholder="https://your-resource.cognitiveservices.azure.com"
                    class="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">API Key <span class="text-slate-400 text-xs">(選填)</span></label>
                  <input v-model="newAzureApiKey" :type="showNewKey ? 'text' : 'password'" placeholder="Azure API Key"
                    class="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Deployment Name <span class="text-red-500">*</span></label>
                  <input v-model="newAzureDeployment" type="text" placeholder="gpt-5.3-codex"
                    class="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Reasoning Effort</label>
                  <div class="grid grid-cols-3 gap-2">
                    <button v-for="opt in reasoningEffortOptions" :key="opt.value"
                      type="button"
                      @click="newAzureReasoningEffort = opt.value"
                      class="py-2 rounded-xl border-2 text-sm font-medium transition-all duration-150"
                      :class="newAzureReasoningEffort === opt.value
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-blue-300'">
                      {{ opt.label }}
                    </button>
                  </div>
                  <p class="text-xs text-slate-400 mt-1">控制推理模型的思考深度，影響回應品質與速度</p>
                </div>
              </div>

              <!-- Custom fields -->
              <div v-else-if="newProvider === 'custom'" class="space-y-3">
                <div>
                  <label class="block text-sm font-medium mb-1">Base URL <span class="text-red-500">*</span></label>
                  <input v-model="newBaseUrl" type="url" placeholder="https://api.example.com"
                    class="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">API Key <span class="text-slate-400 text-xs">(選填)</span></label>
                  <input v-model="newApiKey" :type="showNewKey ? 'text' : 'password'" placeholder="sk-..."
                    class="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Model ID <span class="text-red-500">*</span></label>
                  <input v-model="newModelId" type="text" placeholder="gpt-4o"
                    class="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <label class="flex items-start gap-2 cursor-pointer">
                  <input v-model="newIsReasoningModel" type="checkbox" class="mt-0.5 w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500" />
                  <span class="text-sm">
                    這是推理模型（gpt-5 / o1 / o3 系列等）
                    <span class="block text-xs text-slate-400 mt-0.5">這類模型不接受舊式 max_tokens 參數，勾選後會改用 max_completion_tokens，否則呼叫會被直接拒絕、完全沒有回應</span>
                  </span>
                </label>
              </div>

              <p v-if="llmUpdateError" class="text-sm text-red-500">{{ llmUpdateError }}</p>
              <p v-if="llmUpdateSuccess" class="text-sm text-green-600 dark:text-green-400">{{ llmUpdateSuccess }}</p>

              <button @click="applyLlmUpdate" :disabled="isUpdatingLlm || !newProvider"
                class="flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-500/20">
                <RefreshCw class="w-4 h-4" :class="isUpdatingLlm ? 'animate-spin' : ''" />
                {{ isUpdatingLlm ? '套用中，容器重啟...' : '套用並重啟容器' }}
              </button>
            </div>
          </template>
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
import { KeyRound, Eye, EyeOff, AudioWaveform, Mail, Server, FolderOpen, TriangleAlert, RefreshCw, Sparkles, Cloud } from 'lucide-vue-next'
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
  if (llmProvider.value === 'azure') return 'Azure OpenAI'
  if (llmProvider.value === 'custom') return 'Custom Provider'
  return ''
})

// LLM update form state
const showLlmForm = ref(false)
const newProvider = ref('')
const newGeminiKey = ref('')
const newAzureEndpoint = ref('')
const newAzureApiKey = ref('')
const newAzureDeployment = ref('')
const newAzureReasoningEffort = ref('high')
const newBaseUrl = ref('')

const reasoningEffortOptions = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]
const newApiKey = ref('')
const newModelId = ref('')
const newIsReasoningModel = ref(false)
const showNewKey = ref(false)
const isUpdatingLlm = ref(false)
const llmUpdateError = ref('')
const llmUpdateSuccess = ref('')

async function applyLlmUpdate() {
  llmUpdateError.value = ''
  llmUpdateSuccess.value = ''
  const token = localStorage.getItem('clawpm_token')

  const body = { provider: newProvider.value }
  if (newProvider.value === 'gemini') {
    if (!newGeminiKey.value.trim()) { llmUpdateError.value = '請填寫 Gemini API Key'; return }
    body.geminiApiKey = newGeminiKey.value.trim()
  } else if (newProvider.value === 'azure') {
    if (!newAzureEndpoint.value.trim() || !newAzureDeployment.value.trim()) {
      llmUpdateError.value = '請填寫 Azure Endpoint 與 Deployment Name'; return
    }
    body.azureEndpoint = newAzureEndpoint.value.trim()
    body.azureApiKey = newAzureApiKey.value.trim()
    body.azureDeploymentName = newAzureDeployment.value.trim()
    body.azureReasoningEffort = newAzureReasoningEffort.value
  } else if (newProvider.value === 'custom') {
    if (!newBaseUrl.value.trim() || !newModelId.value.trim()) {
      llmUpdateError.value = '請填寫 Base URL 與 Model ID'; return
    }
    body.baseUrl = newBaseUrl.value.trim()
    body.apiKey = newApiKey.value.trim()
    body.modelId = newModelId.value.trim()
    body.isReasoningModel = newIsReasoningModel.value
  } else {
    llmUpdateError.value = '請選擇 Provider'; return
  }

  isUpdatingLlm.value = true
  try {
    const res = await fetch('/api/container/update-llm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '更新失敗')
    llmUpdateSuccess.value = '設定已套用，容器已重啟。請稍候片刻後重新嘗試對話。'
    showLlmForm.value = false
    await fetchUserSettings()
  } catch (err) {
    llmUpdateError.value = err.message
  } finally {
    isUpdatingLlm.value = false
  }
}

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
