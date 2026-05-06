<template>
  <div class="max-w-4xl mx-auto space-y-8 pb-20">
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold">容器設定</h2>
      <div class="flex items-center gap-2">
        <button @click="$emit('restart')" class="bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400 px-4 py-2 rounded-lg font-bold flex items-center gap-2 hover:bg-amber-100 dark:hover:bg-amber-900 transition-all">
          <RotateCw class="w-4 h-4" /> 重啟 Container
        </button>
        <button @click="$emit('destroy')" class="bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400 px-4 py-2 rounded-lg font-bold flex items-center gap-2 hover:bg-red-100 dark:hover:bg-red-900 transition-all">
          <Trash2 class="w-4 h-4" /> 刪除容器
        </button>
      </div>
    </div>

    <!-- Container Info -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><Server class="w-5 h-5 text-emerald-500" /> OpenClaw 容器資訊</h3>
      </div>
      <div class="p-8 space-y-5">
        <div v-if="!containerConfig" class="text-sm text-slate-400 italic">尚未建立容器，請先完成初始設定。</div>
        <template v-else>
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-500">工作路徑位置</label>
            <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm break-all">
              <FolderOpen class="w-4 h-4 text-slate-400 shrink-0" />
              <span>{{ containerConfig.workspacePath || '—' }}</span>
            </div>
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-500">Gateway 工作路徑位置</label>
            <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm break-all">
              <FolderOpen class="w-4 h-4 text-slate-400 shrink-0" />
              <span>{{ containerConfig.gatewayWorkspacePath || containerConfig.gatewayConfigPath || '—' }}</span>
            </div>
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-500">Gateway Token</label>
            <div class="relative">
              <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm pr-12 break-all">
                <KeyRound class="w-4 h-4 text-slate-400 shrink-0" />
                <span>{{ showToken ? (containerConfig.gatewayToken || '—') : maskToken(containerConfig.gatewayToken) }}</span>
              </div>
              <button @click="showToken = !showToken" class="absolute right-3 top-3 text-slate-400 hover:text-slate-600">
                <EyeOff v-if="showToken" class="w-4 h-4" />
                <Eye v-else class="w-4 h-4" />
              </button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-4 pt-1">
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Gateway Port</label>
              <div class="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm">
                {{ containerConfig.gatewayPort || '—' }}
              </div>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Bridge Port</label>
              <div class="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm">
                {{ containerConfig.bridgePort || '—' }}
              </div>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!-- AI Keys -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><KeyRound class="w-5 h-5 text-blue-500" /> AI 服務金鑰</h3>
      </div>
      <div class="p-8 space-y-6">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="space-y-2">
            <label class="text-sm font-medium">Gemini API Key</label>
            <div class="relative">
              <input :type="showKeys ? 'text' : 'password'" value="AIzaSyA_example_key_123456" class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl outline-none ring-1 ring-slate-200 dark:ring-slate-700 focus:ring-blue-500" />
              <button @click="showKeys = !showKeys" class="absolute right-3 top-3 text-slate-400">
                <EyeOff v-if="showKeys" class="w-4 h-4" />
                <Eye v-else class="w-4 h-4" />
              </button>
            </div>
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium">Azure OpenAI Key</label>
            <input :type="showKeys ? 'text' : 'password'" value="892347sd981237asdf987213" class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl outline-none ring-1 ring-slate-200 dark:ring-slate-700 focus:ring-blue-500" />
          </div>
        </div>
        <div class="space-y-2">
          <label class="text-sm font-medium">Azure Endpoint</label>
          <input type="text" placeholder="https://your-resource.openai.azure.com/" class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl outline-none ring-1 ring-slate-200 dark:ring-slate-700 focus:ring-blue-500" />
        </div>
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
          <label class="text-sm font-medium">Email 收件人 (會議完成通知)</label>
          <input type="email" placeholder="jason.su@example.com" class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl outline-none ring-1 ring-slate-200 dark:ring-slate-700 focus:ring-blue-500" />
        </div>
      </div>
    </section>

    <div class="flex justify-end pt-4">
      <button @click="$emit('save')" class="bg-blue-600 text-white px-10 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-xl shadow-blue-500/20 transition-all">儲存設定</button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { RotateCw, Trash2, KeyRound, Eye, EyeOff, AudioWaveform, Mail, Server, FolderOpen } from 'lucide-vue-next'

defineProps({
  containerConfig: { type: Object, default: null }
})
defineEmits(['restart', 'destroy', 'save'])

const showKeys = ref(false)
const showToken = ref(false)
const selectedModel = ref('large-v3')
const whisperModels = [
  { name: 'large-v3', desc: '最精準 • 耗能高' },
  { name: 'medium', desc: '平衡首選' },
  { name: 'small', desc: '極速處理' }
]

function maskToken(token) {
  if (!token) return '—'
  return token.slice(0, 8) + '••••••••••••••••••••••••' + token.slice(-4)
}
</script>
