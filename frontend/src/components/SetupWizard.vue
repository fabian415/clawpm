<template>
<div>
  <div class="max-w-2xl mx-auto py-4">
    <!-- Header -->
    <div class="text-center mb-8">
      <div class="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-500/30">
        <BrainCircuit class="w-8 h-8 text-white" />
      </div>
      <h1 class="text-2xl font-bold">歡迎使用 ClawPM</h1>
      <p class="text-slate-500 text-sm mt-1">在開始前，請先完成容器初始化設定</p>
    </div>

    <!-- Phase: Steps -->
    <template v-if="phase === 'steps'">
      <!-- Stepper -->
      <div class="flex items-start justify-center mb-8">
        <div v-for="(label, i) in stepLabels" :key="i" class="flex items-start">
          <div class="flex flex-col items-center gap-1.5">
            <div
              class="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all duration-300"
              :class="stepBubbleClass(i + 1)"
            >
              <Check v-if="step > i + 1" class="w-4 h-4" />
              <span v-else>{{ i + 1 }}</span>
            </div>
            <span class="text-xs text-center w-20 leading-tight"
              :class="step >= i + 1 ? 'text-slate-700 dark:text-slate-200 font-medium' : 'text-slate-400'">
              {{ label }}
            </span>
          </div>
          <div v-if="i < stepLabels.length - 1"
            class="h-0.5 w-16 mx-1 mt-4 transition-all duration-500"
            :class="step > i + 1 ? 'bg-blue-500' : 'bg-slate-200 dark:bg-slate-700'">
          </div>
        </div>
      </div>

      <!-- Step Card -->
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 shadow-sm">

        <!-- Step 1: LLM Provider -->
        <Transition name="step" mode="out-in">
          <div v-if="step === 1" key="step1">
            <h2 class="text-lg font-bold mb-1">選擇 LLM Provider</h2>
            <p class="text-slate-500 text-sm mb-6">請選擇您的語言模型服務提供商</p>

            <div class="grid grid-cols-2 gap-4 mb-6">
              <button @click="provider = 'gemini'"
                class="p-4 rounded-xl border-2 text-left transition-all duration-200"
                :class="provider === 'gemini' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/60' : 'border-slate-200 dark:border-slate-700 hover:border-blue-300'">
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center shadow-sm">
                      <Sparkles class="w-5 h-5 text-white" />
                    </div>
                    <span class="font-bold text-sm">Gemini</span>
                  </div>
                  <div v-if="provider === 'gemini'" class="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                    <Check class="w-3 h-3 text-white" />
                  </div>
                </div>
                <p class="text-xs text-slate-500">Google Gemini API</p>
              </button>

              <button @click="provider = 'custom'"
                class="p-4 rounded-xl border-2 text-left transition-all duration-200"
                :class="provider === 'custom' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/60' : 'border-slate-200 dark:border-slate-700 hover:border-blue-300'">
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center shadow-sm">
                      <Server class="w-5 h-5 text-white" />
                    </div>
                    <span class="font-bold text-sm">Custom</span>
                  </div>
                  <div v-if="provider === 'custom'" class="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                    <Check class="w-3 h-3 text-white" />
                  </div>
                </div>
                <p class="text-xs text-slate-500">OpenAI 相容端點</p>
              </button>
            </div>

            <!-- Gemini fields -->
            <div v-if="provider === 'gemini'">
              <label class="block text-sm font-medium mb-1.5">Gemini API Key <span class="text-red-500">*</span></label>
              <div class="relative">
                <Key class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input v-model="geminiApiKey"
                  :type="showKey ? 'text' : 'password'"
                  placeholder="AIzaSy..."
                  class="w-full pl-10 pr-10 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
                <button @click="showKey = !showKey" type="button" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
                  <Eye v-if="!showKey" class="w-4 h-4" /><EyeOff v-else class="w-4 h-4" />
                </button>
              </div>
            </div>

            <!-- Custom fields -->
            <div v-if="provider === 'custom'" class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-1.5">Base URL <span class="text-red-500">*</span></label>
                <div class="relative">
                  <Globe class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input v-model="customBaseUrl" type="url" placeholder="https://api.example.com"
                    class="w-full pl-10 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                  />
                </div>
              </div>
              <div>
                <label class="block text-sm font-medium mb-1.5">API Key <span class="text-red-500">*</span></label>
                <div class="relative">
                  <Key class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input v-model="customApiKey"
                    :type="showKey ? 'text' : 'password'"
                    placeholder="sk-..."
                    class="w-full pl-10 pr-10 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                  />
                  <button @click="showKey = !showKey" type="button" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
                    <Eye v-if="!showKey" class="w-4 h-4" /><EyeOff v-else class="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Step 2: Model -->
          <div v-else-if="step === 2" key="step2">
            <h2 class="text-lg font-bold mb-1">選擇語言模型</h2>
            <p class="text-slate-500 text-sm mb-6">
              <span v-if="isFetchingModels">正在從 {{ providerLabel }} 取得模型列表...</span>
              <span v-else-if="fetchFailed">無法取得模型列表，請手動輸入模型名稱</span>
              <span v-else>從 {{ providerLabel }} 取得到 {{ models.length }} 個可用模型</span>
            </p>

            <!-- Loading -->
            <div v-if="isFetchingModels" class="flex flex-col items-center py-10 gap-4">
              <div class="w-10 h-10">
                <svg class="animate-spin w-full h-full text-blue-600" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"/>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                </svg>
              </div>
              <p class="text-sm text-slate-500">連接中，請稍候...</p>
            </div>

            <!-- Model list -->
            <div v-else-if="!fetchFailed && models.length > 0" class="space-y-3">
              <div class="relative">
                <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input v-model="modelSearch" type="search" placeholder="搜尋模型關鍵字..."
                  class="w-full pl-10 pr-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
              </div>
              <div v-if="filteredModels.length > 0" class="space-y-2 max-h-52 overflow-y-auto pr-1">
                <button v-for="m in filteredModels" :key="m" @click="selectedModel = m"
                  class="w-full flex items-center justify-between p-3.5 rounded-xl border-2 text-left text-sm transition-all duration-150"
                  :class="selectedModel === m
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 hover:border-blue-300 hover:bg-slate-50 dark:hover:bg-slate-800'">
                  <div class="flex items-center gap-3 min-w-0">
                    <Cpu class="w-4 h-4 text-slate-400 shrink-0" />
                    <span class="font-medium break-all">{{ m }}</span>
                  </div>
                  <div v-if="selectedModel === m" class="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                    <Check class="w-3 h-3 text-white" />
                  </div>
                </button>
              </div>
              <div v-else class="p-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 text-center text-sm text-slate-500">
                找不到符合「{{ modelSearch }}」的模型
              </div>
              <div v-if="modelSearch.trim()" class="text-xs text-slate-400">
                顯示 {{ filteredModels.length }} / {{ models.length }} 個模型
              </div>
            </div>

            <div v-else-if="fetchFailed" class="p-3.5 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl flex items-start gap-3">
              <AlertTriangle class="w-4 h-4 text-yellow-600 mt-0.5 shrink-0" />
              <p class="text-xs text-yellow-700 dark:text-yellow-400">{{ fetchErrorMsg }}</p>
            </div>

            <!-- Manual input -->
            <div v-if="!isFetchingModels" class="mt-4 space-y-4">
              <div>
                <label class="block text-sm font-medium mb-1.5">
                  手動輸入模型 ID
                  <span v-if="fetchFailed || !selectedModel" class="text-red-500">*</span>
                </label>
                <div class="relative">
                  <Cpu class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input v-model="manualModel" type="text"
                    :placeholder="provider === 'gemini' ? 'gemini-1.5-flash' : 'gpt-4o'"
                    class="w-full pl-10 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                  />
                </div>
                <p class="text-xs text-slate-400 mt-1.5">
                  <span v-if="selectedModel && !manualModel.trim()">已選取清單模型；也可以在這裡改填其他模型 ID。</span>
                  <span v-else-if="provider === 'gemini'">例如：gemini-1.5-pro、gemini-1.5-flash、gemini-2.0-flash-exp</span>
                  <span v-else>若清單中沒有適用模型，請在這裡輸入模型 ID。</span>
                </p>
              </div>
            </div>
          </div>

          <!-- Step 3: User ID -->
          <div v-else-if="step === 3" key="step3">
            <h2 class="text-lg font-bold mb-1">設定使用者 ID</h2>
            <p class="text-slate-500 text-sm mb-6">此 ID 將作為容器名稱與工作目錄識別碼，建立後無法變更</p>

            <div>
              <label class="block text-sm font-medium mb-1.5">使用者 ID <span class="text-red-500">*</span></label>
              <div class="relative">
                <User class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input v-model="userId" @input="onUserIdInput" type="text"
                  placeholder="user001"
                  class="w-full pl-10 pr-10 py-2.5 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:border-transparent transition"
                  :class="userIdBorderClass"
                />
                <div class="absolute right-3 top-1/2 -translate-y-1/2">
                  <svg v-if="userIdChecking" class="animate-spin w-4 h-4 text-slate-400" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"/>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                  </svg>
                  <CheckCircle v-else-if="userIdAvailable === true" class="w-4 h-4 text-green-500" />
                  <XCircle v-else-if="userIdAvailable === false" class="w-4 h-4 text-red-500" />
                </div>
              </div>
              <p v-if="userIdError" class="text-xs text-red-500 mt-1.5 flex items-center gap-1">
                <AlertCircle class="w-3.5 h-3.5 shrink-0" /> {{ userIdError }}
              </p>
              <p v-else-if="userIdAvailable === true" class="text-xs text-green-600 dark:text-green-400 mt-1.5">
                此 ID 可以使用
              </p>
              <p v-else class="text-xs text-slate-400 mt-1.5">
                只允許英文字母、數字、連字號 (-) 與底線 (_)，例如：user001、my-user
              </p>
            </div>

            <!-- Summary -->
            <div class="mt-6 p-4 bg-slate-50 dark:bg-slate-800 rounded-xl">
              <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">設定摘要</h4>
              <div class="space-y-2">
                <div class="flex justify-between text-sm">
                  <span class="text-slate-500">Provider</span>
                  <span class="font-medium">{{ providerLabel }}</span>
                </div>
                <div class="flex justify-between text-sm">
                  <span class="text-slate-500">模型</span>
                  <span class="font-mono text-xs font-medium">{{ effectiveModel || '—' }}</span>
                </div>
                <div class="flex justify-between text-sm">
                  <span class="text-slate-500">容器名稱</span>
                  <span class="font-mono text-xs text-blue-600 dark:text-blue-400">
                    {{ userId ? `clawpm-openclaw-${userId}` : '—' }}
                  </span>
                </div>
                <div class="flex justify-between text-sm">
                  <span class="text-slate-500">工作目錄</span>
                  <span class="font-mono text-xs text-blue-600 dark:text-blue-400">
                    {{ userId ? `~/.openclaw/users/${userId}` : '—' }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </Transition>

        <!-- Error -->
        <p v-if="stepError" class="mt-4 text-sm text-red-500 flex items-center gap-2">
          <AlertCircle class="w-4 h-4" /> {{ stepError }}
        </p>

        <!-- Navigation -->
        <div class="flex justify-between mt-8">
          <button v-if="step > 1" @click="prevStep"
            class="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium text-sm transition-colors">
            <ChevronLeft class="w-4 h-4" /> 上一步
          </button>
          <div v-else></div>

          <button @click="nextStep" :disabled="isNextDisabled"
            class="flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-sm transition-all duration-200"
            :class="isNextDisabled
              ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-500/20 active:scale-95'">
            <template v-if="step < 3">下一步 <ChevronRight class="w-4 h-4" /></template>
            <template v-else><Rocket class="w-4 h-4" /> 開始啟動</template>
          </button>
        </div>
      </div>
    </template>

    <!-- Phase: Terminal -->
    <template v-else-if="phase === 'terminal'">
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <!-- Title bar -->
        <div class="flex items-center gap-2 px-4 py-3 bg-slate-800 border-b border-slate-700">
          <div class="flex gap-1.5">
            <div class="w-3 h-3 rounded-full bg-red-500 opacity-90"></div>
            <div class="w-3 h-3 rounded-full bg-yellow-500 opacity-90"></div>
            <div class="w-3 h-3 rounded-full bg-green-500 opacity-90"></div>
          </div>
          <div class="flex items-center gap-2 ml-2">
            <TerminalIcon class="w-3.5 h-3.5 text-slate-400" />
            <span class="text-xs text-slate-400 font-mono">clawpm — provisioning {{ userId }}</span>
          </div>
        </div>
        <!-- Log body -->
        <div ref="terminalRef" class="bg-[#0d1117] p-5 h-72 overflow-y-auto font-mono text-xs leading-6">
          <div v-for="(line, i) in terminalLines" :key="i" class="flex gap-3 log-line">
            <span class="text-slate-600 shrink-0 select-none">{{ line.time }}</span>
            <span :class="{
              'text-green-400': line.type === 'success',
              'text-red-400':   line.type === 'error',
              'text-blue-400':  line.type === 'info',
              'text-yellow-400': line.type === 'warn',
              'text-slate-300': line.type === 'normal',
            }">{{ line.text }}</span>
          </div>
          <div v-if="isStarting" class="flex items-center gap-3 mt-1">
            <span class="text-slate-600 select-none">{{ currentTime }}</span>
            <span class="text-slate-400 animate-pulse">▊</span>
          </div>
        </div>
      </div>

      <!-- Progress -->
      <div class="mt-4">
        <div class="flex justify-between items-center mb-1.5">
          <span class="text-sm font-medium">容器啟動進度</span>
          <span class="text-sm text-slate-500">{{ startProgress }}%</span>
        </div>
        <div class="bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
          <div class="h-full bg-blue-600 transition-all duration-300 rounded-full" :style="{ width: startProgress + '%' }"></div>
        </div>
        <p v-if="provisionError" class="text-center text-sm text-red-500 font-medium mt-2 flex items-center justify-center gap-1.5">
          <AlertCircle class="w-4 h-4" /> {{ provisionError }}
        </p>
        <p v-else-if="!isStarting && startProgress === 100" class="text-center text-sm text-green-600 dark:text-green-400 font-medium mt-2 flex items-center justify-center gap-1.5">
          <CheckCircle class="w-4 h-4" /> 啟動完成！
        </p>
      </div>
    </template>
  </div>

  <!-- Success Modal -->
  <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0" leave-active-class="transition duration-150 ease-in" leave-to-class="opacity-0">
    <div v-if="showSuccess" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
      <div class="bg-white dark:bg-slate-900 w-full max-w-sm rounded-2xl shadow-2xl p-8 text-center animate-modal-in">
        <div class="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-5 ring-8 ring-green-50 dark:ring-green-900/10">
          <CheckCircle class="w-10 h-10 text-green-600" />
        </div>
        <h3 class="text-xl font-bold mb-2">容器啟動成功！</h3>
        <p class="text-slate-500 text-sm mb-6">ClawPM 已完成初始化，您可以開始使用所有功能。</p>

        <div class="p-4 bg-slate-50 dark:bg-slate-800 rounded-xl text-left space-y-2.5 mb-6">
          <div class="flex justify-between text-sm">
            <span class="text-slate-500">Provider</span>
            <span class="font-medium">{{ providerLabel }}</span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500">模型</span>
            <span class="font-mono text-xs font-medium">{{ effectiveModel }}</span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500">使用者 ID</span>
            <span class="font-mono text-xs font-medium">{{ userId }}</span>
          </div>
          <template v-if="provisionResult?.gatewayPort">
            <div class="border-t border-slate-200 dark:border-slate-700 pt-2.5 space-y-2.5">
              <div class="flex justify-between text-sm">
                <span class="text-slate-500">Dashboard</span>
                <a :href="`http://localhost:${provisionResult.gatewayPort}`" target="_blank"
                  class="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline">
                  localhost:{{ provisionResult.gatewayPort }}
                </a>
              </div>
              <div v-if="provisionResult?.gatewayToken" class="space-y-1.5">
                <div class="flex items-center justify-between text-sm">
                  <span class="text-slate-500">Gateway Token</span>
                  <button @click="copyToken" class="text-xs text-slate-400 hover:text-blue-500 transition-colors flex items-center gap-1">
                    <Copy class="w-3 h-3" />{{ tokenCopied ? '已複製' : '複製' }}
                  </button>
                </div>
                <div class="bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 font-mono text-xs break-all select-all text-slate-700 dark:text-slate-200">
                  {{ provisionResult.gatewayToken }}
                </div>
              </div>
            </div>
          </template>
        </div>

        <button @click="handleComplete"
          class="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 shadow-lg shadow-blue-500/20 transition-all active:scale-95 flex items-center justify-center gap-2">
          進入 ClawPM <ArrowRight class="w-4 h-4" />
        </button>
      </div>
    </div>
  </Transition>
</div>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue'
import {
  BrainCircuit, Check, Sparkles, Server, Key, Globe, Eye, EyeOff,
  Cpu, AlertTriangle, AlertCircle, User, Search, ChevronLeft, ChevronRight,
  Rocket, Terminal as TerminalIcon, CheckCircle, XCircle, ArrowRight, Copy
} from 'lucide-vue-next'

defineProps({ isDark: Boolean })
const emit = defineEmits(['complete'])

function handleComplete() {
  emit('complete', {
    provider: provider.value,
    apiKey: provider.value === 'gemini' ? geminiApiKey.value : customApiKey.value,
    baseUrl: provider.value === 'custom' ? customBaseUrl.value : null,
    model: effectiveModel.value,
    workspaceFolder: userId.value,
  })
}

const phase = ref('steps')
const step = ref(1)
const stepLabels = ['LLM Provider', '選擇模型', '使用者 ID']

const provider = ref(null)
const geminiApiKey = ref('')
const customBaseUrl = ref('')
const customApiKey = ref('')
const showKey = ref(false)

const isFetchingModels = ref(false)
const fetchFailed = ref(false)
const fetchErrorMsg = ref('')
const models = ref([])
const selectedModel = ref('')
const manualModel = ref('')
const modelSearch = ref('')

// userId state
const userId = ref('')
const userIdError = ref('')
const userIdChecking = ref(false)
const userIdAvailable = ref(null) // null=unchecked, true=ok, false=taken/invalid
let userIdCheckTimer = null

const stepError = ref('')

const terminalRef = ref(null)
const terminalLines = ref([])
const isStarting = ref(false)
const startProgress = ref(0)
const showSuccess = ref(false)
const provisionError = ref('')
const provisionResult = ref(null)
const tokenCopied = ref(false)

function copyToken() {
  const token = provisionResult.value?.gatewayToken
  if (!token) return
  navigator.clipboard.writeText(token).then(() => {
    tokenCopied.value = true
    setTimeout(() => { tokenCopied.value = false }, 2000)
  })
}
const currentTime = ref(new Date().toTimeString().slice(0, 8))

const providerLabel = computed(() =>
  ({ gemini: 'Google Gemini', custom: 'Custom Provider' })[provider.value] ?? '—'
)

const effectiveModel = computed(() =>
  manualModel.value.trim() || selectedModel.value
)

const filteredModels = computed(() => {
  const keyword = modelSearch.value.trim().toLowerCase()
  if (!keyword) return models.value
  return models.value.filter(model => String(model).toLowerCase().includes(keyword))
})

const userIdBorderClass = computed(() => {
  if (userIdAvailable.value === true) return 'border-green-500 focus:ring-green-500 bg-slate-50 dark:bg-slate-800'
  if (userIdAvailable.value === false || userIdError.value) return 'border-red-400 focus:ring-red-400 bg-slate-50 dark:bg-slate-800'
  return 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-blue-500'
})

const isNextDisabled = computed(() => {
  if (step.value === 1) {
    if (!provider.value) return true
    if (provider.value === 'gemini') return !geminiApiKey.value.trim()
    return !customBaseUrl.value.trim() || !customApiKey.value.trim()
  }
  if (step.value === 2) {
    if (isFetchingModels.value) return true
    return !effectiveModel.value
  }
  if (step.value === 3) {
    return !userId.value.trim() || !!userIdError.value || userIdChecking.value || userIdAvailable.value !== true
  }
  return false
})

function stepBubbleClass(n) {
  if (step.value > n) return 'bg-blue-600 border-blue-600 text-white'
  if (step.value === n) return 'border-blue-500 text-blue-600 bg-blue-50 dark:bg-blue-950/50 dark:text-blue-400'
  return 'border-slate-300 dark:border-slate-600 text-slate-400'
}

function onUserIdInput() {
  userIdAvailable.value = null
  userIdError.value = ''
  clearTimeout(userIdCheckTimer)

  const val = userId.value.trim()
  if (!val) return

  if (!/^[\w-]+$/.test(val)) {
    userIdError.value = '只允許英文字母、數字、連字號與底線'
    return
  }

  userIdChecking.value = true
  userIdCheckTimer = setTimeout(async () => {
    try {
      const token = localStorage.getItem('clawpm_token')
      const res = await fetch(`/api/provision/check-userid/${encodeURIComponent(val)}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      userIdAvailable.value = data.available
      if (!data.available) userIdError.value = data.reason ?? '此 ID 已被使用'
    } catch {
      userIdAvailable.value = null
    } finally {
      userIdChecking.value = false
    }
  }, 400)
}

async function fetchModels() {
  isFetchingModels.value = true
  fetchFailed.value = false
  models.value = []
  selectedModel.value = ''
  modelSearch.value = ''

  try {
    if (provider.value === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiApiKey.value)}`,
        { signal: AbortSignal.timeout(8000) }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      models.value = (data.models ?? [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace('models/', ''))
    } else {
      const base = customBaseUrl.value.replace(/\/+$/, '')
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${customApiKey.value}` },
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      models.value = (data.data ?? data.models ?? []).map(m => m.id ?? m.name)
    }
    if (models.value.length === 0) throw new Error('empty')
  } catch (err) {
    fetchFailed.value = true
    const msg = err.message
    if (msg.includes('HTTP 400') || msg.includes('HTTP 403'))
      fetchErrorMsg.value = 'API Key 無效或權限不足，請手動輸入模型名稱。'
    else if (msg.includes('HTTP'))
      fetchErrorMsg.value = `連線失敗（${msg}），請手動輸入模型名稱。`
    else if (msg === 'empty')
      fetchErrorMsg.value = '未取得任何可用模型，請手動輸入模型名稱。'
    else
      fetchErrorMsg.value = '無法取得模型列表（可能為跨域限制），請手動輸入模型名稱。'
  } finally {
    isFetchingModels.value = false
  }
}

function nextStep() {
  stepError.value = ''
  if (step.value === 1) {
    step.value = 2
    fetchModels()
  } else if (step.value === 2) {
    step.value = 3
  } else {
    startContainerSetup()
  }
}

function prevStep() {
  stepError.value = ''
  step.value--
}

function addLine(type, text) {
  currentTime.value = new Date().toTimeString().slice(0, 8)
  terminalLines.value.push({ time: currentTime.value, type, text })
  nextTick(() => {
    if (terminalRef.value) terminalRef.value.scrollTop = terminalRef.value.scrollHeight
  })
}

async function startContainerSetup() {
  phase.value = 'terminal'
  isStarting.value = true
  startProgress.value = 0
  terminalLines.value = []
  provisionError.value = ''
  provisionResult.value = null

  const token = localStorage.getItem('clawpm_token')
  const body = { userId: userId.value, provider: provider.value }

  if (provider.value === 'gemini') {
    body.geminiApiKey = geminiApiKey.value
  } else {
    body.baseUrl = customBaseUrl.value
    body.apiKey = customApiKey.value
    body.modelId = effectiveModel.value
  }

  // Track progress by counting log events
  let eventCount = 0

  try {
    const response = await fetch('/api/provision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      addLine('error', err.error || `HTTP ${response.status}`)
      isStarting.value = false
      provisionError.value = err.error || '初始化失敗'
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data: ')) continue
        let data
        try { data = JSON.parse(line.slice(6)) } catch { continue }

        if (data.type === 'done') {
          startProgress.value = 100
          isStarting.value = false
          provisionResult.value = data
          setTimeout(() => { showSuccess.value = true }, 700)
        } else if (data.type === 'error') {
          addLine('error', data.text)
          isStarting.value = false
          provisionError.value = data.text
        } else {
          addLine(data.type, data.text)
          eventCount++
          startProgress.value = Math.min(92, Math.round((eventCount / 22) * 92))
        }
      }
    }
  } catch (err) {
    addLine('error', `連線失敗: ${err.message}`)
    isStarting.value = false
    provisionError.value = err.message
  }
}
</script>

<style scoped>
.step-enter-active,
.step-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.step-enter-from { opacity: 0; transform: translateX(14px); }
.step-leave-to   { opacity: 0; transform: translateX(-14px); }

@keyframes modalIn {
  from { opacity: 0; transform: translateY(12px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.animate-modal-in { animation: modalIn 0.25s ease forwards; }

@keyframes logFade {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: translateY(0); }
}
.log-line { animation: logFade 0.12s ease forwards; }
</style>
