<template>
  <div class="max-w-5xl mx-auto space-y-8 pb-20">
    <div class="flex justify-between items-center gap-4">
      <h2 class="text-2xl font-bold">容器設定</h2>
      <div v-if="isAdmin" class="flex items-center gap-2">
        <button @click="$emit('restart')" class="bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400 px-4 py-2 rounded-lg font-bold flex items-center gap-2 hover:bg-amber-100 dark:hover:bg-amber-900 transition-all">
          <RotateCw class="w-4 h-4" /> 重啟 Container
        </button>
        <button @click="$emit('destroy')" class="bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400 px-4 py-2 rounded-lg font-bold flex items-center gap-2 hover:bg-red-100 dark:hover:bg-red-900 transition-all">
          <Trash2 class="w-4 h-4" /> 刪除設定
        </button>
      </div>
    </div>

    <!-- Container Status -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><Server class="w-5 h-5 text-emerald-500" /> 容器資訊</h3>
      </div>
      <div class="p-8 space-y-5">
        <div v-if="isLoadingConfig" class="text-sm text-slate-400 italic flex items-center gap-2">
          <Loader2 class="w-4 h-4 animate-spin" /> 讀取容器資訊中...
        </div>
        <div v-else-if="!resolvedConfig" class="text-sm text-slate-400 italic">尚未建立容器設定，請先完成初始化。</div>
        <template v-else>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Container ID</label>
              <div class="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm">
                {{ resolvedConfig.containerId || '--' }}
              </div>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">狀態</label>
              <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 text-sm">
                <span class="w-2 h-2 rounded-full" :class="statusDotClass"></span>
                <span :class="statusTextClass">{{ statusLabel }}</span>
              </div>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Gateway Port</label>
              <div class="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm">
                {{ resolvedConfig.gatewayPort || '--' }}
              </div>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Bridge Port</label>
              <div class="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm">
                {{ resolvedConfig.bridgePort || '--' }}
              </div>
            </div>
          </div>
          <div class="space-y-1">
            <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Workspace 路徑</label>
            <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm break-all">
              <FolderOpen class="w-4 h-4 text-slate-400 shrink-0" />
              <span>{{ resolvedConfig.workspacePath || '--' }}</span>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!-- Live Logs -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-2">
            <h3 class="font-bold flex items-center gap-2"><Terminal class="w-5 h-5 text-slate-400" /> 即時 Logs</h3>
            <span v-if="isStreaming" class="flex items-center gap-1.5 text-xs text-emerald-500">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              串流中
            </span>
            <span v-else-if="isReconnecting" class="flex items-center gap-1.5 text-xs text-amber-500">
              <Loader2 class="w-3 h-3 animate-spin" /> 重新連線中...
            </span>
            <span v-else-if="streamError" class="text-xs text-red-500">{{ streamError }}</span>
            <span v-else class="text-xs text-slate-400">已停止</span>
          </div>
          <div class="flex items-center gap-2">
            <label class="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
              <input type="checkbox" v-model="autoScroll" class="rounded" />
              自動捲動
            </label>
            <button @click="clearLogs" class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
              清除
            </button>
            <button @click="downloadLogs" :disabled="isDownloading" class="flex items-center gap-1.5 text-xs bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
              <Download class="w-3.5 h-3.5" />
              {{ isDownloading ? '下載中...' : '下載 Logs' }}
            </button>
          </div>
        </div>
      </div>

      <div class="relative">
        <div
          ref="logContainer"
          class="bg-slate-950 text-slate-100 font-mono text-xs leading-5 h-[480px] overflow-y-auto p-4 space-y-0"
          @scroll="handleScroll"
        >
          <div v-if="logLines.length === 0" class="text-slate-600 italic">等待 logs...</div>
          <div
            v-for="(line, i) in logLines"
            :key="i"
            class="whitespace-pre-wrap break-all"
            :class="line.includes('[Error]') ? 'text-red-400' : line.includes('warn') || line.includes('WARN') ? 'text-amber-400' : 'text-slate-200'"
          >{{ line }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { RotateCw, Trash2, Server, Terminal, FolderOpen, Download, Loader2 } from 'lucide-vue-next'

const props = defineProps({
  containerConfig: { type: Object, default: null },
  isAdmin: { type: Boolean, default: false }
})
const emit = defineEmits(['restart', 'destroy', 'config-loaded'])

const localConfig = ref(null)
const isLoadingConfig = ref(false)
const resolvedConfig = computed(() => localConfig.value ?? props.containerConfig)

const logLines = ref([])
const logContainer = ref(null)
const autoScroll = ref(false)
const isStreaming = ref(false)
const isReconnecting = ref(false)
const streamError = ref('')
const isDownloading = ref(false)
let streamReader = null
let componentMounted = true

async function fetchLocalConfig() {
  const token = localStorage.getItem('clawpm_token')
  if (!token) return
  isLoadingConfig.value = true
  try {
    const res = await fetch('/api/container/config', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (res.ok) localConfig.value = await res.json()
  } catch {}
  finally { isLoadingConfig.value = false }
}

const statusLabel = computed(() => {
  const s = resolvedConfig.value?.containerStatus
  const h = resolvedConfig.value?.containerHealth
  if (!s) return '未知'
  if (s === 'running' && h === 'healthy') return '運行中 (healthy)'
  if (s === 'running' && h === 'starting') return '啟動中...'
  if (s === 'running') return '運行中'
  if (s === 'exited') return '已停止'
  return s
})

const statusDotClass = computed(() => {
  const s = resolvedConfig.value?.containerStatus
  const h = resolvedConfig.value?.containerHealth
  if (s === 'running' && h === 'healthy') return 'bg-emerald-500'
  if (s === 'running') return 'bg-amber-400'
  return 'bg-slate-400'
})

const statusTextClass = computed(() => {
  const s = resolvedConfig.value?.containerStatus
  const h = resolvedConfig.value?.containerHealth
  if (s === 'running' && h === 'healthy') return 'text-emerald-600 dark:text-emerald-400'
  if (s === 'running') return 'text-amber-600 dark:text-amber-400'
  return 'text-slate-500'
})

function handleScroll() {
  if (!logContainer.value) return
  const el = logContainer.value
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  autoScroll.value = atBottom
}

async function scrollToBottom() {
  await nextTick()
  if (logContainer.value && autoScroll.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight
  }
}

watch(() => logLines.value.length, scrollToBottom)
watch(autoScroll, (val) => { if (val) scrollToBottom() })

function clearLogs() {
  logLines.value = []
}

// Returns true if stream ended naturally (should retry), false if cancelled
async function connectOnce() {
  const token = localStorage.getItem('clawpm_token')
  if (!token) return false

  let response
  try {
    response = await fetch('/api/container/logs/stream', {
      headers: { Authorization: `Bearer ${token}` }
    })
  } catch (err) {
    if (componentMounted) streamError.value = err.message
    return true
  }

  if (!response.ok) {
    if (componentMounted) streamError.value = `HTTP ${response.status}`
    return true
  }

  streamError.value = ''
  isStreaming.value = true
  isReconnecting.value = false

  const reader = response.body.getReader()
  streamReader = reader
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop()
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue
        try {
          const { text } = JSON.parse(part.slice(6))
          if (text) logLines.value.push(text)
        } catch {}
      }
    }
    return true  // natural end → retry
  } catch (err) {
    if (err.name === 'AbortError' || !componentMounted) return false
    streamError.value = err.message
    return true
  } finally {
    isStreaming.value = false
    streamReader = null
  }
}

async function startLogStream() {
  while (componentMounted) {
    const shouldRetry = await connectOnce()
    if (!shouldRetry || !componentMounted) break
    // stream ended (container restart etc.) — wait then reconnect
    isReconnecting.value = true
    logLines.value.push('━━━ 連線中斷，3 秒後重新連線... ━━━')
    await new Promise(resolve => setTimeout(resolve, 3000))
    if (!componentMounted) break
    logLines.value.push('━━━ 重新連線中 ━━━')
  }
  isReconnecting.value = false
}

async function downloadLogs() {
  if (isDownloading.value) return
  isDownloading.value = true
  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/container/logs/download', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `openclaw-logs-${Date.now()}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (err) {
    streamError.value = `下載失敗: ${err.message}`
  } finally {
    isDownloading.value = false
  }
}

onMounted(() => {
  fetchLocalConfig()
  startLogStream()
})

onBeforeUnmount(() => {
  componentMounted = false
  if (streamReader) {
    try { streamReader.cancel() } catch {}
    streamReader = null
  }
})
</script>
